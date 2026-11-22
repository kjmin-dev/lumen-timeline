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
  Take,
  TakeCatalog,
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

/** A stream and the source position, in project ticks, at content time zero. */
interface ResolvedTake {
  readonly assetId: string;
  readonly streamId: string;
  readonly stream: StreamBinding;
  readonly sourceAtContentZero: Tick;
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

/** Resolves a host-aligned take binding. Throws a `RangeError` for a malformed one. */
function bindingOf(value: unknown): ResolvedTake {
  const assetId = own(value, "assetId");
  const streamId = own(value, "streamId");
  const sourceAtContentZero = own(value, "sourceAtContentZero");
  if (!validId(assetId) || !validId(streamId) || !sampleIndex(sourceAtContentZero))
    throw new RangeError("Invalid take binding");
  const stream = streamOf(value);
  return {
    assetId,
    streamId,
    stream,
    sourceAtContentZero: unitsToTicks(sourceAtContentZero, stream.sampleRate),
  };
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
  takeId: string,
  track: Track,
  range: TickRange,
  resolved: ResolvedTake,
): AudioSpan | null {
  const { stream } = resolved;
  const { sampleRate } = stream;
  const take = {
    sourceAtContentZero: resolved.sourceAtContentZero,
    availableStart: unitsToTicks(stream.availableStart, sampleRate),
    availableEnd: unitsToTicks(stream.availableEnd, sampleRate),
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
  const window = nativeRange(start, end, full.sourceStart + (start - full.start), stream);
  if (!window) return null;
  const audible = nativeRange(full.start, full.end, full.sourceStart, stream);
  // Unreachable: rounding and clamping are monotonic, so the full range holds
  // at least the samples of the window inside it.
  if (!audible) return null;
  return Object.freeze({
    clipId: clip.id,
    trackId: track.id,
    chainId: clip.continuityId ?? null,
    takeId,
    assetId: resolved.assetId,
    assetVersion: stream.assetVersion,
    streamId: resolved.streamId,
    sampleRate,
    gain: track.gain ?? 1,
    sourceOriginTick: origin - clip.start,
    audible,
    window,
  });
}

/** Rejects a malformed catalog or plan options before any clip is visited. */
export function checkPlanInputs(catalog: TakeCatalog, options: PlanOptions | undefined): void {
  if (
    !isMap(catalog) ||
    !validVersion(catalog.version) ||
    (catalog.takes !== undefined && !isMap(catalog.takes)) ||
    (catalog.streams !== undefined && !isMap(catalog.streams))
  )
    throw new TypeError("Expected a versioned take catalog");
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
  catalog: TakeCatalog,
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
      const list = clip.takeIds;
      const take = list !== undefined && validId(id) && list.includes(id) ? takes(id) : undefined;
      const binding = list === undefined && validId(id) ? own(catalog.takes, id) : undefined;
      if (!validId(id) || (take === undefined && binding === undefined)) {
        issues.push(Object.freeze({ code: "unresolved-take", clipId: clip.id, takeId: id }));
        return;
      }
      try {
        let resolved: ResolvedTake;
        if (take) {
          const stream = own(own(catalog.streams, take.assetId), take.streamId);
          if (stream === undefined) {
            issues.push(
              Object.freeze({
                code: "unresolved-stream",
                clipId: clip.id,
                takeId: id,
                assetId: take.assetId,
                streamId: take.streamId,
              }),
            );
            return;
          }
          resolved = {
            assetId: take.assetId,
            streamId: take.streamId,
            stream: streamOf(stream),
            sourceAtContentZero: take.sourceAtContentZero,
          };
        } else {
          resolved = bindingOf(binding);
        }
        const span = planClip(clip, id, track, range, resolved);
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
