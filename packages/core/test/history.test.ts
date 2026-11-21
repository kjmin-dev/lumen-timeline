import assert from "node:assert/strict";
import test from "node:test";
import { commands, createEditor } from "@lumen-timeline/core";
import type {
  Clip,
  CommitHistory,
  EditCommand,
  EditCommit,
  EditErrorCode,
  EditResult,
  EditUnchanged,
  JsonValue,
  Project,
} from "@lumen-timeline/core";
import { codeOf, commit, dataOf, readPath } from "./support.ts";

const clip = (id: string, start: number): Clip => ({
  id,
  trackId: "voice",
  kind: "audio",
  start,
  duration: 8,
  contentIn: 2,
});
const project: Project = {
  schemaVersion: 1,
  duration: 128,
  tracks: [{ id: "voice", overlap: "exclusive" }, { id: "mix" }],
  clips: [clip("a", 0), clip("b", 12), clip("c", 24)],
};
const ignore = { history: "ignore" } as const;
const set = (id: string, key: string, value: JsonValue) =>
  commands.setEntityData({ scope: "take", id, key, value });
const remove = (id: string, key: string) => commands.removeEntityData({ scope: "take", id, key });
const move = (id: string, delta: number, trackId?: string) =>
  commands.moveClips({ clipIds: [id], delta, trackId });
const trim = (id: string, delta: number) => commands.trimClip({ clipId: id, edge: "right", delta });
const split = (clipId: string, at: number, rightId?: string) =>
  commands.splitClip({ clipId, at, rightId });
const pass = (result: EditResult): EditCommit | EditUnchanged => {
  if (!result.ok) assert.fail(JSON.stringify(result));
  return result;
};

test("one or many ignored writes persist and notify once without disturbing either history branch", () => {
  const e = createEditor({ project });
  pass(e.dispatch(move("a", 2)));
  pass(e.history.undo());
  const clips = e.getSnapshot().clips;
  let geometry = 0;
  const events: EditCommit[] = [];
  e.subscribe(
    (s) => s.clips,
    () => geometry++,
  );
  e.subscribe(
    (s) => s.entityData,
    (_, result) => events.push(result),
  );
  const bytes = e.history.estimatedBytes;
  const value = { url: "asset-version-2", samples: [1, 2] };
  pass(e.dispatch(set("B", "status", "queued"), ignore));
  const batch = commit(
    e.dispatch(
      [set("B", "asset", value), set("B", "status", "ready"), set("A", "score", 0)],
      ignore,
    ),
  );
  value.samples.push(3);
  assert.deepEqual(batch.affected, { before: [], after: [] });
  assert.deepEqual(batch.changedIds, []);
  assert.equal(batch.dataPatches.length, 3);
  assert.equal(batch.history, "ignore");
  assert.equal(e.getSnapshot().clips, clips);
  assert.equal(geometry, 0);
  assert.equal(events.length, 2);
  assert.deepEqual(
    [e.history.undoDepth, e.history.redoDepth, e.history.estimatedBytes],
    [0, 1, bytes],
  );
  const durable = e.getSnapshot().entityData;
  pass(e.history.redo());
  pass(e.history.undo());
  assert.equal(e.getSnapshot().entityData, durable);
  assert.ok(durable);
  assert.deepEqual(durable.take.B, {
    status: "ready",
    asset: { url: "asset-version-2", samples: [1, 2] },
  });
  const reopened = createEditor({ project: JSON.parse(JSON.stringify(e.getSnapshot())) });
  assert.deepEqual(reopened.getSnapshot().entityData, durable);
  assert.equal(reopened.history.undoDepth, 0);
});

test("a recorded batch has one revision, final-state collision checks and stable split IDs", () => {
  const e = createEditor({ project });
  let calls = 0;
  e.subscribe(
    (s) => s,
    () => calls++,
  );
  // The first move temporarily occupies B. Only the final layout is published.
  const result = commit(
    e.dispatch([
      move("a", 12),
      move("b", -12),
      split("a", 16, "right"),
      trim("right", -1),
      split("right", 18, "tail"),
      set("B", "selected", true),
    ]),
  );
  assert.deepEqual(result.createdIds, ["right", "tail"]);
  assert.equal(result.revision, 1);
  assert.equal(calls, 1);
  const edited = e.getSnapshot();
  const undo = commit(e.history.undo());
  assert.equal(undo.patches, result.inversePatches);
  assert.deepEqual(e.getSnapshot().clips, project.clips);
  assert.equal(e.getSnapshot().entityData, undefined);
  pass(e.history.redo());
  assert.deepEqual(e.getSnapshot().clips, edited.clips);
  assert.deepEqual(e.getSnapshot().entityData, edited.entityData);
  assert.deepEqual([calls, e.history.undoDepth, e.history.redoDepth], [3, 1, 0]);
});

