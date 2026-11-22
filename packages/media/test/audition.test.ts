import assert from "node:assert/strict";
import test from "node:test";
import { commands, createEditor, TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import type { Editor, Project, Track } from "@lumen-timeline/core";
import { createAudioTransport, createVideoTransport } from "@lumen-timeline/media";
import type { AudioBufferLike, AudioTransportState } from "@lumen-timeline/media";
import type { TestContext } from "node:test";
import { FakeContext, FakeSource, FakeVideo, sink } from "./fakes.ts";

const sec = (n: number): number => Math.round(n * hz);
const rate = 48000;

/** A line with candidates a and b over a music bed, each take on its own asset. */
function project(tracks: Track[] = [{ id: "voice" }, { id: "music" }]): Project {
  return {
    schemaVersion: 1,
    duration: sec(10),
    tracks,
    clips: [
      {
        id: "line",
        trackId: "voice",
        kind: "audio",
        start: sec(2),
        duration: sec(3),
        contentIn: 0,
        takeIds: ["a", "b"],
        activeTakeId: "a",
      },
      {
        id: "bed",
        trackId: "music",
        kind: "audio",
        start: 0,
        duration: sec(10),
        contentIn: 0,
        takeIds: ["m"],
        activeTakeId: "m",
      },
    ],
    takes: ["a", "b", "m"].map((id) => ({
      id,
      assetId: "asset-" + id,
      streamId: "mono",
      sourceAtContentZero: 0,
    })),
  };
}
const stream = { assetVersion: 1, sampleRate: rate, availableStart: 0, availableEnd: 10 * rate };
const catalog = {
  version: 1,
  streams: Object.fromEntries(["a", "b", "m"].map((id) => ["asset-" + id, { mono: stream }])),
};
const buffers = new Map<string, AudioBufferLike>(
  ["a", "b", "m"].map((id) => ["asset-" + id, { sampleRate: rate, length: 10 * rate }]),
);

function fixture(t: TestContext, tracks?: Track[], context = new FakeContext(rate)) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const editor = createEditor({ project: project(tracks) });
  const transport = createAudioTransport({
    editor,
    context,
    output: sink,
    catalog,
    resolveBuffer: (span) => {
      const buffer = buffers.get(span.assetId);
      assert.ok(buffer);
      return buffer;
    },
  });
  const states: AudioTransportState[] = [];
  transport.subscribe((s) => states.push(s));
  t.after(() => {
    transport.dispose();
    editor.dispose();
  });
  return {
    editor,
    context,
    transport,
    states,
    at: (seconds: number): void => {
      context.currentTime = seconds;
      context.outputTime = seconds;
      t.mock.timers.tick(25);
    },
    /** The asset each live node plays, keyed by its buffer. */
    playing: (): string[] => {
      // A booked node records its scheduled stop, and a cancelled one a second.
      const live = context.nodes.filter(
        (node) => node.stops.length === 1 && node.stops[0] > context.currentTime,
      );
      return live.map((node) => assetOf(node)).sort();
    },
  };
}
function assetOf(node: FakeSource): string {
  for (const [id, buffer] of buffers) if (buffer === node.buffer) return id;
  return "unknown";
}
/** The output time the transport anchors to: one render quantum ahead. */
const anchorTime = (context: FakeContext): number =>
  (Math.ceil(context.currentTime * rate) + 128) / rate;

