import type { Clip, ClipQueryOptions, Editor, Tick, TickRange } from "@lumen-timeline/core";
import type { Listen } from "./dom.ts";
import type { Box, Span, Viewport } from "./geometry.ts";
import type { SnapConfig, SnapOptions, TimelineTransport } from "./types.ts";
export type Edge = "left" | "right" | "move";
/** The candidate a drag snapped to, kept so a held snap resists jitter. */
export interface SnapHold {
    readonly correction: number;
    readonly priority: number;
    readonly target: Tick;
    readonly origin: Tick;
}
/** The read handle members snapping needs. */
export interface SnapRead {
    clipsIn(range: TickRange, options?: ClipQueryOptions): readonly Span[];
}
/** A clip being dragged: its placement and track. */
export type DragClip = Span & {
    readonly trackId: string;
};
/** Where a pointer event lands in the view. */
export interface PointerInfo {
    readonly x: number;
    readonly width: number;
    readonly tick: Tick;
    readonly box: Box<Clip> | undefined;
    readonly trackId: string | undefined;
}
export interface EditingOptions {
    readonly root: HTMLElement;
    readonly surface: HTMLElement;
    readonly editor: Editor;
    readonly transport: TimelineTransport;
    readonly listen: Listen;
    readonly point: (event: PointerEvent) => PointerInfo;
    readonly getView: () => Viewport;
    readonly setGhost: (clips: readonly Clip[]) => void;
    readonly message: HTMLElement;
    readonly config: SnapConfig;
}
export declare function handleAt(box: {
    readonly left: number;
    readonly right: number;
}, x: number, width: number): Edge;
export declare function snapDelta(delta: number, clips: readonly DragClip[], edge: Edge, dest: string | undefined, { gridTicks, tolerancePx, neighbors, playhead: snapToPlayhead }: SnapConfig, view: Pick<Viewport, "pixelsPerSecond">, read: SnapRead, playhead: Tick, held?: SnapHold | null): {
    readonly delta: number;
    readonly held?: SnapHold;
};
export declare function snapConfig(snap?: SnapOptions): SnapConfig;
export declare function bindEditing({ root, surface, editor, transport, listen, point, getView, setGhost, message, config, }: EditingOptions): () => void;
