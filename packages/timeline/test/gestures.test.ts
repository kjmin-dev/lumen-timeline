import test from "node:test";
import assert from "node:assert/strict";
import {
  commands,
  createEditor,
  MAX_CLIP_RATE,
  MIN_CLIP_RATE,
  TICKS_PER_SECOND as hz,
} from "@lumen-timeline/core";
import type { Clip } from "@lumen-timeline/core";
import { handleAt, snapDelta, stretchLength } from "@lumen-timeline/timeline/internal";

test("viewport clipping does not invent a trim handle", () => {
  assert.equal(handleAt({ left: -5, right: 30 }, 1, 100), "move");
  assert.equal(handleAt({ left: 2, right: 120 }, 97, 100), "move");
  assert.equal(handleAt({ left: 2, right: 40 }, 4, 100), "left");
  assert.equal(handleAt({ left: 2, right: 40 }, 38, 100), "right");
});
test("snapping respects CSS tolerance, source options and exact zero movement", () => {
  const c = { id: "a", trackId: "t", start: 10 * hz, duration: hz };
  const read = { clipsIn: () => [{ id: "b", start: 15 * hz, duration: hz }], markersIn: () => [] };
  const args = [{ gridTicks: 0, tolerancePx: 5 }, { pixelsPerSecond: 100 }, read, 12 * hz] as const;
  const [config, view, reader, playhead] = args;
  assert.equal(snapDelta(1.98 * hz, [c], "move", "t", ...args).delta, 2 * hz);
  assert.equal(snapDelta(3.98 * hz, [c], "move", "t", ...args).delta, 4 * hz);
  assert.equal(snapDelta(0, [c], "move", "t", ...args).delta, 0);
  assert.equal(
    snapDelta(1.98 * hz, [c], "move", "t", { ...config, playhead: false }, view, reader, playhead)
      .delta,
    1.98 * hz,
  );
});

test("markers snap after the playhead and before clip edges and the grid", () => {
  const c = { id: "a", trackId: "t", start: 10 * hz, duration: hz };
  const read = {
    clipsIn: () => [{ id: "b", start: 13 * hz, duration: hz }],
    markersIn: () => [{ start: 13 * hz }],
  };
  const config = { gridTicks: hz, tolerancePx: 5 };
  const view = { pixelsPerSecond: 100 };
  // A marker, a clip edge and the grid all lie at 13 s, 0.02 s from the dragged start.
  const marker = snapDelta(2.98 * hz, [c], "move", "t", config, view, read, 0);
  assert.equal(marker.delta, 3 * hz);
  assert.equal(marker.held?.priority, 1);
  assert.equal(
    snapDelta(2.98 * hz, [c], "move", "t", config, view, read, 13 * hz).held?.priority,
    0,
  );
  const disabled = { ...config, markers: false };
  assert.equal(snapDelta(2.98 * hz, [c], "move", "t", disabled, view, read, 0).held?.priority, 2);
});

test("a stretch drag keeps the clip's rate in range and its start at or after zero", () => {
  const line: Clip = {
    id: "line",
    trackId: "voice",
    kind: "audio",
    start: hz,
    duration: 4 * hz,
    contentIn: 0,
    rate: 1.25,
  };
  // Five seconds of content: from 1.25 s at rate 4 to 20 s at rate 0.25.
  assert.equal(stretchLength(line, "right", hz), 5 * hz);
  assert.equal(stretchLength(line, "right", -10 * hz), Math.ceil((5 * hz) / MAX_CLIP_RATE));
  assert.equal(stretchLength(line, "right", 100 * hz), Math.floor((5 * hz) / MIN_CLIP_RATE));
  // Pulling the start back can lengthen the clip only to its end at 5 s.
  assert.equal(stretchLength(line, "left", -100 * hz), 5 * hz);
  assert.equal(stretchLength(line, "left", hz), 3 * hz);
  // Every clamped length is a retime the editor accepts.
  const editor = createEditor({
    project: { schemaVersion: 1, tracks: [{ id: "voice" }], clips: [line] },
  });
  for (const [edge, delta] of [
    ["right", -10 * hz],
    ["right", 100 * hz],
    ["left", -100 * hz],
    ["left", 3.9 * hz],
  ] as const) {
    const duration = stretchLength(line, edge, delta);
    const anchor = edge === "left" ? "end" : "start";
    const preview = editor.preview(commands.retimeClip({ clipId: "line", duration, anchor }));
    assert.ok(preview.ok, JSON.stringify(preview));
  }
});
