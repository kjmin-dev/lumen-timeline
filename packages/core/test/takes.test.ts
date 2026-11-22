import assert from "node:assert/strict";
import test from "node:test";
import { commands, createEditor, TICKS_PER_SECOND } from "@lumen-timeline/core";
import type {
  Clip,
  EditCommand,
  Editor,
  Project,
  ProjectSnapshot,
  StreamCatalog,
  Take,
} from "@lumen-timeline/core";
import { codeOf, commit, pass } from "./support.ts";
import type { Draft } from "./support.ts";

const hz = TICKS_PER_SECOND;
const week = 7 * 86400 * hz;
const project = (): Draft<Project> => ({
  schemaVersion: 1,
  duration: 60 * hz,
  tracks: [
    { id: "voice", overlap: "exclusive" },
    { id: "music", locked: true },
  ],
  clips: [
    {
      id: "line",
      trackId: "voice",
      kind: "audio",
      start: 12 * hz,
      duration: 4 * hz,
      contentIn: hz,
      takeIds: ["b", "a"],
      activeTakeId: "a",
    },
    {
      id: "other",
      trackId: "voice",
      kind: "audio",
      start: 30 * hz,
      duration: 2 * hz,
      contentIn: 0,
    },
    {
      id: "bed",
      trackId: "music",
      kind: "audio",
      start: 0,
      duration: 20 * hz,
      contentIn: 0,
      takeIds: ["m"],
      activeTakeId: "m",
    },
  ],
  takes: [
    { id: "m", assetId: "bed-mix", streamId: "a0", sourceAtContentZero: 0 },
    { id: "b", assetId: "line-b", streamId: "a0", sourceAtContentZero: -1.5 * hz, note: "kept" },
    { id: "a", assetId: "line-a", streamId: "a0", sourceAtContentZero: 0, label: "First" },
  ],
});
const editor = (p: Draft<Project> = project()): Editor => createEditor({ project: p });
const clip = (e: Editor, id: string): Clip | undefined =>
  e.getSnapshot().clips.find((c) => c.id === id);
const take = (e: Editor, id: string): Take | undefined =>
  e.getSnapshot().takes?.find((t) => t.id === id);
const takeIds = (e: Editor): string[] => (e.getSnapshot().takes ?? []).map((t) => t.id);
const reopen = (snapshot: ProjectSnapshot): Editor =>
  createEditor({ project: JSON.parse(JSON.stringify(snapshot)) });
const fresh = { assetId: "line-c", streamId: "a0", sourceAtContentZero: -3 * hz };
const ignore = { history: "ignore" } as const;
const add = (clipIds: string[], id: string, activate?: boolean): EditCommand =>
  commands.addTake({ clipIds, take: { id, ...fresh }, activate });
const candidates = (e: Editor, id: string) => {
  const c = clip(e, id);
  return [c?.takeIds, c?.activeTakeId];
};

test("takes load sorted by ID with unknown fields, and each clip state has one form", () => {
  const e = editor();
  assert.deepEqual(takeIds(e), ["a", "b", "m"]);
  assert.equal(take(e, "b")?.["note"], "kept");
  assert.deepEqual(candidates(e, "line"), [["b", "a"], "a"]);
  assert.ok(Object.isFrozen(e.getSnapshot().takes) && Object.isFrozen(clip(e, "line")?.takeIds));
  assert.deepEqual(reopen(e.getSnapshot()).getSnapshot(), e.getSnapshot());

  // No candidates: neither field. Candidates but none active: an explicit null.
  const p = project();
  const [line, other] = p.clips;
  assert.ok(line && other);
  delete line.activeTakeId;
  other.takeIds = [];
  other.activeTakeId = null;
  p.takes = [
    ...(p.takes ?? []),
    { id: "spare", assetId: "x", streamId: "a0", sourceAtContentZero: 0 },
  ];
  const loaded = editor(p);
  assert.deepEqual(candidates(loaded, "line"), [["b", "a"], null]);
  assert.ok(!Object.hasOwn(clip(loaded, "other") ?? {}, "takeIds"));
  assert.ok(!Object.hasOwn(clip(loaded, "other") ?? {}, "activeTakeId"));
  // A take that no clip lists waits in the project until it is pruned.
  assert.deepEqual(takeIds(loaded), ["a", "b", "m", "spare"]);
  assert.deepEqual(reopen(loaded.getSnapshot()).getSnapshot(), loaded.getSnapshot());

  const empty = project();
  empty.takes = [];
  for (const c of empty.clips) {
    delete c.takeIds;
    delete c.activeTakeId;
  }
  assert.ok(!Object.hasOwn(editor(empty).getSnapshot(), "takes"));
});

