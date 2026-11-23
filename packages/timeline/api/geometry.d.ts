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
export declare const laneHeight = 47;
export declare const rowInset = 10;
export declare const tickAt: (x: number, view: Viewport) => Tick;
export declare const pixelAt: (tick: Tick, view: Viewport) => number;
export declare function viewport(startTick: Tick, pixelsPerSecond: number, width: number, duration: Tick): Viewport;
export declare function zoomAt(view: Viewport, x: number, factor: number, width: number, duration: Tick): Viewport;
export declare function pack(clips: readonly Span[], laneH?: number, inset?: number): Packed;
export declare function rectangle<C extends Span>(clip: C, lane: number, rowTop: number, view: Viewport, width: number, laneH?: number, inset?: number): Box<C>;
export declare function hit<C extends Span>(boxes: readonly Box<C>[], x: number, y: number): Box<C> | undefined;
export declare function formatTime(tick: Tick): string;
