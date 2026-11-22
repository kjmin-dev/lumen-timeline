import assert from "node:assert/strict";
import test from "node:test";
import { commands, createEditor, TICKS_PER_SECOND } from "@lumen-timeline/core";
import type {
  Clip,
  EditCommand,
  Editor,
  Project,
  ProjectSnapshot,
  TakeCatalog,
} from "@lumen-timeline/core";
import { codeOf, commit, pass } from "./support.ts";
import type { Draft } from "./support.ts";

const hz = TICKS_PER_SECOND;
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
      activeTakeId: "bed-mix",
    },
  ],
  takes: [
    { id: "b", assetId: "line-b", streamId: "a0", sourceAtContentZero: -1.5 * hz, note: "kept" },
    { id: "a", assetId: "line-a", streamId: "a0", sourceAtContentZero: 0, label: "First" },
  ],
});
const editor = (p: Draft<Project> = project()): Editor => createEditor({ project: p });
const clip = (e: Editor, id: string): Clip | undefined =>
  e.getSnapshot().clips.find((c) => c.id === id);
const takeIds = (e: Editor): string[] => (e.getSnapshot().takes ?? []).map((t) => t.id);
const reopen = (snapshot: ProjectSnapshot): Editor =>
  createEditor({ project: JSON.parse(JSON.stringify(snapshot)) });
const fresh = { assetId: "line-c", streamId: "a0", sourceAtContentZero: -3 * hz };

test("takes load sorted by ID with unknown fields, and empty lists vanish", () => {
  const e = editor();
  assert.deepEqual(takeIds(e), ["a", "b"]);
  assert.equal(e.getSnapshot().takes?.[1]?.["note"], "kept");
  assert.deepEqual(clip(e, "line")?.takeIds, ["b", "a"]);
  assert.ok(Object.isFrozen(e.getSnapshot().takes) && Object.isFrozen(clip(e, "line")?.takeIds));
  assert.deepEqual(reopen(e.getSnapshot()).getSnapshot(), e.getSnapshot());

  const empty = project();
  empty.takes = [];
  const first = empty.clips[0];
  assert.ok(first);
  first.takeIds = [];
  first.activeTakeId = null;
  const loaded = editor(empty).getSnapshot();
  assert.ok(!Object.hasOwn(loaded, "takes"));
  assert.ok(!Object.hasOwn(loaded.clips[0] ?? {}, "takeIds"));
});