test("every invalid take or candidate list is rejected with invalid-take", () => {
  const extra = { id: "c", assetId: "x", streamId: "a0", sourceAtContentZero: 0 };
  const cases: ((p: Draft<Project>) => void)[] = [
    (p) => p.takes?.push({ ...extra, id: "a" }),
    // @ts-expect-error -- A take requires an asset ID.
    (p) => p.takes?.push({ id: "c", streamId: "a0", sourceAtContentZero: 0 }),
    // @ts-expect-error -- A take requires a stream ID.
    (p) => p.takes?.push({ id: "c", assetId: "x", sourceAtContentZero: 0 }),
    (p) => p.takes?.push({ ...extra, sourceAtContentZero: 0.5 }),
    (p) => p.takes?.push({ ...extra, sourceAtContentZero: week + 1 }),
    (p) => p.takes?.push({ ...extra, sourceAtContentZero: -week - 1 }),
    // @ts-expect-error -- A label is a string.
    (p) => p.takes?.push({ ...extra, label: 1 }),
    (p) => p.takes?.push({ ...extra, forkedFrom: "" }),
    // @ts-expect-error -- Extensions are a map.
    (p) => p.takes?.push({ ...extra, extensions: [] }),
    (p) => {
      const first = p.clips[0];
      if (first) first.takeIds = ["a", "a"];
    },
    (p) => {
      const first = p.clips[0];
      if (first) first.takeIds = ["a", ""];
    },
    (p) => {
      const first = p.clips[0];
      if (first) first.takeIds = ["a", "b", "missing"];
    },
    (p) => {
      const first = p.clips[0];
      // A listed active take is required.
      if (first) first.activeTakeId = "m";
    },
    (p) => {
      const second = p.clips[1];
      // An active take without candidates names nothing.
      if (second) second.activeTakeId = "a";
    },
    (p) => {
      const first = p.clips[0];
      // @ts-expect-error -- Candidate lists are arrays.
      if (first) first.takeIds = "a";
    },
  ];
  for (const [index, modify] of cases.entries()) {
    const p = project();
    modify(p);
    assert.throws(() => editor(p), { code: "invalid-take" }, "case " + index);
  }
  const p = project();
  // @ts-expect-error -- Takes are an array.
  p.takes = {};
  assert.throws(() => editor(p), { code: "invalid-project" });
  const far = project();
  const first = far.clips[0];
  if (first) first.contentIn = week + 1;
  assert.throws(() => editor(far), { code: "invalid-range" });
  assert.equal(
    pass(editor().dispatch(commands.updateTake({ takeId: "a", sourceAtContentZero: week }))).ok,
    true,
  );
});

test("add-take appends a candidate without applying it unless asked", () => {
  const e = editor();
  const result = commit(
    e.dispatch(commands.addTake({ clipIds: ["line"], take: { id: "c", ...fresh, label: "C" } })),
  );
  assert.deepEqual(candidates(e, "line"), [["b", "a", "c"], "a"]);
  assert.deepEqual(result.takePatches, [
    { id: "c", before: undefined, after: { id: "c", ...fresh, label: "C" } },
  ]);
  assert.deepEqual(result.changedIds, ["line"]);
  // A first candidate gives the clip an explicit "none active".
  commit(e.dispatch(commands.addTake({ clipIds: ["other"], takeId: "b" })));
  assert.deepEqual(candidates(e, "other"), [["b"], null]);
  commit(e.dispatch(commands.addTake({ clipIds: ["line", "other"], takeId: "c", activate: true })));
  assert.deepEqual(candidates(e, "line"), [["b", "a", "c"], "c"]);
  assert.deepEqual(candidates(e, "other"), [["b", "c"], "c"]);
  assert.ok("unchanged" in pass(e.dispatch(commands.addTake({ clipIds: ["line"], takeId: "c" }))));
  const generated = commit(e.dispatch(commands.addTake({ clipIds: ["other"], take: fresh })));
  const id = generated.takePatches[0]?.id;
  assert.ok(id && clip(e, "other")?.takeIds?.includes(id));
});

test("add-take rejects bad input and locked tracks", () => {
  const e = editor();
  const rejected: [EditCommand, string][] = [
    [commands.addTake({ clipIds: ["line"] }), "invalid-take"],
    [commands.addTake({ clipIds: ["line"], take: fresh, takeId: "a" }), "invalid-take"],
    [add(["line"], "a"), "invalid-take"],
    [commands.addTake({ clipIds: ["line"], take: { ...fresh, streamId: "" } }), "invalid-take"],
    [
      commands.addTake({ clipIds: ["line"], take: { ...fresh, sourceAtContentZero: 0.25 } }),
      "invalid-take",
    ],
    [
      commands.addTake({ clipIds: ["line"], take: { ...fresh, sourceAtContentZero: week + 1 } }),
      "invalid-take",
    ],
    [commands.addTake({ clipIds: ["line"], takeId: "missing" }), "missing-take"],
    [commands.addTake({ clipIds: [], takeId: "a" }), "invalid-selection"],
    [commands.addTake({ clipIds: ["line", "line"], takeId: "a" }), "invalid-selection"],
    [commands.addTake({ clipIds: ["ghost"], takeId: "a" }), "missing-clip"],
    [commands.addTake({ clipIds: ["bed"], takeId: "a" }), "locked-track"],
  ];
  for (const [command, code] of rejected)
    assert.equal(codeOf(e.dispatch(command)), code, JSON.stringify(command));
  assert.equal(e.getSnapshot().revision, 0);
});

