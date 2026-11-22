import { validId } from "./validation.ts";
import { sourceWindow, ticksToUnits, unitsToTicks } from "./time.ts";
import type {
  AudioPlan,
  AudioSpan,
  Clip,
  PlanIssue,
  PlanOptions,
  SourceRange,
  StreamBinding,
  StreamCatalog,
  Take,
  Tick,
  TickRange,
  Track,
  Version,
} from "./types.ts";

const validVersion = (value: unknown): value is Version =>
  validId(value) || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

const isMap = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An own field of a host-supplied map, or undefined. */
function own(map: unknown, key: string): unknown {
  // Reflect.get returns any; the annotation keeps host data unknown.
  const value: unknown = isMap(map) && Object.hasOwn(map, key) ? Reflect.get(map, key) : undefined;
  return value;
}

const sampleIndex = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

/** Validates a host stream binding. Throws a `RangeError` for a malformed one. */
function streamOf(value: unknown): StreamBinding {
  const assetVersion = own(value, "assetVersion");
  const sampleRate = own(value, "sampleRate");
  const availableStart = own(value, "availableStart");
  const availableEnd = own(value, "availableEnd");
  if (
    !validVersion(assetVersion) ||
    !sampleIndex(sampleRate) ||
    sampleRate <= 0 ||
    !sampleIndex(availableStart) ||
    availableStart < 0 ||
    !sampleIndex(availableEnd) ||
    availableEnd < availableStart
  )
    throw new RangeError("Invalid stream binding");
  return { assetVersion, sampleRate, availableStart, availableEnd };
}

function nativeRange(
  start: Tick,
  end: Tick,
  source: Tick,
  stream: StreamBinding,
): SourceRange | null {
  const clamp = (sample: number): number =>
    Math.max(stream.availableStart, Math.min(stream.availableEnd, sample));
  const sourceStart = clamp(ticksToUnits(source, stream.sampleRate));
  const sourceEnd = clamp(ticksToUnits(source + (end - start), stream.sampleRate));
  return sourceEnd > sourceStart ? Object.freeze({ start, end, sourceStart, sourceEnd }) : null;
}

function planClip(
  clip: Clip,
  take: Take,
  track: Track,
  range: TickRange,
  stream: StreamBinding,
): AudioSpan | null {
  const { sampleRate } = stream;
  const window = {
    sourceAtContentZero: take.sourceAtContentZero,
    availableStart: unitsToTicks(stream.availableStart, sampleRate),
    availableEnd: unitsToTicks(stream.availableEnd, sampleRate),
  };
  // Placements, content time and take positions are each within seven days.
  const origin = take.sourceAtContentZero + clip.contentIn;
  const full = sourceWindow(clip, window, clip.start, clip.start + clip.duration);
  if (!full) return null;
  const start = Math.max(full.start, range.start);
  const end = Math.min(full.end, range.end);
  if (end <= start) return null;
  const queried = nativeRange(start, end, full.sourceStart + (start - full.start), stream);
  if (!queried) return null;
  const audible = nativeRange(full.start, full.end, full.sourceStart, stream);
  // Unreachable: rounding and clamping are monotonic, so the full range holds
  // at least the samples of the window inside it.
  if (!audible) return null;
  return Object.freeze({
    clipId: clip.id,
    trackId: track.id,
    chainId: clip.continuityId ?? null,
    takeId: take.id,
    assetId: take.assetId,
    assetVersion: stream.assetVersion,
    streamId: take.streamId,
    sampleRate,
    gain: track.gain ?? 1,
    sourceOriginTick: origin - clip.start,
    audible,
    window: queried,
  });
}

/** Rejects a malformed catalog or plan options before any clip is visited. */
export function checkPlanInputs(catalog: StreamCatalog, options: PlanOptions | undefined): void {
  if (!isMap(catalog) || !validVersion(catalog.version) || !isMap(catalog.streams))
    throw new TypeError("Expected a versioned stream catalog");
  if (options === undefined) return;
  const overrides = isMap(options) ? options.takeOverrides : null;
  if (
    overrides !== undefined &&
    (!isMap(overrides) ||
      !Object.values(overrides).every((value) => value === null || validId(value)))
  )
    throw new TypeError("Expected take overrides mapping clip IDs to take IDs or null");
}

export function planAudio(
  revision: number,
  tracks: readonly Track[],
  range: TickRange,
  catalog: StreamCatalog,
  visit: (trackId: string, emit: (clip: Clip) => void) => void,
  takes: (id: string) => Take | undefined,
  options?: PlanOptions,
): AudioPlan {
  checkPlanInputs(catalog, options);
  const overrides = options?.takeOverrides;
  const spans: AudioSpan[] = [];
  const issues: PlanIssue[] = [];
  const solo = tracks.some((track) => track.solo === true);
  for (const track of tracks) {
    if (track.mute === true || (solo && track.solo !== true) || track.gain === 0) continue;
    if (track.gain !== undefined && (!Number.isFinite(track.gain) || track.gain < 0)) {
      issues.push(Object.freeze({ code: "invalid-gain", trackId: track.id }));
      continue;
    }
    visit(track.id, (clip) => {
      const id =
        isMap(overrides) && Object.hasOwn(overrides, clip.id)
          ? own(overrides, clip.id)
          : clip.activeTakeId;
      if (id === undefined || id === null) return;
      // The editor keeps every listed take in the project.
      const take = validId(id) && clip.takeIds?.includes(id) ? takes(id) : undefined;
      if (!take) {
        issues.push(Object.freeze({ code: "unresolved-take", clipId: clip.id, takeId: id }));
        return;
      }
      const stream = own(own(catalog.streams, take.assetId), take.streamId);
      if (stream === undefined) {
        issues.push(
          Object.freeze({
            code: "unresolved-stream",
            clipId: clip.id,
            takeId: take.id,
            assetId: take.assetId,
            streamId: take.streamId,
          }),
        );
        return;
      }
      try {
        const span = planClip(clip, take, track, range, streamOf(stream));
        if (span) spans.push(span);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        issues.push(
          Object.freeze({
            code: "invalid-stream",
            clipId: clip.id,
            takeId: take.id,
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
