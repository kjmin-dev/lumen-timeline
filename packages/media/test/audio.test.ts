import assert from "node:assert/strict";
import test from "node:test";
import {
  commands,
  createEditor,
  sequenceDuration,
  TICKS_PER_SECOND as hz,
} from "@lumen-timeline/core";
import type { Clip, Marker, TakeCatalog } from "@lumen-timeline/core";
import { createAudioTransport } from "@lumen-timeline/media";
import type { AudioBufferLike, ResolveBuffer } from "@lumen-timeline/media";
import type { TestContext } from "node:test";
import { FakeContext, sink } from "./fakes.ts";

const sec = (n: number): number => Math.round(n * hz);
const clip = (id: string, start: number, duration: number, contentIn = 0): Clip => ({
  id,
  trackId: id,
  activeTakeId: id,
  kind: "audio",
  start: sec(start),
  duration: sec(duration),
  contentIn: sec(contentIn),
});
const clock = (rate: number, state: AudioContextState = "running"): FakeContext =>
  new FakeContext(rate, state);
interface FixtureOptions {
  readonly context?: FakeContext;
  readonly clips?: Clip[];
  readonly duration?: number;
  readonly markers?: Marker[];
  readonly resolveBuffer?: ResolveBuffer;
}
function fixture(t: TestContext, options: FixtureOptions = {}) {
  const context = options.context ?? clock(48000);
  const clips = options.clips ?? [clip("music", 0, 8), clip("dialogue", 2, 4, 1)];
  const editor = createEditor({
    project: {
      schemaVersion: 1,
      tracks: clips.map((c) => ({ id: c.id })),
      clips,
      ...(options.duration === undefined ? {} : { duration: sec(options.duration) }),
      ...(options.markers === undefined ? {} : { markers: options.markers }),
    },
  });
  const rate = context.sampleRate;
  const catalog: TakeCatalog = {
    version: 1,
    takes: Object.fromEntries(
      clips.map((c) => [
        c.id,
        {
          assetId: c.id,
          assetVersion: 1,
          streamId: "mono",
          sampleRate: rate,
          sourceAtContentZero: 0,
          availableStart: 0,
          availableEnd: rate * 10,
        },
      ]),
    ),
  };
  const transport = createAudioTransport({
    editor,
    context,
    output: sink,
    catalog,
    resolveBuffer: options.resolveBuffer ?? (() => ({ sampleRate: rate, length: 10 * rate })),
  });
  t.after(() => {
    transport.dispose();
    editor.dispose();
  });
  return {
    editor,
    context,
    transport,
    at: (renderTime: number, outputTime = renderTime) => {
      context.currentTime = renderTime;
      context.outputTime = outputTime;
      t.mock.timers.tick(25);
    },
  };
}
function timers(t: TestContext): void {
  t.mock.timers.enable({ apis: ["setInterval"] });
}
/** The most recently created item, which the test expects to exist. */
function last<T>(items: readonly T[]): T {
  const item = items.at(-1);
  assert.ok(item !== undefined, "Expected at least one item");
  return item;
}

test("overlapping voices keep native offsets and the music reservation across move, undo and redo", async (t) => {
  timers(t);
  for (const rate of [44100, 48000]) {
    const { transport, context, editor, at } = fixture(t, { context: clock(rate) });
    await transport.seek(sec(3.25));
    assert.equal(context.nodes.length, 0);
    await transport.play();
    const first = context.nodes[0].when;
    at(first);
    const bed = transport.diagnostics("music");
    const offset = () => Math.round(last(context.nodes).offset * rate);
    assert.equal(Math.round(context.nodes[0].offset * rate), 3.25 * rate);
    assert.equal(offset(), 2.25 * rate);
    assert.ok(editor.dispatch(commands.moveClips({ clipIds: ["dialogue"], delta: hz })).ok);
    assert.equal(offset(), 1.25 * rate);
    assert.ok(editor.history.undo().ok);
    assert.equal(offset(), 2.25 * rate);
    assert.ok(editor.history.redo().ok);
    assert.equal(offset(), 1.25 * rate);
    assert.deepEqual(transport.diagnostics("music"), bed);
  }
});