test("select, reorder and remove act on one clip, and removed takes stay until pruned", () => {
  const e = editor();
  assert.equal(
    codeOf(e.dispatch(commands.selectTake({ clipId: "line", takeId: "m" }))),
    "missing-take",
  );
  assert.ok("unchanged" in pass(e.dispatch(commands.selectTake({ clipId: "line", takeId: "a" }))));
  assert.ok(
    "unchanged" in pass(e.dispatch(commands.selectTake({ clipId: "other", takeId: null }))),
  );
  commit(e.dispatch(commands.selectTake({ clipId: "line", takeId: "b" })));
  assert.equal(clip(e, "line")?.activeTakeId, "b");
  for (const takeIds of [["a"], ["a", "a"], ["a", "m"]])
    assert.equal(
      codeOf(e.dispatch(commands.reorderTakes({ clipId: "line", takeIds }))),
      "invalid-take",
    );
  commit(e.dispatch(commands.reorderTakes({ clipId: "line", takeIds: ["a", "b"] })));
  assert.deepEqual(clip(e, "line")?.takeIds, ["a", "b"]);
  assert.equal(
    codeOf(e.dispatch(commands.removeTake({ clipId: "line", takeId: "b" }))),
    "active-take",
  );
  const removed = commit(
    e.dispatch([
      commands.selectTake({ clipId: "line", takeId: null }),
      commands.removeTake({ clipId: "line", takeId: "b" }),
    ]),
  );
  assert.deepEqual(candidates(e, "line"), [["a"], null]);
  assert.deepEqual(removed.takePatches, []);
  assert.deepEqual(takeIds(e), ["a", "b", "m"]);
  // The last candidate takes both fields with it.
  commit(e.dispatch(commands.removeTake({ clipId: "line", takeId: "a" })));
  assert.ok(!Object.hasOwn(clip(e, "line") ?? {}, "takeIds"));
  assert.ok(!Object.hasOwn(clip(e, "line") ?? {}, "activeTakeId"));
  assert.deepEqual(takeIds(e), ["a", "b", "m"]);
  assert.equal(
    codeOf(e.dispatch(commands.selectTake({ clipId: "bed", takeId: null }))),
    "locked-track",
  );
});

test("pruning removes exactly the takes no clip lists", () => {
  const e = editor();
  assert.ok("unchanged" in pass(e.dispatch(commands.pruneTakes())));
  assert.equal(codeOf(e.dispatch(commands.pruneTakes({ takeIds: ["a"] }))), "listed-take");
  assert.equal(codeOf(e.dispatch(commands.pruneTakes({ takeIds: ["ghost"] }))), "missing-take");
  assert.equal(codeOf(e.dispatch(commands.pruneTakes({ takeIds: ["a", "a"] }))), "invalid-take");
  commit(e.dispatch([add(["other"], "c"), add(["other"], "d")]));
  commit(
    e.dispatch([
      commands.removeTake({ clipId: "other", takeId: "c" }),
      commands.removeTake({ clipId: "other", takeId: "d" }),
    ]),
  );
  assert.deepEqual(takeIds(e), ["a", "b", "c", "d", "m"]);
  const one = commit(e.dispatch(commands.pruneTakes({ takeIds: ["c"] })));
  assert.deepEqual(
    one.takePatches.map((p) => [p.id, p.after]),
    [["c", undefined]],
  );
  assert.deepEqual(one.changedIds, []);
  commit(e.dispatch(commands.pruneTakes()));
  assert.deepEqual(takeIds(e), ["a", "b", "m"]);
  pass(e.history.undo());
  pass(e.history.undo());
  assert.deepEqual(takeIds(e), ["a", "b", "c", "d", "m"]);
  // A take unlisted earlier in the same transaction is already prunable.
  commit(
    e.dispatch([
      commands.addTake({ clipIds: ["other"], takeId: "c" }),
      commands.removeTake({ clipId: "other", takeId: "c" }),
      commands.pruneTakes({ takeIds: ["c"] }),
    ]),
  );
  assert.deepEqual(takeIds(e), ["a", "b", "d", "m"]);
});