test("invalid, net-zero and stale batches preserve identity, notifications and redo", () => {
  const e = createEditor({ project });
  pass(e.dispatch(trim("a", -1)));
  pass(e.history.undo());
  const before = e.getSnapshot();
  let calls = 0;
  e.subscribe(
    (s) => s,
    () => calls++,
  );
  const cases: [EditCommand[], EditErrorCode][] = [
    [[set("B", "a", 1), move("a", 12)], "overlap"],
    // @ts-expect-error -- `undefined` is not JSON, so it is a type error and a runtime rejection.
    [[split("a", 2, "new"), set("B", "bad", undefined)], "invalid-project"],
    [[set("B", "ok", 1), trim("missing", 0)], "missing-clip"],
  ];
  for (const policy of ["record", "ignore"] as const) {
    for (const [actions, code] of cases)
      assert.equal(codeOf(e.dispatch(actions, { history: policy })), code);
    const noop = pass(
      e.dispatch([move("a", 1), set("B", "x", "y"), move("a", -1), remove("B", "x")], {
        history: policy,
      }),
    );
    assert.equal(noop.unchanged, true);
  }
  // @ts-expect-error -- An unknown history policy is a type error and a runtime rejection.
  assert.equal(codeOf(e.dispatch([], { history: "wrong" })), "invalid-history-policy");
  assert.equal(
    codeOf(e.dispatch(set("B", "x", 2), { ...ignore, expectedRevision: 0 })),
    "stale-revision",
  );
  assert.equal(e.getSnapshot(), before);
  assert.deepEqual([calls, e.history.undoDepth, e.history.redoDepth], [0, 0, 1]);
});

test("stable-ID replay survives an ignored earlier split and keeps other fields on the same clip", () => {
  const e = createEditor({ project });
  pass(e.dispatch(move("c", 4)));
  pass(e.dispatch([split("a", 4, "aa"), split("aa", 6, "aaa"), trim("c", -2)], ignore));
  const undo = commit(e.history.undo());
  const c = e.getSnapshot().clips.at(-1);
  assert.ok(c);
  assert.deepEqual([c.id, c.start, c.duration, undo.patches[0].index], ["c", 24, 6, 4]);
  pass(e.history.redo());
  assert.deepEqual(
    e.getSnapshot().clips.map((c) => [c.id, c.start, c.duration]),
    [
      ["a", 0, 4],
      ["aa", 4, 2],
      ["aaa", 6, 2],
      ["b", 12, 8],
      ["c", 28, 6],
    ],
  );
});

test("metadata survives undo of the owning split and becomes visible for its restored ID", () => {
  const e = createEditor({ project });
  pass(e.dispatch(split("a", 4, "right")));
  pass(
    e.dispatch(
      commands.setEntityData({ scope: "clip", id: "right", key: "job", value: "complete" }),
      ignore,
    ),
  );
  pass(e.history.undo());
  assert.ok(!e.getSnapshot().clips.some((c) => c.id === "right"));
  assert.equal(dataOf(e.getSnapshot()).clip.right.job, "complete");
  pass(e.history.redo());
  assert.equal(e.getSnapshot().clips[1].id, "right");
  assert.equal(dataOf(e.getSnapshot()).clip.right.job, "complete");
});

