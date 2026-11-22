import assert from "node:assert/strict";
import test from "node:test";
import { commands, createEditor } from "@lumen-timeline/core";
import type {
  EditCommand,
  EditCommit,
  EditResult,
  Editor,
  Project,
  ProjectSnapshot,
} from "@lumen-timeline/core";
import { commit, pass } from "./support.ts";
import type { Draft } from "./support.ts";

// An editor opens a snapshot that an editor issued by taking its records as
// they are. These tests hold that against opening a JSON copy of the same
// snapshot, which is parsed, validated and copied.

const take = (id: string, assetId: string) => ({
  id,
  assetId,
  streamId: "mono",
  sourceAtContentZero: 0,
});
const project = (): Draft<Project> => ({
  schemaVersion: 1,
  duration: 4000,
  // A field the editor does not interpret.
  title: "Episode 4",
  tracks: [{ id: "voice", overlap: "exclusive" }, { id: "mix" }, { id: "spare" }],
  clips: [
    {
      id: "line",
      trackId: "voice",
      kind: "audio",
      start: 100,
      duration: 200,
      contentIn: 10,
      takeIds: ["a", "b"],
      activeTakeId: "a",
      extensions: { color: { hue: 12 } },
    },
    {
      id: "reply",
      trackId: "voice",
      kind: "audio",
      start: 600,
      duration: 300,
      contentIn: 0,
      // A take that two clips list.
      takeIds: ["b"],
      activeTakeId: null,
    },
    { id: "close", trackId: "voice", kind: "audio", start: 1500, duration: 200, contentIn: 40 },
    {
      id: "bed",
      trackId: "mix",
      kind: "audio",
      start: 0,
      duration: 2500,
      contentIn: 0,
      takeIds: ["m"],
      activeTakeId: "m",
    },
    { id: "sting", trackId: "mix", kind: "audio", start: 300, duration: 150, contentIn: 5 },
  ],
  takes: [take("a", "line-a"), take("b", "line-b"), take("m", "music"), take("spare", "unused")],
  markers: [
    { id: "intro", start: 50 },
    { id: "act", start: 900, label: "Act" },
  ],
  entityData: { note: { line: { text: "first" } } },
});

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** A seeded generator. Its high bits are well mixed; its low bits repeat quickly. */
function seeded(seed: number): (n: number) => number {
  let state = seed;
  return (n) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return Math.floor((state / 2147483648) * n);
  };
}

type Action = "undo" | "redo" | EditCommand;
const act = (editor: Editor, action: Action): EditResult =>
  action === "undo"
    ? editor.history.undo()
    : action === "redo"
      ? editor.history.redo()
      : editor.dispatch(action);

/** An edit, undo or redo for this document. Some are refused, which twins must agree on too. */
function randomAction(snapshot: ProjectSnapshot, random: (n: number) => number): Action {
  const clip = snapshot.clips[random(snapshot.clips.length)];
  assert.ok(clip);
  const listed = clip.takeIds ?? [];
  const takes = snapshot.takes ?? [];
  const markers = snapshot.markers ?? [];
  const someTake = takes[random(takes.length)]?.id ?? "none";
  const someMarker = markers[random(markers.length)]?.id ?? "none";
  const tracks = ["voice", "mix", "spare"];
  switch (random(18)) {
    case 0:
      return "undo";
    case 1:
      return "redo";
    case 2:
    case 3:
      return commands.splitClip({ clipId: clip.id, at: clip.start + 1 + random(clip.duration) });
    case 4:
      return commands.addMarker({ start: random(4000), label: "M" + random(9) });
    case 5:
      return commands.addTake({
        clipIds: [clip.id],
        take: {
          assetId: "new" + random(4),
          streamId: "mono",
          sourceAtContentZero: random(9),
          extensions: { review: { marks: [random(3), { by: "ana" }] } },
        },
        activate: random(2) === 0,
      });
    case 6:
      // The last clip to list a take may not give it up while the take stays.
      return commands.removeTake({ clipId: clip.id, takeId: listed[random(listed.length)] ?? "a" });
    case 7:
      return commands.setEntityData({
        scope: "note",
        id: clip.id,
        key: "text",
        value: random(2) ? "n" + random(50) : { lines: ["n" + random(5), { bold: true }] },
      });
    case 8:
      return commands.removeEntityData({ scope: "note", id: clip.id, key: "text" });
    case 9:
      return commands.trimClip({
        clipId: clip.id,
        edge: random(2) ? "left" : "right",
        delta: random(41) - 20,
      });
    case 10:
      return commands.selectTake({
        clipId: clip.id,
        takeId: random(3) ? (listed[random(listed.length)] ?? someTake) : null,
      });
    case 11:
      return commands.updateTake({ takeId: someTake, label: "L" + random(9) });
    case 12:
      return commands.pruneTakes({});
    case 13:
      return commands.moveMarker({ markerId: someMarker, delta: random(61) - 30 });
    case 14:
      return commands.removeMarker({ markerId: someMarker });
    case 15:
      return commands.reorderTakes({ clipId: clip.id, takeIds: listed.toReversed() });
    case 16:
      // Onto another track, where an exclusive one may refuse the overlap.
      return commands.moveClips({
        clipIds: [clip.id],
        delta: random(201) - 100,
        trackId: tracks[random(3)],
      });
    default:
      return commands.moveClips({ clipIds: [clip.id], delta: random(81) - 40 });
  }
}

