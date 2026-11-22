import type { Clip, Tick } from "./types.ts";
export declare const TICKS_PER_SECOND = 282240000;
/** The longest project and the furthest source position: seven days of ticks. */
export declare const MAX_TICK: number;
export declare function unitsToTicks(units: number, numerator: number, denominator?: number): Tick;
export declare function ticksToUnits(ticks: Tick, numerator: number, denominator?: number): number;
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
export declare function sourceWindow(clip: ClipWindow, take: TakeWindow, from: Tick, until: Tick): SourceWindow | null;
/** Fields `splitClip` reads. It copies every other field of the record unchanged. */
export type SplitSource = Pick<Clip, "start" | "duration" | "contentIn">;
export declare function splitClip<C extends SplitSource>(clip: C, at: Tick, rightId: string): [C, C];
