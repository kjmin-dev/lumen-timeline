import type { Clip, Editor, ProjectSnapshot, Tick, Track } from "@lumen-timeline/core";
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
 * Host-supplied text for clip captions and built-in timeline controls.
 * Omitted keys use the English defaults.
 */
export interface TimelineLabels {
    /** One candidate. Defaults to "take". */
    readonly take?: string | undefined;
    /** Several candidates. Defaults to `take` followed by "s". */
    readonly takes?: string | undefined;
    /** Shown when no candidate is active. Defaults to "No " followed by `take`. */
    readonly none?: string | undefined;
    readonly play?: string | undefined;
    readonly pause?: string | undefined;
    readonly tracks?: string | undefined;
    readonly clip?: string | undefined;
    readonly selectClip?: string | undefined;
    readonly marker?: string | undefined;
    readonly selectMarker?: string | undefined;
    readonly addMarker?: string | undefined;
    readonly markerLabel?: string | undefined;
    readonly renameMarker?: string | undefined;
    readonly removeMarker?: string | undefined;
    readonly scroll?: string | undefined;
    readonly zoomIn?: string | undefined;
    readonly zoomOut?: string | undefined;
    readonly operation?: string | undefined;
    readonly move?: string | undefined;
    readonly trimStart?: string | undefined;
    readonly trimEnd?: string | undefined;
    readonly delta?: string | undefined;
    readonly apply?: string | undefined;
    readonly splitAtPlayhead?: string | undefined;
    readonly undo?: string | undefined;
    readonly redo?: string | undefined;
    /** Accessible name of the inline track rename field. Defaults to "Track name". */
    readonly trackName?: string | undefined;
    /** Tooltip of a track header's drag handle. Defaults to "Drag to reorder". */
    readonly reorderTrack?: string | undefined;
    /**
     * Announced to assistive technology after a track moves. `{name}`,
     * `{position}` and `{count}` are filled in. Defaults to
     * "{name} moved to position {position} of {count}".
     */
    readonly trackMoved?: string | undefined;
    /** The toolbar's snapping switch. Defaults to "Snap". */
    readonly snap?: string | undefined;
    /** The selected clip's split button. Defaults to "Split". */
    readonly split?: string | undefined;
    /** The switch that shows a clip's candidates as lanes under its track. Defaults to "Takes". */
    readonly takeLanes?: string | undefined;
    /** A track header's mute switch; the track name follows. Defaults to "Mute". */
    readonly mute?: string | undefined;
    /** A track header's solo switch; the track name follows. Defaults to "Solo". */
    readonly solo?: string | undefined;
    /** Shown for a locked track. Defaults to "Locked". */
    readonly locked?: string | undefined;
    /** A take lane's audition button; the take's label follows. Defaults to "Audition". */
    readonly audition?: string | undefined;
    /** The toolbar switch that makes edge drags stretch clips. Defaults to "Stretch". */
    readonly stretch?: string | undefined;
    /** The edit form's operation that sets a clip's speed. Defaults to "Speed". */
    readonly speed?: string | undefined;
    /** The edit form's value label for a speed. Defaults to "Speed (%)". */
    readonly speedPercent?: string | undefined;
}
/**
 * Toggles individual pieces of built-in DOM chrome. Every flag defaults to `true`.
 * Pass `chrome: false` for a bare clip canvas, or `chrome: "minimal"` for ruler +
 * track headers + clip surface with no toolbars or forms.
 */
