import assert from "node:assert/strict";
import test from "node:test";
import { commands, createEditor } from "@lumen-timeline/core";
import type { EditCommand, Editor, Project } from "@lumen-timeline/core";
import { commit, pass } from "./support.ts";
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
const take = { assetId: "x", streamId: "s", sourceAtContentZero: 0 };

test("an editor names the IDs it generates after its actor, with one counter", () => {
  const e = createEditor({ project: project(), actor: "ana" });
  const split = commit(e.dispatch(commands.splitClip({ clipId: "line", at: 200 })));
  assert.deepEqual(split.createdIds, ["ana-1"]);
  const marker = commit(e.dispatch(commands.addMarker({ start: 5 })));
  assert.equal(marker.markerPatches[0]?.id, "ana-2");
  const added = commit(e.dispatch(commands.addTake({ clipIds: ["line"], take })));
  assert.equal(added.takePatches[0]?.id, "ana-3");
  const copied = commit(
    e.dispatch(commands.updateTake({ takeId: "a", clipIds: ["ana-1"], label: "Right" })),
  );
  assert.equal(copied.takePatches[0]?.id, "ana-4");
  // An ID the project already uses is skipped.
  commit(e.dispatch(commands.addMarker({ id: "ana-5", start: 6 })));
  assert.equal(commit(e.dispatch(commands.addMarker({ start: 7 }))).markerPatches[0]?.id, "ana-6");
});

test("a reopened project continues each actor's counter", () => {
  const p = project();
  p.clips.push({ id: "ana-7", trackId: "mix", kind: "audio", start: 0, duration: 5, contentIn: 0 });
  p.markers = [
    { id: "ana-12", start: 1 },
    { id: "ana-x", start: 2 },
    { id: "ana-013", start: 3 },
    { id: "ben-40", start: 4 },
  ];
  p.takes?.push({ id: "ana-9", ...take });
  const split = (e: Editor): readonly string[] =>
    commit(e.dispatch(commands.splitClip({ clipId: "line", at: 200 }))).createdIds;
  assert.deepEqual(split(createEditor({ project: p, actor: "ana" })), ["ana-13"]);
  assert.deepEqual(split(createEditor({ project: p, actor: "ben" })), ["ben-41"]);
  assert.deepEqual(split(createEditor({ project: p, actor: "cy" })), ["cy-1"]);
  // Clips and takes count as well as markers.
  const byClip = project();
  byClip.clips.push({
    id: "ana-7",
    trackId: "mix",
    kind: "audio",
    start: 0,
    duration: 5,
    contentIn: 0,
  });
  assert.deepEqual(split(createEditor({ project: byClip, actor: "ana" })), ["ana-8"]);
  const byTake = project();
  byTake.takes?.push({ id: "ana-9", ...take });
  assert.deepEqual(split(createEditor({ project: byTake, actor: "ana" })), ["ana-10"]);
  for (const actor of ["", 7, null])
    assert.throws(
      // @ts-expect-error -- An actor is a nonempty string.
      () => createEditor({ project: project(), actor }),
      { code: "invalid-id" },
    );
});

test("sessions without an actor draw different ones, with or without randomUUID", () => {
  const split = (): string | undefined =>
    commit(
      createEditor({ project: project() }).dispatch(
        commands.splitClip({ clipId: "line", at: 200 }),
      ),
    ).createdIds[0];
  const first = split();
  assert.match(first ?? "", /^[0-9a-z]{12}-1$/);
  assert.notEqual(first, split());
  const crypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  try {
    const bare = split();
    assert.match(bare ?? "", /^[0-9a-z]{12}-1$/);
    assert.notEqual(bare, split());
  } finally {
    if (crypto) Object.defineProperty(globalThis, "crypto", crypto);
  }
});

