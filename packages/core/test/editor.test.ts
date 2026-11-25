import assert from "node:assert/strict";
import test from "node:test";
import { createEditor, commands, EditError, TICKS_PER_SECOND } from "@lumen-timeline/core";
import type {
  Clip,
  EditCommand,
  EditErrorCode,
  Project,
  ProjectSnapshot,
} from "@lumen-timeline/core";
import { codeOf, commit, pass, readPath } from "./support.ts";
import type { Draft } from "./support.ts";

type Review = { review: { version: number; data: { notes: string[] } } };
type Fixture = Draft<Project> & { extensions: Review };

const clip = (
  id: string,
  trackId: string,
  start: number,
  duration: number,
  contentIn = 0,
): Draft<Clip> => ({
  id,
  trackId,
  kind: "audio",
  start,
  duration,
  contentIn,
  takeIds: ["A"],
  activeTakeId: "A",
});
const project = (): Fixture => ({
  schemaVersion: 1,
  duration: 100,
  tracks: [
    { id: "voice", overlap: "exclusive", accepts: ["audio"] },
    { id: "bed", overlap: "mix" },
    { id: "picture", accepts: ["video"] },
    { id: "guide", locked: true },
  ],
  clips: [
    clip("a", "voice", 10, 8, 4),
    clip("b", "voice", 18, 8, 20),
    clip("unrelated", "bed", 30, 10),
    clip("locked", "guide", 1, 5),
  ],
  takes: [{ id: "A", assetId: "asset", streamId: "mono", sourceAtContentZero: 0 }],
  extensions: { review: { version: 1, data: { notes: ["keep"] } } },
});
const move = (clipIds: string[], delta: number, trackId?: string) =>
  commands.moveClips({ clipIds, delta, trackId });
const trim = (clipId: string, edge: "left" | "right", delta: number) =>
  commands.trimClip({ clipId, edge, delta });
const split = (clipId: string, at: number, rightId?: string) =>
  commands.splitClip({ clipId, at, rightId });

test("snapshots retain independent immutable JSON and reopen with their revision", () => {
  const input = project();
  const e = createEditor({ project: input });
  const first = e.getSnapshot();
  const dictionary = Object.assign(Object.create(null), input);
  assert.deepEqual(createEditor({ project: dictionary }).getSnapshot(), first);
  input.clips[0].start = 50;
  input.extensions.review.data.notes.push("later");
  assert.equal(first.clips[0].start, 10);
  assert.deepEqual(readPath(first, "extensions", "review", "data", "notes"), ["keep"]);
  assert.throws(() => {
    const notes = readPath(first, "extensions", "review", "data", "notes");
    assert.ok(Array.isArray(notes));
    notes.push("no");
  }, TypeError);
  pass(e.dispatch(trim("a", "left", 2)));
  const current = e.getSnapshot();
  assert.notEqual(first, current);
  assert.equal(current.clips[1], first.clips[1]);
  assert.equal(first.clips[0].duration, 8);
  assert.deepEqual(
    createEditor({ project: JSON.parse(JSON.stringify(current)) }).getSnapshot(),
    current,
  );
});

test("moves a selection as one transaction, including the vacated track intervals", () => {
  const e = createEditor({ project: project() });
  const result = commit(e.dispatch(move(["b", "a"], 3)));
  assert.deepEqual(result.changedIds, ["a", "b"]);
  assert.deepEqual(
    result.affected.before.map((r) => [r.start, r.end]),
    [
      [10, 18],
      [18, 26],
    ],
  );
  assert.deepEqual(
    result.affected.after.map((r) => [r.start, r.end]),
    [
      [13, 21],
      [21, 29],
    ],
  );
  const moved = commit(e.dispatch(move(["a", "b"], 0, "bed")));
  assert.deepEqual(
    moved.affected.before.map((r) => r.trackId),
    ["voice", "voice"],
  );
  assert.deepEqual(
    moved.affected.after.map((r) => r.trackId),
    ["bed", "bed"],
  );
  assert.equal(e.getSnapshot().clips[1].contentIn, 20);
  pass(e.history.undo());
  assert.equal(e.getSnapshot().clips[0].trackId, "voice");
  pass(e.history.undo());
  assert.deepEqual(e.getSnapshot().clips, project().clips);
});

