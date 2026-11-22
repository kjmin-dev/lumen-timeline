import assert from "node:assert/strict";
import test from "node:test";
import {
  commands,
  createEditor,
  sequenceDuration,
  TICKS_PER_SECOND as hz,
  watchMarkerCrossings,
} from "@lumen-timeline/core";
import type { Clip, Marker, PresentationSource, TakeCatalog } from "@lumen-timeline/core";
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
/** The output time a play or playing seek anchors to: one render quantum ahead. */
function anchorTime(context: FakeContext): number {
  return (Math.ceil(context.currentTime * context.sampleRate) + 128) / context.sampleRate;
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

test("a segment changes only when presentation moves without playing", async (t) => {
  timers(t);
  const { transport, context, editor, at } = fixture(t);
  const segment = () => {
    const s = transport.snapshot();
    return [s.segment, s.segmentStart];
  };
  assert.deepEqual(segment(), [0, 0]);
  await transport.seek(sec(1));
  assert.deepEqual(segment(), [1, sec(1)]);
  await transport.play();
  const origin = context.nodes[0].when;
  at(origin + 0.5);
  assert.equal(transport.snapshot().presentedTick, sec(1.5));
  transport.pause();
  assert.deepEqual(segment(), [1, sec(1)]);
  await transport.play();
  at(origin + 1);
  // A playing seek is reported in the old segment until presentation lands.
  const seek = transport.seek(sec(5));
  assert.deepEqual(segment(), [1, sec(1)]);
  const anchor = anchorTime(context);
  await Promise.resolve();
  at(anchor + 0.25, anchor + 0.25);
  assert.equal(await seek, "arrived");
  assert.equal(transport.snapshot().presentedTick, sec(5.25));
  assert.deepEqual(segment(), [2, sec(5)]);
  // Playback reaches the end in the same segment; replay starts a new one.
  at(anchor + 4, anchor + 4);
  assert.equal(transport.snapshot().status, "ended");
  assert.deepEqual(segment(), [2, sec(5)]);
  await transport.play();
  assert.deepEqual(segment(), [3, 0]);
  // A context interruption freezes playback; recovery continues the segment.
  at(origin + 9.5, origin + 9.5);
  context.setState("suspended");
  context.setState("running");
  assert.deepEqual(segment(), [3, 0]);
  // Shortening the sequence behind a paused position clamps it into a new segment.
  transport.pause();
  await transport.seek(sec(7));
  assert.deepEqual(segment(), [4, sec(7)]);
  // Ending exactly at the position is not a move.
  assert.ok(editor.dispatch(commands.trimClip({ clipId: "music", edge: "right", delta: -hz })).ok);
  assert.ok(
    editor.dispatch(commands.trimClip({ clipId: "dialogue", edge: "right", delta: -hz })).ok,
  );
  assert.deepEqual(segment(), [4, sec(7)]);
  assert.ok(editor.dispatch(commands.trimClip({ clipId: "music", edge: "right", delta: -hz })).ok);
  assert.deepEqual(segment(), [5, sec(6)]);
  assert.equal(transport.snapshot().presentedTick, sec(6));
});

test("pausing a seek the output already reached starts its segment at the target", async (t) => {
  timers(t);
  const { transport, context, at } = fixture(t);
  await transport.play();
  at(1);
  const seek = transport.seek(sec(2.5));
  const anchor = anchorTime(context);
  await Promise.resolve();
  // The device reaches the anchor before any wake-up observes it.
  context.currentTime = 1.5;
  context.outputTime = anchor + 0.1;
  transport.pause();
  assert.equal(await seek, "superseded");
  const s = transport.snapshot();
  assert.deepEqual([s.segmentStart, s.presentedTick], [sec(2.5), sec(2.6)]);
});

test("marker crossings follow audio playback, skip a seek and include a marker at the end", async (t) => {
  timers(t);
  const { transport, editor, context, at } = fixture(t, {
    markers: [
      { id: "intro", start: sec(1) },
      { id: "skipped", start: sec(3) },
      { id: "chorus", start: sec(6) },
      { id: "end", start: sec(8) },
    ],
  });
  const source: PresentationSource = transport;
  const crossed: [string, number, number][] = [];
  const stop = watchMarkerCrossings(editor, source, ({ markers, after, through }) => {
    for (const m of markers) crossed.push([m.id, after, through]);
  });
  await transport.play();
  const origin = 128 / context.sampleRate;
  at(origin + 0.5);
  at(origin + 1.25);
  assert.deepEqual(crossed, [["intro", sec(0.5), sec(1.25)]]);
  // The seek lands on its target and is first observed a quarter second later.
  const seek = transport.seek(sec(5.9));
  const anchor = anchorTime(context);
  await Promise.resolve();
  at(anchor + 0.25, anchor + 0.25);
  assert.equal(await seek, "arrived");
  assert.deepEqual(crossed.at(-1), ["chorus", sec(5.9), sec(6.15)]);
  at(anchor + 3, anchor + 3);
  assert.equal(transport.snapshot().status, "ended");
  assert.deepEqual(
    crossed.map(([id]) => id),
    ["intro", "chorus", "end"],
  );
  assert.deepEqual(crossed.at(-1), ["end", sec(6.15), sec(8)]);
  assert.equal(stop(), true);
});

test("seeks that are abandoned, clamped, frozen or overtaken start their own segments", async (t) => {
  timers(t);
  // Disposal rejects the seeks left pending here.
  const settled = (): void => {};
  const of = (s: { segment: number; segmentStart: number; presentedTick: number }) => [
    s.segment,
    s.segmentStart,
    s.presentedTick,
  ];
  {
    // A seek target beyond a shortened sequence is abandoned at the new end.
    const { transport, editor, at } = fixture(t, { clips: [clip("music", 0, 8)] });
    await transport.play();
    at(1);
    void transport.seek(sec(7)).catch(settled);
    await Promise.resolve();
    assert.ok(
      editor.dispatch(commands.trimClip({ clipId: "music", edge: "right", delta: sec(-3) })).ok,
    );
    assert.deepEqual(of(transport.snapshot()), [1, sec(5), sec(5)]);
  }
  {
    // A backward seek still draining a shortened sequence clamps its shown position.
    const { transport, editor, context, at } = fixture(t, { clips: [clip("music", 0, 8)] });
    await transport.play();
    const origin = context.nodes[0].when;
    at(origin + 7);
    void transport.seek(sec(2)).catch(settled);
    await Promise.resolve();
    assert.ok(
      editor.dispatch(commands.trimClip({ clipId: "music", edge: "right", delta: -hz })).ok,
    );
    // Ending exactly at the shown position leaves it alone.
    assert.equal(transport.snapshot().status, "seeking");
    assert.deepEqual(of(transport.snapshot()), [0, 0, sec(7)]);
    assert.ok(
      editor.dispatch(commands.trimClip({ clipId: "music", edge: "right", delta: -hz })).ok,
    );
    assert.deepEqual(of(transport.snapshot()), [1, sec(6), sec(6)]);
  }
  {
    // An interruption freezes a pending seek at its target.
    const { transport, context, at } = fixture(t);
    await transport.play();
    at(1);
    void transport.seek(sec(4)).catch(settled);
    await Promise.resolve();
    context.setState("suspended");
    assert.deepEqual(of(transport.snapshot()), [1, sec(4), sec(4)]);
  }
  {
    // A seek that reached the output before the next one keeps its segment.
    const { transport, context, at } = fixture(t);
    await transport.play();
    at(1);
    void transport.seek(sec(3)).catch(settled);
    const anchor = anchorTime(context);
    await Promise.resolve();
    context.currentTime = context.outputTime = anchor + 0.2;
    void transport.seek(sec(6)).catch(settled);
    assert.deepEqual(of(transport.snapshot()), [1, sec(3), sec(3.2)]);
  }
  {
    // So does one that reached the output before the context closed.
    const { transport, context, at } = fixture(t);
    await transport.play();
    at(1);
    void transport.seek(sec(3)).catch(settled);
    const anchor = anchorTime(context);
    await Promise.resolve();
    context.currentTime = context.outputTime = anchor + 0.2;
    context.setState("closed");
    assert.equal(transport.snapshot().status, "closed");
    assert.deepEqual(of(transport.snapshot()), [1, sec(3), sec(3.2)]);
  }
  {
    // A paused seek to the current position still starts a segment.
    const { transport } = fixture(t);
    await transport.seek(0);
    assert.deepEqual(of(transport.snapshot()), [1, 0, 0]);
  }
});

test("playback that reaches a shortened end keeps its segment and crosses markers before it", async (t) => {
  timers(t);
  const { transport, editor, context, at } = fixture(t, {
    clips: [clip("music", 0, 8)],
    markers: [{ id: "late", start: sec(4.2) }],
  });
  const crossed: string[] = [];
  watchMarkerCrossings(editor, transport, ({ markers }) =>
    crossed.push(...markers.map((m) => m.id)),
  );
  await transport.play();
  const origin = context.nodes[0].when;
  at(origin + 4);
  // The clock moves on before any wake-up observes it, then the sequence shrinks.
  context.currentTime = context.outputTime = origin + 4.8;
  assert.ok(
    editor.dispatch(commands.trimClip({ clipId: "music", edge: "right", delta: sec(-3.5) })).ok,
  );
  assert.equal(transport.snapshot().status, "ended");
  assert.deepEqual(
    [transport.snapshot().segment, transport.snapshot().presentedTick],
    [0, sec(4.5)],
  );
  assert.deepEqual(crossed, ["late"]);
});

test("playback follows project takes through select, alignment updates and undo", async (t) => {
  timers(t);
  const context = clock(48000);
  const rate = context.sampleRate;
  const editor = createEditor({
    project: {
      schemaVersion: 1,
      tracks: [{ id: "voice" }],
      clips: [
        {
          id: "line",
          trackId: "voice",
          kind: "audio",
          start: 0,
          duration: sec(6),
          contentIn: sec(1),
          takeIds: ["a", "b"],
          activeTakeId: "a",
        },
      ],
      takes: [
        { id: "a", assetId: "take-a", streamId: "mono", sourceAtContentZero: 0 },
        { id: "b", assetId: "take-b", streamId: "mono", sourceAtContentZero: -sec(1) },
      ],
    },
  });
  const stream = { assetVersion: 1, sampleRate: rate, availableStart: 0, availableEnd: 10 * rate };
  const buffers = new Map(
    ["take-a", "take-b"].map((id) => [id, { sampleRate: rate, length: 10 * rate }]),
  );
  const transport = createAudioTransport({
    editor,
    context,
    output: sink,
    catalog: { version: 1, streams: { "take-a": { mono: stream }, "take-b": { mono: stream } } },
    resolveBuffer: (span) => {
      const buffer = buffers.get(span.assetId);
      assert.ok(buffer);
      return buffer;
    },
  });
  t.after(() => {
    transport.dispose();
    editor.dispose();
  });
  const playing = () => {
    const node = last(context.nodes);
    return { buffer: node.buffer, offset: Math.round(node.offset * rate) };
  };
  await transport.play();
  const first = playing();
  assert.equal(first.buffer, buffers.get("take-a"));
  // Content time 1 s at take A's origin 0 plays source second 1.
  assert.equal(first.offset, rate);
  assert.ok(editor.dispatch(commands.selectTake({ clipId: "line", takeId: "b" })).ok);
  assert.deepEqual(playing(), { buffer: buffers.get("take-b"), offset: 0 });
  assert.ok(editor.dispatch(commands.updateTake({ takeId: "b", sourceAtContentZero: 0 })).ok);
  assert.deepEqual(playing(), { buffer: buffers.get("take-b"), offset: rate });
  assert.ok(editor.history.undo().ok);
  assert.deepEqual(playing(), { buffer: buffers.get("take-b"), offset: 0 });
  assert.ok(editor.history.undo().ok);
  assert.deepEqual(playing(), first);
  // A label is not media: the scheduled voice stays.
  const node = last(context.nodes);
  assert.ok(editor.dispatch(commands.updateTake({ takeId: "a", label: "Keeper" })).ok);
  assert.equal(last(context.nodes), node);
});
