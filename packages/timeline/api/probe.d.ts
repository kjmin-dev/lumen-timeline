import type { PixelRect, Pixels } from "./renderer.ts";
import type { TimelineView } from "./types.ts";
/** Lets `readPixels` read a mounted view's clip canvas. */
export declare function registerReader(view: TimelineView, read: (rect: PixelRect) => Promise<Pixels>): void;
/**
 * Reads a region of a view's clip canvas, in CSS pixels from its top left, as
 * RGBA bytes at device pixels. The current backend draws its last layout again
 * through its own pipeline and reads that back, so a test can check what any
 * backend draws without a screenshot of the page.
 */
export declare function readPixels(view: TimelineView, rect: PixelRect): Promise<Pixels>;
