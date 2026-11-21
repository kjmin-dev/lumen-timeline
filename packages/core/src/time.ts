import type { Clip, Tick } from "./types.ts";

// Source rates are rational units per second, e.g. 30000 / 1001 frames.
export const TICKS_PER_SECOND = 282_240_000;

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

/** Clip placement fields read by `sourceWindow`. */
export type ClipWindow = Pick<Clip, "start" | "duration" | "contentIn">;

/** A take's source mapping and availability, normalized to project ticks. */
export interface TakeWindow {
  readonly sourceAtContentZero: Tick;
  readonly availableStart: Tick;
  readonly availableEnd: Tick;
}

/** The audible part of a clip in `[from, until)` and its source position. */
export interface SourceWindow {
  readonly start: Tick;
  readonly end: Tick;
  readonly sourceStart: Tick;
}

// Clip, take and query boundaries have already been normalized to project ticks.
export function sourceWindow(
  clip: ClipWindow,
  take: TakeWindow,
  from: Tick,
  until: Tick,
): SourceWindow | null {
  const origin = take.sourceAtContentZero + clip.contentIn - clip.start;
  const start = Math.max(from, clip.start, take.availableStart - origin);
  const end = Math.min(until, clip.start + clip.duration, take.availableEnd - origin);
  return start < end ? { start, end, sourceStart: start + origin } : null;
}

export function splitClip(clip: Clip, at: Tick, rightId: string): [Clip, Clip] {
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
      contentIn: clip.contentIn + leftDuration,
    },
  ];
}
