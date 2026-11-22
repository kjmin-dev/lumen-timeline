import assert from "node:assert/strict";
import test from "node:test";
import { commands, createEditor } from "@lumen-timeline/core";
import type { EditCommand, Editor, Project } from "@lumen-timeline/core";
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
    { id: "next", trackId: "voice", kind: "audio", start: 400, duration: 100, contentIn: 0 },
    { id: "bed", trackId: "mix", kind: "audio", start: 0, duration: 900, contentIn: 0 },
  ],
  takes: [{ id: "a", assetId: "line-a", streamId: "s", sourceAtContentZero: 0 }],
});
const take = { assetId: "x", streamId: "s", sourceAtContentZero: 0 };
// Commands travel as JSON between editors, which drops undefined fields.
const wire = (list: readonly EditCommand[]): EditCommand[] => JSON.parse(JSON.stringify(list));

test("undo and redo commits carry a replay that another editor applies", () => {
  const ana = createEditor({ project: project(), actor: "ana" });
  const ben = createEditor({ project: project(), actor: "ben" });
  const edit = commit(
    ana.dispatch([
      commands.splitClip({ clipId: "line", at: 200 }),
      commands.addMarker({ start: 5, label: "Cut" }),
      commands.addTake({ clipIds: ["line"], take, activate: true }),
      commands.setEntityData({ scope: "line", id: "line", key: "text", value: "Hello" }),
    ]),
  );
  commit(ben.dispatch(wire(edit.commands), { history: "ignore" }));
  for (const step of [() => ana.history.undo(), () => ana.history.redo()]) {
    const result = commit(step());
    const [replay] = result.commands;
    assert.equal(result.commands.length, 1);
    assert.deepEqual(replay, {
      type: "replay",
      clipPatches: result.clipPatches,
      dataPatches: result.dataPatches,
      markerPatches: result.markerPatches,
      takePatches: result.takePatches,
    });
    const applied = commit(ben.dispatch(wire(result.commands), { history: "ignore" }));
    assert.deepEqual(ben.getSnapshot(), ana.getSnapshot());
    // The replayed commit reports the same changes and lists the records it applied.
    assert.deepEqual(applied.changedIds, result.changedIds);
    assert.deepEqual(wire(applied.commands), wire(result.commands));
  }
  // A recorded replay is one undoable edit of the editor that applied it.
  const before = ben.getSnapshot();
  const undo = commit(ana.history.undo());
  commit(ben.dispatch(undo.commands));
  assert.equal(ben.history.undoDepth, 1);
  commit(ben.history.undo());
  assert.deepEqual(ben.getSnapshot().clips, before.clips);
  assert.deepEqual(ben.getSnapshot().entityData, before.entityData);
});

// Three sessions take turns at random edits, undos and redos of their own
// history. Each forwards only the commands of its commits, through JSON, and
// the others replay them. Every snapshot stays identical.
test("seeded sessions converge through edits, undos and redos by forwarding commands", () => {
  let seed = 11;
  // The high bits of this generator are well mixed; its low bits repeat quickly.
  const random = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return Math.floor((seed / 2147483648) * n);
  };
  const pick = <T>(items: readonly T[]): T | undefined => items[random(items.length)];
  const sessions = ["ana", "ben", "cy"].map((actor) => createEditor({ project: project(), actor }));
  const counts = { edit: 0, undo: 0, redo: 0, conflict: 0 };
  for (let step = 0; step < 900; step++) {
    const author = sessions[random(sessions.length)];
    assert.ok(author);
    const snapshot = author.getSnapshot();
    const clip = pick(snapshot.clips);
    assert.ok(clip);
    const listed = clip.takeIds ?? [];
    const choice = random(12);
    let kind: "edit" | "undo" | "redo" = "edit";
    let result;
    if (choice < 3) {
      kind = "undo";
      result = author.history.undo();
    } else if (choice < 5) {
      kind = "redo";
      result = author.history.redo();
    } else {
      let command: EditCommand;
      if (choice === 5)
        command = commands.splitClip({
          clipId: clip.id,
          at: clip.start + 1 + random(clip.duration),
        });
      else if (choice === 6) command = commands.addMarker({ start: random(1000) });
      else if (choice === 7)
        command = commands.addTake({ clipIds: [clip.id], take, activate: random(2) === 0 });
      else if (choice === 8 && listed.length)
        command = commands.removeTake({ clipId: clip.id, takeId: pick(listed) ?? "" });
      else if (choice === 9)
        command = commands.setEntityData({
          scope: "note",
          id: clip.id,
          key: "text",
          value: "n" + step,
        });
      else if (choice === 10)
        command = commands.trimClip({
          clipId: clip.id,
          edge: random(2) ? "left" : "right",
          delta: random(21) - 10,
        });
      else command = commands.moveClips({ clipIds: [clip.id], delta: random(21) - 10 });
      result = author.dispatch(command);
    }
    if (!result.ok) {
      if (result.code === "history-conflict") counts.conflict++;
      continue;
    }
    if (result.unchanged) continue;
    counts[kind]++;
    for (const session of sessions)
      if (session !== author) pass(session.dispatch(wire(result.commands), { history: "ignore" }));
    for (const session of sessions) assert.deepEqual(session.getSnapshot(), author.getSnapshot());
  }
  assert.ok(counts.edit > 300 && counts.undo > 60 && counts.redo > 30, JSON.stringify(counts));
  assert.ok(counts.conflict > 0, "no undo met a concurrent change: " + JSON.stringify(counts));
});

