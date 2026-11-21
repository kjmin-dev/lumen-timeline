import test from "node:test";
import assert from "node:assert/strict";
import { TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import { handleAt, snapDelta } from "@lumen-timeline/timeline/internal";

test("viewport clipping does not invent a trim handle", () => {
  assert.equal(handleAt({ left: -5, right: 30 }, 1, 100), "move");
  assert.equal(handleAt({ left: 2, right: 120 }, 97, 100), "move");
  assert.equal(handleAt({ left: 2, right: 40 }, 4, 100), "left");
  assert.equal(handleAt({ left: 2, right: 40 }, 38, 100), "right");
});
test("snapping respects CSS tolerance, source options and exact zero movement", () => {
  const c = { id: "a", trackId: "t", start: 10 * hz, duration: hz };
  const read = { clipsIn: () => [{ id: "b", start: 15 * hz, duration: hz }] };
  const args = [{ gridTicks: 0, tolerancePx: 5 }, { pixelsPerSecond: 100 }, read, 12 * hz];
  assert.equal(snapDelta(1.98 * hz, [c], "move", "t", ...args).delta, 2 * hz);
  assert.equal(snapDelta(3.98 * hz, [c], "move", "t", ...args).delta, 4 * hz);
  assert.equal(snapDelta(0, [c], "move", "t", ...args).delta, 0);
  assert.equal(
    snapDelta(1.98 * hz, [c], "move", "t", { ...args[0], playhead: false }, ...args.slice(1)).delta,
    1.98 * hz,
  );
});
