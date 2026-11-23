import assert from "node:assert/strict";
import test from "node:test";
import { commands, createEditor } from "@lumen-timeline/core";
import {
  dropSlot,
  fillTemplate,
  moveToSlot,
  renamedTo,
  resolveChrome,
  resolveUiLabels,
  sameChrome,
  sameUiLabels,
} from "@lumen-timeline/timeline/internal";

// Rows of uneven height, as tracks with stacked lanes give.
const rows = [
  { top: 0, height: 40 },
  { top: 40, height: 80 },
  { top: 120, height: 40 },
];

test("dropSlot splits each row at its middle", () => {
  assert.equal(dropSlot(rows, -50), 0);
  assert.equal(dropSlot(rows, 19.9), 0);
  assert.equal(dropSlot(rows, 20), 1);
  assert.equal(dropSlot(rows, 79.9), 1);
  assert.equal(dropSlot(rows, 80), 2);
  assert.equal(dropSlot(rows, 139.9), 2);
  assert.equal(dropSlot(rows, 140), 3);
  assert.equal(dropSlot(rows, 10_000), 3);
  assert.equal(dropSlot([], 0), 0);
});

test("moveToSlot moves an ID into a gap and reports moves that change nothing", () => {
  const ids = ["a", "b", "c", "d"];
  // The gaps on either side of an ID leave it where it is.
  assert.equal(moveToSlot(ids, 1, 1), null);
  assert.equal(moveToSlot(ids, 1, 2), null);
  assert.deepEqual(moveToSlot(ids, 1, 0), ["b", "a", "c", "d"]);
  assert.deepEqual(moveToSlot(ids, 1, 3), ["a", "c", "b", "d"]);
  assert.deepEqual(moveToSlot(ids, 1, 4), ["a", "c", "d", "b"]);
  assert.deepEqual(moveToSlot(ids, 3, 0), ["d", "a", "b", "c"]);
  // Keyboard steps past either end stay at that end.
  assert.equal(moveToSlot(ids, 0, -1), null);
  assert.equal(moveToSlot(ids, 3, 5), null);
  assert.equal(moveToSlot(ids, 7, 0), null);
  assert.deepEqual(ids, ["a", "b", "c", "d"]);
});

test("moveToSlot gives every permutation the editor accepts", () => {
  const editor = createEditor({
    project: {
      schemaVersion: 1,
      tracks: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
      clips: [],
    },
  });
  for (let from = 0; from < 4; from++)
    for (let slot = 0; slot <= 4; slot++) {
      const before = editor.getSnapshot().tracks.map((t) => t.id);
      const next = moveToSlot(before, from, slot);
      if (!next) continue;
      const result = editor.dispatch(commands.reorderTracks({ trackIds: next }));
      assert.ok(result.ok, JSON.stringify({ from, slot, next }));
      assert.deepEqual(
        editor.getSnapshot().tracks.map((t) => t.id),
        next,
      );
      assert.equal(editor.getSnapshot().tracks[slot > from ? slot - 1 : slot]?.id, before[from]);
    }
  editor.dispose();
});

test("renamedTo trims the draft and ignores blank or unchanged names", () => {
  const named = { id: "vo", name: "Voice" };
  assert.equal(renamedTo("  Narrator ", named), "Narrator");
  assert.equal(renamedTo("Voice", named), undefined);
  assert.equal(renamedTo(" Voice  ", named), undefined);
  assert.equal(renamedTo("   ", named), undefined);
  assert.equal(renamedTo("", named), undefined);
  // A track without a name shows its ID, so the ID is no change.
  assert.equal(renamedTo("vo", { id: "vo" }), undefined);
  assert.equal(renamedTo("보이스", { id: "vo" }), "보이스");
});

test("fillTemplate fills named placeholders and keeps unknown ones", () => {
  assert.equal(
    fillTemplate("{name} moved to position {position} of {count}", {
      name: "Music",
      position: 2,
      count: 4,
    }),
    "Music moved to position 2 of 4",
  );
  assert.equal(fillTemplate("{name} → {where}", { name: "{position}" }), "{position} → {where}");
});

test("track rename and reorder chrome default on, and off in the minimal and bare presets", () => {
  assert.equal(resolveChrome().trackRename, true);
  assert.equal(resolveChrome().trackReorder, true);
  assert.equal(resolveChrome({ toolbar: false }).trackReorder, true);
  for (const preset of ["minimal", false] as const) {
    assert.equal(resolveChrome(preset).trackRename, false);
    assert.equal(resolveChrome(preset).trackReorder, false);
  }
  const custom = resolveChrome({ trackRename: false });
  assert.equal(custom.trackRename, false);
  assert.equal(custom.trackReorder, true);
  assert.equal(sameChrome(custom, resolveChrome({ trackRename: false })), true);
  assert.equal(sameChrome(custom, resolveChrome()), false);
  assert.equal(sameChrome(resolveChrome({ trackReorder: false }), resolveChrome()), false);
});

test("track header labels have English defaults and compare by value", () => {
  const labels = resolveUiLabels();
  assert.equal(labels.trackName, "Track name");
  assert.equal(labels.reorderTrack, "Drag to reorder");
  assert.equal(labels.trackMoved, "{name} moved to position {position} of {count}");
  const korean = resolveUiLabels({
    trackName: "트랙 이름",
    reorderTrack: "끌어서 순서 변경",
    trackMoved: "{name}: {count}개 중 {position}번째로 이동",
  });
  assert.equal(korean.trackName, "트랙 이름");
  assert.equal(sameUiLabels(korean, resolveUiLabels({ ...korean })), true);
  assert.equal(sameUiLabels(korean, labels), false);
  assert.equal(sameUiLabels(resolveUiLabels({ trackMoved: "x" }), labels), false);
  assert.equal(sameUiLabels(resolveUiLabels({ reorderTrack: "x" }), labels), false);
});