test("net-zero take edits in one transaction leave the project unchanged", () => {
  const e = editor();
  for (const batch of [
    [
      add(["line"], "c"),
      commands.removeTake({ clipId: "line", takeId: "c" }),
      commands.pruneTakes(),
    ],
    [
      commands.selectTake({ clipId: "line", takeId: "b" }),
      commands.selectTake({ clipId: "line", takeId: "a" }),
    ],
    [
      add(["other"], "c", true),
      commands.selectTake({ clipId: "other", takeId: null }),
      commands.removeTake({ clipId: "other", takeId: "c" }),
      commands.pruneTakes({ takeIds: ["c"] }),
    ],
    [
      commands.reorderTakes({ clipId: "line", takeIds: ["a", "b"] }),
      commands.reorderTakes({ clipId: "line", takeIds: ["b", "a"] }),
    ],
  ])
    assert.ok("unchanged" in pass(e.dispatch(batch)), JSON.stringify(batch));
  assert.equal(e.getSnapshot().revision, 0);
  // Selecting and clearing a take returns to the same JSON as before.
  const before = JSON.stringify(clip(e, "line"));
  commit(e.dispatch(commands.selectTake({ clipId: "line", takeId: null })));
  commit(e.dispatch(commands.selectTake({ clipId: "line", takeId: "a" })));
  assert.equal(JSON.stringify(clip(e, "line")), before);
});

test("a split shares candidates, and a take added to one half stays there", () => {
  const e = editor();
  const split = commit(
    e.dispatch(commands.splitClip({ clipId: "line", at: 14 * hz, rightId: "r" })),
  );
  assert.deepEqual(split.takePatches, []);
  assert.deepEqual(candidates(e, "r"), [["b", "a"], "a"]);
  commit(
    e.dispatch(
      commands.addTake({
        clipIds: ["r"],
        take: { id: "c", ...fresh, sourceAtContentZero: -(clip(e, "r")?.contentIn ?? 0) },
        activate: true,
      }),
    ),
  );
  assert.deepEqual(candidates(e, "line"), [["b", "a"], "a"]);
  assert.deepEqual(candidates(e, "r"), [["b", "a", "c"], "c"]);
  const edited = e.getSnapshot();
  assert.deepEqual(reopen(edited).getSnapshot(), edited);
  pass(e.history.undo());
  assert.deepEqual(takeIds(e), ["a", "b", "m"]);
  assert.deepEqual(candidates(e, "r"), [["b", "a"], "a"]);
  pass(e.history.undo());
  assert.equal(clip(e, "r"), undefined);
  pass(e.history.redo());
  pass(e.history.redo());
  assert.deepEqual(e.getSnapshot().clips, edited.clips);
  assert.deepEqual(e.getSnapshot().takes, edited.takes);
});

test("update-take remaps every listing clip, and a label alone remaps none", () => {
  const e = editor();
  commit(e.dispatch(commands.splitClip({ clipId: "line", at: 14 * hz, rightId: "r" })));
  const label = commit(e.dispatch(commands.updateTake({ takeId: "a", label: "Approved" })));
  assert.deepEqual(label.changedIds, []);
  assert.equal(take(e, "a")?.label, "Approved");
  const moved = commit(e.dispatch(commands.updateTake({ takeId: "b", sourceAtContentZero: -hz })));
  assert.deepEqual([...moved.changedIds].sort(), ["line", "r"]);
  assert.deepEqual(
    moved.affected.after.map((a) => [a.clipId, a.start, a.end]),
    [
      ["line", 12 * hz, 14 * hz],
      ["r", 14 * hz, 16 * hz],
    ],
  );
  assert.deepEqual(moved.clipPatches, []);
  const rejected: [EditCommand, string][] = [
    [commands.updateTake({ takeId: "zzz", label: "x" }), "missing-take"],
    [commands.updateTake({ takeId: "a", sourceAtContentZero: 1.5 }), "invalid-take"],
    [commands.updateTake({ takeId: "a", sourceAtContentZero: week + 1 }), "invalid-take"],
    [commands.updateTake({ takeId: "a", newId: "a2", label: "x" }), "invalid-take"],
  ];
  for (const [command, code] of rejected)
    assert.equal(codeOf(e.dispatch(command)), code, JSON.stringify(command));
});

