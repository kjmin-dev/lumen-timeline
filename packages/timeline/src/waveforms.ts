import { contentAt } from "@lumen-timeline/core";
import type { Clip, Tick } from "@lumen-timeline/core";
import { tickAt } from "./geometry.ts";
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
export function placeWaveform(
  clip: Clip,
  take: WaveformSource,
  x: number,
  endX: number,
  view: Viewport,
): PlacedWaveform | null {
  const from = Math.round(x);
  const to = Math.round(endX);
  const start = Math.max(clip.start, tickAt(from, view));
  const end = Math.min(clip.start + clip.duration, tickAt(to, view));
  if (to <= from || end <= start) return null;
  // Timeline tick t plays the clip's content at t, which sits at
  // sourceAtContentZero in the source. A rate other than 1 spreads more or
  // less source over the same columns.
  const zero = take.sourceAtContentZero ?? 0;
  return {
    request: Object.freeze({
      assetId: take.assetId,
      streamId: take.streamId,
      start: zero + contentAt(clip, start),
      end: zero + contentAt(clip, end),
      buckets: to - from,
    }),
    x: from,
  };
}

/** A peak value clamped to -1 to 1, with anything unusable read as silence. */
export function unit(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}