test("a commit's commands carry every generated ID and replay elsewhere", () => {
  const e = createEditor({ project: project(), actor: "ana" });
  const dispatched: EditCommand[] = [
    commands.splitClip({ clipId: "line", at: 200 }),
    commands.addMarker({ start: 5, label: "Cut" }),
    commands.addTake({ clipIds: ["line"], take, activate: true }),
    commands.moveClips({ clipIds: ["bed"], delta: 10 }),
  ];
  const result = commit(e.dispatch(dispatched));
  assert.deepEqual(result.commands, [
    // A split is recorded at its content position: 200 - start 100 + contentIn 10.
    { type: "split", clipId: "line", atContent: 110, rightId: "ana-1" },
    { type: "add-marker", start: 5, label: "Cut", id: "ana-2" },
    { type: "add-take", clipIds: ["line"], take: { ...take, id: "ana-3" }, activate: true },
    { type: "move", clipIds: ["bed"], delta: 10 },
  ]);
  // Commands that named their IDs pass through as dispatched.
  assert.equal(result.commands[3], dispatched[3]);
  assert.ok(Object.isFrozen(result.commands) && Object.isFrozen(result.commands[0]));
  const scoped = commit(
    e.dispatch(commands.updateTake({ takeId: "a", clipIds: ["ana-1"], label: "Right" })),
  );
  assert.deepEqual(scoped.commands, [
    { type: "update-take", takeId: "a", clipIds: ["ana-1"], label: "Right", newId: "ana-4" },
  ]);
  // Another session replays them to the same document, whatever its own actor.
  const other = createEditor({ project: project(), actor: "ben" });
  commit(other.dispatch(result.commands));
  commit(other.dispatch(scoped.commands));
  assert.deepEqual(other.getSnapshot(), e.getSnapshot());
  // Undo and redo list one replay of the records they applied.
  const undo = commit(e.history.undo());
  assert.deepEqual(undo.commands, [
    {
      type: "replay",
      clipPatches: undo.clipPatches,
      dataPatches: undo.dataPatches,
      markerPatches: undo.markerPatches,
      takePatches: undo.takePatches,
    },
  ]);
  commit(other.dispatch(undo.commands));
  assert.deepEqual(other.getSnapshot(), e.getSnapshot());
});

// Three sessions take turns at random edits. Each forwards only the commands
// of its commits, and the others replay them. Every snapshot stays identical.
test("seeded sessions converge by replaying each other's commit commands", () => {
  let seed = 3;
  // The high bits of this generator are well mixed; its low bits repeat quickly.
  const random = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return Math.floor((seed / 2147483648) * n);
  };
  const pick = <T>(items: readonly T[]): T | undefined => items[random(items.length)];
  const sessions = ["ana", "ben", "cy"].map((actor) => createEditor({ project: project(), actor }));
  let effective = 0;
  for (let step = 0; step < 600; step++) {
    const author = sessions[random(sessions.length)];
    assert.ok(author);
    const snapshot = author.getSnapshot();
    const clip = pick(snapshot.clips);
    assert.ok(clip);
    const listed = clip.takeIds ?? [];
    const choice = random(8);
    let command: EditCommand;
    if (choice === 0)
      command = commands.splitClip({ clipId: clip.id, at: clip.start + 1 + random(clip.duration) });
    else if (choice === 1) command = commands.addMarker({ start: random(1000) });
    else if (choice === 2)
      command = commands.addTake({ clipIds: [clip.id], take, activate: random(2) === 0 });
    else if (choice === 3 && listed.length)
      command = commands.updateTake({
        takeId: pick(listed) ?? "",
        clipIds: [clip.id],
        label: "L" + step,
      });
    else if (choice === 4 && listed.length)
      command = commands.removeTake({ clipId: clip.id, takeId: pick(listed) ?? "" });
    else if (choice === 5) command = commands.pruneTakes();
    else if (choice === 6)
      command = commands.selectTake({ clipId: clip.id, takeId: pick(listed) ?? null });
    else command = commands.moveClips({ clipIds: [clip.id], delta: random(21) - 10 });
    const result = author.dispatch(command);
    if (!result.ok || result.unchanged) continue;
    effective++;
    for (const session of sessions)
      if (session !== author) pass(session.dispatch(result.commands, { history: "ignore" }));
    for (const session of sessions) assert.deepEqual(session.getSnapshot(), author.getSnapshot());
  }
  assert.ok(effective > 300, "effective edits: " + effective);
  const ids = sessions[0]?.getSnapshot().clips.map((c) => c.id) ?? [];
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.some((id) => id.startsWith("ben-")) && ids.some((id) => id.startsWith("cy-")));
});