test("an update of some clips copies a shared take and leaves the others alone", () => {
  const e = editor();
  commit(e.dispatch(commands.splitClip({ clipId: "line", at: 14 * hz, rightId: "r" })));
  assert.deepEqual(e.read().clipsListing("a"), ["line", "r"]);
  const forked = commit(
    e.dispatch(
      commands.updateTake({ takeId: "a", clipIds: ["r"], newId: "a2", sourceAtContentZero: hz }),
    ),
  );
  // The copy takes the original's place and stays active where it was.
  assert.deepEqual(candidates(e, "r"), [["b", "a2"], "a2"]);
  assert.deepEqual(candidates(e, "line"), [["b", "a"], "a"]);
  assert.deepEqual(take(e, "a2"), {
    id: "a2",
    assetId: "line-a",
    streamId: "a0",
    sourceAtContentZero: hz,
    label: "First",
    forkedFrom: "a",
  });
  assert.equal(take(e, "a")?.sourceAtContentZero, 0);
  assert.deepEqual(forked.changedIds, ["r"]);
  assert.deepEqual(e.read().clipsListing("a"), ["line"]);
  assert.deepEqual(e.read().clipsListing("a2"), ["r"]);
  assert.deepEqual(reopen(e.getSnapshot()).getSnapshot(), e.getSnapshot());

  // A scope that covers every listing changes the take in place.
  const inPlace = commit(
    e.dispatch(commands.updateTake({ takeId: "a2", clipIds: ["r"], newId: "unused", label: "R" })),
  );
  assert.equal(take(e, "a2")?.label, "R");
  assert.equal(take(e, "unused"), undefined);
  assert.deepEqual(inPlace.changedIds, []);
  commit(e.dispatch(commands.updateTake({ takeId: "b", clipIds: ["line", "r"], label: "Both" })));
  assert.equal(take(e, "b")?.label, "Both");
  assert.deepEqual(takeIds(e), ["a", "a2", "b", "m"]);

  // A copy without other changes detaches the clip, and its ID can be generated.
  const detached = commit(e.dispatch(commands.updateTake({ takeId: "b", clipIds: ["line"] })));
  const copy = detached.takePatches[0]?.after;
  assert.ok(copy && copy.forkedFrom === "b" && copy.id !== "b");
  assert.deepEqual(candidates(e, "line"), [[copy.id, "a"], "a"]);

  // Undo removes the copy and puts the original back in the clip.
  const f = editor();
  commit(f.dispatch(commands.splitClip({ clipId: "line", at: 14 * hz, rightId: "r" })));
  const rejected: [EditCommand, string][] = [
    [commands.updateTake({ takeId: "a", clipIds: ["other"], label: "x" }), "missing-take"],
    [commands.updateTake({ takeId: "a", clipIds: [], label: "x" }), "invalid-selection"],
    [commands.updateTake({ takeId: "a", clipIds: ["r", "r"], label: "x" }), "invalid-selection"],
    [commands.updateTake({ takeId: "a", clipIds: ["ghost"], label: "x" }), "missing-clip"],
    [commands.updateTake({ takeId: "m", clipIds: ["bed"], label: "x" }), "locked-track"],
    [commands.updateTake({ takeId: "b", clipIds: ["r"], newId: "a" }), "invalid-take"],
    [commands.updateTake({ takeId: "b", clipIds: ["r"], newId: "" }), "invalid-take"],
  ];
  for (const [command, code] of rejected)
    assert.equal(codeOf(f.dispatch(command)), code, JSON.stringify(command));
  assert.equal(f.getSnapshot().revision, 1);
  commit(f.dispatch(commands.updateTake({ takeId: "a", clipIds: ["r"], newId: "a2", label: "R" })));
  pass(f.history.undo());
  assert.deepEqual(candidates(f, "r"), [["b", "a"], "a"]);
  assert.equal(take(f, "a2"), undefined);
  pass(f.history.redo());
  assert.deepEqual(candidates(f, "r"), [["b", "a2"], "a2"]);
});

test("expectations guard a transaction against stale state", () => {
  const e = editor();
  const scope = "studio.script";
  commit(e.dispatch(commands.setEntityData({ scope, id: "line", key: "revision", value: 3 })));
  const generated = (revision: number): EditCommand[] => [
    commands.expectData({ scope, id: "line", key: "revision", value: revision }),
    commands.expectClip({ clipId: "line", fields: { contentIn: hz, extensions: undefined } }),
    add(["line"], "c"),
  ];
  commit(e.dispatch(commands.setEntityData({ scope, id: "line", key: "revision", value: 4 })));
  const stale = e.dispatch(generated(3));
  assert.equal(codeOf(stale), "expectation-failed");
  assert.equal(stale.ok ? null : stale.target, "line");
  assert.deepEqual(takeIds(e), ["a", "b", "m"]);
  assert.equal(
    codeOf(e.dispatch(commands.expectClip({ clipId: "line", fields: { contentIn: 0 } }))),
    "expectation-failed",
  );
  assert.equal(
    codeOf(e.dispatch(commands.expectClip({ clipId: "line", fields: { takeIds: ["a", "b"] } }))),
    "expectation-failed",
  );
  commit(e.dispatch(generated(4)));
  assert.deepEqual(takeIds(e), ["a", "b", "c", "m"]);
  // Expectations read the transaction's staged state.
  commit(
    e.dispatch([
      commands.selectTake({ clipId: "line", takeId: "c" }),
      commands.expectClip({
        clipId: "line",
        fields: { activeTakeId: "c", takeIds: ["b", "a", "c"] },
      }),
      commands.setEntityData({ scope, id: "line", key: "revision", value: 5 }),
      commands.expectData({ scope, id: "line", key: "revision", value: 5 }),
    ]),
  );
  assert.equal(
    codeOf(e.dispatch(commands.expectClip({ clipId: "gone", fields: {} }))),
    "expectation-failed",
  );
  assert.equal(
    codeOf(e.dispatch(commands.expectData({ scope, id: "line", key: "", value: 1 }))),
    "invalid-expectation",
  );
  assert.ok("unchanged" in pass(e.dispatch(commands.expectClip({ clipId: "line", fields: {} }))));
});

