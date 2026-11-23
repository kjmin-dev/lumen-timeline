import type { Rgba } from "./layout.ts";
import type { TimelineChromeOption, TimelineLabels, TimelineLayoutOptions, TimelineTheme } from "./types.ts";
export interface ResolvedChrome {
    readonly toolbar: boolean;
    readonly ruler: boolean;
    readonly trackHeaders: boolean;
    readonly scrollBar: boolean;
    readonly markerEditor: boolean;
    readonly editToolbar: boolean;
    readonly status: boolean;
    readonly clipNavigator: boolean;
    readonly markerNavigator: boolean;
}
export declare function resolveChrome(option?: TimelineChromeOption): ResolvedChrome;
export declare function sameChrome(a: ResolvedChrome, b: ResolvedChrome): boolean;
export interface ResolvedUiLabels {
    readonly play: string;
    readonly pause: string;
    readonly tracks: string;
    readonly clip: string;
    readonly selectClip: string;
    readonly marker: string;
    readonly selectMarker: string;
    readonly addMarker: string;
    readonly markerLabel: string;
    readonly renameMarker: string;
    readonly removeMarker: string;
    readonly scroll: string;
    readonly zoomIn: string;
    readonly zoomOut: string;
    readonly operation: string;
    readonly move: string;
    readonly trimStart: string;
    readonly trimEnd: string;
    readonly delta: string;
    readonly apply: string;
    readonly splitAtPlayhead: string;
    readonly undo: string;
    readonly redo: string;
}
export declare function resolveUiLabels(labels?: TimelineLabels): ResolvedUiLabels;
export declare function sameUiLabels(a: ResolvedUiLabels, b: ResolvedUiLabels): boolean;
export interface ResolvedLayout {
    readonly laneHeight: number;
    readonly rowInset: number;
}
export declare function resolveLayout(layout?: TimelineLayoutOptions): ResolvedLayout;
export declare function sameLayout(a: ResolvedLayout, b: ResolvedLayout): boolean;
export interface ResolvedTrackColors {
    readonly fillHex: string;
    readonly stripeHex: string;
    readonly waveformHex: string;
    readonly fill: Rgba;
    readonly stripe: Rgba;
    readonly waveform: Rgba;
}
export interface ResolvedTheme {
    readonly rowEvenHex: string;
    readonly rowOddHex: string;
    readonly gridHex: string;
    readonly rowEven: Rgba;
    readonly rowOdd: Rgba;
    readonly grid: Rgba;
    readonly selectionStroke: string;
    readonly handleFill: string;
    readonly ghostFill: string;
    readonly ghostStroke: string;
    readonly marker: string;
    readonly rulerText: string;
    readonly rulerMarkerBackground: string;
    readonly labelColor: string;
    readonly nameFont: string;
    readonly captionFont: string;
    readonly palette: readonly ResolvedTrackColors[];
}
export declare function resolveTheme(theme?: TimelineTheme): ResolvedTheme;
export declare function sameAtlasTheme(a: ResolvedTheme, b: ResolvedTheme): boolean;
export declare function sameTheme(a: ResolvedTheme, b: ResolvedTheme): boolean;