export interface TimelineChrome {
    readonly toolbar?: boolean | undefined;
    readonly ruler?: boolean | undefined;
    readonly trackHeaders?: boolean | undefined;
    readonly scrollBar?: boolean | undefined;
    readonly markerEditor?: boolean | undefined;
    readonly editToolbar?: boolean | undefined;
    readonly status?: boolean | undefined;
    /** Clip `<select>` inside the toolbar. Set `false` to skip maintaining DOM `<option>` nodes. */
    readonly clipNavigator?: boolean | undefined;
    readonly markerNavigator?: boolean | undefined;
    /**
     * Inline rename in the track headers: double-click a name, or press Enter or
     * F2 on a focused header. Off in the `"minimal"` preset and in `readOnly`.
     */
    readonly trackRename?: boolean | undefined;
    /**
     * Track reordering from the headers: drag a header or its grip, or press
     * Alt+Arrow keys on a focused header. Off in the `"minimal"` preset and in
     * `readOnly`.
     */
    readonly trackReorder?: boolean | undefined;
    /** Undo and redo buttons in the toolbar. Off in the `"minimal"` preset. */
    readonly history?: boolean | undefined;
    /** The toolbar switch that suspends snapping. Off in the `"minimal"` preset. */
    readonly snapToggle?: boolean | undefined;
    /**
     * The toolbar switch between trimming and stretching with edge drags, also
     * flipped with R on the focused clip surface. Off in the `"minimal"` preset.
     */
    readonly stretchToggle?: boolean | undefined;
    /**
     * The floating toolbar above a single selected clip: split at the playhead,
     * and the take lanes switch for a clip with several candidates. Off in the
     * `"minimal"` preset and in `readOnly`.
     */
    readonly clipToolbar?: boolean | undefined;
    /**
     * Take lanes: the selected clip's candidates as lanes under its track, each
     * with its own waveform. A click on a lane makes that candidate active. Opened
     * from the clip toolbar, with T on the focused clip surface, or through
     * `view.showTakeLanes`. Off in the `"minimal"` preset.
     */
    readonly takeLanes?: boolean | undefined;
    /**
     * Mute and solo switches, the lock mark and the gain readout in the default
     * track headers. Off in the `"minimal"` preset.
     */
    readonly trackControls?: boolean | undefined;
}
export type TimelineChromeOption = false | "minimal" | TimelineChrome;
/**
 * Clip colors for one track or clip (`#rrggbb` hex). `fill` is the clip body and
 * `stripe` its accent: the track header's dot and the outline of an inactive
 * take lane. `waveform` defaults to the accent at 40% opacity, and `text`, the
 * clip's name, to whichever of a dark or a light ink reads better on `fill`.
 */
export interface TimelineTrackColors {
    readonly fill: string;
    readonly stripe: string;
    readonly waveform?: string | undefined;
    readonly text?: string | undefined;
}
/**
 * Canvas and overlay theme overrides. Unspecified fields keep the palette of
 * `scheme`.
 */
export interface TimelineTheme {
    /**
     * The built-in palette the view starts from, for its DOM chrome and its
     * canvases alike: `"dark"`, the default, or `"light"`. The other fields
     * override single colors of it.
     */
    readonly scheme?: "light" | "dark" | undefined;
    readonly rowEven?: string | undefined;
    readonly rowOdd?: string | undefined;
    readonly grid?: string | undefined;
    readonly selectionStroke?: string | undefined;
    readonly handleFill?: string | undefined;
    readonly ghostFill?: string | undefined;
    readonly ghostStroke?: string | undefined;
    readonly marker?: string | undefined;
    readonly rulerText?: string | undefined;
    readonly rulerMarkerBackground?: string | undefined;
    readonly labelColor?: string | undefined;
    readonly nameFont?: string | undefined;
    readonly captionFont?: string | undefined;
    /** The ruler's time labels. Defaults to a 10px monospace face. */
    readonly rulerFont?: string | undefined;
    /** The ruler's marker flags. Defaults to a bold 10px system face. */
    readonly markerFont?: string | undefined;
    /** Track colors cycled by row index when neither clip nor track sets `color`. */
    readonly palette?: readonly TimelineTrackColors[] | undefined;
    /** The colors of a locked track's clips. Defaults to a neutral grey. */
    readonly locked?: TimelineTrackColors | undefined;
}
/** Row spacing in CSS pixels. */
export interface TimelineLayoutOptions {
    /** Height of one clip lane in CSS pixels (`>= 16`). Defaults to `47`. */
    readonly laneHeight?: number | undefined;
    /** Top and bottom padding per track row in CSS pixels (`>= 0`). Defaults to `10`. */
    readonly rowInset?: number | undefined;
}
/** Per-clip visual overrides returned by `clipStyle`. */
export interface ClipAppearance {
    readonly fill?: string | undefined;
    readonly stripe?: string | undefined;
    readonly waveform?: string | undefined;
    /** Override the clip's displayed primary label. */
    readonly label?: string | undefined;
    /** Override or hide (`null`) the secondary caption. */
    readonly caption?: string | null | undefined;
    readonly captionColor?: string | undefined;
}
export type ClipStyleFn = (clip: Clip, track: Track, trackIndex: number) => ClipAppearance | undefined;
/**
 * Context handed to `renderTrackHeader` for one virtualized track header row.
 * Built-in rename and reorder reach a custom header through two markers in its
 * content: an element with `data-lt-track-grip` starts a reorder drag, and
 * double-clicking an element with `data-lt-track-name` swaps it for the inline
 * rename field until the rename ends. The header element itself takes the
 * arrow-key, Enter, F2 and Alt+Arrow keys.
 */
