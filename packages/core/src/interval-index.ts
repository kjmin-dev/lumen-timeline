import { defined } from "./invariant.ts";
import type { Clip, Tick } from "./types.ts";

// A balanced tree over the editor's start-ordered track array. The midpoint of
// each subarray stores the largest exclusive end anywhere in that subtree.
// Every index below stays within [0, clips.length).
const indexes = new WeakMap<readonly Clip[], Float64Array>();

function indexFor(clips: readonly Clip[]): Float64Array {
  const cached = indexes.get(clips);
  if (cached) return cached;
  const ends = new Float64Array(clips.length);
  function build(lo: number, hi: number): number {
    if (lo >= hi) return -Infinity;
    const mid = Math.floor((lo + hi) / 2);
    const clip = defined(clips[mid], "indexed clip");
    ends[mid] = Math.max(clip.start + clip.duration, build(lo, mid), build(mid + 1, hi));
    return ends[mid];
  }
  build(0, clips.length);
  indexes.set(clips, ends);
  return ends;
}

// Returns the number of inspected subtree roots for the query-work benchmark.
export function visitRange(
  clips: readonly Clip[] | undefined,
  start: Tick,
  end: Tick,
  emit: (clip: Clip) => void,
): number {
  if (!clips?.length || start >= end) return 0;
  const ends = indexFor(clips);
  let visited = 0;
  const walk = (lo: number, hi: number): void => {
    if (lo >= hi) return;
    const mid = Math.floor((lo + hi) / 2);
    visited++;
    if (
      defined(ends[mid], "subtree end") <= start ||
      defined(clips[lo], "subtree head").start >= end
    )
      return;
    walk(lo, mid);
    const clip = defined(clips[mid], "subtree root");
    if (clip.start >= end) return;
    if (clip.start + clip.duration > start) emit(clip);
    walk(mid + 1, hi);
  };
  walk(0, clips.length);
  return visited;
}