test("history replays take edits field by field and conflicts on owned ones", () => {
  const e = editor();
  commit(e.dispatch(commands.updateTake({ takeId: "a", label: "Second" })));
  commit(e.dispatch(commands.updateTake({ takeId: "a", sourceAtContentZero: hz }), ignore));
  // The label undo keeps the later position, which it does not own.
  pass(e.history.undo());
  assert.equal(take(e, "a")?.label, "First");
  assert.equal(take(e, "a")?.sourceAtContentZero, hz);

  // Undoing an addition would remove a take that changed since.
  const f = editor();
  commit(f.dispatch(add(["other"], "c")));
  commit(f.dispatch(commands.updateTake({ takeId: "c", label: "Edited" }), ignore));
  assert.equal(codeOf(f.history.undo()), "history-conflict");
  assert.deepEqual(takeIds(f), ["a", "b", "c", "m"]);

  // Selection and order are separate fields.
  const g = editor();
  commit(g.dispatch(commands.selectTake({ clipId: "line", takeId: "b" })));
  commit(g.dispatch(commands.reorderTakes({ clipId: "line", takeIds: ["a", "b"] }), ignore));
  pass(g.history.undo());
  assert.deepEqual(candidates(g, "line"), [["a", "b"], "a"]);
});

test("a take's presence follows its listings when history replays", () => {
  // Another clip listed the take since: undo unlists it here and keeps the take.
  const e = editor();
  commit(e.dispatch(add(["other"], "c")));
  commit(e.dispatch(commands.addTake({ clipIds: ["line"], takeId: "c" }), ignore));
  const undone = commit(e.history.undo());
  assert.deepEqual(undone.takePatches, []);
  assert.ok(!Object.hasOwn(clip(e, "other") ?? {}, "takeIds"));
  assert.deepEqual(candidates(e, "line"), [["b", "a", "c"], "a"]);
  assert.deepEqual(takeIds(e), ["a", "b", "c", "m"]);
  // Redo lists it again without adding a second take.
  const redone = commit(e.history.redo());
  assert.deepEqual(redone.takePatches, []);
  assert.deepEqual(candidates(e, "other"), [["c"], null]);
  // With the other listing gone, undo removes the take as recorded.
  commit(e.dispatch(commands.removeTake({ clipId: "line", takeId: "c" }), ignore));
  pass(e.history.undo());
  assert.deepEqual(takeIds(e), ["a", "b", "m"]);

  // Undo cannot list a take that was pruned since.
  const f = editor();
  commit(f.dispatch(add(["other", "line"], "c")));
  commit(f.dispatch(commands.removeTake({ clipId: "line", takeId: "c" })));
  commit(
    f.dispatch(
      [commands.removeTake({ clipId: "other", takeId: "c" }), commands.pruneTakes()],
      ignore,
    ),
  );
  assert.equal(codeOf(f.history.undo()), "history-conflict");
  assert.deepEqual(takeIds(f), ["a", "b", "m"]);

  // Undoing a prune restores the take; redoing it skips a take listed since.
  const g = editor();
  commit(g.dispatch([add(["other"], "c"), commands.removeTake({ clipId: "other", takeId: "c" })]));
  commit(g.dispatch(commands.pruneTakes()));
  pass(g.history.undo());
  assert.deepEqual(takeIds(g), ["a", "b", "c", "m"]);
  commit(g.dispatch(commands.addTake({ clipIds: ["other"], takeId: "c" }), ignore));
  pass(g.history.redo());
  assert.deepEqual(takeIds(g), ["a", "b", "c", "m"]);
  assert.deepEqual(candidates(g, "other"), [["c"], null]);

  // Redoing a prune also skips a take that is already gone.
  const h = editor();
  commit(h.dispatch([add(["other"], "c"), commands.removeTake({ clipId: "other", takeId: "c" })]));
  commit(h.dispatch(commands.pruneTakes()));
  pass(h.history.undo());
  commit(h.dispatch(commands.pruneTakes(), ignore));
  assert.deepEqual(commit(h.history.redo()).takePatches, []);
  assert.deepEqual(takeIds(h), ["a", "b", "m"]);
});