test("an audition plays one candidate in the mix over its clip, then returns paused", async (t) => {
  const { editor, context, transport, states, at, playing } = fixture(t);
  await transport.play();
  // Play anchored at output sample 128.
  at(128 / rate + 1);
  assert.equal(transport.snapshot().presentedTick, sec(1));
  const revision = editor.getSnapshot().revision;
  const before = transport.snapshot().segment;

  const heard = transport.audition({ clipId: "line", takeId: "b" });
  const audition = transport.snapshot().audition;
  assert.deepEqual(audition, {
    clipId: "line",
    takeId: "b",
    mode: "mix",
    range: { start: sec(2), end: sec(5) },
    returnTick: sec(1),
  });
  // Project playback stopped, and the clip plays candidate b with the bed.
  assert.equal(transport.snapshot().presentedTick, sec(2));
  assert.equal(transport.snapshot().segmentStart, sec(2));
  assert.deepEqual(playing(), ["asset-b", "asset-m"]);
  const start = anchorTime(context);
  const bed = context.nodes.findLast((node) => assetOf(node) === "asset-m");
  assert.ok(bed);
  // Every voice stops at the clip's end, including the bed that continues past it.
  assert.equal(bed.offset, 2);
  assert.equal(Math.round(bed.when * rate), Math.round(start * rate));
  assert.equal(Math.round(bed.stops[0] * rate), Math.round((start + 3) * rate));

  at(start + 1.5);
  assert.equal(transport.snapshot().presentedTick, sec(3.5));
  assert.equal(transport.snapshot().status, "playing");
  at(start + 3);
  assert.equal(await heard, "finished");
  assert.deepEqual(
    { ...transport.snapshot(), segment: 0 },
    {
      status: "paused",
      playing: false,
      presentedTick: sec(1),
      requestedTick: null,
      precision: "exact",
      segment: 0,
      segmentStart: sec(1),
      audition: null,
    },
  );
  // Entering and leaving each start a segment, and the project did not change.
  assert.equal(transport.snapshot().segment, before + 2);
  assert.equal(editor.getSnapshot().revision, revision);
  assert.equal(editor.getSnapshot().clips[0].activeTakeId, "a");
  assert.ok(states.some((s) => s.audition?.takeId === "b" && s.status === "playing"));
  // Playback resumes from the return position with the active take.
  await transport.play();
  at(anchorTime(context) + 1.5);
  assert.deepEqual(playing(), ["asset-a", "asset-m"]);
});

test("an isolated audition plays the clip alone, even on a muted track", async (t) => {
  const tracks = [
    { id: "voice", mute: true, gain: 0.5 },
    { id: "music", solo: true },
  ];
  const { context, transport, at, playing } = fixture(t, tracks);
  const heard = transport.audition({ clipId: "line", takeId: "a", mode: "isolated" });
  assert.deepEqual(playing(), ["asset-a"]);
  at(anchorTime(context) + 3);
  assert.equal(await heard, "finished");
  // Silence in the slot: the mix without the clip.
  const silent = transport.audition({ clipId: "line", takeId: null });
  assert.deepEqual(playing(), ["asset-m"]);
  transport.cancelAudition();
  assert.equal(await silent, "cancelled");
});

test("pause, play, seek, a newer audition and cancelAudition each end an audition", async (t) => {
  const { context, transport, at, playing } = fixture(t);
  await transport.seek(sec(7));
  assert.equal(transport.cancelAudition(), false);

  let heard = transport.audition({ clipId: "line", takeId: "b" });
  transport.pause();
  assert.equal(await heard, "cancelled");
  assert.equal(transport.snapshot().presentedTick, sec(7));
  assert.equal(transport.snapshot().status, "paused");
  assert.deepEqual(playing(), []);

  // A newer audition cancels the first and keeps its return position.
  heard = transport.audition({ clipId: "line", takeId: "b" });
  at(anchorTime(context) + 1);
  const next = transport.audition({ clipId: "line", takeId: "a", mode: "isolated" });
  assert.equal(await heard, "cancelled");
  assert.equal(transport.snapshot().audition?.returnTick, sec(7));
  assert.deepEqual(playing(), ["asset-a"]);
  assert.equal(transport.cancelAudition(), true);
  assert.equal(await next, "cancelled");
  assert.equal(transport.snapshot().presentedTick, sec(7));

  // A seek wins over the return position.
  heard = transport.audition({ clipId: "line", takeId: "b" });
  assert.equal(await transport.seek(sec(9)), "arrived");
  assert.equal(await heard, "cancelled");
  assert.equal(transport.snapshot().presentedTick, sec(9));
  assert.equal(transport.snapshot().status, "paused");

  // Play returns to the position, then plays the project from there.
  heard = transport.audition({ clipId: "line", takeId: "b" });
  assert.equal(await transport.play(), "playing");
  assert.equal(await heard, "cancelled");
  assert.equal(transport.snapshot().audition, null);
  at(anchorTime(context) + 0.5);
  assert.equal(transport.snapshot().presentedTick, sec(9.5));
  assert.deepEqual(playing(), ["asset-m"]);

  // An audition started during playback stops it; finishing leaves it paused.
  heard = transport.audition({ clipId: "line", takeId: "a" });
  assert.equal(transport.snapshot().audition?.returnTick, sec(9.5));
  at(anchorTime(context) + 3);
  assert.equal(await heard, "finished");
  assert.equal(transport.snapshot().status, "paused");
  assert.equal(transport.snapshot().presentedTick, sec(9.5));
});

