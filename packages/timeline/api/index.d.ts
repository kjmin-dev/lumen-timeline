import type { TimelineOptions, TimelineView } from "./types.ts";
export type * from "./types.ts";
export type { Viewport } from "./geometry.ts";
export declare function mountTimeline(container: HTMLElement, { editor, transport, pixelsPerSecond, startTick, snap, labels, waveforms, renderer, }: TimelineOptions): TimelineView;