function assertFrozen(value: unknown, path: string): void {
  if (typeof value !== "object" || value === null) return;
  assert.ok(Object.isFrozen(value), path + " is not frozen");
  for (const [key, item] of Object.entries(value)) assertFrozen(item, path + "." + key);
}

/** Everything a view or planner reads of the current snapshot. */
function reads(editor: Editor): unknown {
  const snapshot = editor.getSnapshot();
  const read = editor.read();
  const all = { start: 0, end: 4000 };
  return {
    clips: read.clipsIn(all),
    voice: read.clipsIn(all, { trackIds: ["voice"] }),
    takes: snapshot.clips.map((clip) => read.takesOf(clip.id)),
    listings: (snapshot.takes ?? []).map((item) => read.clipsListing(item.id)),
    markers: read.markersIn(all),
    selection: editor.session.getSelection(),
  };
}

/** A document's records. The clip list's order is left out, which no patch carries. */
function records({ revision: _revision, ...document }: ProjectSnapshot): unknown {
  return { ...document, clips: document.clips.toSorted((a, b) => (a.id < b.id ? -1 : 1)) };
}

const depths = ({ history }: Editor): unknown => ({
  undo: history.undoDepth,
  redo: history.redoDepth,
  bytes: history.estimatedBytes,
});

/** Two editors that must be indistinguishable take the same action. */
function together(a: Editor, b: Editor, action: Action, context: string): EditResult {
  const result = act(a, action);
  assert.deepEqual(result, act(b, action), context + ": the results differ");
  assert.deepEqual(a.getSnapshot(), b.getSnapshot(), context + ": the snapshots differ");
  assert.deepEqual(reads(a), reads(b), context + ": the reads differ");
  assert.deepEqual(depths(a), depths(b), context + ": the histories differ");
  return result;
}

test("an editor opens another editor's snapshot by its records, and then edits as over a copy", () => {
  let committed = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const random = seeded(seed);
    // `source` and `mirror` take the same edits; only `source` has its snapshot opened.
    const source = createEditor({ project: project(), actor: "src" });
    const mirror = createEditor({ project: project(), actor: "src" });
    for (let step = 0; step < 25; step++)
      together(source, mirror, randomAction(source.getSnapshot(), random), `seed ${seed} before`);

    const issued = source.getSnapshot();
    const opened = createEditor({ project: issued, actor: "ana" });
    const copied = createEditor({ project: json(issued), actor: "ana" });
    assert.equal(opened.getSnapshot().clips, issued.clips, "the clip list was copied");
    assert.equal(opened.getSnapshot().takes, issued.takes, "the take list was copied");
    assert.deepEqual(opened.getSnapshot(), copied.getSnapshot());
    assert.deepEqual(reads(opened), reads(copied));

    // Each pair goes its own way. Neither editor of a pair may see the other pair's edits.
    for (let step = 0; step < 90; step++) {
      const context = `seed ${seed} step ${step}`;
      if (random(2)) together(source, mirror, randomAction(source.getSnapshot(), random), context);
      const result = together(opened, copied, randomAction(opened.getSnapshot(), random), context);
      if (result.ok && !result.unchanged) committed++;
      assertFrozen(opened.getSnapshot(), "snapshot");
    }
    // The snapshot both opened is as it was, and still reads as it did.
    assert.deepEqual(issued, json(issued));
    assert.deepEqual(
      issued.clips.map((clip) => source.read(issued).takesOf(clip.id)),
      issued.clips.map((clip) =>
        (clip.takeIds ?? []).map((id) => issued.takes?.find((item) => item.id === id)),
      ),
    );
  }
  // The random edits are not all refused.
  assert.ok(committed > 300, `${committed} edits committed`);
});