test("edits end an audition only when the clip can no longer play it", async (t) => {
  const { editor, context, transport, at, playing } = fixture(t);
  await transport.seek(sec(1));
  let heard = transport.audition({ clipId: "line", takeId: "b" });
  // Applying the auditioned take, relabeling it or slipping the content keep it.
  assert.ok(editor.dispatch(commands.selectTake({ clipId: "line", takeId: "b" })).ok);
  assert.ok(editor.dispatch(commands.updateTake({ takeId: "b", label: "Keeper" })).ok);
  assert.ok(editor.dispatch(commands.reorderTakes({ clipId: "line", takeIds: ["b", "a"] })).ok);
  assert.ok(editor.dispatch(commands.selectTake({ clipId: "line", takeId: "a" })).ok);
  assert.equal(transport.snapshot().audition?.takeId, "b");
  assert.deepEqual(playing(), ["asset-b", "asset-m"]);
  // Unlisting the take ends it.
  assert.ok(editor.dispatch(commands.removeTake({ clipId: "line", takeId: "b" })).ok);
  assert.equal(await heard, "cancelled");
  assert.equal(transport.snapshot().presentedTick, sec(1));
  assert.deepEqual(playing(), []);
  assert.ok(editor.history.undo().ok);

  // So does a move of either edge.
  for (const edit of [
    commands.moveClips({ clipIds: ["line"], delta: hz }),
    commands.trimClip({ clipId: "line", edge: "left", delta: hz }),
    commands.splitClip({ clipId: "line", at: sec(4), rightId: "right" }),
  ]) {
    heard = transport.audition({ clipId: "line", takeId: "b" });
    at(anchorTime(context) + 0.5);
    assert.ok(editor.dispatch(edit).ok);
    assert.equal(await heard, "cancelled");
    assert.equal(transport.snapshot().presentedTick, sec(1));
    assert.ok(editor.history.undo().ok);
  }
  // And the removal of the clip, here by undoing the split that made it.
  assert.ok(editor.history.redo().ok);
  heard = transport.audition({ clipId: "right", takeId: "b" });
  assert.deepEqual(transport.snapshot().audition?.range, { start: sec(4), end: sec(5) });
  assert.ok(editor.history.undo().ok);
  assert.equal(await heard, "cancelled");
  assert.equal(transport.snapshot().audition, null);
});

test("invalid requests reject without stopping playback, and disposal rejects an audition", async (t) => {
  const { editor, transport, playing } = fixture(t);
  await transport.play();
  await assert.rejects(transport.audition({ clipId: "ghost", takeId: "a" }), {
    code: "missing-clip",
  });
  await assert.rejects(transport.audition({ clipId: "line", takeId: "m" }), {
    code: "missing-take",
  });
  await assert.rejects(
    // @ts-expect-error -- The mode is mix or isolated.
    transport.audition({ clipId: "line", takeId: "a", mode: "solo" }),
    TypeError,
  );
  assert.equal(transport.snapshot().status, "playing");
  assert.deepEqual(playing(), ["asset-m"]);
  const heard = transport.audition({ clipId: "line", takeId: "a" });
  transport.dispose();
  await assert.rejects(heard, /disposed/);
  assert.equal(transport.snapshot().audition, null);
  await assert.rejects(transport.audition({ clipId: "line", takeId: "a" }), /unavailable/);
  editor.dispose();
});

