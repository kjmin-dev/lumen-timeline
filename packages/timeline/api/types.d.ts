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
/**
 * The part of a take's source that the view draws for one clip, in source
 * time: the clip's content time plus the take's `sourceAtContentZero`. The
 * range divides into `buckets` equal slices, one per CSS pixel column.
 */
export interface WaveformRequest {
    readonly assetId: string;
    readonly streamId: string;
    readonly start: Tick;
    readonly end: Tick;
    readonly buckets: number;
}
/**
 * Peaks for the waveforms the view draws inside clips. The view asks for the
 * visible part of each clip's active take whenever it paints that clip.
 */
export interface WaveformProvider {
    /**
     * `buckets` minimum and maximum pairs in -1 to 1, as `[min0, max0, min1,
     * max1, …]`, or `null` to draw no waveform for this source yet.
     */
    peaks(request: WaveformRequest): ArrayLike<number> | null;
    /**
     * Called with an asset ID when its peaks become available or change. The view
     * repaints the tracks whose clips play that asset. Call it outside `peaks`.
     */
    subscribe?(listener: (assetId: string) => void): () => unknown;
}
export interface TimelineOptions {
    readonly editor: Editor;
    readonly transport: TimelineTransport;
    readonly pixelsPerSecond?: number | undefined;
    readonly startTick?: Tick | undefined;
    readonly snap?: SnapOptions | undefined;
    readonly labels?: TimelineLabels | undefined;
    /** Draws a waveform in each clip whose active take the provider has peaks for. */
    readonly waveforms?: WaveformProvider | undefined;
    /**
     * The drawing backend. `auto`, the default, draws through WebGL2 on a
     * hardware GPU and through Canvas 2D where WebGL2 is missing or would run on
     * a software rasterizer. `webgl2` uses WebGL2 wherever it exists. `webgpu`
     * draws through WebGPU once its device is ready, and through WebGL2 or
     * Canvas 2D until then and after a lost device. `canvas2d` never touches the
     * GPU from the view.
     */
    readonly renderer?: "auto" | "webgl2" | "webgpu" | "canvas2d" | undefined;
}
export interface TimelineDiagnostics {
    readonly layoutBuilds: number;
    readonly staticPaints: number;
    readonly overlayPaints: number;
    readonly previewClipCount: number;
    /** The backend drawing the clips now. */
    readonly backend: "webgl2" | "webgpu" | "canvas2d";
    /** The backend the mount asked for. */
    readonly renderer: "auto" | "webgl2" | "webgpu" | "canvas2d";
    /** Why `backend` is not the one asked for, such as a lost device, or `null`. */
    readonly fallback: string | null;
    /**
     * Geometry uploads to the GPU since the view mounted: one per frame the
     * layout changed. A fixed viewport and project during playback adds none.
     */
    readonly staticUploads: number;
    /** Lost WebGL2 contexts and WebGPU devices since the view mounted. */
    readonly deviceLosses: number;
    /** Bytes of GPU buffers and textures the drawing backend holds: geometry and the label atlas. */
    readonly gpuBytes: number;
    /** Clips in the current layout: the clips of visible rows in the visible range. */
    readonly visibleClips: number;
    /** Labels rasterized into the label atlas since the view mounted. */
    readonly labelsRasterized: number;
}
/** What lies under a point of the clip surface. */
export interface TimelineHit {
    /** The clip under the point, or `null` over empty track space. */
    readonly clipId: string | null;
    /** The clip's part under the point: a trim handle or its body. `null` with no clip. */
    readonly edge: "left" | "right" | "move" | null;
    /** The track row under the point, or `null` below the last track. */
    readonly trackId: string | null;
    /** The timeline tick at the point's horizontal position. */
    readonly tick: Tick;
}
export interface TimelineView {
    setViewport(viewport: Partial<Viewport>): void;
    getViewport(): Viewport;
    /**
     * Scrolls the clip's lane into view and pans to its start when that is
     * offscreen. Selection is the host's. Returns false for a clip the project
     * does not hold.
     */
    reveal(clipId: string): boolean;
    /**
     * What lies under a point given in CSS pixels from the clip surface's top
     * left corner, as the pointer sees it. `null` outside the surface. It reads
     * the layout, not pixels, so every backend answers alike.
     */
    hitTest(point: {
        readonly x: number;
        readonly y: number;
    }): TimelineHit | null;
    getDiagnostics(): TimelineDiagnostics;
    /** Releases this mount's DOM, observers and subscriptions. The host owns the editor and transport. */
    dispose(): void;
}
