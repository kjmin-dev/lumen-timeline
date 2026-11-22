import test from "node:test";
import assert from "node:assert/strict";
import { commands, createEditor } from "@lumen-timeline/core";
import type { Clip } from "@lumen-timeline/core";
import { activeTake, captionWords, takeCaption } from "@lumen-timeline/timeline/internal";

test("a caption names the active candidate and counts the list in the host's words", () => {
  const editor = createEditor({
    project: {
      schemaVersion: 1,
      tracks: [{ id: "voice" }],
      clips: [
        {
          id: "line",
          trackId: "voice",
          kind: "audio",
          start: 0,
          duration: 10,
          contentIn: 0,
          takeIds: ["a", "b"],
          activeTakeId: "b",
        },
        { id: "bare", trackId: "voice", kind: "audio", start: 20, duration: 10, contentIn: 0 },
      ],
      takes: [
        { id: "a", assetId: "x", streamId: "s", sourceAtContentZero: 0 },
        { id: "b", assetId: "x", streamId: "s", sourceAtContentZero: 0, label: "Keeper" },
      ],
    },
  });
  const caption = (id: string, words = captionWords()) => {
    const read = editor.read();
    const clip = editor.getSnapshot().clips.find((c: Clip) => c.id === id);
    assert.ok(clip);
    return takeCaption(clip, activeTake(clip, read.takesOf(clip.id)), words);
  };
  assert.equal(caption("line"), "Keeper · 2 takes");
  assert.equal(caption("bare"), undefined);
  assert.ok(editor.dispatch(commands.selectTake({ clipId: "line", takeId: "a" })).ok);
  // An unlabeled take shows its ID.
  assert.equal(caption("line"), "a · 2 takes");
  assert.ok(editor.dispatch(commands.selectTake({ clipId: "line", takeId: null })).ok);
  assert.ok(editor.dispatch(commands.removeTake({ clipId: "line", takeId: "a" })).ok);
  assert.equal(caption("line"), "No take · 1 take");
  assert.equal(caption("line", captionWords({ take: "version" })), "No version · 1 version");
  const korean = captionWords({ take: "테이크", takes: "테이크", none: "선택 없음" });
  assert.equal(caption("line", korean), "선택 없음 · 1 테이크");
  assert.deepEqual(captionWords({ take: "pass", takes: "passes" }), {
    take: "pass",
    takes: "passes",
    none: "No pass",
  });
  editor.dispose();
});
