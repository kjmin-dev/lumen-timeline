import type { Editor, Tick } from "@lumen-timeline/core";
import type { Viewport } from "./geometry.ts";
/** What the view reads from a transport snapshot. */
export interface TransportState {
    readonly playing: boolean;
    readonly presentedTick: Tick;
    /** A seek the transport has accepted but not yet presented. */
    readonly requestedTick: Tick | null;
}
/**
 * The transport contract the view needs. Media transports satisfy it, and a host
 * can adapt any player that reports project ticks.
 */
export interface TimelineTransport {
    snapshot(): TransportState;
    subscribe(listener: (state: TransportState) => void): () => unknown;
    /** May return a promise. A rejection is shown in the view's status line. */
    play(): unknown;
    pause(): void;
    /** May return a promise. A rejection is shown in the view's status line. */
    seek(tick: Tick): unknown;
}
export interface SnapOptions {
    /** Grid interval in ticks. Zero disables the grid. Defaults to one 30 fps frame. */
    readonly gridTicks?: number;
    /** CSS-pixel snap distance. Zero disables snapping. Defaults to 5. */
    readonly tolerancePx?: number;
    /** Snap to neighboring clip boundaries. Defaults to true. */
    readonly neighbors?: boolean;
    /** Snap to the playhead. Defaults to true. */
    readonly playhead?: boolean;
    /** Snap to saved markers. Defaults to true. */
    readonly markers?: boolean;
}
/** Snap options with their defaults applied. */
export interface SnapConfig extends SnapOptions {
    readonly gridTicks: number;
    readonly tolerancePx: number;
}
/**
 * The host's words for a clip's candidates, which the view draws after the
 * name of each clip that lists any: the active candidate's label and the count.
 */
export interface TimelineLabels {
    /** One candidate. Defaults to "take". */
    readonly take?: string | undefined;
    /** Several candidates. Defaults to `take` followed by "s". */
    readonly takes?: string | undefined;
    /** Shown when no candidate is active. Defaults to "No " followed by `take`. */
    readonly none?: string | undefined;
}
export interface TimelineOptions {
    readonly editor: Editor;
    readonly transport: TimelineTransport;
    readonly pixelsPerSecond?: number | undefined;
    readonly startTick?: Tick | undefined;
    readonly snap?: SnapOptions | undefined;
    readonly labels?: TimelineLabels | undefined;
}
export interface TimelineDiagnostics {
    readonly layoutBuilds: number;
    readonly staticPaints: number;
    readonly overlayPaints: number;
    readonly previewClipCount: number;
}
export interface TimelineView {
    setViewport(viewport: Partial<Viewport>): void;
    getViewport(): Viewport;
    getDiagnostics(): TimelineDiagnostics;
    /** Releases this mount's DOM, observers and subscriptions. The host owns the editor and transport. */
    dispose(): void;
}
