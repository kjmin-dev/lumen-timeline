import assert from "node:assert/strict";
import test from "node:test";
import { createEditor, commands } from "@lumen-timeline/core";
import { codeOf, pass } from "./support.ts";

test("preview matches dispatch validation and produces placements without publishing or branching history", () => {
  const editor = createEditor({
    project: {
      schemaVersion: 1,
      duration: 100,
      tracks: [
        { id: "v", overlap: "exclusive" },
        { id: "locked", locked: true },
      ],
      clips: ["a", "b"].map((id, i) => ({
        id,
        kind: "audio",
        trackId: "v",
        start: 20 * i,
        duration: 10,
        contentIn: 0,
        contentBounds: { start: 0, end: 30 },
      })),
    },
  });
  const move = (delta: number, trackId?: string) =>
    commands.moveClips({ clipIds: ["a"], delta, trackId });
  assert.ok(editor.dispatch(move(2)).ok);
  editor.history.undo();
  const snap = editor.getSnapshot(),
    bytes = editor.history.estimatedBytes;
  let events = 0;
  editor.subscribe(
    (s) => s,
    () => events++,
  );
  editor.history.subscribe(() => events++);
  const p = pass(editor.preview(move(8)));
  assert.equal(p.placements[0].start, 8);
  for (const cmd of [
    move(15),
    move(-4),
    move(0, "locked"),
    commands.trimClip({ clipId: "a", edge: "left", delta: -2 }),
  ]) {
    assert.deepEqual(editor.preview(cmd), editor.dispatch(cmd));
  }
  assert.equal(codeOf(editor.preview(move(2), { expectedRevision: 0 })), "stale-revision");
  assert.equal(
    // @ts-expect-error -- Preview accepts only moves and trims, and the runtime rejects a split too.
    codeOf(editor.preview(commands.splitClip({ clipId: "a", at: 5 }))),
    "unsupported-preview",
  );
  assert.equal(editor.getSnapshot(), snap);
  assert.equal(events, 0);
  assert.equal(editor.history.estimatedBytes, bytes);
  assert.equal(editor.history.canRedo, true);
  assert.ok(editor.dispatch(move(8), { expectedRevision: p.revision }).ok);
  assert.deepEqual(editor.getSnapshot().clips[0], p.placements[0]);
});
