import type { Tick } from "./types.ts";

/** The fields `sequenceDuration` reads from a snapshot. */
export interface SequenceExtent {
  readonly duration?: Tick;
  readonly clips: readonly { readonly start: Tick; readonly duration: Tick }[];
  readonly markers?: readonly { readonly start: Tick; readonly duration?: Tick }[];
}

// Editor snapshots share the frozen clip array across metadata-only commits.
const ends = new WeakMap<object, Tick>();
function clipEnd(snapshot: SequenceExtent): Tick {
  const clips = snapshot.clips;
  const cached = ends.get(clips);
  if (cached !== undefined) return cached;
  const end = clips.reduce((last, clip) => Math.max(last, clip.start + clip.duration), 0);
  if (Object.isFrozen(snapshot) && Object.isFrozen(clips)) ends.set(clips, end);
  return end;
}

/**
 * The explicit duration, or else the end of the last clip or the last marker
 * (including a region marker's duration), whichever is later. An empty sequence
 * has zero length.
 */
export function sequenceDuration(snapshot: SequenceExtent): Tick {
  if (snapshot.duration !== undefined) return snapshot.duration;
  const markerEnd = (snapshot.markers ?? []).reduce(
    (last, marker) => Math.max(last, marker.start + (marker.duration ?? 0)),
    0,
  );
  return Math.max(clipEnd(snapshot), markerEnd);
}
