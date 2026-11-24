import type { Clip, Tick } from "./types.ts";
export declare const TICKS_PER_SECOND = 282240000;
/** The longest project and the furthest source position: seven days of ticks. */
export declare const MAX_TICK: number;
export declare function unitsToTicks(units: number, numerator: number, denominator?: number): Tick;
export declare function ticksToUnits(ticks: Tick, numerator: number, denominator?: number): number;
/**
 * The slowest and fastest clip rates. A clip's rate is content ticks per
 * timeline tick: 0.5 plays its content at half speed over twice the length.
 */
export declare const MIN_CLIP_RATE = 0.25;
export declare const MAX_CLIP_RATE = 4;
/** A clip's rate: its `rate` field, or 1 when absent. */
export declare const rateOf: (clip: {
    readonly rate?: number | undefined;
}) => number;
/** Rounds half away from zero, as tick conversions do. */
export declare function roundTick(value: number): Tick;
/**
 * The content length a clip of `rate` covers in `ticks` of timeline. At rate 1
 * this is `ticks` itself; otherwise it rounds to the nearest tick.
 */
export declare function contentLength(ticks: Tick, rate: number): Tick;
/** The timeline ticks that cover `length` of content at `rate`, rounded to the nearest tick. */
export declare function timelineLength(length: Tick, rate: number): Tick;
/** Clip placement fields read by `sourceWindow`. */
export type ClipWindow = Pick<Clip, "start" | "duration" | "contentIn"> & {
    readonly rate?: number | undefined;
};
/** The content position a clip plays at timeline tick `tick`. */
export declare function contentAt(clip: ClipWindow, tick: Tick): Tick;
/** A clip's content end: the content position at its timeline end. */
export declare function contentEnd(clip: ClipWindow): Tick;
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
export declare function sourceWindow(clip: ClipWindow, take: TakeWindow, from: Tick, until: Tick): SourceWindow | null;
/** Fields `splitClip` reads. It copies every other field of the record unchanged. */
export type SplitSource = Pick<Clip, "start" | "duration" | "contentIn"> & {
    readonly rate?: number | undefined;
};
/**
 * Cuts a clip at timeline tick `at`. The right half starts at content position
 * `atContent`, which defaults to the content the clip plays at `at`.
 */
export declare function splitClip<C extends SplitSource>(clip: C, at: Tick, rightId: string, atContent?: Tick): [C, C];
