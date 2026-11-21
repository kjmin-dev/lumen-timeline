// A balanced tree over the editor's start-ordered track array. The midpoint of
// each subarray stores the largest exclusive end anywhere in that subtree.
const indexes = new WeakMap();

function indexFor(clips) {
  let ends = indexes.get(clips);
  if (ends) return ends;
  ends = new Float64Array(clips.length);
  function build(lo, hi) {
    if (lo >= hi) return -Infinity;
    const mid = Math.floor((lo + hi) / 2);
    const clip = clips[mid];
    ends[mid] = Math.max(clip.start + clip.duration, build(lo, mid), build(mid + 1, hi));
    return ends[mid];
  }
  build(0, clips.length);
  indexes.set(clips, ends);
  return ends;
}

// Returns the number of inspected subtree roots for the query-work benchmark.
export function visitRange(clips, start, end, emit) {
  if (!clips?.length || start >= end) return 0;
  const ends = indexFor(clips);
  let visited = 0;
  function walk(lo, hi) {
    if (lo >= hi) return;
    const mid = Math.floor((lo + hi) / 2);
    visited++;
    if (ends[mid] <= start || clips[lo].start >= end) return;
    walk(lo, mid);
    const clip = clips[mid];
    if (clip.start >= end) return;
    if (clip.start + clip.duration > start) emit(clip);
    walk(mid + 1, hi);
  }
  walk(0, clips.length);
  return visited;
}
