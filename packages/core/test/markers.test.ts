import assert from "node:assert/strict";
import test from "node:test";
import { commands, createEditor, EditError, sequenceDuration } from "@lumen-timeline/core";
import type { Editor, Marker, Project } from "@lumen-timeline/core";
import { codeOf, commit, pass } from "./support.ts";
import type { Draft } from "./support.ts";

const project = (): Draft<Project> => ({
  schemaVersion: 1,
  duration: 100,
  tracks: [{ id: "voice", overlap: "exclusive" }],
  clips: [{ id: "line", trackId: "voice", kind: "audio", start: 10, duration: 20, contentIn: 0 }],
  markers: [
    { id: "outro", start: 90, label: "Outro", review: { state: "open" } },
    { id: "intro", start: 0, label: "Intro", color: "#ffd7a4" },
    { id: "cue", start: 40 },
  ],
});
const ids = (e: Editor): string[] => (e.getSnapshot().markers ?? []).map((m) => m.id);
const marker = (e: Editor, id: string): Marker | undefined =>
  e.getSnapshot().markers?.find((m) => m.id === id);
const add = commands.addMarker;
const move = (markerId: string, delta: number) => commands.moveMarker({ markerId, delta });
const rename = (markerId: string, label: string) => commands.updateMarker({ markerId, label });
const remove = (markerId: string) => commands.removeMarker({ markerId });

test("markers load sorted by start and ID, keep unknown fields and vanish when empty", () => {
  const e = createEditor({ project: project() });
  assert.deepEqual(ids(e), ["intro", "cue", "outro"]);
  assert.deepEqual(marker(e, "outro"), {
    id: "outro",
    start: 90,
    label: "Outro",
    review: { state: "open" },
  });
  assert.ok(Object.isFrozen(e.getSnapshot().markers));
  assert.deepEqual(Object.keys(e.getSnapshot()).slice(0, 6), [
    "schemaVersion",
    "duration",
    "tracks",
    "clips",
    "markers",
    "revision",
  ]);
  const empty = project();
  empty.markers = [];
  assert.ok(!Object.hasOwn(createEditor({ project: empty }).getSnapshot(), "markers"));
  const reopened = createEditor({ project: JSON.parse(JSON.stringify(e.getSnapshot())) });
  assert.deepEqual(reopened.getSnapshot(), e.getSnapshot());
});

test("every invalid marker field is rejected with invalid-marker", () => {
  for (const modify of [
    (p) => {
      p.markers = [
        { id: "a", start: 1 },
        { id: "a", start: 2 },
      ];
    },
    (p) => {
      // @ts-expect-error -- A marker ID is a nonempty string.
      p.markers = [{ id: 7, start: 1 }];
    },
    (p) => {
      p.markers = [{ id: "late", start: 101 }];
    },
    (p) => {
      p.markers = [{ id: "early", start: -1 }];
    },
    (p) => {
      p.markers = [{ id: "half", start: 1.5 }];
    },
    (p) => {
      // @ts-expect-error -- A label is a string.
      p.markers = [{ id: "a", start: 1, label: 3 }];
    },
    (p) => {
      // @ts-expect-error -- A color is a string.
      p.markers = [{ id: "a", start: 1, color: null }];
    },
    (p) => {
      // @ts-expect-error -- Extensions are a map.
      p.markers = [{ id: "a", start: 1, extensions: [] }];
    },
  ] satisfies ((p: Draft<Project>) => void)[]) {
    const p = project();
    modify(p);
    assert.throws(
      () => createEditor({ project: p }),
      (error) => error instanceof EditError && error.code === "invalid-marker",
    );
  }
  const list = project();
  // @ts-expect-error -- Markers are an array.
  list.markers = { intro: { start: 0 } };
  assert.throws(
    () => createEditor({ project: list }),
    (error) => error instanceof EditError && error.code === "invalid-project",
  );
});

test("add, move, rename and remove commit marker patches without touching clips", () => {
  const e = createEditor({ project: project() });
  const seen: number[] = [];
  e.subscribe(
    (s) => s.markers,
    (_, result) => seen.push(result.revision),
  );
  const added = commit(e.dispatch(add({ id: "drop", start: 60, label: "Drop" })));
  assert.deepEqual(added.markerPatches, [
    { id: "drop", before: undefined, after: { id: "drop", start: 60, label: "Drop" } },
  ]);
  assert.deepEqual(added.inverseMarkerPatches, [
    { id: "drop", before: { id: "drop", start: 60, label: "Drop" }, after: undefined },
  ]);
  assert.deepEqual([added.changedIds, added.createdIds, added.clipPatches], [[], [], []]);
  assert.deepEqual(ids(e), ["intro", "cue", "drop", "outro"]);
  commit(e.dispatch(move("drop", -25)));
  assert.equal(marker(e, "drop")?.start, 35);
  assert.deepEqual(ids(e), ["intro", "drop", "cue", "outro"]);
  commit(e.dispatch(rename("drop", "Bridge")));
  assert.deepEqual(marker(e, "drop"), { id: "drop", start: 35, label: "Bridge" });
  commit(e.dispatch(commands.updateMarker({ markerId: "drop", color: "#87d6cb" })));
  assert.equal(marker(e, "drop")?.label, "Bridge");
  commit(e.dispatch(remove("drop")));
  assert.equal(marker(e, "drop"), undefined);
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  const generated = commit(e.dispatch(add({ start: 5 })));
  const id = generated.markerPatches[0]?.id;
  assert.ok(id && marker(e, id)?.start === 5);
  assert.equal(e.getSnapshot().clips[0]?.start, 10);
});