test("a replacement by an editor's snapshot is the replacement by a copy of it", () => {
  let replaced = 0;
  let unchanged = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const random = seeded(seed * 31);
    const confirmed = createEditor({ project: project(), actor: "seq" });
    // The same editor twice: one is handed snapshots, the other JSON copies of them.
    const handed = createEditor({ project: project(), actor: "ana" });
    const copied = createEditor({ project: project(), actor: "ana" });
    const seen: EditCommit[][] = [[], []];
    for (const [index, editor] of [handed, copied].entries())
      editor.subscribe(
        (snapshot) => snapshot,
        (_snapshot, change) => seen[index]?.push(change),
      );
    // An editor that is never replaced: it replays the commands of every
    // commit, so a replacement's patches must describe all that it changed.
    const follower = createEditor({ project: project(), actor: "fol" });
    handed.subscribe(
      (snapshot) => snapshot,
      (_snapshot, change) => pass(follower.dispatch(change.commands, { history: "ignore" })),
    );
    // Snapshots `handed` issued earlier, to go back to.
    const kept: ProjectSnapshot[] = [];
    for (let round = 0; round < 45; round++) {
      const context = `seed ${seed} round ${round}`;
      for (let n = random(3); n > 0; n--)
        act(confirmed, randomAction(confirmed.getSnapshot(), random));
      // Edits of its own, as a session's pending ones, and their undo and redo.
      for (let n = random(3); n > 0; n--)
        together(handed, copied, randomAction(handed.getSnapshot(), random), context);

      const back = kept.length > 0 && random(5) === 0;
      const target = back ? kept[random(kept.length)] : confirmed.getSnapshot();
      assert.ok(target);
      const result = handed.replace(target);
      assert.deepEqual(result, copied.replace(json(target)), context + ": the results differ");
      assert.deepEqual(handed.getSnapshot(), copied.getSnapshot(), context);
      assert.deepEqual(reads(handed), reads(copied), context + ": the reads differ");
      assert.deepEqual(depths(handed), depths(copied), context + ": the histories differ");
      assert.deepEqual(seen[0], seen[1], context + ": the notifications differ");
      assertFrozen(handed.getSnapshot(), "snapshot");
      const { revision: _target, ...document } = target;
      const { revision: _shown, ...shown } = handed.getSnapshot();
      assert.deepEqual(shown, document, context + ": the replacement is not shown");
      assert.deepEqual(
        records(follower.getSnapshot()),
        records(handed.getSnapshot()),
        context + ": the patches do not lead to the replacement",
      );
      if (pass(result).unchanged) unchanged++;
      else replaced++;
      kept.push(handed.getSnapshot());
    }
  }
  assert.ok(replaced > 300 && unchanged > 10, `${replaced} replaced, ${unchanged} unchanged`);
});

test("an editor that took a snapshot keeps the project's bounds", () => {
  const bounded = (): Draft<Project> => ({ ...project(), minClipDuration: 50 });
  const source = createEditor({ project: bounded(), actor: "src" });
  const opened = createEditor({ project: source.getSnapshot(), actor: "ana" });
  const replaced = createEditor({ project: bounded(), actor: "ben" });
  commit(source.dispatch(commands.moveClips({ clipIds: ["sting"], delta: 7 })));
  commit(replaced.replace(source.getSnapshot()));
  for (const editor of [opened, replaced]) {
    // The bed ends at 2,500 of 4,000 ticks, and the sting is 150 ticks long.
    const past = editor.dispatch(commands.moveClips({ clipIds: ["bed"], delta: 1501 }));
    assert.equal(past.ok ? "committed" : past.code, "invalid-range");
    commit(editor.dispatch(commands.moveClips({ clipIds: ["bed"], delta: 1500 })));
    const short = editor.dispatch(
      commands.trimClip({ clipId: "sting", edge: "right", delta: -101 }),
    );
    assert.equal(short.ok ? "committed" : short.code, "invalid-range");
    commit(editor.dispatch(commands.trimClip({ clipId: "sting", edge: "right", delta: -100 })));
    // The voice track still takes no overlap.
    const over = editor.dispatch(commands.moveClips({ clipIds: ["reply"], delta: -350 }));
    assert.equal(over.ok ? "committed" : over.code, "overlap");
  }
});

