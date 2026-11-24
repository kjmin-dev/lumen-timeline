import type { Clip, ClipQueryOptions, Editor, Tick, TickRange } from "@lumen-timeline/core";
import type { ResolvedChrome, ResolvedUiLabels } from "./config.ts";
import type { Listen } from "./dom.ts";
import type { Box, Span, Viewport } from "./geometry.ts";
import type { EdgeMode, SnapConfig, SnapOptions, TimelineEvents, TimelineTransport } from "./types.ts";
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
    markersIn(range: TickRange): readonly {
        readonly start: Tick;
    }[];
}
/** A clip being dragged: its placement and track. */
export type DragClip = Span & {
    readonly trackId: string;
};
/** Where a pointer event lands in the view. */
export interface PointerInfo {
    readonly x: number;
    readonly y: number;
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
    readonly point: (event: MouseEvent | PointerEvent) => PointerInfo;
    readonly getView: () => Viewport;
    readonly setGhost: (clips: readonly Clip[]) => void;
    readonly message: HTMLElement;
    /** Where the undo and redo buttons go: the view's toolbar. */
    readonly history: HTMLElement;
    /** The snap settings now, which the host can change while the view is mounted. */
    readonly config: () => SnapConfig;
    readonly readOnly: () => boolean;
    readonly shortcuts: () => boolean;
    readonly chrome: () => ResolvedChrome;
    readonly uiLabels: () => ResolvedUiLabels;
    readonly events: () => TimelineEvents | undefined;
    /** What an edge drag does now. */
    readonly edgeMode: () => EdgeMode;
}
export interface EditingBinding {
    sync(): void;
    /** Splits the single selected clip at the playhead, as the S key does. */
    split(): void;
    dispose(): void;
}
export declare function handleAt(box: {
    readonly left: number;
    readonly right: number;
}, x: number, width: number): Edge;
export declare function snapDelta(delta: number, clips: readonly DragClip[], edge: Edge, dest: string | undefined, { gridTicks, tolerancePx, neighbors, playhead: snapToPlayhead, markers, }: SnapConfig, view: Pick<Viewport, "pixelsPerSecond">, read: SnapRead, playhead: Tick, held?: SnapHold | null): {
    readonly delta: number;
    readonly held?: SnapHold;
};
/**
 * The timeline length a stretch of `edge` by `delta` gives `clip`, held to the
 * lengths whose rate stays from `MIN_CLIP_RATE` to `MAX_CLIP_RATE`, and to a
 * start at or after zero. The bounds use the rate a `retime` by duration
 * computes, so a clamped drag is never rejected for its rate.
 */
export declare function stretchLength(clip: Clip, edge: "left" | "right", delta: Tick): Tick;
export declare function snapConfig(snap?: SnapOptions): SnapConfig;
export declare function bindEditing({ root, surface, editor, transport, listen, point, getView, setGhost, message, history, config, readOnly, shortcuts, chrome, uiLabels, events, edgeMode, }: EditingOptions): EditingBinding;
