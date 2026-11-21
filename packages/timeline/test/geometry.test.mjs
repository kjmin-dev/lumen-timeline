import test from "node:test";
import assert from "node:assert/strict";
import { TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import { pack, rectangle, hit, zoomAt, tickAt, pixelAt } from "@lumen-timeline/timeline/internal";

test("CSS-pixel projection round trips and preserves pointer time across zoom", () => {
  const v = { startTick: 12 * hz, pixelsPerSecond: 100 };
  assert.equal(tickAt(220, v), 14.2 * hz);
  assert.ok(Math.abs(pixelAt(tickAt(220, v), v) - 220) < 1e-9);
  assert.equal(tickAt(220, zoomAt(v, 220, 2, 600, 30 * hz)), tickAt(220, v));
});
test("overlaps have stable lanes, adjacent edges and clipped bounds hit correctly", () => {
  const items = [
    { id: "a", start: 0, duration: 12 },
    { id: "b", start: 4, duration: 2 },
    { id: "c", start: 6, duration: 2 },
  ];
  const { lanes } = pack(items);
  assert.deepEqual([...lanes.values()], [0, 1, 1]);
  const boxes = items.map((c) =>
    rectangle(c, lanes.get(c.id), 0, { startTick: 5, pixelsPerSecond: hz }, 10),
  );
  assert.equal(boxes[0].left, -5);
  assert.equal(boxes[0].x, 0);
  assert.equal(hit(boxes, 1, boxes[1].y + 1).clip.id, "c");
});
