// Editor snapshots share the frozen clip array across metadata-only commits.
const ends = new WeakMap();
export function sequenceDuration(snapshot) {
  if (snapshot.duration !== undefined) return snapshot.duration;
  const clips = snapshot.clips;
  if (ends.has(clips)) return ends.get(clips);
  const end = clips.reduce((last, clip) => Math.max(last, clip.start + clip.duration), 0);
  if (Object.isFrozen(snapshot) && Object.isFrozen(clips)) ends.set(clips, end);
  return end;
}