test("every invalid take or candidate list is rejected with invalid-take", () => {
  const cases: ((p: Draft<Project>) => void)[] = [
    (p) => {
      p.takes?.push({ id: "a", assetId: "x", streamId: "a0", sourceAtContentZero: 0 });
    },
    (p) => {
      // @ts-expect-error -- A take requires an asset ID.
      p.takes?.push({ id: "c", streamId: "a0", sourceAtContentZero: 0 });
    },
    (p) => {
      // @ts-expect-error -- A take requires a stream ID.
      p.takes?.push({ id: "c", assetId: "x", sourceAtContentZero: 0 });
    },
    (p) => {
      p.takes?.push({ id: "c", assetId: "x", streamId: "a0", sourceAtContentZero: 0.5 });
    },
    (p) => {
      // @ts-expect-error -- A label is a string.
      p.takes?.push({ id: "c", assetId: "x", streamId: "a0", sourceAtContentZero: 0, label: 1 });
    },
    (p) => {
      p.takes?.push({
        id: "c",
        assetId: "x",
        streamId: "a0",
        sourceAtContentZero: 0,
        // @ts-expect-error -- Extensions are a map.
        extensions: [],
      });
    },
    (p) => {
      // An unlisted take.
      p.takes?.push({ id: "c", assetId: "x", streamId: "a0", sourceAtContentZero: 0 });
    },
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
      if (first) first.activeTakeId = "bed-mix";
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
});

test("add-take appends a candidate without applying it unless asked", () => {
  const e = editor();
  const result = commit(
    e.dispatch(commands.addTake({ clipIds: ["line"], take: { id: "c", ...fresh, label: "C" } })),
  );
  assert.deepEqual(clip(e, "line")?.takeIds, ["b", "a", "c"]);
  assert.equal(clip(e, "line")?.activeTakeId, "a");
  assert.deepEqual(result.takePatches, [
    { id: "c", before: undefined, after: { id: "c", ...fresh, label: "C" } },
  ]);
  assert.deepEqual(result.changedIds, ["line"]);
  commit(e.dispatch(commands.addTake({ clipIds: ["line", "other"], takeId: "c", activate: true })));
  assert.deepEqual(clip(e, "line")?.takeIds, ["b", "a", "c"]);
  assert.deepEqual(clip(e, "other")?.takeIds, ["c"]);
  assert.equal(clip(e, "other")?.activeTakeId, "c");
  assert.equal(clip(e, "line")?.activeTakeId, "c");
  assert.equal(pass(e.dispatch(commands.addTake({ clipIds: ["line"], takeId: "c" }))).ok, true);
  assert.equal(
    "unchanged" in pass(e.dispatch(commands.addTake({ clipIds: ["line"], takeId: "c" }))),
    true,
  );
  const generated = commit(e.dispatch(commands.addTake({ clipIds: ["other"], take: fresh })));
  const id = generated.takePatches[0]?.id;
  assert.ok(id && clip(e, "other")?.takeIds?.includes(id));
});

test("add-take rejects bad input, locked tracks and an unlisted active take", () => {
  const e = editor();
  const rejected: [EditCommand, string][] = [
    [commands.addTake({ clipIds: ["line"] }), "invalid-take"],
    [commands.addTake({ clipIds: ["line"], take: fresh, takeId: "a" }), "invalid-take"],
    [commands.addTake({ clipIds: ["line"], take: { id: "a", ...fresh } }), "invalid-take"],
    [commands.addTake({ clipIds: ["line"], take: { ...fresh, streamId: "" } }), "invalid-take"],
    [
      commands.addTake({ clipIds: ["line"], take: { ...fresh, sourceAtContentZero: 0.25 } }),
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
  // A host-aligned active take must be registered before other candidates join it.
  const p = project();
  const free = p.tracks[1];
  if (free) free.locked = false;
  const host = editor(p);
  assert.equal(
    codeOf(host.dispatch(commands.addTake({ clipIds: ["bed"], takeId: "a" }))),
    "invalid-take",
  );
  commit(
    host.dispatch(
      commands.addTake({
        clipIds: ["bed"],
        take: { id: "bed-mix", assetId: "bed", streamId: "a0", sourceAtContentZero: 0 },
      }),
    ),
  );
  assert.deepEqual(clip(host, "bed")?.takeIds, ["bed-mix"]);
  assert.equal(e.getSnapshot().revision, 0);
});

test("select, reorder and remove act on one clip's candidates", () => {
  const e = editor();
  assert.equal(
    codeOf(e.dispatch(commands.selectTake({ clipId: "line", takeId: "zzz" }))),
    "missing-take",
  );
  assert.ok("unchanged" in pass(e.dispatch(commands.selectTake({ clipId: "line", takeId: "a" }))));
  commit(e.dispatch(commands.selectTake({ clipId: "line", takeId: "b" })));
  assert.equal(clip(e, "line")?.activeTakeId, "b");
  assert.equal(
    codeOf(e.dispatch(commands.reorderTakes({ clipId: "line", takeIds: ["a"] }))),
    "invalid-take",
  );
  assert.equal(
    codeOf(e.dispatch(commands.reorderTakes({ clipId: "line", takeIds: ["a", "a"] }))),
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
  assert.deepEqual(clip(e, "line")?.takeIds, ["a"]);
  assert.deepEqual(takeIds(e), ["a"]);
  assert.deepEqual(
    removed.takePatches.map((p) => [p.id, p.after]),
    [["b", undefined]],
  );
  commit(e.dispatch(commands.removeTake({ clipId: "line", takeId: "a" })));
  assert.ok(!Object.hasOwn(clip(e, "line") ?? {}, "takeIds"));
  assert.equal(clip(e, "line")?.activeTakeId, null);
  assert.ok(!Object.hasOwn(e.getSnapshot(), "takes"));
  assert.equal(
    codeOf(e.dispatch(commands.selectTake({ clipId: "bed", takeId: null }))),
    "locked-track",
  );
});

test("a split shares candidates, and a take added to one half stays there", () => {
  const e = editor();
  const split = commit(
    e.dispatch(commands.splitClip({ clipId: "line", at: 14 * hz, rightId: "r" })),
  );
  assert.deepEqual(split.takePatches, []);
  assert.deepEqual(clip(e, "r")?.takeIds, ["b", "a"]);
  assert.equal(clip(e, "r")?.activeTakeId, "a");
  commit(
    e.dispatch(
      commands.addTake({
        clipIds: ["r"],
        take: { id: "c", ...fresh, sourceAtContentZero: -(clip(e, "r")?.contentIn ?? 0) },
        activate: true,
      }),
    ),
  );
  assert.deepEqual(clip(e, "line")?.takeIds, ["b", "a"]);
  assert.equal(clip(e, "line")?.activeTakeId, "a");
  assert.deepEqual(clip(e, "r")?.takeIds, ["b", "a", "c"]);
  const edited = e.getSnapshot();
  assert.deepEqual(reopen(edited).getSnapshot(), edited);
  pass(e.history.undo());
  assert.deepEqual(takeIds(e), ["a", "b"]);
  assert.deepEqual(clip(e, "r")?.takeIds, ["b", "a"]);
  pass(e.history.undo());
  assert.equal(clip(e, "r"), undefined);
  pass(e.history.redo());
  pass(e.history.redo());
  assert.deepEqual(e.getSnapshot().clips, edited.clips);
  assert.deepEqual(e.getSnapshot().takes, edited.takes);
});

test("net-zero take edits in one transaction leave the clip unchanged", () => {
  const e = editor();
  for (const batch of [
    [
      commands.addTake({ clipIds: ["line"], take: { id: "c", ...fresh } }),
      commands.removeTake({ clipId: "line", takeId: "c" }),
    ],
    [
      commands.selectTake({ clipId: "line", takeId: "b" }),
      commands.selectTake({ clipId: "line", takeId: "a" }),
    ],
    [
      commands.addTake({ clipIds: ["other"], take: { id: "c", ...fresh }, activate: true }),
      commands.selectTake({ clipId: "other", takeId: null }),
      commands.removeTake({ clipId: "other", takeId: "c" }),
    ],
    [
      commands.reorderTakes({ clipId: "line", takeIds: ["a", "b"] }),
      commands.reorderTakes({ clipId: "line", takeIds: ["b", "a"] }),
    ],
  ])
    assert.ok("unchanged" in pass(e.dispatch(batch)), JSON.stringify(batch));
  assert.equal(e.getSnapshot().revision, 0);
});

test("a take leaves the project with its last listing and undo restores it", () => {
  const e = editor();
  assert.ok(
    "unchanged" in
      pass(
        e.dispatch([
          commands.addTake({ clipIds: ["other"], take: { id: "c", ...fresh } }),
          commands.removeTake({ clipId: "other", takeId: "c" }),
        ]),
      ),
  );
  commit(e.dispatch(commands.addTake({ clipIds: ["other"], take: { id: "c", ...fresh } })));
  commit(e.dispatch(commands.removeTake({ clipId: "other", takeId: "c" })));
  assert.deepEqual(takeIds(e), ["a", "b"]);
  pass(e.history.undo());
  assert.deepEqual(takeIds(e), ["a", "b", "c"]);
  assert.deepEqual(clip(e, "other")?.takeIds, ["c"]);
  pass(e.history.undo());
  assert.deepEqual(takeIds(e), ["a", "b"]);
  assert.ok(!Object.hasOwn(clip(e, "other") ?? {}, "takeIds"));
});

test("update-take remaps every listing clip, and a label alone remaps none", () => {
  const e = editor();
  commit(e.dispatch(commands.splitClip({ clipId: "line", at: 14 * hz, rightId: "r" })));
  const label = commit(e.dispatch(commands.updateTake({ takeId: "a", label: "Approved" })));
  assert.deepEqual(label.changedIds, []);
  assert.equal(e.getSnapshot().takes?.[0]?.label, "Approved");
  const moved = commit(e.dispatch(commands.updateTake({ takeId: "b", sourceAtContentZero: -hz })));
  assert.deepEqual([...moved.changedIds].sort(), ["line", "r"]);
  assert.deepEqual(
    moved.affected.after.map((a) => [a.clipId, a.start, a.end]),
    [
      ["line", 12 * hz, 14 * hz],
      ["r", 14 * hz, 16 * hz],
    ],
  );
  assert.deepEqual(moved.patches, []);
  assert.equal(
    codeOf(e.dispatch(commands.updateTake({ takeId: "zzz", label: "x" }))),
    "missing-take",
  );
  assert.equal(
    codeOf(e.dispatch(commands.updateTake({ takeId: "a", sourceAtContentZero: 1.5 }))),
    "invalid-take",
  );
});

test("expectations guard a transaction against stale state", () => {
  const e = editor();
  const scope = "studio.script";
  commit(e.dispatch(commands.setEntityData({ scope, id: "line", key: "revision", value: 3 })));
  const generated = (revision: number): EditCommand[] => [
    commands.expectData({ scope, id: "line", key: "revision", value: revision }),
    commands.expectClip({ clipId: "line", fields: { contentIn: hz, extensions: undefined } }),
    commands.addTake({ clipIds: ["line"], take: { id: "c", ...fresh } }),
  ];
  commit(e.dispatch(commands.setEntityData({ scope, id: "line", key: "revision", value: 4 })));
  const stale = e.dispatch(generated(3));
  assert.equal(codeOf(stale), "expectation-failed");
  assert.equal(stale.ok ? null : stale.target, "line");
  assert.deepEqual(takeIds(e), ["a", "b"]);
  assert.equal(
    codeOf(e.dispatch(commands.expectClip({ clipId: "line", fields: { contentIn: 0 } }))),
    "expectation-failed",
  );
  assert.equal(
    codeOf(e.dispatch(commands.expectClip({ clipId: "line", fields: { takeIds: ["a", "b"] } }))),
    "expectation-failed",
  );
  commit(e.dispatch(generated(4)));
  assert.deepEqual(takeIds(e), ["a", "b", "c"]);
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
  commit(e.dispatch(commands.updateTake({ takeId: "a", sourceAtContentZero: hz })));
  e.history.discard("undo");
  // The label undo keeps the later origin, which it does not own.
  pass(e.history.undo());
  assert.equal(e.getSnapshot().takes?.[0]?.label, "First");
  assert.equal(e.getSnapshot().takes?.[0]?.sourceAtContentZero, hz);

  const f = editor();
  commit(f.dispatch(commands.addTake({ clipIds: ["other"], take: { id: "c", ...fresh } })));
  commit(f.dispatch(commands.updateTake({ takeId: "c", label: "Edited" })));
  f.history.discard("undo");
  // Undoing the addition would remove a take that changed since.
  assert.equal(codeOf(f.history.undo()), "history-conflict");
  assert.deepEqual(takeIds(f), ["a", "b", "c"]);

  // Undo cannot remove a take that a later, discarded edit listed elsewhere.
  const h = editor();
  commit(h.dispatch(commands.addTake({ clipIds: ["other"], take: { id: "c", ...fresh } })));
  commit(h.dispatch(commands.addTake({ clipIds: ["line"], takeId: "c" })));
  h.history.discard("undo");
  assert.equal(codeOf(h.history.undo()), "history-conflict");
  assert.deepEqual(clip(h, "line")?.takeIds, ["b", "a", "c"]);

  // Nor relist a take that a later, discarded edit removed from the project.
  const k = editor();
  commit(k.dispatch(commands.addTake({ clipIds: ["other", "line"], take: { id: "c", ...fresh } })));
  commit(k.dispatch(commands.removeTake({ clipId: "line", takeId: "c" })));
  commit(k.dispatch(commands.removeTake({ clipId: "other", takeId: "c" })));
  k.history.discard("undo");
  assert.equal(codeOf(k.history.undo()), "history-conflict");
  assert.deepEqual(takeIds(k), ["a", "b"]);

  const g = editor();
  commit(g.dispatch(commands.selectTake({ clipId: "line", takeId: "b" })));
  commit(g.dispatch(commands.reorderTakes({ clipId: "line", takeIds: ["a", "b"] })));
  g.history.discard("undo");
  // Selection and order are separate fields.
  pass(g.history.undo());
  assert.equal(clip(g, "line")?.activeTakeId, "a");
  assert.deepEqual(clip(g, "line")?.takeIds, ["a", "b"]);
});

const stream = (sampleRate: number, seconds: number) => ({
  assetVersion: 1,
  sampleRate,
  availableStart: 0,
  availableEnd: sampleRate * seconds,
});
const catalog: TakeCatalog = {
  version: 1,
  streams: { "line-a": { a0: stream(48000, 10) }, "line-b": { a0: stream(44100, 2) } },
  takes: {
    "bed-mix": {
      assetId: "bed",
      streamId: "a0",
      sourceAtContentZero: 0,
      ...stream(48000, 30),
    },
    a: { assetId: "ignored", streamId: "a0", sourceAtContentZero: 0, ...stream(48000, 1) },
  },
};

test("planning plays a listed take through its stream at its tick alignment", () => {
  const e = editor();
  const read = e.read();
  const plan = read.planAudio({ start: 0, end: 60 * hz }, catalog);
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
  assert.equal(plan.spans.find((s) => s.clipId === "bed")?.assetId, "bed");

  // The design's worked edit: take B, origin -1.5 s, audio [0, 2) s, contentIn 1 s.
  const b = read.planAudio({ start: 0, end: 60 * hz }, catalog, { takeOverrides: { line: "b" } });
  assert.deepEqual(b.spans.find((s) => s.clipId === "line")?.audible, {
    start: 12.5 * hz,
    end: 14.5 * hz,
    sourceStart: 0,
    sourceEnd: 2 * 44100,
  });
  assert.equal(e.getSnapshot().clips[0]?.activeTakeId, "a");

  const muted = read.planAudio({ start: 0, end: 60 * hz }, catalog, {
    takeOverrides: { line: null },
  });
  assert.equal(
    muted.spans.find((s) => s.clipId === "line"),
    undefined,
  );
  commit(e.dispatch(commands.addTake({ clipIds: ["other"], take: { id: "c", ...fresh } })));
  const elsewhere = e.read().planAudio({ start: 0, end: 60 * hz }, catalog, {
    takeOverrides: { line: "c" },
  });
  assert.deepEqual(elsewhere.issues, [{ code: "unresolved-take", clipId: "line", takeId: "c" }]);
  const unlisted = read.planAudio({ start: 0, end: 60 * hz }, catalog, {
    takeOverrides: { line: "bed-mix" },
  });
  assert.deepEqual(unlisted.issues, [
    { code: "unresolved-take", clipId: "line", takeId: "bed-mix" },
  ]);
  const missing = read.planAudio({ start: 0, end: 60 * hz }, { ...catalog, streams: {} });
  assert.deepEqual(missing.issues, [
    { code: "unresolved-stream", clipId: "line", takeId: "a", assetId: "line-a", streamId: "a0" },
  ]);
  const broken = read.planAudio(
    { start: 0, end: 60 * hz },
    { ...catalog, streams: { "line-a": { a0: { ...stream(48000, 1), sampleRate: 0 } } } },
  );
  assert.equal(broken.issues[0]?.code, "invalid-take");
  assert.throws(
    () =>
      // @ts-expect-error -- Override values are take IDs or null.
      read.planAudio({ start: 0, end: hz }, catalog, { takeOverrides: { line: 3 } }),
    TypeError,
  );
  assert.deepEqual(
    read.takesOf("line").map((t) => t.id),
    ["b", "a"],
  );
  assert.deepEqual(read.takesOf("other"), []);
  assert.throws(() => read.takesOf("ghost"), { code: "missing-clip" });
});

// A seeded random walk over take commands. After every step the references
// are exact, the snapshot reopens identically, and full undo and redo return
// to the first and last snapshots.
test("seeded take edits keep references exact through history and reopen", () => {
  let seed = 7;
  const random = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let trial = 0; trial < 40; trial++) {
    const e = editor();
    const initial = e.getSnapshot();
    let counter = 0;
    for (let step = 0; step < 25; step++) {
      const clips = e.getSnapshot().clips.filter((c) => c.trackId === "voice");
      const target = clips[random(clips.length)];
      assert.ok(target);
      const listed = target.takeIds ?? [];
      const all = takeIds(e);
      const pick = <T>(items: readonly T[]): T | undefined => items[random(items.length)];
      const choice = random(7);
      let command: EditCommand;
      if (choice === 0)
        command = commands.addTake({
          clipIds: [target.id],
          take: { id: "n" + ++counter, ...fresh },
          activate: random(2) === 0,
        });
      else if (choice === 1 && all.length)
        command = commands.addTake({ clipIds: [target.id], takeId: pick(all) ?? "" });
      else if (choice === 2)
        command = commands.selectTake({ clipId: target.id, takeId: pick(listed) ?? null });
      else if (choice === 3 && listed.length)
        command = commands.removeTake({ clipId: target.id, takeId: pick(listed) ?? "" });
      else if (choice === 4)
        command = commands.reorderTakes({ clipId: target.id, takeIds: [...listed].reverse() });
      else if (choice === 5 && all.length)
        command = commands.updateTake({
          takeId: pick(all) ?? "",
          sourceAtContentZero: random(5) * hz,
        });
      else
        command = commands.splitClip({
          clipId: target.id,
          at: target.start + 1 + random(target.duration - 1),
          rightId: "s" + ++counter,
        });
      const result = e.dispatch(command);
      if (!result.ok)
        assert.ok(["active-take", "invalid-take"].includes(result.code), JSON.stringify(result));
      const snapshot = e.getSnapshot();
      const counts = new Map<string, number>();
      for (const c of snapshot.clips) {
        for (const id of c.takeIds ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
        if (c.takeIds) assert.ok(c.activeTakeId == null || c.takeIds.includes(c.activeTakeId));
      }
      assert.deepEqual([...counts.keys()].sort(), takeIds(e));
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
});

test("replay owns the fields an edit removed and compares lists by value", () => {
  const ignore = { history: "ignore" } as const;
  // Undoing the first candidate removes the list from a clip that moved since.
  const e = editor();
  commit(e.dispatch(commands.addTake({ clipIds: ["other"], take: { id: "c", ...fresh } })));
  commit(e.dispatch(commands.moveClips({ clipIds: ["other"], delta: hz }), ignore));
  pass(e.history.undo());
  assert.ok(!Object.hasOwn(clip(e, "other") ?? {}, "takeIds"));
  assert.equal(clip(e, "other")?.start, 31 * hz);
  assert.deepEqual(takeIds(e), ["a", "b"]);
  pass(e.history.redo());
  assert.deepEqual(clip(e, "other")?.takeIds, ["c"]);

  // Undoing a first selection removes the field again, not only its value.
  const p = project();
  const second = p.clips[1];
  assert.ok(second);
  second.takeIds = ["a"];
  const f = editor(p);
  commit(f.dispatch(commands.selectTake({ clipId: "other", takeId: "a" })));
  commit(f.dispatch(commands.moveClips({ clipIds: ["other"], delta: hz }), ignore));
  pass(f.history.undo());
  assert.ok(!Object.hasOwn(clip(f, "other") ?? {}, "activeTakeId"));
  assert.equal(clip(f, "other")?.start, 31 * hz);

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
