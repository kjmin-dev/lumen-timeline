import test from "node:test";
import assert from "node:assert/strict";
import {
  EditError,
  MAX_CLIP_RATE,
  MIN_CLIP_RATE,
  TICKS_PER_SECOND as hz,
  clipFieldChanges,
  commands,
  contentAt,
  contentEnd,
  createEditor,
  sourceWindow,
} from "@lumen-timeline/core";
import type {
  Clip,
  EditCommand,
  EditErrorCode,
  Editor,
  Project,
  StreamCatalog,
} from "@lumen-timeline/core";
import { codeOf, commit, pass } from "./support.ts";

// A four-second line at 2 s that plays one second into its take.
const line: Clip = {
  id: "line",
  trackId: "voice",
  kind: "audio",
  start: 2 * hz,
  duration: 4 * hz,
  contentIn: hz,
  takeIds: ["A"],
  activeTakeId: "A",
};
const project = (clips: readonly Clip[] = [line], locked = false): Project => ({
  schemaVersion: 1,
  tracks: [{ id: "voice", ...(locked ? { locked: true } : {}) }],
  clips,
  takes: [{ id: "A", assetId: "a", streamId: "mono", sourceAtContentZero: 0 }],
});
const open = (clips?: readonly Clip[], locked?: boolean): Editor =>
  createEditor({ project: project(clips, locked) });
const clipOf = (editor: Editor, id = "line"): Clip => {
  const found = editor.getSnapshot().clips.find((clip) => clip.id === id);
  assert.ok(found, "missing clip " + id);
  return found;
};
const catalog = (availableEnd = 20 * 48000): StreamCatalog => ({
  version: 1,
  streams: { a: { mono: { assetVersion: 1, sampleRate: 48000, availableStart: 0, availableEnd } } },
});

test("a rate retime keeps the clip's content and moves only the unanchored edge", () => {
  const e = open();
  commit(e.dispatch(commands.retimeClip({ clipId: "line", rate: 1.25 })));
  const faster = clipOf(e);
  assert.equal(faster.start, 2 * hz);
  assert.equal(faster.duration, 3.2 * hz);
  assert.equal(faster.contentIn, hz);
  assert.equal(faster.rate, 1.25);
  assert.equal(contentEnd(faster), 5 * hz);

  commit(e.dispatch(commands.retimeClip({ clipId: "line", rate: 0.8, anchor: "end" })));
  const slower = clipOf(e);
  // The end stays at 5.2 s; four seconds of content now take five.
  assert.equal(slower.start + slower.duration, 5.2 * hz);
  assert.equal(slower.duration, 5 * hz);
  assert.equal(slower.contentIn, hz);
  assert.equal(contentEnd(slower), 5 * hz);

  commit(e.dispatch(commands.retimeClip({ clipId: "line", rate: 1 })));
  const normal = clipOf(e);
  assert.equal(Object.hasOwn(normal, "rate"), false, "a rate of 1 is omitted");
  assert.equal(normal.duration, 4 * hz);
  assert.equal(contentEnd(normal), 5 * hz);

  const same = pass(e.dispatch(commands.retimeClip({ clipId: "line", rate: 1 })));
  assert.equal(same.unchanged, true);
});

test("a duration retime sets the rate that keeps the content", () => {
  const e = open();
  commit(e.dispatch(commands.retimeClip({ clipId: "line", duration: 3 * hz })));
  const clip = clipOf(e);
  assert.equal(clip.duration, 3 * hz);
  assert.equal(clip.rate, 4 / 3);
  assert.equal(contentEnd(clip), 5 * hz);

  commit(e.dispatch(commands.retimeClip({ clipId: "line", duration: 4 * hz, anchor: "end" })));
  const back = clipOf(e);
  assert.equal(Object.hasOwn(back, "rate"), false, "returning to the content length restores 1");
  assert.equal(back.start, hz);
  assert.equal(back.duration, 4 * hz);

  const unchanged = pass(e.dispatch(commands.retimeClip({ clipId: "line", duration: 4 * hz })));
  assert.equal(unchanged.unchanged, true);
});

