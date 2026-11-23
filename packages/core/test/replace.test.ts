import assert from "node:assert/strict";
import test from "node:test";
import { commands, createEditor } from "@lumen-timeline/core";
import type { EditCommit, Project, ProjectSnapshot } from "@lumen-timeline/core";
import { codeOf, commit, pass } from "./support.ts";
import type { Draft } from "./support.ts";

const project = (): Draft<Project> => ({
  schemaVersion: 1,
  duration: 1000,
  tracks: [{ id: "voice", overlap: "exclusive" }, { id: "mix" }],
  clips: [
    {
      id: "line",
      trackId: "voice",
      kind: "audio",
      start: 100,
      duration: 200,
      contentIn: 10,
      takeIds: ["a"],
      activeTakeId: "a",
    },
    { id: "bed", trackId: "mix", kind: "audio", start: 0, duration: 900, contentIn: 0 },
  ],
  takes: [{ id: "a", assetId: "line-a", streamId: "s", sourceAtContentZero: 0 }],
});
// A JSON copy, as a snapshot arrives from storage or another participant.
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const withoutRevision = ({ revision: _revision, ...rest }: ProjectSnapshot): unknown => json(rest);
const lineOf = (snapshot: ProjectSnapshot) => snapshot.clips.find((c) => c.id === "line");

test("a replacement notifies once, prunes the selection and keeps history", () => {
  const ana = createEditor({ project: project(), actor: "ana" });
  const old = ana.getSnapshot();
  commit(ana.dispatch(commands.splitClip({ clipId: "line", at: 200 })));
  ana.session.select(["ana-1", "bed"]);
  const seen: EditCommit[] = [];
  let historyCalls = 0;
  const selections: (readonly string[])[] = [];
  ana.subscribe(
    (s) => s,
    (_value, change) => seen.push(change),
  );
  ana.history.subscribe(() => historyCalls++);
  ana.session.subscribeSelection((ids) => selections.push(ids));

  // Another editor's document: the bed moved, a marker and a data field were added.
  const ben = createEditor({ project: project(), actor: "ben" });
  commit(ben.dispatch(commands.moveClips({ clipIds: ["bed"], delta: 10 })));
  commit(ben.dispatch(commands.addMarker({ id: "m", start: 50 })));
  commit(ben.dispatch(commands.setEntityData({ scope: "s", id: "bed", key: "k", value: 1 })));
  const target = ben.getSnapshot();
  const before = ana.getSnapshot();
  const result = commit(ana.replace(json(target)));

  assert.equal(result.history, "replace");
  // Ben's revision, 3, is later than Ana's next one, 2.
  assert.equal(result.revision, 3);
  assert.equal(before.revision, 1);
  assert.deepEqual(withoutRevision(ana.getSnapshot()), withoutRevision(target));
  assert.deepEqual(seen, [result]);
  assert.deepEqual([...result.changedIds].sort(), ["ana-1", "bed", "line"]);
  assert.deepEqual(result.createdIds, []);
  assert.deepEqual(
    result.markerPatches.map((p) => p.id),
    ["m"],
  );
  assert.deepEqual(
    result.dataPatches.map((p) => [p.id, p.key, p.after]),
    [["bed", "k", 1]],
  );
  assert.deepEqual(selections, [["bed"]]);
  assert.equal(historyCalls, 0);
  assert.equal(ana.history.undoDepth, 1);
  // Its commands carry the difference: replayed on the old document, they reach the new one.
  const replayed = createEditor({ project: json(before), actor: "cy" });
  commit(replayed.dispatch(json(result.commands)));
  assert.deepEqual(withoutRevision(replayed.getSnapshot()), withoutRevision(target));
  // The split's entry replays against the new document, which lacks its clip.
  const undo = ana.history.undo();
  assert.equal(codeOf(undo), "history-conflict");
  assert.equal(ana.history.undoDepth, 1);
  // The revision only moves forward: a later snapshot keeps its own.
  const later = { ...target, revision: 50 };
  commit(ana.replace(json({ ...later, markers: [] })));
  assert.equal(ana.getSnapshot().revision, 50);
  // An identical document changes nothing.
  assert.ok(pass(ana.replace(json(ana.getSnapshot()))).unchanged);
  assert.deepEqual(old.clips.length, 2);
});