test("replay owns the fields an edit removed and compares lists by value", () => {
  // Undoing the first candidate removes both fields from a clip that moved since.
  const e = editor();
  commit(e.dispatch(add(["other"], "c", true)));
  commit(e.dispatch(commands.moveClips({ clipIds: ["other"], delta: hz }), ignore));
  pass(e.history.undo());
  assert.ok(!Object.hasOwn(clip(e, "other") ?? {}, "takeIds"));
  assert.ok(!Object.hasOwn(clip(e, "other") ?? {}, "activeTakeId"));
  assert.equal(clip(e, "other")?.start, 31 * hz);
  assert.deepEqual(takeIds(e), ["a", "b", "m"]);
  pass(e.history.redo());
  assert.deepEqual(candidates(e, "other"), [["c"], "c"]);

  // A list that returned to the same IDs through other edits is unchanged.
  const g = editor();
  commit(g.dispatch(commands.reorderTakes({ clipId: "line", takeIds: ["a", "b"] })));
  commit(g.dispatch(commands.reorderTakes({ clipId: "line", takeIds: ["b", "a"] }), ignore));
  commit(g.dispatch(commands.reorderTakes({ clipId: "line", takeIds: ["a", "b"] }), ignore));
  pass(g.history.undo());
  assert.deepEqual(clip(g, "line")?.takeIds, ["b", "a"]);

  // The same holds for a split child that undo removes.
  const h = editor();
  commit(h.dispatch(commands.splitClip({ clipId: "line", at: 14 * hz, rightId: "r" })));
  commit(h.dispatch(commands.reorderTakes({ clipId: "r", takeIds: ["a", "b"] }), ignore));
  commit(h.dispatch(commands.reorderTakes({ clipId: "r", takeIds: ["b", "a"] }), ignore));
  pass(h.history.undo());
  assert.equal(clip(h, "r"), undefined);
  assert.equal(clip(h, "line")?.duration, 4 * hz);
});

const stream = (sampleRate: number, seconds: number) => ({
  assetVersion: 1,
  sampleRate,
  availableStart: 0,
  availableEnd: sampleRate * seconds,
});
const catalog: StreamCatalog = {
  version: 1,
  streams: {
    "line-a": { a0: stream(48000, 10) },
    "line-b": { a0: stream(44100, 2) },
    "bed-mix": { a0: stream(48000, 30) },
  },
};

test("planning plays a listed take through its stream at its tick alignment", () => {
  const e = editor();
  const read = e.read();
  const all = { start: 0, end: 60 * hz };
  const plan = read.planAudio(all, catalog);
  assert.deepEqual(plan.issues, []);
  const line = plan.spans.find((s) => s.clipId === "line");
  assert.equal(line?.takeId, "a");
  assert.equal(line?.assetId, "line-a");
  assert.deepEqual(line?.audible, {
    start: 12 * hz,
    end: 16 * hz,
    sourceStart: 48000,
    sourceEnd: 5 * 48000,
  });
  assert.equal(plan.spans.find((s) => s.clipId === "bed")?.assetId, "bed-mix");

  // The design's worked edit: take B, origin -1.5 s, audio [0, 2) s, contentIn 1 s.
  const b = read.planAudio(all, catalog, { takeOverrides: { line: "b" } });
  assert.deepEqual(b.spans.find((s) => s.clipId === "line")?.audible, {
    start: 12.5 * hz,
    end: 14.5 * hz,
    sourceStart: 0,
    sourceEnd: 2 * 44100,
  });
  assert.equal(clip(e, "line")?.activeTakeId, "a");

  const muted = read.planAudio(all, catalog, { takeOverrides: { line: null } });
  assert.equal(
    muted.spans.find((s) => s.clipId === "line"),
    undefined,
  );
  // A take the clip does not list cannot be previewed in it.
  const unlisted = read.planAudio(all, catalog, { takeOverrides: { line: "m", other: "a" } });
  assert.deepEqual(unlisted.issues, [
    { code: "unresolved-take", clipId: "line", takeId: "m" },
    { code: "unresolved-take", clipId: "other", takeId: "a" },
  ]);
  const { "line-a": _missing, ...rest } = catalog.streams;
  assert.deepEqual(read.planAudio(all, { version: 2, streams: rest }).issues, [
    { code: "unresolved-stream", clipId: "line", takeId: "a", assetId: "line-a", streamId: "a0" },
  ]);
  const broken = read.planAudio(all, {
    version: 3,
    streams: { ...rest, "line-a": { a0: { ...stream(48000, 1), sampleRate: 0 } } },
  });
  assert.deepEqual(
    broken.issues.map((i) => i.code),
    ["invalid-stream"],
  );
  assert.throws(
    () =>
      // @ts-expect-error -- Override values are take IDs or null.
      read.planAudio(all, catalog, { takeOverrides: { line: 3 } }),
    TypeError,
  );
  // @ts-expect-error -- A catalog maps assets to streams.
  assert.throws(() => read.planAudio(all, { version: 1 }), TypeError);
});