test("a split names a content point, which a concurrent move does not change", () => {
  const e = createEditor({ project: project(), actor: "ana" });
  const clipOf = (editor: Editor, id: string) =>
    editor.getSnapshot().clips.find((c) => c.id === id);
  // Content point 60 of a clip that starts at 100 with contentIn 10 is tick 150.
  const cut = commit(
    e.dispatch(commands.splitClip({ clipId: "line", atContent: 60, rightId: "r" })),
  );
  assert.deepEqual(
    [clipOf(e, "line")?.duration, clipOf(e, "r")?.start, clipOf(e, "r")?.contentIn],
    [50, 150, 60],
  );
  // A command that names every field passes through as dispatched.
  assert.deepEqual(cut.commands, [{ type: "split", clipId: "line", atContent: 60, rightId: "r" }]);
  pass(e.history.undo());
  pass(e.history.redo());
  assert.equal(clipOf(e, "r")?.contentIn, 60);

  // Ben moved the clip by 40 ticks while Ana cut it at tick 150. Replaying her
  // recorded command cuts the same content point, now at tick 190.
  const ana = createEditor({ project: project(), actor: "ana" });
  const ben = createEditor({ project: project(), actor: "ben" });
  const sent = commit(ana.dispatch(commands.splitClip({ clipId: "line", at: 150 }))).commands;
  assert.deepEqual(sent, [{ type: "split", clipId: "line", atContent: 60, rightId: "ana-1" }]);
  commit(ben.dispatch(commands.moveClips({ clipIds: ["line"], delta: 40 })));
  commit(ben.dispatch(sent));
  assert.deepEqual(
    [clipOf(ben, "ana-1")?.start, clipOf(ben, "ana-1")?.contentIn, clipOf(ben, "line")?.duration],
    [190, 60, 50],
  );
  // Within one transaction, the content point follows the staged clip.
  const t = createEditor({ project: project(), actor: "ana" });
  const both = commit(
    t.dispatch([
      commands.trimClip({ clipId: "line", edge: "left", delta: 20 }),
      commands.splitClip({ clipId: "line", at: 150, rightId: "r" }),
    ]),
  );
  assert.deepEqual(both.commands[1], {
    type: "split",
    clipId: "line",
    atContent: 60,
    rightId: "r",
  });

  // The cut lies strictly between the content edges [10, 210), named one way only.
  const code = (args: { readonly at?: number; readonly atContent?: number }) => {
    const result = createEditor({ project: project() }).dispatch(
      // @ts-expect-error -- A JavaScript host can name both forms of the cut, or neither.
      { type: "split", clipId: "line", ...args },
    );
    return result.ok ? "ok" : result.code;
  };
  assert.deepEqual(
    [{ atContent: 11 }, { atContent: 209 }, { atContent: 10 }, { atContent: 210 }].map(code),
    ["ok", "ok", "invalid-range", "invalid-range"],
  );
  assert.equal(code({ atContent: 59.5 }), "invalid-range");
  assert.equal(code({ at: 150, atContent: 60 }), "invalid-range");
  assert.equal(code({}), "invalid-range");
  // @ts-expect-error -- A split names one form of its cut.
  commands.splitClip({ clipId: "line", at: 150, atContent: 60 });
});