test("rejections and no-ops leave snapshots, subscriptions and redo untouched", () => {
  const e = createEditor({ project: project() });
  pass(e.dispatch(trim("a", "right", -1)));
  pass(e.history.undo());
  const before = e.getSnapshot();
  const seen: ProjectSnapshot[] = [];
  e.subscribe(
    (s) => s,
    (s) => seen.push(s),
  );
  const cases: [EditCommand, EditErrorCode][] = [
    [move(["a"], 1), "overlap"],
    [move(["a", "locked"], 1, "bed"), "locked-track"],
    [move(["a"], 0, "guide"), "locked-track"],
    [move(["a"], 0, "picture"), "incompatible-kind"],
    [move(["a"], 0, "missing"), "missing-track"],
    [move(["missing"], 0), "missing-clip"],
    [move(["a", "a"], 1), "invalid-selection"],
    [move([], 0), "invalid-selection"],
    [move(["a", "b"], -11), "invalid-range"],
    [move(["a"], 99), "invalid-range"],
    // @ts-expect-error -- An unknown trim edge is a type error and a runtime rejection.
    [trim("a", "end", 1), "invalid-edge"],
    [trim("a", "left", 8), "invalid-range"],
    [trim("a", "right", NaN), "invalid-delta"],
    [split("a", 10), "invalid-range"],
    [split("a", 18), "invalid-range"],
    [split("a", 12.5), "invalid-range"],
    [split("a", 12, "b"), "invalid-id"],
    // @ts-expect-error -- An unknown command type is a type error and a runtime rejection.
    [{ type: "other" }, "unknown-command"],
  ];
  for (const [cmd, code] of cases) {
    assert.equal(codeOf(e.dispatch(cmd)), code);
    assert.equal(e.getSnapshot(), before);
  }
  assert.equal(codeOf(e.dispatch(trim("a", "left", 1), { expectedRevision: 0 })), "stale-revision");
  assert.equal(codeOf(e.history.redo({ expectedRevision: 1 })), "stale-revision");
  assert.equal(pass(e.dispatch(move(["a"], 0))).unchanged, true);
  assert.equal(pass(e.dispatch(trim("a", "right", 0))).unchanged, true);
  assert.deepEqual(seen, []);
  assert.equal(e.history.canRedo, true);
  pass(e.dispatch(trim("a", "right", -2), { expectedRevision: before.revision }));
  assert.equal(codeOf(e.history.redo()), "empty-history");
  assert.equal(seen.length, 1);
});

test("trim uses content handles, minimum duration, exclusive neighbors and slot padding", () => {
  const data = project();
  data.minClipDuration = 2;
  data.clips[0].contentBounds = { start: 2, end: 12 };
  const e = createEditor({ project: data });
  assert.equal(codeOf(e.dispatch(trim("a", "left", -3))), "source-bounds");
  assert.equal(codeOf(e.dispatch(trim("a", "right", 1))), "source-bounds");
  assert.equal(codeOf(e.dispatch(split("a", 11))), "invalid-range");
  pass(e.dispatch(trim("a", "left", -2)));
  let a = e.getSnapshot().clips[0];
  assert.deepEqual([a.start, a.duration, a.contentIn], [8, 10, 2]);
  pass(e.dispatch(trim("a", "left", 2)));
  pass(e.dispatch(trim("a", "right", -3)));
  a = e.getSnapshot().clips[0];
  assert.deepEqual([a.start, a.duration, a.contentIn], [10, 5, 4]);
  assert.equal(codeOf(e.dispatch(trim("b", "left", -4))), "overlap");
  pass(e.dispatch(trim("unrelated", "left", -2)));
  assert.equal(e.getSnapshot().clips[2].contentIn, -2);
});

test("split preserves identity, takes, exact ordering and inverse patches", () => {
  const e = createEditor({ project: project() });
  const first = e.getSnapshot();
  const result = commit(e.dispatch(split("a", 13)));
  const [rightId] = result.createdIds;
  const edited = e.getSnapshot();
  assert.ok(rightId && rightId !== "a");
  assert.deepEqual(edited.clips.slice(0, 2), [
    { ...first.clips[0], duration: 3 },
    { ...first.clips[0], id: rightId, start: 13, duration: 5, contentIn: 7 },
  ]);
  assert.equal(edited.clips[2], first.clips[1]);
  const undo = commit(e.history.undo());
  assert.equal(undo.clipPatches, result.inverseClipPatches);
  assert.deepEqual(e.getSnapshot().clips, first.clips);
  const redo = commit(e.history.redo());
  assert.deepEqual(redo.createdIds, [rightId]);
  assert.deepEqual(e.getSnapshot().clips, edited.clips);
  assert.deepEqual([result.revision, undo.revision, redo.revision], [1, 2, 3]);
  assert.equal(e.history.canRedo, false);
});