test("marker rejections and no-ops leave the snapshot and history untouched", () => {
  const e = createEditor({ project: project() });
  const before = e.getSnapshot();
  for (const [command, code] of [
    [add({ id: "cue", start: 1 }), "invalid-marker"],
    [add({ id: "", start: 1 }), "invalid-marker"],
    [add({ id: "x", start: 101 }), "invalid-range"],
    [move("missing", 1), "missing-marker"],
    [move("cue", 0.5), "invalid-delta"],
    [move("cue", -41), "invalid-range"],
    [rename("missing", "x"), "missing-marker"],
    [remove("missing"), "missing-marker"],
  ] as const) {
    assert.equal(codeOf(e.dispatch(command)), code);
    assert.equal(e.getSnapshot(), before);
  }
  assert.equal(
    // @ts-expect-error -- A label is a string, in types and at runtime.
    codeOf(e.dispatch(commands.updateMarker({ markerId: "cue", label: 5 }))),
    "invalid-marker",
  );
  assert.equal(pass(e.dispatch(move("cue", 0))).unchanged, true);
  assert.equal(pass(e.dispatch([move("cue", 5), move("cue", -5)])).unchanged, true);
  assert.equal(pass(e.dispatch([add({ id: "tmp", start: 1 }), remove("tmp")])).unchanged, true);
  assert.equal(e.history.undoDepth, 0);
});

test("a mixed batch moves clips and markers in one revision and undoes together", () => {
  const e = createEditor({ project: project() });
  const result = commit(
    e.dispatch([
      commands.moveClips({ clipIds: ["line"], delta: 5 }),
      move("cue", 5),
      add({ id: "end", start: 100 }),
    ]),
  );
  assert.equal(result.revision, 1);
  assert.deepEqual(result.changedIds, ["line"]);
  assert.deepEqual(
    result.markerPatches.map((p) => p.id),
    ["cue", "end"],
  );
  const after = e.getSnapshot();
  commit(e.history.undo());
  assert.deepEqual(
    e.getSnapshot().markers,
    project().markers?.toSorted((a, b) => a.start - b.start),
  );
  assert.equal(e.getSnapshot().clips[0]?.start, 10);
  commit(e.history.redo());
  assert.deepEqual(e.getSnapshot().markers, after.markers);
  assert.deepEqual(e.getSnapshot().clips, after.clips);
});

test("marker replay keeps disjoint fields, conflicts on owned ones and protects edited removals", () => {
  const e = createEditor({ project: project() });
  commit(e.dispatch(move("cue", 10)));
  commit(e.dispatch(rename("cue", "Chorus"), { history: "ignore" }));
  commit(e.history.undo());
  assert.deepEqual(marker(e, "cue"), { id: "cue", start: 40, label: "Chorus" });
  commit(e.history.redo());
  assert.deepEqual(marker(e, "cue"), { id: "cue", start: 50, label: "Chorus" });

  commit(e.dispatch(move("intro", 3)));
  commit(e.dispatch(move("intro", 1), { history: "ignore" }));
  const pinned = e.getSnapshot();
  assert.equal(codeOf(e.history.undo()), "history-conflict");
  assert.equal(e.getSnapshot(), pinned);
  assert.equal(e.history.undoDepth, 2);
  assert.ok(e.history.discard("undo"));

  commit(e.dispatch(add({ id: "temp", start: 70, label: "Temp" })));
  commit(e.dispatch(rename("temp", "Kept"), { history: "ignore" }));
  assert.equal(codeOf(e.history.undo()), "history-conflict");
  assert.equal(marker(e, "temp")?.label, "Kept");

  commit(e.dispatch(remove("outro")));
  commit(e.dispatch(add({ id: "outro", start: 95 }), { history: "ignore" }));
  assert.equal(codeOf(e.history.undo()), "history-conflict");
});

test("marker reads match a seeded oracle and stay pinned to their snapshot", () => {
  let seed = 7;
  const rand = (n: number): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n;
  const p = project();
  p.markers = Array.from({ length: 300 }, (_, i) => ({ id: "m" + i, start: rand(100) }));
  const e = createEditor({ project: p });
  const read = e.read();
  const all = e.getSnapshot().markers ?? [];
  for (let i = 0; i < 400; i++) {
    const start = rand(110) - 5;
    const end = start + rand(30);
    const tick = rand(110) - 5;
    assert.deepEqual(
      read.markersIn({ start, end }).map((m) => m.id),
      all.filter((m) => start <= m.start && m.start < end).map((m) => m.id),
    );
    assert.equal(
      read.nextMarker(tick),
      all.find((m) => m.start > tick),
    );
    assert.equal(
      read.previousMarker(tick),
      all.findLast((m) => m.start < tick),
    );
  }
  assert.throws(() => read.markersIn({ start: 5, end: 1 }), /range/);
  assert.throws(() => read.nextMarker(0.5), /tick/);
  commit(e.dispatch(remove("m0")));
  assert.equal(read.markersIn({ start: 0, end: 101 }).length, 300);
  assert.equal(e.read().markersIn({ start: 0, end: 101 }).length, 299);
});

test("an implicit extent follows the last marker; an explicit duration bounds markers", () => {
  const p = project();
  delete p.duration;
  const e = createEditor({ project: p });
  assert.equal(sequenceDuration(e.getSnapshot()), 90);
  commit(e.dispatch(move("outro", 30)));
  assert.equal(sequenceDuration(e.getSnapshot()), 120);
  commit(e.dispatch(remove("outro")));
  assert.equal(sequenceDuration(e.getSnapshot()), 40);
  commit(e.history.undo());
  assert.equal(sequenceDuration(e.getSnapshot()), 120);
  const bounded = createEditor({ project: project() });
  commit(bounded.dispatch(move("outro", 10)));
  assert.equal(sequenceDuration(bounded.getSnapshot()), 100);
});