test("reads list a clip's candidates and the clips that list a take", () => {
  const e = editor();
  commit(e.dispatch(commands.splitClip({ clipId: "line", at: 14 * hz, rightId: "r" })));
  commit(e.dispatch([add(["other"], "c"), commands.removeTake({ clipId: "other", takeId: "c" })]));
  const read = e.read();
  assert.deepEqual(
    read.takesOf("line").map((t) => t.id),
    ["b", "a"],
  );
  assert.deepEqual(read.takesOf("other"), []);
  assert.throws(() => read.takesOf("ghost"), { code: "missing-clip" });
  assert.deepEqual(read.clipsListing("a"), ["line", "r"]);
  assert.deepEqual(read.clipsListing("m"), ["bed"]);
  assert.deepEqual(read.clipsListing("c"), []);
  assert.throws(() => read.clipsListing("ghost"), { code: "missing-take" });
});

// A seeded random walk over take commands. After every step the references
// hold, each clip state has its one form, and the snapshot reopens identically.
// Full undo and redo return to the first and last snapshots.
test("seeded take edits keep references exact through history and reopen", () => {
  let seed = 7;
  // The high bits of this generator are well mixed; its low bits repeat quickly.
  const random = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return Math.floor((seed / 2147483648) * n);
  };
  const kinds = new Map<string, number>();
  for (let trial = 0; trial < 40; trial++) {
    const e = editor();
    const initial = e.getSnapshot();
    let counter = 0;
    for (let step = 0; step < 30; step++) {
      const clips = e.getSnapshot().clips.filter((c) => c.trackId === "voice");
      const target = clips[random(clips.length)];
      assert.ok(target);
      const listed = target.takeIds ?? [];
      const all = takeIds(e);
      const pick = <T>(items: readonly T[]): T | undefined => items[random(items.length)];
      const choice = random(9);
      let command: EditCommand;
      if (choice === 0) command = add([target.id], "n" + ++counter, random(2) === 0);
      else if (choice === 1)
        command = commands.addTake({ clipIds: [target.id], takeId: pick(all) ?? "" });
      else if (choice === 2)
        command = commands.selectTake({ clipId: target.id, takeId: pick(listed) ?? null });
      else if (choice === 3 && listed.length)
        command = commands.removeTake({ clipId: target.id, takeId: pick(listed) ?? "" });
      else if (choice === 4)
        command = commands.reorderTakes({ clipId: target.id, takeIds: [...listed].reverse() });
      else if (choice === 5)
        command = commands.updateTake({
          takeId: pick(all) ?? "",
          sourceAtContentZero: random(5) * hz,
        });
      else if (choice === 6 && listed.length)
        command = commands.updateTake({
          takeId: pick(listed) ?? "",
          clipIds: [target.id],
          newId: "f" + ++counter,
          label: "fork " + counter,
        });
      else if (choice === 7) command = commands.pruneTakes();
      else
        command = commands.splitClip({
          clipId: target.id,
          at: target.start + 1 + random(target.duration - 1),
          rightId: "s" + ++counter,
        });
      const result = e.dispatch(command);
      if (!result.ok) assert.equal(result.code, "active-take", JSON.stringify(result));
      else if (!result.unchanged) kinds.set(command.type, (kinds.get(command.type) ?? 0) + 1);
      const snapshot = e.getSnapshot();
      const known = new Set(takeIds(e));
      for (const c of snapshot.clips) {
        const ids = c.takeIds;
        assert.equal(ids === undefined, !Object.hasOwn(c, "activeTakeId"), c.id);
        if (!ids) continue;
        assert.ok(ids.length > 0 && ids.every((id) => known.has(id)), c.id);
        assert.ok(c.activeTakeId === null || ids.includes(c.activeTakeId ?? ""), c.id);
        for (const id of ids) assert.ok(e.read().clipsListing(id).includes(c.id));
      }
      assert.deepEqual(reopen(snapshot).getSnapshot(), snapshot);
    }
    const final = e.getSnapshot();
    while (e.history.canUndo) pass(e.history.undo());
    assert.deepEqual(e.getSnapshot().clips, initial.clips);
    assert.deepEqual(e.getSnapshot().takes, initial.takes);
    while (e.history.canRedo) pass(e.history.redo());
    assert.deepEqual(e.getSnapshot().clips, final.clips);
    assert.deepEqual(e.getSnapshot().takes, final.takes);
  }
  // Every kind of command took effect many times.
  for (const type of [
    "add-take",
    "select-take",
    "remove-take",
    "reorder-takes",
    "update-take",
    "prune-takes",
    "split",
  ])
    assert.ok((kinds.get(type) ?? 0) >= 10, type + ": " + kinds.get(type));
});