test("validates loaded projects and preserves opaque extension data", () => {
  for (const modify of [
    (p) => {
      p.schemaVersion = 0;
    },
    (p) => {
      p.clips[0].trackId = "absent";
    },
    (p) => {
      p.clips[0].duration = 0;
    },
    (p) => {
      p.clips[1].id = p.clips[0].id;
    },
    (p) => {
      // @ts-expect-error -- Projects must use the timeline tick rate.
      p.timebase = 1000;
    },
    (p) => {
      p.revision = -1;
    },
    (p) => {
      p.clips[1].start--;
    },
    (p) => {
      p.tracks[2].id = p.tracks[1].id;
    },
    (p) => {
      p.duration = 8 * 86400 * TICKS_PER_SECOND;
    },
    (p) => {
      p.deferred = new Map();
    },
  ] satisfies ((p: Fixture) => void)[]) {
    const p = project();
    modify(p);
    assert.throws(() => createEditor({ project: p }), EditError);
  }
  // Typed fields are checked on load, so a snapshot's types describe its contents.
  for (const [modify, code] of [
    [
      (p) => {
        // @ts-expect-error -- A track name must be a string.
        p.tracks[0].name = 7;
      },
      "invalid-track",
    ],
    [
      (p) => {
        // @ts-expect-error -- Mute is a boolean.
        p.tracks[1].mute = "yes";
      },
      "invalid-track",
    ],
    [
      (p) => {
        // @ts-expect-error -- Solo is a boolean.
        p.tracks[1].solo = 1;
      },
      "invalid-track",
    ],
    [
      (p) => {
        // @ts-expect-error -- Gain is a number.
        p.tracks[1].gain = "loud";
      },
      "invalid-track",
    ],
    [
      (p) => {
        // @ts-expect-error -- A take ID is a string or null.
        p.clips[0].activeTakeId = 7;
      },
      "invalid-clip",
    ],
    [
      (p) => {
        // @ts-expect-error -- A continuity ID is a string or null.
        p.clips[0].continuityId = false;
      },
      "invalid-clip",
    ],
    [
      (p) => {
        // @ts-expect-error -- Extensions are a map, not a list.
        p.clips[0].extensions = [];
      },
      "invalid-clip",
    ],
    [
      (p) => {
        // @ts-expect-error -- A clip name must be a string.
        p.clips[0].name = null;
      },
      "invalid-clip",
    ],
  ] satisfies [(p: Fixture) => void, string][]) {
    const p = project();
    modify(p);
    assert.throws(
      () => createEditor({ project: p }),
      (error) => error instanceof EditError && error.code === code,
    );
  }
  const data = project();
  data.clips[0].extensions = { words: { version: 7, data: [1, 2] } };
  const e = createEditor({ project: data });
  assert.equal(codeOf(e.dispatch(split("a", 13))), "split-policy-required");
  pass(e.dispatch(move(["a"], -1)));
  assert.deepEqual(e.getSnapshot().clips[0].extensions, data.clips[0].extensions);
});

test("selector subscriptions deliver coherent revisions, including nested commits, and unsubscribe", () => {
  const e = createEditor({ project: project() });
  const revisions: number[] = [];
  const selected: number[] = [];
  e.subscribe(
    (s) => s.revision,
    (revision) => {
      if (revision === 1) pass(e.history.undo());
    },
  );
  const off = e.subscribe(
    (s) => s.clips[0],
    (next, result, snapshot) => {
      revisions.push(result.revision);
      assert.equal(next, snapshot.clips[0]);
      selected.push(next.duration);
    },
  );
  pass(e.dispatch(trim("a", "right", -2)));
  pass(e.dispatch(move(["unrelated"], 5)));
  assert.deepEqual(revisions, [1, 2]);
  assert.deepEqual(selected, [6, 8]);
  off();
  pass(e.dispatch(trim("a", "right", -1)));
  assert.deepEqual(revisions, [1, 2]);
  e.dispose();
  assert.equal(codeOf(e.dispatch(trim("a", "left", 1))), "disposed");
  assert.equal(codeOf(e.history.undo()), "disposed");
});

test("1,000 committed edits rewind and replay the same source windows and IDs", () => {
  const initial: Draft<Project> = {
    schemaVersion: 1,
    duration: 10000,
    tracks: [{ id: "one" }, { id: "two", overlap: "exclusive" }],
    clips: [clip("main", "one", 0, 3000, 100)],
    takes: [{ id: "A", assetId: "asset", streamId: "mono", sourceAtContentZero: 0 }],
  };
  const e = createEditor({ project: initial, history: { maxEntries: 1000 } });
  for (let i = 1; i <= 250; i++) {
    const id = "part-" + i;
    pass(e.dispatch(split("main", 3000 - i * 10, id)));
    pass(e.dispatch(move([id], 4000, "two")));
    pass(e.dispatch(trim(id, "left", 1)));
    pass(e.dispatch(trim(id, "right", -1)));
  }
  const final = e.getSnapshot().clips;
  assert.equal(final.length, 251);
  assert.equal(final[0].duration, 500);
  for (const c of final.slice(1)) {
    const source = 3000 - Number(c.id.slice(5)) * 10 + 1;
    assert.deepEqual(
      [c.trackId, c.start, c.duration, c.contentIn],
      ["two", source + 4000, 8, source + 100],
    );
  }
  for (let i = 0; i < 1000; i++) pass(e.history.undo());
  assert.deepEqual(e.getSnapshot().clips, initial.clips);
  for (let i = 0; i < 1000; i++) pass(e.history.redo());
  assert.deepEqual(e.getSnapshot().clips, final);
  assert.equal(e.getSnapshot().revision, 3000);
});