export interface TrackHeaderContext {
    readonly element: HTMLElement;
    readonly track: Track;
    readonly index: number;
    readonly height: number;
    readonly editor: Editor;
}
/**
 * Populates a virtualized track header element, or returns a child element to
 * replace its contents.
 */
export type TrackHeaderRenderer = (track: Track, context: TrackHeaderContext) => HTMLElement | void;
/** A visible clip's layout rectangle in surface-local CSS pixels. */
export interface ClipBox {
    readonly clip: Clip;
    readonly left: number;
    readonly right: number;
    readonly x: number;
    readonly endX: number;
    readonly y: number;
    readonly height: number;
}
/** Context handed to `renderOverlay` after built-in selection, ghost and marker drawing. */
export interface OverlayRenderContext {
    readonly ctx: CanvasRenderingContext2D;
    readonly width: number;
    readonly height: number;
    readonly scrollTop: number;
    readonly view: Viewport;
    readonly snapshot: ProjectSnapshot;
    readonly selection: readonly string[];
    readonly pixelAt: (tick: Tick) => number;
    readonly tickAt: (x: number) => Tick;
    readonly boxOf: (clipId: string) => ClipBox | undefined;
}
export type OverlayRenderer = (context: OverlayRenderContext) => void;
/** Pointer interaction payload delivered to host callbacks. */
export interface TimelinePointerEvent {
    readonly hit: TimelineHit;
    readonly x: number;
    readonly y: number;
    readonly originalEvent: MouseEvent | PointerEvent;
}
export interface TimelineClipEvent extends TimelinePointerEvent {
    readonly clipId: string;
}
/** Host interaction callbacks fired by the timeline surface and viewport. */
/**
 * What dragging a clip's edge does. `"trim"` reveals or hides content and keeps
 * the clip's speed. `"stretch"` keeps the content and changes the clip's rate,
 * as a `retime` command anchored at the other edge.
 */
