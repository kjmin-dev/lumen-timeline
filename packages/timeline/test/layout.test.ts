import assert from "node:assert/strict";
import test from "node:test";
import { TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import type { Clip, Take } from "@lumen-timeline/core";
import { decibelScale } from "@lumen-timeline/timeline";
import {
  captionWords,
  isImage,
  layoutRow,
  QuadList,
  quadFloats,
  radiusOf,
  rectangle,
  rgba,
  takeLanesHeight,
} from "@lumen-timeline/timeline/internal";
import type { Box, LabelSlot, RowLayout, TakeBox } from "@lumen-timeline/timeline/internal";

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
  top: 67,
  lanes: new Map([
    ["a", 0],
    ["b", 0],
    ["c", 0],
  ]),
  height: 67,
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
    return {
      x,
      y,
      w,
      h,
      uv: [u0, v0, u1, v1],
      color: list.colors[i],
      image: isImage(list, i),
      radius: radiusOf(list, i),
    };
  });
}

test("a row lays out its lane strip, grid, then each clip's body, waveform bars and label", () => {
  const list = new QuadList();
  const boxes: Box<Clip>[] = [];
  const clips = [
    clip("a", 0, 3),
    clip("b", 5, 2, { takeIds: ["k"], activeTakeId: "k" }),
    clip("c", 9.9, 0.05),
  ];
  let asked = 0;
  const grid = rgba("#223344");
  layoutRow(
    row,
    clips,
    layout({
      theme: {
        rowEven: rgba("#101010"),
        rowOdd: rgba("#202020"),
        grid,
        palette: [
          {
            stripeHex: "#f9a870",
            textHex: "#0c0e11",
            fill: rgba("#f9a870"),
            stripe: rgba("#f9a870"),
            waveform: rgba("#593215"),
          },
        ],
      },
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
  // The strip leaves a 2 px gap above and below, inside the row's 3 px margin.
  assert.deepEqual(all[0], {
    x: 0,
    y: 12,
    w: 1000,
    h: 60,
    uv: [0, 10, 0, 0],
    color: rgba("#202020"),
    image: false,
    radius: 10,
  });
  assert.deepEqual(
    all.slice(1, 3).map((q) => [q.x, q.y, q.w, q.h, q.color]),
    [
      [0, 12, 1, 60, grid],
      [73, 12, 1, 60, grid],
    ],
  );
  assert.deepEqual(
    boxes.map((b) => b.clip.id),
    ["a", "b", "c"],
  );
  // Clip a starts offscreen: its body runs past the edge, so no corner shows
  // there, and its label starts on a device pixel in the name row.
  const a = rectangle(clips[0], 0, 10, layout().view, 1000);
  assert.deepEqual([a.y, a.height], [20, 44]);
  assert.deepEqual(
    [all[3].x, all[3].w, all[3].h, all[3].color, all[3].radius],
    [-14, a.right + 14, 44, rgba("#f9a870"), 7],
  );
  assert.equal(all[4].image, true);
  assert.deepEqual([all[4].x, all[4].y, all[4].w, all[4].h], [8, a.y - 1, 80, 20]);
  // Clip b: a 2 px bar every 3 px under the name row, clear of the corners,
  // each spanning the loudest of its columns.
  const b = rectangle(clips[1], 0, 10, layout().view, 1000);
  assert.deepEqual([all[5].x, all[5].w, all[5].radius], [b.x, 200, 7]);
  const bars = all.slice(6, -2).filter((q) => !q.image);
  assert.equal(asked, 1);
  assert.equal(bars.length, Math.ceil(194 / 3));
  assert.ok(bars.every((q) => q.w === 2 && q.radius === 0 && q.color === rgba("#593215")));
  assert.deepEqual(
    bars.slice(0, 2).map((q) => [q.x, q.y, q.h]),
    [
      [b.x + 3, b.y + 20, 15],
      [b.x + 6, b.y + 20, 15],
    ],
  );
  const label = all.findLast((q) => q.image && q.x > b.x);
  assert.equal(label?.x, Math.round((b.x + 8) * 2) / 2);
  // Clip c is too narrow for a label: its body only.
  assert.deepEqual([all.at(-1)?.w, all.at(-1)?.h], [5, 44]);
  assert.equal(all.filter((q) => q.image).length, 2);
});

test("a clip too short for a name row draws its waveform over its full height", () => {
  const list = new QuadList();
  layoutRow(
    { ...row, height: 46 },
    [clip("b", 5, 2, { takeIds: ["k"], activeTakeId: "k" })],
    layout({
      laneHeight: 34,
      rowInset: 6,
      peaks: ({ buckets }) => new Float32Array(2 * buckets).map((_, i) => (i % 2 ? 1 : -1)),
    }),
    list,
    [],
  );
  const all = quads(list);
  // A 31 px clip keeps a 16 px name row; a 25 px one has none.
  assert.deepEqual([all[1].y, all[1].h], [16, 31]);
  assert.deepEqual([all[2].y, all[2].h], [16 + 17, 31 - 17 - 4]);
  const short = new QuadList();
  layoutRow(
    { ...row, height: 40 },
    [clip("b", 5, 2, { takeIds: ["k"], activeTakeId: "k" })],
    layout({
      laneHeight: 28,
      rowInset: 6,
      peaks: ({ buckets }) => new Float32Array(2 * buckets).map((_, i) => (i % 2 ? 1 : -1)),
    }),
    short,
    [],
  );
  const drawn = quads(short);
  assert.deepEqual([drawn[2].y, drawn[2].h], [16 + 3, 25 - 6]);
  assert.equal(drawn.at(-1)?.y, 16 + 5);
});

test("take lanes draw each candidate under the clip, the active one filled", () => {
  const candidates: readonly Take[] = [
    { id: "k", assetId: "first", streamId: "mono", sourceAtContentZero: 0 },
    { id: "j", assetId: "second", streamId: "mono", sourceAtContentZero: 0 },
  ];
  const drawer = takeLanesHeight(candidates.length);
  assert.equal(drawer, 54);
  assert.equal(takeLanesHeight(0), 0);
  const list = new QuadList();
  const takeBoxes: TakeBox[] = [];
  const asked: string[] = [];
  const open = clip("b", 5, 2, { takeIds: ["k", "j"], activeTakeId: "j" });
  layoutRow(
    { ...row, height: 67 + drawer },
    [open],
    layout({
      takesOf: () => candidates,
      peaks: ({ assetId, buckets }) => {
        asked.push(assetId);
        return new Float32Array(2 * buckets).fill(0.5);
      },
      takeLanes: { clipId: "b", takes: candidates },
      takeBoxes,
    }),
    list,
    [],
  );
  // The band sits at the bottom of the strip, which grew by its height.
  const all = quads(list);
  assert.deepEqual([all[0].y, all[0].h], [12, 60 + drawer]);
  const top = 12 + 60;
  assert.deepEqual([all[3].y, all[3].h, all[3].w], [top, 1, 1000]);
  const b = rectangle(open, 0, 10, layout().view, 1000);
  assert.deepEqual(takeBoxes, [
    { clipId: "b", takeId: "k", x: b.x, endX: b.endX, y: top + 2, height: 22 },
    { clipId: "b", takeId: "j", x: b.x, endX: b.endX, y: top + 28, height: 22 },
  ]);
  // The clip's own waveform is its active take's; each lane asks for its own.
  assert.deepEqual(asked, ["second", "first", "second"]);
  const lanes = all.filter((q) => q.radius === 5);
  assert.deepEqual(
    lanes.map((q) => [q.y, q.h, q.color === rgba("#f9a870")]),
    [
      [top + 2, 22, false],
      [top + 28, 22, true],
    ],
  );
});

test("a label is cropped inside its clip, and left out when the atlas has no room", () => {
  const list = new QuadList();
  layoutRow(row, [clip("a", 2, 0.5)], layout(), list, []);
  const label = quads(list).find((q) => q.image);
  // 50 px wide: from 8 px in to 3 px before the end.
  assert.ok(label);
  assert.equal(label.w, 50 - 8 - 3);
  assert.deepEqual(label.uv, [0.1, 0.2, 0.1 + (0.2 * 39) / 80, 0.25].map(Math.fround));
  // A clip with less than 24 px of room, as when zoomed far out, has no label.
  const narrow = new QuadList();
  layoutRow(row, [clip("a", 2, 0.3)], layout(), narrow, []);
  assert.equal(quads(narrow).filter((q) => q.image).length, 0);
  const full = new QuadList();
  layoutRow(row, [clip("a", 2, 0.5)], layout({ label: () => null }), full, []);
  assert.equal(quads(full).filter((q) => q.image).length, 0);
});

test("a clip's takes are read once, a caption is made only for a label, and the row's assets are kept", () => {
  const withTakes = { takeIds: ["k", "j"], activeTakeId: "j" };
  const listed: Record<string, readonly Take[]> = {
    wide: [
      { id: "k", assetId: "first", streamId: "mono", sourceAtContentZero: 0 },
      { id: "j", assetId: "second", streamId: "mono", sourceAtContentZero: 0, label: "Keeper" },
    ],
    // Zoomed far out: wide enough for two columns, too narrow for a label.
    narrow: [
      { id: "k", assetId: "first", streamId: "mono", sourceAtContentZero: 0 },
      { id: "j", assetId: "third", streamId: "mono", sourceAtContentZero: 0 },
    ],
    // Less than a pixel wide: no column to ask for.
    sliver: [{ id: "j", assetId: "fourth", streamId: "mono", sourceAtContentZero: 0 }],
    silent: [{ id: "j", assetId: "fifth", streamId: "mono", sourceAtContentZero: 0 }],
  };
  const clips = [
    clip("wide", 2, 3, withTakes),
    clip("narrow", 6, 0.02, withTakes),
    clip("sliver", 7, 0.004, { takeIds: ["j"], activeTakeId: "j" }),
    // Candidates, none active: a caption and no waveform.
    clip("silent", 8, 1, { takeIds: ["j"], activeTakeId: null }),
    clip("bare", 9.5, 1),
  ];
  const reads: string[] = [];
  const captions: (string | undefined)[] = [];
  const asked: string[] = [];
  const assets = new Set<string>(["stale"]);
  const list = new QuadList();
  layoutRow(
    { ...row, lanes: new Map(clips.map((c) => [c.id, 0])) },
    clips,
    layout({
      takesOf: (id) => {
        reads.push(id);
        return listed[id] ?? [];
      },
      peaks: ({ assetId, buckets }) => {
        asked.push(assetId);
        return new Float32Array(2 * buckets).fill(0.25);
      },
      label: (_name, caption) => {
        captions.push(caption);
        return slot;
      },
      assets,
    }),
    list,
    [],
  );
  // One read per clip that lists takes, and none for a clip that lists none.
  assert.deepEqual(reads, ["wide", "narrow", "sliver", "silent"]);
  // The active take's asset, for each clip with a column to draw.
  assert.deepEqual(asked, ["second", "third"]);
  assert.deepEqual([...assets], ["stale", "second", "third"]);
  // Captions only where a label is drawn.
  assert.deepEqual(captions, ["Keeper · 2 takes", "No take · 1 take", undefined]);
  assert.equal(quads(list).filter((q) => q.image).length, 3);
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

test("a clip's gain scales its waveform before the provider's scale draws it", () => {
  const heights = (extra: Partial<Clip>, scale?: (peak: number) => number): number[] => {
    const list = new QuadList();
    layoutRow(
      row,
      [clip("b", 5, 2, { takeIds: ["k"], activeTakeId: "k", ...extra })],
      layout({
        peaks: ({ buckets }) => new Float32Array(2 * buckets).map((_, i) => (i % 2 ? 0.25 : -0.25)),
        ...(scale ? { scale } : {}),
      }),
      list,
      [],
    );
    // The bars, without the strip, grid, body and label.
    return [
      ...new Set(
        quads(list)
          .slice(4, -1)
          .map((q) => q.h),
      ),
    ];
  };
  const [unity] = heights({});
  assert.ok(unity && unity > 4);
  assert.deepEqual(heights({ gain: 2 }), [unity * 2]);
  assert.deepEqual(heights({ gain: 0.5 }), [unity / 2]);
  // Past full scale the bars clip, as the sound would.
  assert.deepEqual(heights({ gain: 16 }), [unity * 4]);
  // A silenced clip keeps its minimum bars so it still reads as audio.
  assert.deepEqual(heights({ gain: 0 }), [1.5]);
  // The scale sees the gained peak. Quads hold 32-bit floats.
  const db = decibelScale(-42);
  const [quarter] = heights({}, db);
  const [eighth] = heights({ gain: 0.5 }, db);
  assert.ok(quarter && eighth);
  assert.ok(Math.abs(quarter / unity - 4 * db(0.25)) < 1e-5);
  assert.ok(Math.abs(eighth / unity - 4 * db(0.125)) < 1e-5);
});

test("decibelScale maps levels to heights and keeps their sign", () => {
  const db = decibelScale(-40);
  assert.equal(db(1), 1);
  assert.equal(db(-1), -1);
  assert.equal(db(0), 0);
  assert.equal(db(0.01), 0);
  assert.ok(Math.abs(db(0.1) - 0.5) < 1e-12);
  assert.ok(Math.abs(db(-0.1) + 0.5) < 1e-12);
  assert.equal(db(4), 1);
  assert.equal(db(Number.NaN), 0);
  for (const floor of [0, 3, Number.NaN, Number.NEGATIVE_INFINITY])
    assert.throws(() => decibelScale(floor), RangeError);
});