test("presentation uses output time, freezes on pause and labels an estimated fallback", async (t) => {
  timers(t);
  const { transport, context, at } = fixture(t);
  await transport.play();
  const origin = context.nodes[0].when;
  at(origin + 1, origin + 0.8);
  assert.equal(transport.snapshot().presentedTick, sec(0.8));
  assert.equal(transport.snapshot().precision, "output");
  context.getOutputTimestamp = undefined;
  at(origin + 1.25);
  assert.equal(transport.snapshot().presentedTick, sec(1.25));
  assert.equal(transport.snapshot().precision, "estimated");
  transport.pause();
  at(origin + 4);
  assert.equal(transport.snapshot().presentedTick, sec(1.25));
  assert.equal(context.state, "running");
});

test("a paused seek, pause or disposal supersedes a pending resume immediately", async (t) => {
  timers(t);
  for (const action of ["seek", "pause", "dispose"] as const) {
    const context = clock(48000, "suspended");
    let resume: (() => void) | undefined;
    context.resume = () =>
      new Promise((yes) => {
        resume = yes;
      });
    const { transport } = fixture(t, { context });
    const start = transport.play();
    assert.equal(transport.snapshot().status, "starting");
    if (action === "seek") await transport.seek(sec(2));
    else transport[action]();
    if (action === "dispose") await assert.rejects(start, /disposed/);
    else assert.equal(await start, "superseded");
    context.setState("running");
    assert.ok(resume);
    resume();
    await Promise.resolve();
    assert.equal(context.nodes.length, 0);
    if (action === "seek") assert.equal(transport.snapshot().presentedTick, sec(2));
  }
});

test("rapid playing seeks acknowledge only the newest audible mapping", async (t) => {
  timers(t);
  const { context, transport, at } = fixture(t);
  await transport.play();
  at(1);
  const requests = Array.from({ length: 100 }, (_, i) =>
    transport.seek(i === 99 ? sec(3.25) : sec(i % 6)),
  );
  assert.equal(transport.snapshot().requestedTick, sec(3.25));
  await Promise.resolve();
  assert.equal(context.nodes.length, 3); // original music plus two final voices
  at(1.1, 1);
  assert.equal(transport.snapshot().status, "seeking");
  const boundary = last(context.nodes).when;
  at(1.1, boundary);
  const results = await Promise.all(requests);
  assert.equal(results.filter((x) => x === "superseded").length, 99);
  assert.equal(results.at(-1), "arrived");
  assert.equal(transport.snapshot().presentedTick, sec(3.25));
  assert.equal(transport.snapshot().requestedTick, null);
});

test("interruption recovers only the latest play intent and keeps a borrowed context alive", async (t) => {
  timers(t);
  const context = clock(48000);
  const a = fixture(t, { context }),
    b = fixture(t, { context });
  await a.transport.play();
  await b.transport.play();
  a.at(1);
  const music = b.transport.diagnostics("music");
  a.transport.pause();
  assert.deepEqual(b.transport.diagnostics("music"), music);
  context.setState("suspended");
  assert.equal(b.transport.snapshot().status, "interrupted");
  const tick = b.transport.snapshot().presentedTick;
  b.at(3);
  assert.equal(b.transport.snapshot().presentedTick, tick);
  context.setState("running");
  assert.equal(b.transport.snapshot().status, "playing");
  assert.equal(a.transport.snapshot().status, "paused");
  context.setState("suspended");
  b.transport.pause();
  context.setState("running");
  assert.equal(b.transport.snapshot().status, "paused");
  await b.transport.play();
  const current = b.transport.diagnostics("music");
  a.transport.dispose();
  assert.equal(context.state, "running");
  assert.deepEqual(b.transport.diagnostics("music"), current);
});

test("gaps advance, natural end fires once and replay starts at zero", async (t) => {
  timers(t);
  const { transport, context, at } = fixture(t, { clips: [clip("line", 2, 1)], duration: 4 });
  const ended: number[] = [];
  transport.subscribe((s) => {
    if (s.status === "ended") ended.push(s.presentedTick);
  });
  await transport.play();
  assert.equal(context.nodes.length, 0);
  const origin = 128 / context.sampleRate;
  at(origin + 1);
  assert.equal(transport.snapshot().presentedTick, hz);
  at(origin + 1.95);
  assert.equal(context.nodes.length, 1);
  at(origin + 4);
  at(origin + 5);
  assert.deepEqual(ended, [sec(4)]);
  await transport.play();
  assert.equal(transport.snapshot().presentedTick, 0);
  assert.equal(transport.snapshot().playing, true);
});