export type EdgeMode = "trim" | "stretch";
export interface TimelineEvents {
    readonly onClipClick?: ((event: TimelineClipEvent) => void) | undefined;
    readonly onClipDoubleClick?: ((event: TimelineClipEvent) => void) | undefined;
    readonly onContextMenu?: ((event: TimelinePointerEvent) => void) | undefined;
    readonly onTrackClick?: ((event: TimelinePointerEvent) => void) | undefined;
    readonly onViewportChange?: ((viewport: Viewport) => void) | undefined;
    /**
     * Makes each take lane show an audition button, and receives its clicks. The
     * view plays nothing itself: the host auditions the candidate with its own
     * transport.
     */
    readonly onTakeAudition?: ((event: TimelineTakeEvent) => void) | undefined;
    /** The user switched edge drags between trimming and stretching. */
    readonly onEdgeModeChange?: ((mode: EdgeMode) => void) | undefined;
}
/** A candidate of a clip, as a take lane names it. */
export interface TimelineTakeEvent {
    readonly clipId: string;
    readonly takeId: string;
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
     * Maps a peak, already multiplied by the clip's gain, to the height drawn,
     * both in -1 to 1, keeping its sign. `decibelScale(floor)` draws quiet
     * material larger. Omitted, peaks are drawn as they are.
     */
    scale?(peak: number): number;
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
    /** Draws a waveform in each clip whose active take or direct source the provider has peaks for. */
    readonly waveforms?: WaveformProvider | undefined;
    /**
     * Controls which built-in DOM panels are shown. Defaults to showing all built-in
     * controls. Pass `"minimal"` for ruler + track headers + clip surface, or `false`
     * for a bare clip surface.
     */
    readonly chrome?: TimelineChromeOption | undefined;
    /** Canvas and overlay theme overrides. */
    readonly theme?: TimelineTheme | undefined;
    /** Row geometry overrides (`laneHeight`, `rowInset`). */
    readonly layout?: TimelineLayoutOptions | undefined;
    /**
     * Disables drag/keyboard/form editing while keeping selection, seek, zoom
     * and pan. Defaults to `true` for an editor whose `readOnly` names a reason,
     * such as a project in a later schema, and to `false` otherwise.
     */
    readonly readOnly?: boolean | undefined;
    /** Enables built-in keyboard editing and marker shortcuts. Defaults to `true`. */
    readonly shortcuts?: boolean | undefined;
    /** Formats ticks for the ruler, time readout and accessibility labels. */
    readonly formatTime?: ((tick: Tick) => string) | undefined;
    /** Returns the grid interval in ticks for a given zoom (`pixelsPerSecond`). */
    readonly gridSpacing?: ((pixelsPerSecond: number) => Tick) | undefined;
    /** Per-clip color, label and caption overrides. */
    readonly clipStyle?: ClipStyleFn | undefined;
    /** Custom DOM renderer for virtualized track header rows. */
    readonly renderTrackHeader?: TrackHeaderRenderer | undefined;
    /** Custom 2D overlay hook drawn above clips, selection and markers. */
    readonly renderOverlay?: OverlayRenderer | undefined;
    /** Interaction and viewport change callbacks. */
    readonly events?: TimelineEvents | undefined;
    /**
     * What dragging a clip's edge does. Defaults to `"trim"`. The user can flip
     * it with the toolbar's stretch switch or R; `update` changes it only to a
     * value other than the one last given, so a host that passes the same value
     * on every render keeps the user's choice.
     */
    readonly edgeMode?: EdgeMode | undefined;
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
/**
 * The options a mounted view can change. `editor`, `transport` and `renderer`
 * are fixed for a view's life; mount another view to change them.
 */
export type TimelineUpdate = Pick<TimelineOptions, "pixelsPerSecond" | "startTick" | "snap" | "labels" | "waveforms" | "chrome" | "theme" | "layout" | "readOnly" | "shortcuts" | "formatTime" | "gridSpacing" | "clipStyle" | "renderTrackHeader" | "renderOverlay" | "events" | "edgeMode">;
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
     * Geometry uploads to the GPU since the view mounted: one for each layout a
     * GPU backend drew. A fixed viewport and project during playback adds none.
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
    /**
     * Applies the options given, as a framework wrapper does on every render. A
     * key left out keeps its value, and a key given as `undefined` returns to its
     * default. Snap settings and caption words are compared by value, so equal
     * ones change nothing. A new waveform provider replaces the old one and the
     * clips repaint. `pixelsPerSecond` and `startTick` move the viewport only
     * when they differ from the values last given, at mount or here, so the
     * user's pan and zoom survive a host that passes the same values again.
     * Throws a `RangeError` for invalid snap settings, before changing anything.
     */
    update(options: TimelineUpdate): void;
    setViewport(viewport: Partial<Viewport>): void;
    getViewport(): Viewport;
    /**
     * Scrolls the clip's lane into view and pans to its start when that is
     * offscreen. Selection is the host's. Returns false for a clip the project
     * does not hold.
     */
    reveal(clipId: string): boolean;
    /** Scrolls a track row into view. Returns false if the track does not exist. */
    scrollToTrack(trackId: string): boolean;
    /**
     * Scrolls a track into view and opens the inline rename field in its header,
     * as after adding a track. Enter or a blur commits one undoable edit; Escape
     * cancels. Returns false when the track does not exist, rename is off
     * (`chrome.trackRename`, `readOnly`) or a custom header marks no
     * `data-lt-track-name` element.
     */
    renameTrack(trackId: string): boolean;
    /**
     * Shows a clip's candidates as take lanes under its track, or hides the open
     * lanes for `null`. The lanes close when the selection moves to other clips.
     * Returns false when take lanes are off (`chrome.takeLanes`) or the clip does
     * not list at least two candidates.
     */
    showTakeLanes(clipId: string | null): boolean;
    /**
     * Forces a redraw of the overlay (`"overlay"`) or the whole timeline (`"all"`,
     * default), e.g. when host state read by `renderOverlay` or `clipStyle` changes.
     */
    repaint(scope?: "all" | "overlay"): void;
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