test("a same-field or structural collision rejects replay without partial changes or implicit loss of redo", () => {
  const e = createEditor({ project });
  pass(e.dispatch([move("a", 1), set("B", "status", "pending")]));
  pass(e.dispatch(set("B", "status", "ready"), ignore));
  const before = e.getSnapshot();
  assert.equal(codeOf(e.history.undo()), "history-conflict");
  assert.equal(e.getSnapshot(), before);
  assert.equal(e.history.undoDepth, 1);
  assert.equal(e.history.discard("undo"), true);
  pass(e.dispatch(split("b", 15, "right")));
  pass(e.history.undo());
  pass(e.dispatch(split("c", 27, "right"), ignore));
  assert.equal(codeOf(e.history.redo()), "history-conflict");
  assert.equal(e.history.redoDepth, 1);
  let rev = e.getSnapshot().revision;
  e.history.clear();
  assert.equal(e.getSnapshot().revision, rev);
  assert.equal(e.history.estimatedBytes, 0);
  pass(e.dispatch(split("a", 4, "child")));
  pass(e.dispatch(trim("child", -1), ignore));
  assert.equal(codeOf(e.history.undo()), "history-conflict");
});

test("overlap or same placement field modified by ignored edits cannot be overwritten by undo", () => {
  const e = createEditor({ project });
  pass(e.dispatch(move("a", 40)));
  pass(e.dispatch(move("b", -12), ignore));
  assert.equal(codeOf(e.history.undo()), "history-conflict");
  pass(e.dispatch(move("b", 12), ignore));
  pass(e.dispatch(move("a", 1), ignore));
  assert.equal(codeOf(e.history.undo()), "history-conflict");
  assert.equal(e.getSnapshot().clips[0].start, 41);
});

test("entity metadata uses sparse JSON maps and safe literal keys", () => {
  const e = createEditor({ project });
  const field = (value: JsonValue) =>
    commands.setEntityData({ scope: "__proto__", id: "constructor", key: "__proto__", value });
  pass(e.dispatch(field(null)));
  pass(e.dispatch(field({ a: 1, b: [2] }), ignore));
  const rev = e.getSnapshot().revision;
  assert.equal(pass(e.dispatch(field({ b: [2], a: 1 }), ignore)).unchanged, true);
  assert.equal(e.getSnapshot().revision, rev);
  assert.deepEqual(readPath(e.getSnapshot().entityData, "__proto__", "constructor", "__proto__"), {
    a: 1,
    b: [2],
  });
  pass(e.dispatch(field(null), ignore));
  pass(e.history.undo());
  assert.ok(!Object.hasOwn(e.getSnapshot(), "entityData"));
  // @ts-expect-error -- An entity scope must be a map, in types and at runtime.
  assert.throws(() => createEditor({ project: { ...project, entityData: { take: [] } } }), /scope/);
  assert.equal(
    createEditor({ project: { ...project, entityData: { take: { B: {} } } } }).getSnapshot()
      .entityData,
    undefined,
  );
});

test("entry and logical byte limits keep whole transactions and a single oversized newest edit", () => {
  const e = createEditor({ project, history: { maxEntries: 2 } });
  for (let i = 0; i < 3; i++) pass(e.dispatch(trim("c", 1)));
  assert.equal(e.history.undoDepth, 2);
  const bytes = e.history.estimatedBytes;
  pass(e.history.undo());
  assert.equal(e.history.estimatedBytes, bytes);
  pass(e.history.undo());
  assert.equal(codeOf(e.history.undo()), "empty-history");
  assert.equal(e.getSnapshot().clips[2].duration, 9);
  pass(e.dispatch([set("B", "a", 1), set("B", "b", 2)]));
  assert.equal(e.history.redoDepth, 0);
  const bounded = createEditor({ project, history: { maxBytes: 1 } });
  pass(bounded.dispatch(set("x", "v", "small")));
  pass(bounded.dispatch(set("x", "v", "large".repeat(1000))));
  assert.equal(bounded.history.undoDepth, 1);
  pass(bounded.history.undo());
  assert.equal(dataOf(bounded.getSnapshot()).take.x.v, "small");
  const disabled = createEditor({ project, history: { maxEntries: 0 } });
  pass(disabled.dispatch(move("a", 1)));
  assert.deepEqual([disabled.history.undoDepth, disabled.history.estimatedBytes], [0, 0]);
});

test("a disjoint recorded or ignored data field is never replaced by another field replay", () => {
  const e = createEditor({ project });
  pass(e.dispatch([set("A", "content", "old"), set("A", "tag", "warm")]));
  pass(e.dispatch([set("A", "content", "new"), move("b", 2)]));
  pass(e.history.undo());
  pass(e.dispatch([set("A", "tag", "fresh"), set("B", "length", 12)], ignore));
  pass(e.history.redo());
  assert.deepEqual(dataOf(e.getSnapshot()).take.A, { content: "new", tag: "fresh" });
  pass(e.history.undo());
  assert.deepEqual(dataOf(e.getSnapshot()).take.A, { content: "old", tag: "fresh" });
  assert.equal(dataOf(e.getSnapshot()).take.B.length, 12);
  const before = e.getSnapshot();
  assert.equal(codeOf(e.history.undo()), "history-conflict");
  assert.equal(e.getSnapshot(), before);
});