test("extent follows clip edits and undo; a shortened sequence clamps and an empty one stays stopped", async (t) => {
  timers(t);
  const { editor, transport, at } = fixture(t, { clips: [clip("line", 2, 4)] });
  await transport.play();
  at(5);
  assert.ok(
    editor.dispatch(commands.trimClip({ clipId: "line", edge: "right", delta: sec(-2) })).ok,
  );
  assert.equal(sequenceDuration(editor.getSnapshot()), sec(4));
  assert.equal(transport.snapshot().presentedTick, sec(4));
  assert.equal(transport.snapshot().status, "ended");
  editor.history.undo();
  assert.equal(sequenceDuration(editor.getSnapshot()), sec(6));
  await transport.seek(sec(5));
  assert.equal(transport.snapshot().presentedTick, sec(5));
  const empty = fixture(t, { clips: [] });
  assert.equal(await empty.transport.play(), "empty");
  assert.equal(empty.transport.snapshot().presentedTick, 0);
  assert.equal(empty.transport.snapshot().playing, false);
});

test("disposed transport discards deferred buffers and settles pending seek", async (t) => {
  timers(t);
  let complete: ((buffer: AudioBufferLike) => void) | undefined;
  let signal: AbortSignal | undefined;
  const { transport, context } = fixture(t, {
    clips: [clip("music", 0, 8)],
    resolveBuffer: (_, s) => {
      signal = s;
      return new Promise<AudioBufferLike>((yes) => {
        complete = yes;
      });
    },
  });
  await transport.play();
  const seeking = transport.seek(sec(1));
  await Promise.resolve();
  transport.dispose();
  await assert.rejects(seeking, /disposed/);
  assert.ok(signal?.aborted);
  assert.ok(complete);
  complete({ sampleRate: 48000, length: 480000 });
  await Promise.resolve();
  assert.equal(context.nodes.length, 0);
});

test("pausing a forward seek before device arrival freezes the last presented position", async (t) => {
  timers(t);
  const { transport, at } = fixture(t);
  await transport.play();
  at(1, 0.8);
  const displayed = transport.snapshot().presentedTick;
  const seek = transport.seek(sec(6));
  await Promise.resolve();
  transport.pause();
  assert.equal(await seek, "superseded");
  assert.equal(transport.snapshot().presentedTick, displayed);
  assert.equal(transport.snapshot().requestedTick, null);
});

test("a late superseded buffer never starts, even when its replacement is already scheduled", async (t) => {
  timers(t);
  const loads: { resolve: (buffer: AudioBufferLike) => void; signal: AbortSignal }[] = [];
  const { transport, context, at } = fixture(t, {
    clips: [clip("music", 0, 8)],
    resolveBuffer: (_, signal) =>
      new Promise<AudioBufferLike>((resolve) => {
        loads.push({ resolve, signal });
      }),
  });
  await transport.play();
  at(1);
  const seek = transport.seek(sec(3));
  await Promise.resolve();
  assert.ok(loads[0].signal.aborted);
  at(1 + 128 / context.sampleRate);
  assert.equal(await seek, "arrived");
  loads[1].resolve({ sampleRate: 48000, length: 480000 });
  await Promise.resolve();
  loads[0].resolve({ sampleRate: 48000, length: 480000 });
  await Promise.resolve();
  assert.equal(context.nodes.length, 1);
  assert.equal(context.nodes[0].offset, 3);
});

test("a denied resume surfaces its reason and a later user gesture can retry", async (t) => {
  timers(t);
  const context = clock(48000, "suspended");
  const { transport } = fixture(t, { context });
  context.resume = async () => {
    throw new Error("resume denied");
  };
  await assert.rejects(transport.play(), /resume denied/);
  assert.equal(transport.snapshot().status, "paused");
  context.resume = async () => context.setState("running");
  await transport.play();
  assert.equal(transport.snapshot().playing, true);
  context.setState("closed");
  assert.equal(transport.snapshot().status, "closed");
  await assert.rejects(transport.seek(0), /unavailable/);
});

test("a marker after the last clip extends playback through silence to its tick", async (t) => {
  timers(t);
  const { transport, context, at } = fixture(t, {
    clips: [clip("line", 2, 1)],
    markers: [{ id: "chapter", start: sec(5) }],
  });
  const ended: number[] = [];
  transport.subscribe((s) => {
    if (s.status === "ended") ended.push(s.presentedTick);
  });
  await transport.play();
  const origin = 128 / context.sampleRate;
  at(origin + 4);
  assert.equal(transport.snapshot().status, "playing");
  assert.equal(transport.snapshot().presentedTick, sec(4));
  at(origin + 6);
  assert.deepEqual(ended, [sec(5)]);
  assert.equal(transport.snapshot().presentedTick, sec(5));
});