test("an edit's history entry still undoes after a replacement that kept its fields", () => {
  const ana = createEditor({ project: project(), actor: "ana" });
  const edit = commit(ana.dispatch(commands.moveClips({ clipIds: ["bed"], delta: 5 })));
  // The confirmed document holds the edit and someone else's marker.
  const confirmed = createEditor({ project: project(), actor: "seq" });
  commit(confirmed.dispatch(edit.commands));
  commit(confirmed.dispatch(commands.addMarker({ id: "m", start: 10 })));
  commit(ana.replace(confirmed.getSnapshot()));
  commit(ana.history.undo());
  assert.equal(ana.getSnapshot().clips[1]?.start, 0);
  assert.deepEqual(
    ana.getSnapshot().markers?.map((m) => m.id),
    ["m"],
  );
});

test("a replacement moves the ID counter past the snapshot and never back", () => {
  const ana = createEditor({ project: project(), actor: "ana" });
  const original = ana.getSnapshot();
  const cut = commit(ana.dispatch(commands.splitClip({ clipId: "line", at: 200 })));
  assert.deepEqual(cut.createdIds, ["ana-1"]);
  // The split was dropped: the replacement lacks it, and its ID is not issued again.
  commit(ana.replace(original));
  const again = commit(ana.dispatch(commands.splitClip({ clipId: "line", at: 150 })));
  assert.deepEqual(again.createdIds, ["ana-2"]);
  // A snapshot that holds a later ID of this actor moves the counter past it.
  const moved: Draft<Project> = JSON.parse(JSON.stringify(ana.getSnapshot()));
  const right = moved.clips.find((c) => c.id === "ana-2");
  assert.ok(right);
  right.id = "ana-7";
  commit(ana.replace(moved));
  const third = commit(ana.dispatch(commands.addMarker({ start: 1 })));
  assert.deepEqual(
    third.markerPatches.map((p) => p.id),
    ["ana-8"],
  );
});

test("a foreign or invalid snapshot is refused and changes nothing", () => {
  const ana = createEditor({ project: project(), actor: "ana" });
  const before = ana.getSnapshot();
  let notified = 0;
  ana.subscribe(
    (s) => s,
    () => notified++,
  );
  const foreign: Draft<Project>[] = [
    { ...project(), duration: 2000 },
    { ...project(), minClipDuration: 5 },
  ];
  for (const snapshot of foreign) assert.equal(codeOf(ana.replace(snapshot)), "foreign-snapshot");
  const named = createEditor({ project: { ...project(), id: "proj-a" }, actor: "ana" });
  assert.equal(codeOf(named.replace({ ...project(), id: "proj-b" })), "foreign-snapshot");
  const overlap = project();
  const second = overlap.clips[1];
  assert.ok(second);
  second.trackId = "voice";
  assert.equal(codeOf(ana.replace(overlap)), "overlap");
  // @ts-expect-error -- An unchecked host may pass anything.
  assert.equal(codeOf(ana.replace({ schemaVersion: 2 })), "unsupported-schema");
  assert.equal(ana.getSnapshot(), before);
  assert.equal(notified, 0);
});

