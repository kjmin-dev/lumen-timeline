import assert from "node:assert/strict";
import test from "node:test";
import { TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import type { Clip, Take } from "@lumen-timeline/core";
import {
  captionWords,
  isImage,
  layoutRow,
  QuadList,
  quadFloats,
  rectangle,
  rgba,
} from "@lumen-timeline/timeline/internal";
import type { Box, LabelSlot, RowLayout } from "@lumen-timeline/timeline/internal";

const sec = (n: number): number => Math.round(n * hz);
const clip = (id: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip => ({
  id,
  trackId: "t",
  kind: "audio",
  start: sec(start),
  duration: sec(duration),
  contentIn: 0,
  ...extra,
});
const takes: Record<string, readonly Take[]> = {
  b: [{ id: "k", assetId: "a", streamId: "mono", sourceAtContentZero: 0 }],
};
const row = {
  track: { id: "t" },
  index: 1,
  top: 46,
  lanes: new Map([
    ["a", 0],
    ["b", 0],
    ["c", 0],
  ]),
  height: 46,
};
const slot: LabelSlot = { u0: 0.1, v0: 0.2, u1: 0.3, v1: 0.25, width: 80, height: 20 };

function layout(extra: Partial<RowLayout> = {}): RowLayout {
  return {
    view: { startTick: sec(1), pixelsPerSecond: 100 },
    width: 1000,
    top: 10,
    dpr: 2,
    grid: [0.4, 72.6],
    words: captionWords(),
    takesOf: (id) => takes[id] ?? [],
    label: () => slot,
    ...extra,
  };
}

/** Each quad as an object, in drawing order. */
function quads(list: QuadList) {
  return Array.from({ length: list.count }, (_, i) => {
    const [x, y, w, h, u0, v0, u1, v1] = list.data.slice(i * quadFloats, (i + 1) * quadFloats);
    return { x, y, w, h, uv: [u0, v0, u1, v1], color: list.colors[i], image: isImage(list, i) };
  });
}

test("a row lays out background, grid, then each clip's fill, stripe, waveform and label", () => {
  const list = new QuadList();
  const boxes: Box<Clip>[] = [];
  const clips = [
    clip("a", 0, 3),
    clip("b", 5, 2, { takeIds: ["k"], activeTakeId: "k" }),
    clip("c", 9.9, 0.05),
  ];
  let asked = 0;
  layoutRow(
    row,
    clips,
    layout({
      peaks: ({ buckets }) => {
        asked++;
        // Every third column has nothing to draw; values past ±1 are clamped.
        return Float32Array.from({ length: 2 * buckets }, (_, i) =>
          Math.floor(i / 2) % 3 === 2 ? NaN : i % 2 ? 2 : -0.5,
        );
      },
    }),
    list,
    boxes,
  );
  const all = quads(list);
  assert.deepEqual(all[0], {
    x: 0,
    y: 10,
    w: 1000,
    h: 45,
    uv: [0, 0, 0, 0],
    color: rgba("#1b2025"),
    image: false,
  });
  assert.deepEqual(
    all.slice(1, 3).map((q) => [q.x, q.w, q.h]),
    [
      [0, 1, 46],
      [73, 1, 46],
    ],
  );
  // Clip a starts offscreen: its box is clamped, and its label starts on a device pixel.
  const a = rectangle(clips[0], 0, 10, layout().view, 1000);
  assert.deepEqual(
    boxes.map((b) => b.clip.id),
    ["a", "b", "c"],
  );
  assert.deepEqual([all[3].x, all[3].w, all[3].color], [0, a.endX, rgba("#604332")]);
  assert.deepEqual([all[4].h, all[4].color], [3, rgba("#ffb184")]);
  assert.equal(all[5].image, true);
  assert.deepEqual([all[5].x, all[5].y, all[5].w, all[5].h], [9, a.y + 6, 80, 20]);
  // Clip b: one column per pixel except the empty ones, then its label over them.
  const b = rectangle(clips[1], 0, 10, layout().view, 1000);
  const columns = all.slice(8, -2).filter((q) => !q.image);
  assert.equal(asked, 1);
  assert.equal(columns.length, 200 - Math.floor(200 / 3));
  assert.ok(columns.every((q) => q.w === 1 && q.color === rgba("#ffb184", 0x66)));
  const mid = b.y + 3 + (b.height - 3) / 2;
  const half = (b.height - 7) / 2;
  assert.deepEqual([columns[0].x, columns[0].y, columns[0].h], [b.x, mid - half, 1.5 * half]);
  const label = all.findLast((q) => q.image && q.x > b.x);
  assert.equal(label?.x, Math.round((b.x + 9) * 2) / 2);
  // Clip c is too narrow for a label: fill and stripe only.
  assert.equal(all.at(-1)?.h, 3);
  assert.equal(all.filter((q) => q.image).length, 2);
});

test("a label is cropped inside its clip, and left out when the atlas has no room", () => {
  const list = new QuadList();
  layoutRow(row, [clip("a", 2, 0.5)], layout(), list, []);
  const label = quads(list).find((q) => q.image);
  // 50 px wide: from 9 px in to 3 px before the end.
  assert.ok(label);
  assert.equal(label.w, 50 - 9 - 3);
  assert.deepEqual(label.uv, [0.1, 0.2, 0.1 + (0.2 * 38) / 80, 0.25].map(Math.fround));
  // A clip with less than 24 px of room, as when zoomed far out, has no label.
  const narrow = new QuadList();
  layoutRow(row, [clip("a", 2, 0.3)], layout(), narrow, []);
  assert.equal(quads(narrow).filter((q) => q.image).length, 0);
  const full = new QuadList();
  layoutRow(row, [clip("a", 2, 0.5)], layout({ label: () => null }), full, []);
  assert.equal(quads(full).filter((q) => q.image).length, 0);
});

test("colors pack red into the lowest byte, as GPUs read RGBA8", () => {
  const bytes = new Uint8Array(Uint32Array.of(rgba("#2b5580", 0x66)).buffer);
  assert.deepEqual([...bytes], [0x2b, 0x55, 0x80, 0x66]);
  assert.equal(rgba("#ffffff"), 0xffffffff);
});

test("a list grows past its first capacity and clears for reuse", () => {
  const list = new QuadList();
  for (let i = 0; i < 1000; i++) list.rect(i, 0, 1, 1, i);
  assert.equal(list.count, 1000);
  assert.equal(list.data[999 * quadFloats], 999);
  assert.equal(list.colors[999], 999);
  list.clear();
  assert.equal(list.count, 0);
});
