import { TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import type { Tick } from "@lumen-timeline/core";

/** The visible window: the tick at the left edge and the zoom level. */
export interface Viewport {
  readonly startTick: Tick;
  readonly pixelsPerSecond: number;
}

/** The placement fields that layout reads. */
export interface Span {
  readonly id: string;
  readonly start: Tick;
  readonly duration: Tick;
}

/** Lane assignments for one track and the row height they need. */
export interface Packed {
  readonly lanes: Map<string, number>;
  readonly height: number;
}

/** A clip's rectangle in CSS pixels, with its true and visible horizontal extent. */
export interface Box<C extends Span = Span> {
  readonly clip: C;
  readonly left: number;
  readonly right: number;
  readonly x: number;
  readonly endX: number;
  readonly y: number;
  readonly height: number;
}

export const laneHeight = 34;
export const rowInset = 6;
export const tickAt = (x: number, view: Viewport): Tick =>
  view.startTick + Math.round((x * hz) / view.pixelsPerSecond);
export const pixelAt = (tick: Tick, view: Viewport): number =>
  ((tick - view.startTick) / hz) * view.pixelsPerSecond;

export function viewport(
  startTick: Tick,
  pixelsPerSecond: number,
  width: number,
  duration: Tick,
): Viewport {
  if (
    !Number.isSafeInteger(startTick) ||
    !Number.isFinite(pixelsPerSecond) ||
    pixelsPerSecond <= 0
  ) {
    throw new RangeError("Expected a safe tick and positive zoom");
  }
  const scale = Math.max(0.01, Math.min(pixelsPerSecond, hz));
  const maxStart = Math.max(0, duration - Math.ceil((width * hz) / scale));
  return { startTick: Math.max(0, Math.min(startTick, maxStart)), pixelsPerSecond: scale };
}

export function zoomAt(
  view: Viewport,
  x: number,
  factor: number,
  width: number,
  duration: Tick,
): Viewport {
  const scale = viewport(0, view.pixelsPerSecond * factor, width, duration).pixelsPerSecond;
  return viewport(tickAt(x, view) - Math.round((x * hz) / scale), scale, width, duration);
}

// clipsIn supplies a stable start/ID order for the whole track. Horizontal pans
// reuse these assignments even when an overlapping predecessor is offscreen.
export function pack(clips: readonly Span[]): Packed {
  const lanes = new Map<string, number>();
  const ends: number[] = [];
  for (const clip of clips) {
    let index = ends.findIndex((end) => end <= clip.start);
    if (index < 0) index = ends.length;
    ends[index] = clip.start + clip.duration;
    lanes.set(clip.id, index);
  }
  return { lanes, height: Math.max(1, ends.length) * laneHeight + rowInset * 2 };
}

export function rectangle<C extends Span>(
  clip: C,
  lane: number,
  rowTop: number,
  view: Viewport,
  width: number,
): Box<C> {
  const left = pixelAt(clip.start, view);
  const right = pixelAt(clip.start + clip.duration, view);
  return {
    clip,
    left,
    right,
    x: Math.max(0, left),
    endX: Math.min(width, right),
    y: rowTop + rowInset + laneHeight * lane,
    height: laneHeight - 3,
  };
}

export function hit<C extends Span>(
  boxes: readonly Box<C>[],
  x: number,
  y: number,
): Box<C> | undefined {
  return boxes.find((b) => b.x <= x && x < b.endX && b.y <= y && y < b.y + b.height);
}

export function formatTime(tick: Tick): string {
  const ms = Math.round((Math.max(0, tick) / hz) * 1000);
  return (
    String(Math.floor(ms / 60000)).padStart(2, "0") +
    ":" +
    String(Math.floor(ms / 1000) % 60).padStart(2, "0") +
    "." +
    String(ms % 1000).padStart(3, "0")
  );
}