test("a replayed edit takes over its history entry, so undo reverses what it did after the replay", () => {
  const ana = createEditor({ project: project(), actor: "ana" });
  const ben = createEditor({ project: project(), actor: "ben" });
  // Ana moves the line by 20 while Ben, first in order, moves it by 5.
  const pending = commit(ana.dispatch(commands.moveClips({ clipIds: ["line"], delta: 20 })));
  commit(ben.dispatch(commands.moveClips({ clipIds: ["line"], delta: 5 })));
  // Ana adopts Ben's document and replays her edit on top of it.
  commit(ana.replace(ben.getSnapshot()));
  const replayed = commit(ana.dispatch(pending.commands, { rebases: pending }));
  assert.equal(replayed.history, "ignore");
  assert.equal(lineOf(ana.getSnapshot())?.start, 125);
  assert.equal(ana.history.undoDepth, 1);
  // Ben moves it again by 3 before Ana's edit is confirmed: a second rebuild
  // rebases the rebased commit, whose entry follows again.
  commit(ben.dispatch(commands.moveClips({ clipIds: ["line"], delta: 3 })));
  commit(ana.replace(ben.getSnapshot()));
  const again = commit(ana.dispatch(pending.commands, { rebases: replayed }));
  assert.equal(lineOf(ana.getSnapshot())?.start, 128);
  // Undo returns to Ben's position, not to where Ana's edit started.
  commit(ana.history.undo());
  assert.equal(lineOf(ana.getSnapshot())?.start, 108);
  commit(ana.history.redo());
  assert.equal(lineOf(ana.getSnapshot())?.start, 128);

  // An edit undone before either was confirmed: both replay, and the entry
  // that the undo moved takes the undo's records, so redo still works.
  const carol = createEditor({ project: project(), actor: "carol" });
  const edit = commit(carol.dispatch(commands.moveClips({ clipIds: ["bed"], delta: 30 })));
  const undo = commit(carol.history.undo());
  const confirmed = createEditor({ project: project(), actor: "seq" });
  commit(confirmed.dispatch(commands.trimClip({ clipId: "bed", edge: "right", delta: -100 })));
  commit(carol.replace(confirmed.getSnapshot()));
  let edited = commit(carol.dispatch(edit.commands, { rebases: edit }));
  let undone = commit(carol.dispatch(undo.commands, { rebases: undo }));
  // A second rebuild rebases the rebased commits, and each entry keeps its direction.
  commit(confirmed.dispatch(commands.addMarker({ id: "m", start: 1 })));
  commit(carol.replace(confirmed.getSnapshot()));
  edited = commit(carol.dispatch(edit.commands, { rebases: edited }));
  undone = commit(carol.dispatch(undo.commands, { rebases: undone }));
  assert.equal(undone.history, "ignore");
  assert.deepEqual(
    [carol.getSnapshot().clips[1]?.start, carol.getSnapshot().clips[1]?.duration],
    [0, 800],
  );
  assert.deepEqual([carol.history.undoDepth, carol.history.redoDepth], [0, 1]);
  commit(carol.history.redo());
  assert.deepEqual(
    [carol.getSnapshot().clips[1]?.start, carol.getSnapshot().clips[1]?.duration],
    [30, 800],
  );
  // When the other edit wrote the field the undo restores, the undo's replay
  // conflicts here exactly as it will where the edits are ordered.
  const dan = createEditor({ project: project(), actor: "dan" });
  const move = commit(dan.dispatch(commands.moveClips({ clipIds: ["bed"], delta: 30 })));
  const back = commit(dan.history.undo());
  commit(confirmed.dispatch(commands.moveClips({ clipIds: ["bed"], delta: 7 })));
  commit(dan.replace(confirmed.getSnapshot()));
  commit(dan.dispatch(move.commands, { rebases: move }));
  assert.equal(codeOf(dan.dispatch(back.commands, { rebases: back })), "history-conflict");

  // `rebases` records nothing of its own and refuses a history policy.
  assert.equal(
    codeOf(ana.dispatch(pending.commands, { rebases: pending, history: "record" })),
    "invalid-history-policy",
  );
  // An entry that is gone leaves history as it is.
  ana.history.clear();
  commit(ana.dispatch(commands.moveClips({ clipIds: ["line"], delta: 1 }), { rebases: again }));
  assert.deepEqual([ana.history.undoDepth, ana.history.redoDepth], [0, 0]);
});
