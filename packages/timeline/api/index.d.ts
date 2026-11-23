import type { TimelineOptions, TimelineView } from "./types.ts";
export type * from "./types.ts";
export type { Viewport } from "./geometry.ts";
export declare function mountTimeline(container: HTMLElement, options: TimelineOptions): TimelineView;