test("retimes outside the rate range, the sequence or the command's shape are rejected", () => {
  const e = open();
  const code = (command: Parameters<typeof commands.retimeClip>[0]) =>
    codeOf(e.dispatch(commands.retimeClip(command)));
  assert.equal(code({ clipId: "line", rate: MAX_CLIP_RATE * 1.01 }), "invalid-rate");
  assert.equal(code({ clipId: "line", rate: MIN_CLIP_RATE * 0.99 }), "invalid-rate");
  assert.equal(code({ clipId: "line", rate: 0 }), "invalid-rate");
  assert.equal(code({ clipId: "line", rate: Number.NaN }), "invalid-rate");
  // Four seconds of content in half a second would be rate 8.
  assert.equal(code({ clipId: "line", duration: 0.5 * hz }), "invalid-rate");
  assert.equal(code({ clipId: "line", duration: 1.5 }), "invalid-range");
  assert.equal(code({ clipId: "line", duration: 0 }), "invalid-range");
  // Five seconds anchored at the end would start before zero.
  assert.equal(code({ clipId: "line", duration: 7 * hz, anchor: "end" }), "invalid-range");
  const malformed: [EditCommand, EditErrorCode][] = [
    // @ts-expect-error -- Both a rate and a duration are a type error and a runtime rejection.
    [{ type: "retime", clipId: "line", rate: 2, duration: 2 * hz }, "invalid-rate"],
    // @ts-expect-error -- Neither is too.
    [{ type: "retime", clipId: "line" }, "invalid-rate"],
    // @ts-expect-error -- So is an unknown anchor.
    [{ type: "retime", clipId: "line", rate: 2, anchor: "middle" }, "invalid-edge"],
  ];
  for (const [command, expected] of malformed) assert.equal(codeOf(e.dispatch(command)), expected);
  assert.equal(code({ clipId: "nope", rate: 2 }), "missing-clip");
  assert.equal(
    codeOf(open([line], true).dispatch(commands.retimeClip({ clipId: "line", rate: 2 }))),
    "locked-track",
  );
  assert.deepEqual(e.getSnapshot().clips, [line]);
});

test("trims of a retimed clip move content by the clip's rate", () => {
  const e = open([{ ...line, contentBounds: { start: 0, end: 6 * hz } }]);
  commit(e.dispatch(commands.retimeClip({ clipId: "line", rate: 2 })));
  assert.equal(clipOf(e).duration, 2 * hz);

  commit(e.dispatch(commands.trimClip({ clipId: "line", edge: "left", delta: 0.5 * hz })));
  let clip = clipOf(e);
  assert.deepEqual(
    [clip.start, clip.duration, clip.contentIn, contentEnd(clip)],
    [2.5 * hz, 1.5 * hz, 2 * hz, 5 * hz],
  );
  commit(e.dispatch(commands.trimClip({ clipId: "line", edge: "right", delta: -0.5 * hz })));
  clip = clipOf(e);
  assert.deepEqual([clip.duration, contentEnd(clip)], [hz, 4 * hz]);

  // One more timeline second is two of content: past the six-second handle.
  assert.equal(
    codeOf(e.dispatch(commands.trimClip({ clipId: "line", edge: "right", delta: 1.5 * hz }))),
    "source-bounds",
  );
  commit(e.dispatch(commands.trimClip({ clipId: "line", edge: "right", delta: hz })));
  assert.equal(contentEnd(clipOf(e)), 6 * hz);
});

