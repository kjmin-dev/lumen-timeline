import assert from "node:assert/strict";
import test from "node:test";
import { commands, createEditor } from "@lumen-timeline/core";
import type { GateDecision, GatedTransaction, Project } from "@lumen-timeline/core";
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

/** An editor whose gate answers with `decision` and records what it saw. */
function gated() {
  const editor = createEditor({ project: project(), actor: "ana" });
  const seen: GatedTransaction[] = [];
  let decision: GateDecision = "commit";
  editor.setGate((transaction) => {
    seen.push(transaction);
    return decision;
  });
  let notified = 0;
  editor.subscribe(
    (s) => s,
    () => notified++,
  );
  return {
    editor,
    seen,
    decide: (next: GateDecision) => {
      decision = next;
    },
    notified: () => notified,
  };
}

test("a gate sees each validated transaction with its commands and targets", () => {
  const { editor, seen } = gated();
  const result = commit(
    editor.dispatch([
      commands.splitClip({ clipId: "line", at: 200 }),
      commands.addMarker({ start: 5 }),
      commands.updateTake({ takeId: "a", label: "A" }),
      commands.setEntityData({ scope: "s", id: "bed", key: "k", value: 1 }),
      commands.setEntityData({ scope: "s", id: "bed", key: "j", value: 2 }),
    ]),
  );
  assert.deepEqual(seen, [
    {
      history: "record",
      commands: result.commands,
      targets: {
        clipIds: ["line", "ana-1"],
        markerIds: ["ana-2"],
        takeIds: ["a"],
        entities: [{ scope: "s", id: "bed" }],
      },
      revision: 1,
    },
  ]);
  // Undo and redo reach it with one replay command; unchanged and invalid
  // transactions never do.
  commit(editor.history.undo());
  commit(editor.history.redo());
  assert.deepEqual(
    seen.slice(1).map((t) => [t.history, t.commands.map((c) => c.type)]),
    [
      ["undo", ["replay"]],
      ["redo", ["replay"]],
    ],
  );
  assert.ok(pass(editor.dispatch(commands.moveClips({ clipIds: ["bed"], delta: 0 }))).unchanged);
  assert.equal(
    codeOf(editor.dispatch(commands.moveClips({ clipIds: ["x"], delta: 1 }))),
    "missing-clip",
  );
  assert.equal(seen.length, 3);
});

test("a held transaction changes nothing and returns its commands", () => {
  const { editor, seen, decide, notified } = gated();
  commit(editor.dispatch(commands.moveClips({ clipIds: ["bed"], delta: 10 })));
  const before = editor.getSnapshot();
  const calls = notified();
  decide("hold");
  for (const run of [
    () => editor.dispatch(commands.splitClip({ clipId: "line", at: 200 })),
    () => editor.history.undo(),
  ]) {
    const result = run();
    assert.ok(!result.ok && result.held, JSON.stringify(result));
    assert.equal(result.code, "held");
    assert.equal(result.revision, before.revision);
    assert.equal(editor.getSnapshot(), before);
    assert.deepEqual([editor.history.undoDepth, editor.history.redoDepth], [1, 0]);
    assert.equal(notified(), calls);
  }
  const held = seen.at(-2);
  assert.ok(held);
  // The held split named its new clip; dispatched later, it makes that clip.
  decide("commit");
  const later = commit(editor.dispatch(held.commands));
  assert.deepEqual(later.createdIds, ["ana-1"]);
  assert.deepEqual(held.targets.clipIds, ["line", "ana-1"]);
});

test("a read-only gate rejects every kind of transaction with its reason", () => {
  const { editor, decide } = gated();
  commit(editor.dispatch(commands.moveClips({ clipIds: ["bed"], delta: 10 })));
  commit(editor.history.undo());
  const before = editor.getSnapshot();
  decide({ readOnly: "offline" });
  for (const result of [
    editor.dispatch(commands.addMarker({ start: 1 })),
    editor.dispatch(commands.moveClips({ clipIds: ["bed"], delta: 1 }), { history: "ignore" }),
    editor.history.redo(),
  ]) {
    assert.ok(!result.ok && !result.held);
    assert.deepEqual([result.code, result.target], ["read-only", "offline"]);
  }
  assert.equal(editor.getSnapshot(), before);
  assert.deepEqual([editor.history.undoDepth, editor.history.redoDepth], [0, 1]);
  // Removing the gate lets the same redo through.
  editor.setGate(null);
  commit(editor.history.redo());
});

test("a gate cannot edit, must answer with a decision, and does not see a replacement", () => {
  const editor = createEditor({ project: project(), actor: "ana" });
  const original = editor.getSnapshot();
  editor.setGate(() => {
    editor.dispatch(commands.addMarker({ start: 1 }));
    return "commit";
  });
  assert.throws(() => editor.dispatch(commands.addMarker({ start: 2 })), /cannot edit/);
  // @ts-expect-error -- An unchecked gate may answer anything.
  editor.setGate(() => "maybe");
  assert.throws(() => editor.dispatch(commands.addMarker({ start: 2 })), TypeError);
  editor.setGate(() => {
    throw new Error("Gate failed");
  });
  assert.throws(() => editor.dispatch(commands.addMarker({ start: 2 })), /Gate failed/);
  assert.equal(editor.getSnapshot(), original);
  // A replacement is the host's own action and bypasses the gate.
  editor.setGate(() => ({ readOnly: "viewer" }));
  const other = createEditor({ project: project(), actor: "ben" });
  commit(other.dispatch(commands.addMarker({ start: 3 })));
  commit(editor.replace(other.getSnapshot()));
  assert.equal(editor.getSnapshot().markers?.length, 1);
  // @ts-expect-error -- Only a function or null installs a gate.
  assert.throws(() => editor.setGate("open"), /gate function/);
});