test("a replay that conflicts is rejected whole", () => {
  const ana = createEditor({ project: project(), actor: "ana" });
  const ben = createEditor({ project: project(), actor: "ben" });
  const edit = commit(
    ana.dispatch([
      commands.moveClips({ clipIds: ["line"], delta: 20 }),
      commands.setEntityData({ scope: "line", id: "line", key: "text", value: "Hello" }),
    ]),
  );
  commit(ben.dispatch(edit.commands, { history: "ignore" }));
  const undo = commit(ana.history.undo());
  // Ben moves the same clip before Ana's undo arrives. Its data record alone
  // would still apply, but the replay is rejected whole.
  commit(ben.dispatch(commands.moveClips({ clipIds: ["line"], delta: 5 })));
  const before = ben.getSnapshot();
  const result = ben.dispatch(undo.commands);
  assert.equal(codeOf(result), "history-conflict");
  assert.equal(ben.getSnapshot(), before);

  // A replay whose result breaks a rule is a conflict too: here, an overlap.
  const carol = createEditor({ project: project(), actor: "carol" });
  const back = commit(carol.dispatch(commands.moveClips({ clipIds: ["next"], delta: 200 })));
  commit(carol.dispatch(commands.moveClips({ clipIds: ["line"], delta: 200 })));
  const replay = commands.replay({ clipPatches: back.inverseClipPatches });
  assert.equal(codeOf(carol.dispatch(replay)), "history-conflict");
});

test("a replay forms a transaction by itself, and malformed records are refused", () => {
  const e: Editor = createEditor({ project: project(), actor: "ana" });
  const moved = commit(e.dispatch(commands.moveClips({ clipIds: ["bed"], delta: 10 })));
  const good = commands.replay({ clipPatches: moved.inverseClipPatches });
  const before = e.getSnapshot();
  const line = before.clips[0];
  assert.ok(line);
  const malformed: unknown[] = [
    [good, commands.moveClips({ clipIds: ["bed"], delta: 1 })],
    [commands.moveClips({ clipIds: ["bed"], delta: 1 }), good],
    { type: "replay", clipPatches: "x" },
    { type: "replay", clipPatches: [{ before: line, after: line }] },
    { type: "replay", clipPatches: [{ id: "line" }] },
    { type: "replay", clipPatches: [{ id: "other", before: line, after: line }] },
    {
      type: "replay",
      clipPatches: [{ id: "line", before: line, after: { ...line, duration: -1 } }],
    },
    { type: "replay", clipPatches: [{ id: "z", after: { ...line, id: "z" }, follows: "" }] },
    { type: "replay", markerPatches: [{ id: "m", after: { id: "m", start: -5 } }] },
    { type: "replay", takePatches: [{ id: "t", after: { id: "t", assetId: "" } }] },
    { type: "replay", dataPatches: [{ scope: "s", id: "i", after: 1 }] },
    { type: "replay", dataPatches: [{ scope: "s", id: "i", key: "k", after: Number.NaN }] },
  ];
  for (const input of malformed) {
    // @ts-expect-error -- Malformed input, as an unchecked host or a peer may send.
    const result = e.dispatch(input);
    assert.equal(codeOf(result), "invalid-replay", JSON.stringify(input));
    assert.equal(e.getSnapshot(), before);
  }
  // An empty replay changes nothing, and a well-formed one applies.
  assert.ok(pass(e.dispatch(commands.replay({}))).unchanged);
  commit(e.dispatch(good));
  assert.equal(e.getSnapshot().clips[2]?.start, 0);
});
