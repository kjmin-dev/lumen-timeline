import { validId } from "./document.mjs";
import { sourceWindow, ticksToUnits, unitsToTicks } from "./time.mjs";

const validVersion = (value) => validId(value) || (Number.isSafeInteger(value) && value >= 0);

function nativeRange(start, end, source, binding) {
  const clamp = (sample) =>
    Math.max(binding.availableStart, Math.min(binding.availableEnd, sample));
  const sourceStart = clamp(ticksToUnits(source, binding.sampleRate));
  const sourceEnd = clamp(ticksToUnits(source + (end - start), binding.sampleRate));
  return sourceEnd > sourceStart ? Object.freeze({ start, end, sourceStart, sourceEnd }) : null;
}

function planClip(clip, track, range, binding) {
  if (
    !binding ||
    !validId(binding.assetId) ||
    !validId(binding.streamId) ||
    !validVersion(binding.assetVersion) ||
    !Number.isSafeInteger(binding.sampleRate) ||
    binding.sampleRate <= 0 ||
    !Number.isSafeInteger(binding.availableStart) ||
    binding.availableStart < 0 ||
    !Number.isSafeInteger(binding.availableEnd) ||
    binding.availableEnd < binding.availableStart ||
    !Number.isSafeInteger(binding.sourceAtContentZero)
  )
    throw new RangeError("Invalid take binding");
  const { sampleRate } = binding;
  const take = {
    sourceAtContentZero: unitsToTicks(binding.sourceAtContentZero, sampleRate),
    availableStart: unitsToTicks(binding.availableStart, sampleRate),
    availableEnd: unitsToTicks(binding.availableEnd, sampleRate),
  };
  const origin = take.sourceAtContentZero + clip.contentIn;
  if (![origin, origin - clip.start, origin + clip.duration].every(Number.isSafeInteger)) {
    throw new RangeError("Source mapping exceeds safe tick range");
  }
  const full = sourceWindow(clip, take, clip.start, clip.start + clip.duration);
  if (!full) return null;
  const start = Math.max(full.start, range.start);
  const end = Math.min(full.end, range.end);
  if (end <= start) return null;
  const window = nativeRange(start, end, full.sourceStart + (start - full.start), binding);
  if (!window) return null;
  const audible = nativeRange(full.start, full.end, full.sourceStart, binding);
  return Object.freeze({
    clipId: clip.id,
    trackId: track.id,
    chainId: clip.continuityId ?? null,
    takeId: clip.activeTakeId,
    assetId: binding.assetId,
    assetVersion: binding.assetVersion,
    streamId: binding.streamId,
    sampleRate,
    gain: track.gain ?? 1,
    sourceOriginTick: origin - clip.start,
    audible,
    window,
  });
}

export function planAudio(revision, tracks, range, catalog, visit) {
  if (
    !catalog ||
    !validVersion(catalog.version) ||
    !catalog.takes ||
    typeof catalog.takes !== "object" ||
    Array.isArray(catalog.takes)
  )
    throw new TypeError("Expected a versioned take catalog");
  const spans = [];
  const issues = [];
  const solo = tracks.some((track) => track.solo === true);
  for (const track of tracks) {
    if (track.mute === true || (solo && track.solo !== true) || track.gain === 0) continue;
    if (track.gain !== undefined && (!Number.isFinite(track.gain) || track.gain < 0)) {
      issues.push(Object.freeze({ code: "invalid-gain", trackId: track.id }));
      continue;
    }
    visit(track.id, (clip) => {
      const id = clip.activeTakeId;
      if (id === undefined || id === null) return;
      if (!validId(id) || !Object.hasOwn(catalog.takes, id)) {
        issues.push(Object.freeze({ code: "unresolved-take", clipId: clip.id, takeId: id }));
        return;
      }
      try {
        const span = planClip(clip, track, range, catalog.takes[id]);
        if (span) spans.push(span);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        issues.push(
          Object.freeze({
            code: "invalid-take",
            clipId: clip.id,
            takeId: id,
            reason: error.message,
          }),
        );
      }
    });
  }
  return Object.freeze({
    revision,
    catalogVersion: catalog.version,
    spans: Object.freeze(spans),
    issues: Object.freeze(issues),
  });
}
