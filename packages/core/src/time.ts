import type { Clip, Tick } from "./types.ts";

// Source rates are rational units per second, e.g. 30000 / 1001 frames.
export const TICKS_PER_SECOND = 282_240_000;

/** The longest project and the furthest source position: seven days of ticks. */
export const MAX_TICK: number = 7 * 86400 * TICKS_PER_SECOND;

function convert(value: number, numerator: number, denominator: number, toTicks: boolean): number {
  if (
    !Number.isSafeInteger(value) ||
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    throw new RangeError("Expected a safe integer position and positive integer rate terms");
  }
  const scale = TICKS_PER_SECOND * denominator;
  if (Number.isSafeInteger(scale)) {
    const multiplier = toTicks ? scale : numerator;
    const divisor = toTicks ? numerator : scale;
    // Cancel an exact ratio first, as is possible for common audio and frame rates.
    if (multiplier % divisor === 0) {
      const result = value * (multiplier / divisor);
      if (!Number.isSafeInteger(result)) throw new RangeError("Time exceeds safe integer range");
      return result || 0;
    }
    const product = Math.abs(value) * multiplier;
    if (Number.isSafeInteger(product)) {
      const remainder = product % divisor;
      const whole = (product - remainder) / divisor;
      const rounded = whole + Number(remainder >= divisor - remainder);
      return rounded === 0 ? 0 : value < 0 ? -rounded : rounded;
    }
  }
  const exactScale = BigInt(TICKS_PER_SECOND) * BigInt(denominator);
  const multiplier = toTicks ? exactScale : BigInt(numerator);
  const divisor = toTicks ? BigInt(numerator) : exactScale;
  const magnitude = (BigInt(Math.abs(value)) * multiplier + divisor / 2n) / divisor;
  const result = Number(value < 0 ? -magnitude : magnitude);
  if (!Number.isSafeInteger(result)) throw new RangeError("Time exceeds safe integer range");
  return result;
}

export function unitsToTicks(units: number, numerator: number, denominator: number = 1): Tick {
  return convert(units, numerator, denominator, true);
}

export function ticksToUnits(ticks: Tick, numerator: number, denominator: number = 1): number {
  return convert(ticks, numerator, denominator, false);
}

/**
 * The slowest and fastest clip rates. A clip's rate is content ticks per
 * timeline tick: 0.5 plays its content at half speed over twice the length.
 */
export const MIN_CLIP_RATE = 0.25;
export const MAX_CLIP_RATE = 4;

/** A clip's rate: its `rate` field, or 1 when absent. */
export const rateOf = (clip: { readonly rate?: number | undefined }): number => clip.rate ?? 1;

/** Rounds half away from zero, as tick conversions do. */
export function roundTick(value: number): Tick {
  const rounded = value < 0 ? -Math.round(-value) : Math.round(value);
  return rounded || 0;
}

/**
 * The content length a clip of `rate` covers in `ticks` of timeline. At rate 1
 * this is `ticks` itself; otherwise it rounds to the nearest tick.
 */
export function contentLength(ticks: Tick, rate: number): Tick {
  return rate === 1 ? ticks : roundTick(ticks * rate);
}

/** The timeline ticks that cover `length` of content at `rate`, rounded to the nearest tick. */
export function timelineLength(length: Tick, rate: number): Tick {
  return rate === 1 ? length : roundTick(length / rate);
}

/** Clip placement fields read by `sourceWindow`. */
export type ClipWindow = Pick<Clip, "start" | "duration" | "contentIn"> & {
  readonly rate?: number | undefined;
};

/** The content position a clip plays at timeline tick `tick`. */
export function contentAt(clip: ClipWindow, tick: Tick): Tick {
  return clip.contentIn + contentLength(tick - clip.start, rateOf(clip));
}

/** A clip's content end: the content position at its timeline end. */
export function contentEnd(clip: ClipWindow): Tick {
  return clip.contentIn + contentLength(clip.duration, rateOf(clip));
}

/** A take's source mapping and availability, normalized to project ticks. */
export interface TakeWindow {
  readonly sourceAtContentZero: Tick;
  readonly availableStart: Tick;
  readonly availableEnd: Tick;
}

/** The audible part of a clip in `[from, until)` and its source positions. */
export interface SourceWindow {
  readonly start: Tick;
  readonly end: Tick;
  /** Source position at `start`. */
  readonly sourceStart: Tick;
  /** Source position at `end`. At rate 1, `sourceStart + end - start`. */
  readonly sourceEnd: Tick;
}

// Clip, take and query boundaries have already been normalized to project ticks.
export function sourceWindow(
  clip: ClipWindow,
  take: TakeWindow,
  from: Tick,
  until: Tick,
): SourceWindow | null {
  const rate = rateOf(clip);
  // Content position c plays at timeline tick clip.start + (c - contentIn) / rate,
  // and sources take.sourceAtContentZero + c. The first and last ticks whose
  // source lies inside the available range bound the window.
  const zero = take.sourceAtContentZero + clip.contentIn;
  const first = clip.start + Math.ceil((take.availableStart - zero) / rate);
  const last = clip.start + Math.ceil((take.availableEnd - zero) / rate);
  const start = Math.max(from, clip.start, first);
  const end = Math.min(until, clip.start + clip.duration, last);
  if (start >= end) return null;
  return {
    start,
    end,
    sourceStart: take.sourceAtContentZero + contentAt(clip, start),
    sourceEnd: take.sourceAtContentZero + contentAt(clip, end),
  };
}

/** Fields `splitClip` reads. It copies every other field of the record unchanged. */
export type SplitSource = Pick<Clip, "start" | "duration" | "contentIn"> & {
  readonly rate?: number | undefined;
};

/**
 * Cuts a clip at timeline tick `at`. The right half starts at content position
 * `atContent`, which defaults to the content the clip plays at `at`.
 */
export function splitClip<C extends SplitSource>(
  clip: C,
  at: Tick,
  rightId: string,
  atContent: Tick = contentAt(clip, at),
): [C, C] {
  const leftDuration = at - clip.start;
  if (!Number.isSafeInteger(at) || leftDuration <= 0 || leftDuration >= clip.duration) {
    throw new RangeError("Split must be inside the clip");
  }
  return [
    { ...clip, duration: leftDuration },
    {
      ...clip,
      id: rightId,
      start: at,
      duration: clip.duration - leftDuration,
      contentIn: atContent,
    },
  ];
}