test("redo checks same-field conflicts and a stale generation cannot replace newer data", () => {
  const e = createEditor({ project });
  const created = pass(e.dispatch(set("B", "state", "ready")));
  pass(e.history.undo());
  const update = pass(e.dispatch(set("B", "state", "replaced"), ignore));
  assert.equal(
    codeOf(
      e.dispatch(set("B", "state", "stale"), { ...ignore, expectedRevision: created.revision }),
    ),
    "stale-revision",
  );
  const snapshot = e.getSnapshot();
  assert.equal(codeOf(e.history.redo()), "history-conflict");
  assert.equal(e.getSnapshot(), snapshot);
  assert.equal(e.history.discard("redo"), true);
  assert.equal(e.history.discard("redo"), false);
  assert.equal(e.getSnapshot().revision, update.revision);
});

test("default budget is 200 transactions across undo/redo, and evicted history is unreachable", () => {
  const e = createEditor({ project });
  for (let n = 0; n < 215; n++) pass(e.dispatch(set("A", "count", n)));
  assert.equal(e.history.undoDepth, 200);
  for (let n = 0; n < 200; n++) pass(e.history.undo());
  assert.deepEqual(
    [dataOf(e.getSnapshot()).take.A.count, e.history.undoDepth, e.history.redoDepth],
    [14, 0, 200],
  );
  pass(e.dispatch(set("A", "extra", true), ignore));
  assert.equal(e.history.redoDepth, 200);
  pass(e.dispatch(set("A", "count", -1)));
  assert.deepEqual([e.history.undoDepth, e.history.redoDepth], [1, 0]);
});

test("nested notifications see one coherent snapshot per transaction and history policy", () => {
  const e = createEditor({ project });
  const events: [number, CommitHistory, JsonValue | undefined][] = [];
  e.subscribe(
    (s) => s.revision,
    (rev) => {
      if (rev === 1) pass(e.dispatch([set("A", "score", 5), set("B", "score", 6)], ignore));
    },
  );
  e.subscribe(
    (s) => s.revision,
    (rev, result, doc) => events.push([rev, result.history, doc.entityData?.take.B.score]),
  );
  pass(e.dispatch(move("a", 1)));
  pass(e.history.undo());
  assert.deepEqual(events, [
    [1, "record", undefined],
    [2, "ignore", 6],
    [3, "undo", 6],
  ]);
});

test("a large ignored batch updates only data selectors once, while toolbar controls observe stack changes", () => {
  const e = createEditor({ project });
  const depths: [number, number][] = [];
  const off = e.history.subscribe((s) => depths.push([s.undoDepth, s.redoDepth]));
  let dataEvents = 0;
  let clipEvents = 0;
  e.subscribe(
    (s) => s.entityData,
    () => dataEvents++,
  );
  e.subscribe(
    (s) => s.clips,
    () => clipEvents++,
  );
  const initial = e.getSnapshot().clips;
  pass(
    e.dispatch(
      Array.from({ length: 1000 }, (_, i) => set(String(i), "ready", true)),
      ignore,
    ),
  );
  assert.equal(e.getSnapshot().clips, initial);
  assert.deepEqual([dataEvents, clipEvents, depths.length], [1, 0, 0]);
  pass(e.dispatch(move("a", 1)));
  pass(e.history.undo());
  pass(e.dispatch(set("x", "value", 8), ignore));
  e.history.discard("redo");
  pass(e.dispatch(move("a", 1)));
  const rev = e.getSnapshot().revision;
  e.history.clear();
  e.history.clear();
  assert.deepEqual(depths, [
    [1, 0],
    [0, 1],
    [0, 0],
    [1, 0],
    [0, 0],
  ]);
  assert.equal(e.getSnapshot().revision, rev);
  off();
  pass(e.dispatch(move("a", 1)));
  assert.equal(depths.length, 5);
});
