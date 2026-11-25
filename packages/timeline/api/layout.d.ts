import type { Clip, Take, Track } from "@lumen-timeline/core";
import type { CaptionWords } from "./captions.ts";
import type { Box, Packed, Viewport } from "./geometry.ts";
import type { ClipStyleFn, WaveformRequest } from "./types.ts";
/** Floats per quad: x, y, width, height, then the atlas region u0, v0, u1, v1. */
export declare const quadFloats = 8;
/** A packed color: red in the lowest byte, alpha in the highest, as GPUs read RGBA8. */
export type Rgba = number;
export declare function rgba(hex: string, alpha?: number): Rgba;
/** `from` moved toward `to` by `amount` (0 to 1), as an opaque `#rrggbb`. Unparsable colors stay as given. */
export declare function mixHex(from: string, to: string, amount: number): string;
/** The ink that reads on a fill: near black on a light one, near white on a dark one. */
export declare function inkOn(fill: string): string;
/** The quads of one row, reused from paint to paint. */
export declare class QuadList {
    count: number;
    data: Float32Array<ArrayBuffer>;
    colors: Uint32Array<ArrayBuffer>;
    clear(): void;
    private reserve;
    /** A solid rectangle. Its atlas region is empty. */
    rect(x: number, y: number, w: number, h: number, color: Rgba): void;
    /**
     * A solid rectangle with rounded corners. The radius rides in the second
     * atlas coordinate, which a solid quad does not otherwise use.
     */
    round(x: number, y: number, w: number, h: number, color: Rgba, radius: number): void;
    /** A crop of the label atlas, drawn unchanged. */
    image(x: number, y: number, w: number, h: number, u0: number, v0: number, u1: number, v1: number): void;
}
/** Whether quad `i` crops the atlas rather than filling a color. */
export declare const isImage: (list: QuadList, i: number) => boolean;
/** The corner radius of solid quad `i`, in CSS pixels. */
export declare const radiusOf: (list: QuadList, i: number) => number;
/** A label rasterized in the atlas, in normalized atlas coordinates and CSS pixels. */
export interface LabelSlot {
    readonly u0: number;
    readonly v0: number;
    readonly u1: number;
    readonly v1: number;
    readonly width: number;
    readonly height: number;
}
/** Rasterizes a clip's name and caption, or returns `null` when the atlas is full. */
export type LabelSource = (name: string, caption: string | undefined, captionColor: string, nameColor: string) => LabelSlot | null;
/** A track row as the view lays it out. */
export interface LayoutRow extends Packed {
    readonly track: Track;
    readonly index: number;
    /** Top in the scrolled content, in CSS pixels. */
    readonly top: number;
}
/** One palette entry as the layout reads it. */
export interface RowColors {
    readonly stripeHex: string;
    readonly textHex: string;
    readonly fill: Rgba;
    readonly stripe: Rgba;
    readonly waveform: Rgba;
}
export interface RowTheme {
    readonly scheme?: "light" | "dark" | undefined;
    readonly rowEven: Rgba;
    readonly rowOdd: Rgba;
    readonly grid: Rgba;
    readonly drawer?: Rgba | undefined;
    readonly drawerLine?: Rgba | undefined;
    /** One color for every clip name, instead of each entry's own. */
    readonly labelColor?: string | undefined;
    readonly palette: readonly RowColors[];
    /** The colors of a locked track's clips. */
    readonly locked?: RowColors | undefined;
}
/** The candidates a row shows as take lanes under its clip lanes. */
export interface TakeLanes {
    readonly clipId: string;
    readonly takes: readonly Take[];
}
/** A take lane's rectangle in CSS pixels, for hit tests. */
export interface TakeBox {
    readonly clipId: string;
    readonly takeId: string;
    readonly x: number;
    readonly endX: number;
    readonly y: number;
    readonly height: number;
}
export interface RowLayout {
    readonly view: Viewport;
    readonly width: number;
    /** The row's top relative to the viewport. */
    readonly top: number;
    readonly dpr: number;
    /** Grid line positions across the viewport. */
    readonly grid: readonly number[];
    readonly words: CaptionWords;
    readonly takesOf: (clipId: string) => readonly Take[];
    peaks?: ((request: WaveformRequest) => ArrayLike<number> | null) | undefined;
    /** Maps a peak, after the clip's gain, to the height drawn. */
    readonly scale?: ((peak: number) => number) | undefined;
    readonly label: LabelSource;
    /** Collects the assets whose waveforms the row asked for. */
    readonly assets?: Set<string> | undefined;
    readonly laneHeight?: number | undefined;
    readonly rowInset?: number | undefined;
    readonly theme?: RowTheme | undefined;
    readonly clipStyle?: ClipStyleFn | undefined;
    /** Take lanes at the bottom of the row; the row's height already holds them. */
    readonly takeLanes?: TakeLanes | undefined;
    /** Collects the take lanes' rectangles. */
    readonly takeBoxes?: TakeBox[] | undefined;
}
/** Where a label starts after its clip's left edge. */
export declare const labelInset = 8;
/**
 * The least room, in CSS pixels, a clip needs for its label. Narrower clips,
 * as when zoomed far out, would show a letter or two, and their labels would
 * crowd the atlas.
 */
export declare const labelRoom = 24;
/** Label height in CSS pixels, with the text's baseline 15 pixels down. */
export declare const labelHeight = 20;
export declare const labelBaseline = 15;
/** The pitch of a take lane and the height of the lane itself, in CSS pixels. */
export declare const takeLanePitch = 26;
export declare const takeLaneHeight = 22;
/** The height `count` take lanes add to a row. */
export declare const takeLanesHeight: (count: number) => number;
/**
 * The height of a clip's name row: the label sits there, above the waveform.
 * A clip too short for both draws its waveform over its full height instead,
 * with the label on top.
 */
export declare const nameRow: (clipHeight: number) => number;
/** The gap above a row's lane strip, and its rounding. */
export declare const stripGap: (inset: number) => number;
/**
 * Lays out one row's visible clips into `quads`, appending their boxes to
 * `boxes` for hit tests. `clips` are the row's clips in the visible range.
 */
export declare function layoutRow(row: LayoutRow, clips: readonly Clip[], layout: RowLayout, quads: QuadList, boxes: Box<Clip>[]): void;
