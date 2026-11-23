import type { Clip, Tick } from "@lumen-timeline/core";
import type { Viewport } from "./geometry.ts";
import type { WaveformRequest } from "./types.ts";
/** Source media mapping read by `placeWaveform`: a `Take` or a direct `ClipSource`. */
export interface WaveformSource {
    readonly assetId: string;
    readonly streamId: string;
    readonly sourceAtContentZero?: Tick | undefined;
}
/** A waveform request and the CSS pixel column its first bucket fills. */
export interface PlacedWaveform {
    readonly request: WaveformRequest;
    readonly x: number;
}
/**
 * The source range of `take` (or direct `clip.source`) that a clip shows between
 * two CSS pixel positions, one bucket per whole pixel column. `null` when no
 * column or no tick of the clip is visible.
 */
export declare function placeWaveform(clip: Clip, take: WaveformSource, x: number, endX: number, view: Viewport): PlacedWaveform | null;
/** A peak value clamped to -1 to 1, with anything unusable read as silence. */
export declare function unit(value: number | undefined): number;