test("a split of a retimed clip cuts at content, and both halves keep the rate", () => {
  const e = open();
  commit(e.dispatch(commands.retimeClip({ clipId: "line", rate: 2 })));
  const cut = commit(
    e.dispatch(commands.splitClip({ clipId: "line", at: 3 * hz, rightId: "right" })),
  );
  assert.deepEqual(cut.commands, [
    { type: "split", clipId: "line", atContent: 3 * hz, rightId: "right" },
  ]);
  const left = clipOf(e);
  const right = clipOf(e, "right");
  assert.deepEqual(
    [left.duration, contentEnd(left), right.start, right.duration, right.contentIn],
    [hz, 3 * hz, 3 * hz, hz, 3 * hz],
  );
  assert.equal(left.rate, 2);
  assert.equal(right.rate, 2);

  // A content position between ticks of timeline still names the content exactly.
  const f = open();
  commit(f.dispatch(commands.retimeClip({ clipId: "line", rate: 2 })));
  commit(f.dispatch(commands.splitClip({ clipId: "line", atContent: 2.5 * hz + 1, rightId: "r" })));
  const r = clipOf(f, "r");
  assert.equal(r.contentIn, 2.5 * hz + 1);
  assert.equal(r.start, 2 * hz + Math.round((1.5 * hz + 1) / 2));
  assert.equal(
    codeOf(f.dispatch(commands.splitClip({ clipId: "r", atContent: 2.5 * hz + 0.5 }))),
    "invalid-range",
  );
});

test("a split recorded before another editor's retime replays at the same content", () => {
  const a = open();
  const b = open();
  const cut = commit(a.dispatch(commands.splitClip({ clipId: "line", at: 4 * hz, rightId: "r" })));
  commit(b.dispatch(commands.retimeClip({ clipId: "line", rate: 1.25 })));
  commit(b.dispatch(cut.commands));
  // A cut the right half at content 3 s; at rate 1.25 that plays 1.6 s into the clip.
  assert.equal(clipOf(a, "r").contentIn, 3 * hz);
  assert.equal(clipOf(b, "r").contentIn, 3 * hz);
  assert.equal(clipOf(b, "r").start, 3.6 * hz);
  assert.equal(contentEnd(clipOf(b, "r")), 5 * hz);
  assert.equal(contentEnd(clipOf(b)), 3 * hz);
});

test("undo and redo of a retime restore exact placements, and a retimed placement merges as one value", () => {
  const e = open();
  const original = e.getSnapshot().clips;
  commit(e.dispatch(commands.retimeClip({ clipId: "line", rate: 1.5, anchor: "end" })));
  const retimed = e.getSnapshot().clips;
  commit(e.history.undo());
  assert.deepEqual(e.getSnapshot().clips, original);
  commit(e.history.redo());
  assert.deepEqual(e.getSnapshot().clips, retimed);

  // A change outside history to another field merges with the undo.
  commit(
    e.dispatch(commands.updateClip({ clipId: "line", name: "Line 1" }), { history: "ignore" }),
  );
  commit(e.history.undo());
  assert.deepEqual(clipOf(e), { ...line, name: "Line 1" });

  // A placement change outside history conflicts with undoing a retime.
  commit(e.history.redo());
  commit(e.dispatch(commands.moveClips({ clipIds: ["line"], delta: hz }), { history: "ignore" }));
  const conflict = e.history.undo();
  assert.equal(codeOf(conflict), "history-conflict");
  assert.ok(!conflict.ok && conflict.reason.includes("placement"), JSON.stringify(conflict));
});

test("a retime patch reports its rate as a field change", () => {
  const e = open();
  const result = commit(e.dispatch(commands.retimeClip({ clipId: "line", rate: 1.25 })));
  const [patch] = result.clipPatches;
  assert.ok(patch);
  const changes = clipFieldChanges(patch);
  assert.deepEqual(changes.fields, { rate: { before: undefined, after: 1.25 } });
  assert.equal(changes.placement.in, undefined);
  assert.equal(changes.placement.out, undefined);
});

test("a preview shows a retime without committing it", () => {
  const e = open();
  const preview = pass(
    e.preview(commands.retimeClip({ clipId: "line", duration: 3 * hz, anchor: "end" })),
  );
  assert.deepEqual(preview.placements, [{ ...line, start: 3 * hz, duration: 3 * hz, rate: 4 / 3 }]);
  assert.deepEqual(e.getSnapshot().clips, [line]);
});