test("a replacement shares the records it did not change, and an unchanged one notifies nobody", () => {
  const confirmed = createEditor({ project: project(), actor: "seq" });
  const view = createEditor({ project: confirmed.getSnapshot(), actor: "ana" });
  let notified = 0;
  view.subscribe(
    (snapshot) => snapshot,
    () => notified++,
  );
  commit(confirmed.dispatch(commands.moveClips({ clipIds: ["sting"], delta: 7 })));
  const target = confirmed.getSnapshot();
  const result = commit(view.replace(target));
  assert.deepEqual(
    result.clipPatches.map((patch) => patch.id),
    ["sting"],
  );
  const shown = view.getSnapshot();
  // Every other clip, and the lists the move left alone, are the confirmed editor's own.
  assert.deepEqual(
    shown.clips.map((clip, index) => clip === target.clips[index]),
    [true, true, true, true, true],
  );
  assert.equal(shown.takes, target.takes);
  assert.equal(shown.markers, target.markers);
  assert.equal(shown.entityData, target.entityData);
  assert.equal(notified, 1);

  assert.ok(pass(view.replace(target)).unchanged);
  assert.ok(pass(view.replace(shown)).unchanged);
  assert.equal(view.getSnapshot(), shown);
  assert.equal(notified, 1);
});

test("a replacement that remaps a take reports the clips that list it, as the edit did", () => {
  const confirmed = createEditor({ project: project(), actor: "seq" });
  const view = createEditor({ project: confirmed.getSnapshot(), actor: "ana" });
  // Two clips list take `b`. Neither clip changes, and both now play another part of its media.
  const edit = commit(
    confirmed.dispatch(commands.updateTake({ takeId: "b", sourceAtContentZero: 5 })),
  );
  const result = commit(view.replace(confirmed.getSnapshot()));
  assert.deepEqual(result.clipPatches, []);
  assert.deepEqual(
    result.takePatches.map((patch) => patch.id),
    ["b"],
  );
  assert.deepEqual(result.changedIds, ["line", "reply"]);
  assert.deepEqual(result.changedIds, edit.changedIds);
  assert.deepEqual(result.affected, edit.affected);
  assert.deepEqual(
    result.affected.after.map((range) => [range.clipId, range.start, range.end]),
    [
      ["line", 100, 300],
      ["reply", 600, 900],
    ],
  );
  // A clip that the replacement also patches is reported once, where it now lies.
  commit(confirmed.dispatch(commands.updateTake({ takeId: "b", sourceAtContentZero: 9 })));
  commit(confirmed.dispatch(commands.moveClips({ clipIds: ["reply"], delta: 10 })));
  const both = commit(view.replace(confirmed.getSnapshot()));
  assert.deepEqual(both.changedIds, ["reply", "line"]);
  assert.deepEqual(
    both.affected.after.map((range) => [range.clipId, range.start, range.end]),
    [
      ["reply", 610, 910],
      ["line", 100, 300],
    ],
  );
  // A relabeled take plays the same media, so no clip is reported.
  commit(confirmed.dispatch(commands.updateTake({ takeId: "b", label: "Retake" })));
  assert.deepEqual(commit(view.replace(confirmed.getSnapshot())).changedIds, []);
});

test("snapshots without a patch between them still replace when they differ", () => {
  const editor = createEditor({ project: project(), actor: "ana" });
  const seen: EditCommit[] = [];
  editor.subscribe(
    (snapshot) => snapshot,
    (_snapshot, change) => seen.push(change),
  );
  const patches = (change: EditCommit): number =>
    change.clipPatches.length +
    change.dataPatches.length +
    change.markerPatches.length +
    change.takePatches.length;

  // A field the editor does not interpret.
  const titled = json(editor.getSnapshot());
  Reflect.set(titled, "title", "Episode 5");
  const first = commit(editor.replace(titled));
  assert.equal(patches(first), 0);
  assert.equal(editor.getSnapshot()["title"], "Episode 5");

  // The same clips in another order, from another editor's own snapshot.
  const reordered = json(editor.getSnapshot());
  Reflect.set(reordered, "clips", reordered.clips.toReversed());
  const other = createEditor({ project: reordered, actor: "ben" });
  const second = commit(editor.replace(other.getSnapshot()));
  assert.equal(patches(second), 0);
  assert.deepEqual(
    editor.getSnapshot().clips.map((clip) => clip.id),
    ["sting", "bed", "close", "reply", "line"],
  );
  // Reads follow the order the editor now holds.
  assert.deepEqual(
    editor
      .read()
      .takesOf("bed")
      .map((item) => item.id),
    ["m"],
  );
  commit(editor.dispatch(commands.moveClips({ clipIds: ["sting"], delta: 3 })));
  assert.equal(editor.getSnapshot().clips[0]?.start, 303);
  assert.equal(seen.length, 3);
});
