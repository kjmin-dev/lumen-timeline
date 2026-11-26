// The roadmap's seek race target: 100 seeks mixed with stalls, looping and take changes. Once the
// device has played out what was submitted before, only audio of the current playback
// generation is audible: one voice per clip under the playhead, each at the source sample the
// playhead stands on.
import assert from "node:assert/strict";
import test from "node:test";
import { commands, createEditor, TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import { createAudioTransport } from "@lumen-timeline/media";
import type { AudioBufferLike, SeekResult } from "@lumen-timeline/media";
import { FakeContext, sink } from "./fakes.ts";
import type { FakeSource } from "./fakes.ts";

const sec = (n: number): number => Math.round(n * hz);

/** A seeded generator: the same seed gives the same trace. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

for (const seed of [1, 2, 3, 4]) {
  test(`100 seeks mixed with stalls, loops and take changes leave only the current generation audible (seed ${seed})`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const random = seeded(seed);
    const context = new FakeContext(48000);
    const rate = context.sampleRate;
    // Music under the whole sequence; a line with two takes, each from its own recording.
    const editor = createEditor({
      project: {
        schemaVersion: 2,
        tracks: [{ id: "music" }, { id: "voice" }],
        clips: [
          {
            id: "music",
            trackId: "music",
            kind: "audio",
            start: 0,
            duration: sec(60),
            contentIn: 0,
            takeIds: ["music"],
            activeTakeId: "music",
          },
          {
            id: "line",
            trackId: "voice",
            kind: "audio",
            start: sec(2),
            duration: sec(48),
            contentIn: sec(5),
            takeIds: ["a", "b"],
            activeTakeId: "a",
          },
        ],
        takes: [
          { id: "music", assetId: "music", streamId: "mono", sourceAtContentZero: 0 },
          { id: "a", assetId: "take-a", streamId: "mono", sourceAtContentZero: 0 },
          { id: "b", assetId: "take-b", streamId: "mono", sourceAtContentZero: sec(2) },
        ],
      },
    });
    const stream = {
      assetVersion: 1,
      sampleRate: rate,
      availableStart: 0,
      availableEnd: 90 * rate,
    };
    const buffers = new Map<string, AudioBufferLike>(
      ["music", "take-a", "take-b"].map((id) => [id, { sampleRate: rate, length: 90 * rate }]),
    );
    // While stalled, a buffer arrives only when the trace releases it, in any order, also after
    // the request was aborted.
    let stalled = false;
    const pending: { assetId: string; resolve: (buffer: AudioBufferLike) => void }[] = [];
    const transport = createAudioTransport({
      editor,
      context,
      output: sink,
      catalog: {
        version: 1,
        streams: {
          music: { mono: stream },
          "take-a": { mono: stream },
          "take-b": { mono: stream },
        },
      },
      resolveBuffer: (span) => {
        const buffer = buffers.get(span.assetId);
        assert.ok(buffer);
        if (!stalled) return buffer;
        return new Promise<AudioBufferLike>((resolve) =>
          pending.push({ assetId: span.assetId, resolve }),
        );
      },
    });
    t.after(() => {
      transport.dispose();
      editor.dispose();
    });
    let now = 0;
    const advance = (seconds: number) => {
      now += seconds;
      context.currentTime = now;
      context.outputTime = now;
      t.mock.timers.tick(25);
    };
    const release = (index: number) => {
      const [load] = pending.splice(index, 1);
      load?.resolve(buffers.get(load.assetId) ?? { sampleRate: rate, length: 0 });
    };

    await transport.play();
    advance(0.5);
    const seeks: Promise<SeekResult>[] = [];
    const counts = { seek: 0, loop: 0, take: 0, stall: 0, release: 0, clock: 0 };
    while (counts.seek < 100) {
      const roll = random();
      if (roll < 0.4) {
        counts.seek++;
        seeks.push(transport.seek(sec(random() * 55)));
      } else if (roll < 0.5) {
        counts.loop++;
        const start = random() * 50;
        transport.setLoop(
          random() < 0.3 ? null : { start: sec(start), end: sec(start + 0.5 + random() * 4) },
        );
      } else if (roll < 0.6) {
        counts.take++;
        const activeTakeId = editor.getSnapshot().clips[1]?.activeTakeId;
        const takeId = activeTakeId === "a" ? "b" : "a";
        assert.ok(editor.dispatch(commands.selectTake({ clipId: "line", takeId })).ok);
      } else if (roll < 0.7) {
        counts.stall++;
        stalled = !stalled;
      } else if (roll < 0.8) {
        counts.release++;
        release(Math.floor(random() * pending.length));
      } else {
        counts.clock++;
        advance(random() * 0.3);
      }
      await Promise.resolve();
    }
    assert.ok(
      Object.values(counts).every((n) => n > 0),
      JSON.stringify(counts),
    );

    // Every stalled buffer arrives, the superseded ones late, then the device plays out.
    stalled = false;
    while (pending.length) release(pending.length - 1);
    for (let i = 0; i < 40; i++) {
      await Promise.resolve();
      advance(0.05);
    }
    for (const result of await Promise.all(seeks))
      assert.ok(result === "arrived" || result === "superseded");
    const state = transport.snapshot();
    assert.equal(state.status, "playing");
    assert.equal(state.requestedTick, null);

    // What sounds now: the nodes that have started and have not stopped. Web Audio applies the
    // last stop a node was given.
    const sounding = (node: FakeSource) =>
      node.when <= now && (node.stops.at(-1) ?? Infinity) > now;
    const audible = context.nodes.filter(sounding);
    const at = state.presentedTick;
    const snapshot = editor.getSnapshot();
    const expected = snapshot.clips
      .filter((c) => c.start <= at && at < c.start + c.duration)
      .map((c) => {
        const take = (snapshot.takes ?? []).find((k) => k.id === c.activeTakeId);
        assert.ok(take);
        return {
          buffer: buffers.get(take.assetId),
          source: (at - c.start + c.contentIn + take.sourceAtContentZero) / hz,
        };
      });
    assert.equal(
      audible.length,
      expected.length,
      `${audible.length} voices sound for ${expected.length} clips`,
    );
    for (const { buffer, source } of expected) {
      const node = audible.find((n) => n.buffer === buffer);
      assert.ok(node, "a clip under the playhead is silent or plays another take");
      // The node's source position now, against the playhead's, within one sample.
      const playing = node.offset + (now - node.when);
      assert.ok(Math.abs(playing - source) * rate <= 1, `${playing} s against ${source} s`);
    }
  });
}