test("a loaded or added clip's rate is validated, and a rate of 1 is omitted", () => {
  const loaded = open([
    { ...line, rate: 1 },
    { ...line, id: "half", start: 7 * hz, rate: 0.5 },
  ]);
  assert.equal(Object.hasOwn(clipOf(loaded), "rate"), false);
  assert.equal(clipOf(loaded, "half").rate, 0.5);
  assert.equal(contentEnd(clipOf(loaded, "half")), 3 * hz);
  const rejects = (clip: Clip, code: string) =>
    assert.throws(
      () => open([clip]),
      (error: unknown) => error instanceof EditError && error.code === code,
    );
  rejects({ ...line, rate: 8 }, "invalid-rate");
  // @ts-expect-error -- A string rate is a type error and a load rejection.
  rejects({ ...line, rate: "2" }, "invalid-rate");
  rejects({ ...line, rate: 2, contentBounds: { start: 0, end: 8 * hz } }, "source-bounds");

  const e = open([]);
  commit(e.dispatch(commands.addClip({ clip: { ...line, rate: 0.5 } })));
  assert.equal(clipOf(e).rate, 0.5);
  commit(e.dispatch(commands.addClip({ clip: { ...line, id: "plain", start: 12 * hz, rate: 1 } })));
  assert.equal(Object.hasOwn(clipOf(e, "plain"), "rate"), false);
  assert.equal(
    codeOf(e.dispatch(commands.addClip({ clip: { ...line, id: "fast", rate: 5 } }))),
    "invalid-rate",
  );
});

test("an audio plan maps a retimed clip's ticks to source at its rate", () => {
  const e = open();
  commit(e.dispatch(commands.retimeClip({ clipId: "line", rate: 1.25 })));
  const [whole] = e.read().planAudio({ start: 0, end: 10 * hz }, catalog()).spans;
  assert.ok(whole);
  assert.equal(whole.rate, 1.25);
  assert.equal(whole.sourceOriginTick, hz - 2.5 * hz);
  assert.deepEqual(whole.audible, {
    start: 2 * hz,
    end: 5.2 * hz,
    sourceStart: 48000,
    sourceEnd: 5 * 48000,
  });
  const [part] = e.read().planAudio({ start: 3 * hz, end: 4 * hz }, catalog()).spans;
  assert.ok(part);
  assert.deepEqual(part.window, {
    start: 3 * hz,
    end: 4 * hz,
    sourceStart: 2.25 * 48000,
    sourceEnd: 3.5 * 48000,
  });
  // The stream ends at 3 s: the clip is audible until two seconds of source have played.
  const [short] = e.read().planAudio({ start: 0, end: 10 * hz }, catalog(3 * 48000)).spans;
  assert.ok(short);
  assert.deepEqual(short.audible, {
    start: 2 * hz,
    end: 3.6 * hz,
    sourceStart: 48000,
    sourceEnd: 3 * 48000,
  });
  const plain = open()
    .read()
    .planAudio({ start: 0, end: 10 * hz }, catalog()).spans[0];
  assert.equal(plain?.rate, 1);
});

test("content and source positions agree with the planner at any tick", () => {
  const clip: Clip = { ...line, rate: 0.75, duration: 5 * hz };
  const take = { sourceAtContentZero: -hz, availableStart: 0, availableEnd: 30 * hz };
  for (const tick of [2 * hz, 2 * hz + 1, 3 * hz + 12345, 7 * hz - 1, 7 * hz]) {
    const window = sourceWindow(clip, take, tick, 7 * hz);
    assert.equal(contentAt(clip, tick), hz + Math.round((tick - 2 * hz) * 0.75));
    if (window) assert.equal(window.sourceStart, -hz + contentAt(clip, tick));
  }
  // Content before the take's available start is not audible.
  const late = { ...take, availableStart: 1.75 * hz };
  const window = sourceWindow(clip, late, 0, 10 * hz);
  assert.ok(window);
  // Source 1.75 s is content 2.75 s, which plays 2.75 - 1 = 1.75 s / 0.75 into the clip.
  assert.equal(window.start, 2 * hz + Math.ceil((1.75 * hz) / 0.75));
  assert.ok(window.sourceStart >= late.availableStart);
});
