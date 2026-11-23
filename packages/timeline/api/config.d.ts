import type { Rgba } from "./layout.ts";
import type { TimelineChrome, TimelineChromeOption, TimelineLabels, TimelineLayoutOptions, TimelineTheme } from "./types.ts";
export type ResolvedChrome = {
    readonly [K in keyof TimelineChrome]-?: boolean;
};
export declare function resolveChrome(option?: TimelineChromeOption): ResolvedChrome;
export declare function sameChrome(a: ResolvedChrome, b: ResolvedChrome): boolean;
type UiLabelKey = Exclude<keyof TimelineLabels, "take" | "takes" | "none">;
export type ResolvedUiLabels = {
    readonly [K in UiLabelKey]: string;
};
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
    /** The clip name's color. */
    readonly textHex: string;
    readonly fill: Rgba;
    readonly stripe: Rgba;
    readonly waveform: Rgba;
}
export type ColorScheme = "light" | "dark";
export interface ResolvedTheme {
    readonly scheme: ColorScheme;
    readonly rowEvenHex: string;
    readonly rowOddHex: string;
    readonly gridHex: string;
    readonly rowEven: Rgba;
    readonly rowOdd: Rgba;
    readonly grid: Rgba;
    /** The band that holds a track's take lanes, and the hairline above it. */
    readonly drawer: Rgba;
    readonly drawerLine: Rgba;
    readonly selectionStroke: string;
    readonly handleFill: string;
    readonly ghostFill: string;
    readonly ghostStroke: string;
    readonly marker: string;
    readonly rulerText: string;
    /** The text of a marker flag, or `undefined` for whichever ink reads on the flag. */
    readonly rulerMarkerBackground: string | undefined;
    /** One color for every clip name, or `undefined` for each palette entry's own. */
    readonly labelColor: string | undefined;
    readonly nameFont: string;
    readonly captionFont: string;
    readonly rulerFont: string;
    readonly markerFont: string;
    readonly palette: readonly ResolvedTrackColors[];
    readonly locked: ResolvedTrackColors;
}
export declare function resolveTheme(theme?: TimelineTheme): ResolvedTheme;
export declare function sameAtlasTheme(a: ResolvedTheme, b: ResolvedTheme): boolean;
export declare function sameTheme(a: ResolvedTheme, b: ResolvedTheme): boolean;
export {};
