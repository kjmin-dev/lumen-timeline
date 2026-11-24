import assert from "node:assert/strict";
import test from "node:test";
import { TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import type { Clip, Take } from "@lumen-timeline/core";
import { placeWaveform, rectangle, unit } from "@lumen-timeline/timeline/internal";

const sec = (n: number): number => Math.round(n * hz);
// Content from 1 s plays from 2 s; the take's source is half a second ahead of its content.
const clip: Clip = {
  id: "c",
  trackId: "t",
  kind: "audio",
  start: sec(2),
  duration: sec(3),
  contentIn: sec(1),
  takeIds: ["k"],
  activeTakeId: "k",
};
const take: Take = { id: "k", assetId: "a", streamId: "mono", sourceAtContentZero: sec(0.5) };
const view = { startTick: 0, pixelsPerSecond: 100 };

test("a waveform asks for the clip's visible source range, one bucket per column", () => {
  const b = rectangle(clip, 0, 0, view, 1000);
  assert.deepEqual(placeWaveform(clip, take, b.x, b.endX, view), {
    request: { assetId: "a", streamId: "mono", start: sec(1.5), end: sec(4.5), buckets: 300 },
    x: 200,
  });
  // Scrolled past the clip's start, only its visible part is asked for.
  const later = { startTick: sec(3), pixelsPerSecond: 100 };
  const cut = rectangle(clip, 0, 0, later, 1000);
  assert.deepEqual(placeWaveform(clip, take, cut.x, cut.endX, later), {
    request: { assetId: "a", streamId: "mono", start: sec(2.5), end: sec(4.5), buckets: 200 },
    x: 0,
  });
  // Clipped by the view's right edge.
  const narrow = rectangle(clip, 0, 0, view, 350);
  assert.equal(placeWaveform(clip, take, narrow.x, narrow.endX, view)?.request.end, sec(3));
  // Nothing visible asks for nothing.
  const gone = rectangle(clip, 0, 0, { startTick: sec(6), pixelsPerSecond: 100 }, 1000);
  assert.equal(placeWaveform(clip, take, gone.x, gone.endX, view), null);
});

test("a move keeps the clip's source range, and a trim or take offset changes it", () => {
  const source = (c: Clip, k: Take = take) => {
    const b = rectangle(c, 0, 0, view, 2000);
    const placed = placeWaveform(c, k, b.x, b.endX, view);
    return placed && [placed.request.start / hz, placed.request.end / hz];
  };
  assert.deepEqual(source({ ...clip, start: sec(4) }), [1.5, 4.5]);
  assert.deepEqual(
    source({ ...clip, start: sec(2.5), duration: sec(2.5), contentIn: sec(1.5) }),
    [2, 4.5],
  );
  assert.deepEqual(source(clip, { ...take, sourceAtContentZero: sec(0.75) }), [1.75, 4.75]);
});

test("peaks outside -1 to 1 are clamped, and unusable values read as silence", () => {
  assert.deepEqual(
    [2, -3, 0.5, Number.NaN, undefined, Infinity].map((v) => unit(v)),
    [1, -1, 0.5, 0, 0, 0],
  );
});

test("a retimed clip's waveform spreads its content over the same columns", () => {
  // At rate 1.5 the three-second clip shows 4.5 s of content from 1 s.
  const fast: Clip = { ...clip, rate: 1.5 };
  const b = rectangle(fast, 0, 0, view, 1000);
  assert.deepEqual(placeWaveform(fast, take, b.x, b.endX, view), {
    request: { assetId: "a", streamId: "mono", start: sec(1.5), end: sec(6), buckets: 300 },
    x: 200,
  });
  // One second into the clip is 1.5 s into its content.
  const later = { startTick: sec(3), pixelsPerSecond: 100 };
  const cut = rectangle(fast, 0, 0, later, 1000);
  assert.deepEqual(placeWaveform(fast, take, cut.x, cut.endX, later)?.request, {
    assetId: "a",
    streamId: "mono",
    start: sec(3),
    end: sec(6),
    buckets: 200,
  });
});
