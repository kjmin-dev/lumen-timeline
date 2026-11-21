import test from "node:test";
import assert from "node:assert/strict";
import { commands, createEditor } from "@lumen-timeline/core";

test("shared selection publishes once, prunes a removed child, and leaves project history alone", () => {
  const e = createEditor({
    project: {
      schemaVersion: 1,
      tracks: [{ id: "t" }],
      clips: [{ id: "a", trackId: "t", kind: "audio", start: 0, duration: 10, contentIn: 0 }],
    },
  });
  const seen: (readonly string[])[] = [];
  const off = e.session.subscribeSelection((ids) => seen.push(ids));
  e.session.select(["a", "a"]);
  e.session.select(["a"]);
  assert.equal(e.getSnapshot().revision, 0);
  assert.equal(e.history.undoDepth, 0);
  assert.throws(() => e.session.select(["missing"]));
  e.dispatch(commands.splitClip({ clipId: "a", at: 5, rightId: "b" }));
  e.session.select(["a", "b"]);
  e.history.undo();
  assert.deepEqual(e.session.getSelection(), ["a"]);
  e.history.redo();
  assert.deepEqual(seen, [["a"], ["a", "b"], ["a"]]);
  off();
  e.session.select([]);
  assert.equal(seen.length, 3);
});
