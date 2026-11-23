import assert from "node:assert/strict";
import test from "node:test";
import { TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import type { Clip, Track } from "@lumen-timeline/core";
import {
  captionWords,
  layoutRow,
  pack,
  QuadList,
  quadFloats,
  rectangle,
  rgba,
} from "@lumen-timeline/timeline/internal";
import type { Box, LabelSlot, RowLayout } from "@lumen-timeline/timeline/internal";

const sec = (n: number): number => Math.round(n * hz);
const slot: LabelSlot = { u0: 0.1, v0: 0.2, u1: 0.3, v1: 0.25, width: 60, height: 20 };

test("rgba supports 3-digit, 6-digit and 8-digit hex colors", () => {
  assert.equal(rgba("#f0a"), rgba("#ff00aa", 255));
  assert.equal(rgba("#2b558066"), rgba("#2b5580", 0x66));
  assert.equal(rgba("#112233", 0x80), rgba("#11223380"));
});

test("pack and rectangle honor custom laneHeight and rowInset", () => {
  const clips = [
    { id: "a", start: 0, duration: sec(4) },
    { id: "b", start: sec(1), duration: sec(2) },
  ];
  const packed = pack(clips, 48, 10);
  assert.equal(packed.height, 2 * 48 + 20);
  const box = rectangle(clips[1], 1, 0, { startTick: 0, pixelsPerSecond: 100 }, 500, 48, 10);
  assert.equal(box.y, 10 + 48);
  assert.equal(box.height, 45);
});

test("layoutRow applies theme, track.color, clip.color, clipStyle and direct clip.source waveforms", () => {
  const track: Track = { id: "t", color: "#33aa88" };
  const clips: Clip[] = [
    {
      id: "direct",
      trackId: "t",
      kind: "audio",
      start: 0,
      duration: sec(2),
      contentIn: 0,
      source: { assetId: "stem", streamId: "mono" },
    },
    {
      id: "colored",
      trackId: "t",
      kind: "audio",
      start: sec(3),
      duration: sec(2),
      contentIn: 0,
      color: "#dd5577",
    },
    {
      id: "styled",
      trackId: "t",
      kind: "audio",
      start: sec(6),
      duration: sec(2),
      contentIn: 0,
    },
  ];
  const row = {
    track,
    index: 0,
    top: 0,
    lanes: new Map(clips.map((c) => [c.id, 0])),
    height: 46,
  };
  const labelsSeen: { name: string; caption: string | undefined; color: string }[] = [];
  const assets = new Set<string>();
  const quads = new QuadList();
  const boxes: Box<Clip>[] = [];
  const layout: RowLayout = {
    view: { startTick: 0, pixelsPerSecond: 100 },
    width: 900,
    top: 0,
    dpr: 1,
    grid: [],
    words: captionWords(),
    takesOf: () => [],
    peaks: ({ buckets }) => new Float32Array(buckets * 2).fill(0.4),
    label: (name, caption, color) => {
      labelsSeen.push({ name, caption, color });
      return slot;
    },
    assets,
    theme: {
      rowEven: rgba("#ffffff"),
      rowOdd: rgba("#eeeeee"),
      grid: rgba("#cccccc"),
      palette: [
        {
          stripeHex: "#112233",
          fill: rgba("#112233"),
          stripe: rgba("#445566"),
          waveform: rgba("#445566", 0x66),
        },
      ],
    },
    clipStyle: (clip) =>
      clip.id === "styled"
        ? {
            fill: "#123456",
            stripe: "#abcdef",
            label: "Custom Label",
            caption: "Approved",
            captionColor: "#ffffff",
          }
        : undefined,
  };
  layoutRow(row, clips, layout, quads, boxes);

  // Row background used custom theme color.
  assert.equal(quads.colors[0], rgba("#ffffff"));
  // Direct clip.source drew waveform without needing takes.
  assert.deepEqual([...assets], ["stem"]);
  // Labels received custom overrides & clip/track accent colors.
  assert.deepEqual(labelsSeen, [
    { name: "direct", caption: undefined, color: "#33aa88" },
    { name: "colored", caption: undefined, color: "#dd5577" },
    { name: "Custom Label", caption: "Approved", color: "#ffffff" },
  ]);
  // Styled clip used custom fill & stripe colors.
  const styledColors: number[] = [];
  for (let i = 0; i < quads.count; i++) {
    if (quads.data[i * quadFloats] === 600) styledColors.push(quads.colors[i] ?? 0);
  }
  assert.deepEqual(styledColors, [rgba("#123456"), rgba("#abcdef")]);
});
