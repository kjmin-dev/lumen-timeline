import type { Clip, Take } from "@lumen-timeline/core";
import { tickAt } from "./geometry.ts";
import type { Viewport } from "./geometry.ts";
import type { WaveformRequest } from "./types.ts";

/** A waveform request and the CSS pixel column its first bucket fills. */
export interface PlacedWaveform {
  readonly request: WaveformRequest;
  readonly x: number;
}

/**
 * The source range of `take` that a clip shows between two CSS pixel
 * positions, one bucket per whole pixel column. `null` when no column or no
 * tick of the clip is visible.
 */
export function placeWaveform(
  clip: Clip,
  take: Take,
  x: number,
  endX: number,
  view: Viewport,
): PlacedWaveform | null {
  const from = Math.round(x);
  const to = Math.round(endX);
  const start = Math.max(clip.start, tickAt(from, view));
  const end = Math.min(clip.start + clip.duration, tickAt(to, view));
  if (to <= from || end <= start) return null;
  // Timeline tick t plays source time t - start + contentIn + sourceAtContentZero.
  const offset = clip.contentIn + take.sourceAtContentZero - clip.start;
  return {
    request: Object.freeze({
      assetId: take.assetId,
      streamId: take.streamId,
      start: start + offset,
      end: end + offset,
      buckets: to - from,
    }),
    x: from,
  };
}

/** A peak value clamped to -1 to 1, with anything unusable read as silence. */
export function unit(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}