test("an audition waits for the context, and an interruption cancels it", async (t) => {
  const context = new FakeContext(rate, "suspended");
  let resume: (() => void) | undefined;
  context.resume = () =>
    new Promise((resolve) => {
      resume = () => {
        context.setState("running");
        resolve();
      };
    });
  const { transport, at, playing } = fixture(t, undefined, context);
  const heard = transport.audition({ clipId: "line", takeId: "b" });
  assert.equal(transport.snapshot().status, "starting");
  assert.deepEqual(playing(), []);
  assert.ok(resume);
  resume();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(playing(), ["asset-b", "asset-m"]);
  at(anchorTime(context) + 1);
  context.setState("suspended");
  assert.equal(await heard, "cancelled");
  assert.equal(transport.snapshot().status, "paused");
  assert.equal(transport.snapshot().presentedTick, 0);

  // A denied resume rejects the audition and returns.
  context.resume = () => Promise.reject(new Error("Not allowed"));
  await assert.rejects(transport.audition({ clipId: "line", takeId: "a" }), /Not allowed/);
  assert.equal(transport.snapshot().audition, null);
  assert.equal(transport.snapshot().presentedTick, 0);
});

function videoFixture(t: TestContext): {
  editor: Editor;
  video: FakeVideo;
  context: FakeContext;
  player: ReturnType<typeof createVideoTransport>;
} {
  const editor = createEditor({ project: project() });
  const context = new FakeContext(rate);
  const video = new FakeVideo();
  const player = createVideoTransport({
    editor,
    context,
    video,
    catalog,
    resolveBuffer: (span) => {
      const buffer = buffers.get(span.assetId);
      assert.ok(buffer);
      return buffer;
    },
  });
  t.after(() => {
    player.dispose();
    editor.dispose();
  });
  return { editor, video, context, player };
}
/** Presents a frame. The first callback after a clock reset belongs to the old generation. */
function frame(video: FakeVideo, seconds: number): void {
  video.present(seconds);
  video.present(seconds);
}
/** Lets the element finish the seek the transport started. */
async function land(video: FakeVideo): Promise<void> {
  await Promise.resolve();
  video.seeked();
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

test("a video audition seeks to the clip, plays it and seeks back at its end", async (t) => {
  const { video, player } = videoFixture(t);
  assert.equal(player.snapshot().presentedTick, hz);
  const heard = player.audition({ clipId: "line", takeId: "b", mode: "isolated" });
  assert.equal(player.snapshot().audition?.returnTick, hz);
  assert.equal(player.snapshot().requestedTick, sec(2));
  assert.equal(video.currentTime, 2);
  assert.equal(video.pauses, 1);
  await land(video);
  assert.equal(video.starts, 1);
  frame(video, 3);
  assert.equal(player.snapshot().presentedTick, sec(3));
  // The frame at the clip's end finishes the audition and seeks back.
  frame(video, 5);
  assert.equal(player.snapshot().audition, null);
  assert.equal(video.currentTime, 1);
  await land(video);
  assert.equal(await heard, "finished");
  assert.equal(player.snapshot().presentedTick, hz);
  assert.equal(video.pauses, 2);

  // Pause cancels and returns; a seek cancels for its own target.
  const paused = player.audition({ clipId: "line", takeId: "a" });
  await land(video);
  player.pause();
  await land(video);
  assert.equal(await paused, "cancelled");
  assert.equal(video.currentTime, 1);
  const sought = player.audition({ clipId: "line", takeId: "a" });
  await land(video);
  const seek = player.seek(sec(8));
  await land(video);
  assert.equal(await seek, "arrived");
  assert.equal(await sought, "cancelled");
  assert.equal(player.snapshot().presentedTick, sec(8));
  await assert.rejects(player.audition({ clipId: "line", takeId: "m" }), {
    code: "missing-take",
  });
});
