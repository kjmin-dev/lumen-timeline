import { normalizeEntityData } from "./entity-data.ts";
import { MAX_CLIP_GAIN, SCHEMA_VERSION } from "./schema.ts";
import { compareMarkers, parseMarker } from "./markers.ts";
import type { PluginRegistry } from "./plugins.ts";
import { checkLoadedReferences, compareTakes, parseCandidates, parseTake } from "./takes.ts";
import { MAX_CLIP_RATE, MAX_TICK, MIN_CLIP_RATE, TICKS_PER_SECOND, contentLength } from "./time.ts";
import { parseTrack } from "./tracks.ts";
import type {
  Clip,
  ClipSource,
  ContentBounds,
  ExtensionVersions,
  JsonValue,
  Marker,
  ProjectSnapshot,
  Take,
  Tick,
  Track,
} from "./types.ts";
import { freezeJson, isArray, isRecord, requireEdit, safeInteger, validId } from "./validation.ts";

/** Checks a clip gain, absent or from 0 to `MAX_CLIP_GAIN`. */
export function checkGain(id: unknown, gain: unknown): asserts gain is number | undefined {
  requireEdit(
    gain === undefined ||
      (typeof gain === "number" && Number.isFinite(gain) && gain >= 0 && gain <= MAX_CLIP_GAIN),
    "invalid-gain",
    id,
    "Clip gain must be a number from 0 to " + MAX_CLIP_GAIN,
  );
}

/** Validation rules shared by project loading and every staged clip. */
export interface Rules {
  readonly tracks: ReadonlyMap<string, Track>;
  readonly duration: Tick;
  readonly minimum: Tick;
}

/**
 * Start-ordered clips per track ID. A layout and its lists never change: an
 * edit makes a new layout with new lists for the tracks it touched.
 */
export type TrackLayout = ReadonlyMap<string, readonly Clip[]>;

export interface OpenedProject {
  readonly snapshot: ProjectSnapshot;
  readonly rules: Rules;
  readonly byTrack: TrackLayout;
  /** Each clip's index in `snapshot.clips`, where an editor already kept them. */
  readonly positions: ReadonlyMap<string, number> | undefined;
}

/** A snapshot an editor issued, with what that editor keeps beside it. */
interface Issued {
  readonly snapshot: ProjectSnapshot;
  readonly byTrack: TrackLayout;
  readonly positions: ReadonlyMap<string, number>;
}

// Every snapshot an editor issues is validated, canonical and frozen all the
// way down, and its layout and positions never change. Another editor can
// therefore open one by taking all three as they are, with no copy and no
// second validation.
const issued = new WeakMap<object, Issued>();

/** Records a snapshot an editor issued, with its clips per track and their positions. */
export function issue(
  snapshot: ProjectSnapshot,
  byTrack: TrackLayout,
  positions: ReadonlyMap<string, number>,
): void {
  issued.set(snapshot, { snapshot, byTrack, positions });
}

function adopt({ snapshot, byTrack, positions }: Issued): OpenedProject {
  return {
    snapshot,
    rules: {
      tracks: new Map(snapshot.tracks.map((track) => [track.id, track])),
      duration: snapshot.duration ?? MAX_TICK,
      minimum: snapshot.minClipDuration ?? 1,
    },
    byTrack,
    positions,
  };
}

/** Placement fields before validation, from JSON or from a staged edit. */
export interface PlacementInput {
  readonly id: string;
  readonly trackId: unknown;
  readonly kind: unknown;
  readonly start: unknown;
  readonly duration: unknown;
  readonly contentIn: unknown;
  readonly contentBounds?: unknown;
  /** Absent means 1. */
  readonly rate?: unknown;
}

/** Validated placement fields. `contentBounds` is undefined when absent. */
export interface Placement {
  readonly trackId: string;
  readonly kind: string;
  readonly start: Tick;
  readonly duration: Tick;
  readonly contentIn: Tick;
  readonly contentBounds: ContentBounds | undefined;
  /** 1 when the clip plays at normal speed. */
  readonly rate: number;
}

/** Parses a direct clip source binding. */
export function parseClipSource(id: string, value: unknown): ClipSource | undefined {
  if (value === undefined) return undefined;
  requireEdit(
    typeof value === "object" && value !== null && !isArray(value),
    "invalid-clip",
    id,
    "Expected a clip source object",
  );
  const assetId: unknown = Reflect.get(value, "assetId");
  const streamId: unknown = Reflect.get(value, "streamId");
  const sourceAtContentZero: unknown = Reflect.get(value, "sourceAtContentZero");
  requireEdit(
    validId(assetId) &&
      validId(streamId) &&
      (sourceAtContentZero === undefined ||
        (safeInteger(sourceAtContentZero) && Math.abs(sourceAtContentZero) <= MAX_TICK)),
    "invalid-clip",
    id,
    "A clip source requires asset and stream IDs and an optional tick offset within seven days",
  );
  return Object.freeze({
    assetId,
    streamId,
    ...(sourceAtContentZero === undefined ? {} : { sourceAtContentZero }),
  });
}

/** Parses one clip of a loaded project or a replayed record. */
export function parseClip(
  value: JsonValue,
  ids: ReadonlySet<string>,
  rules: Rules,
  plugins?: PluginRegistry,
): Clip {
  const clip = isRecord(value) ? value : undefined;
  const id = clip?.["id"];
  requireEdit(
    clip !== undefined && validId(id) && !ids.has(id),
    "invalid-clip",
    id,
    "Clip IDs must be unique",
  );
  const { trackId, kind, start, duration, contentIn, contentBounds, rate } = checkPlacement(
    {
      id,
      trackId: clip["trackId"],
      kind: clip["kind"],
      start: clip["start"],
      duration: clip["duration"],
      contentIn: clip["contentIn"],
      contentBounds: clip["contentBounds"],
      rate: clip["rate"],
    },
    rules,
  );
  const activeTakeId = clip["activeTakeId"];
  const continuityId = clip["continuityId"];
  requireEdit(
    (activeTakeId === undefined || activeTakeId === null || typeof activeTakeId === "string") &&
      (continuityId === undefined || continuityId === null || typeof continuityId === "string"),
    "invalid-clip",
    id,
    "Expected string take and continuity IDs",
  );
  const candidates = parseCandidates(id, clip["takeIds"], activeTakeId);
  const source = parseClipSource(id, clip["source"]);
  const extensions = clip["extensions"];
  requireEdit(
    extensions === undefined || isRecord(extensions),
    "invalid-clip",
    id,
    "Expected an extensions map",
  );
  const name = clip["name"];
  requireEdit(
    name === undefined || typeof name === "string",
    "invalid-clip",
    id,
    "Expected a string name",
  );
  const color = clip["color"];
  requireEdit(
    color === undefined || typeof color === "string",
    "invalid-clip",
    id,
    "Expected a string color",
  );
  const gain = clip["gain"];
  checkGain(id, gain);
  plugins?.validate("clip", id, extensions);
  // A clip carries both candidate fields or neither, and a rate or a gain only
  // when it is not 1. Kept fields keep their position.
  const { takeIds: _noTakes, activeTakeId: _noActive, ...withoutCandidates } = clip;
  const kept = candidates === undefined ? withoutCandidates : clip;
  const { rate: _noRate, ...withoutRate } = kept;
  const rated = rate === 1 ? withoutRate : kept;
  const { gain: _noGain, ...withoutGain } = rated;
  return Object.freeze({
    ...(gain === 1 ? withoutGain : rated),
    id,
    trackId,
    kind,
    start,
    duration,
    contentIn,
    ...(rate === 1 ? {} : { rate }),
    ...(gain === undefined || gain === 1 ? {} : { gain }),
    ...(contentBounds === undefined ? {} : { contentBounds }),
    ...(source === undefined ? {} : { source }),
    ...candidates,
    ...(continuityId === undefined ? {} : { continuityId }),
    ...(extensions === undefined ? {} : { extensions }),
    ...(name === undefined ? {} : { name }),
    ...(color === undefined ? {} : { color }),
  });
}

/**
 * Opens a project at `SCHEMA_VERSION`, as a migration leaves it. With `newer`,
 * a later schema opens too, under the rules of this one.
 */
export function openProject(
  input: unknown,
  plugins?: PluginRegistry,
  newer = false,
): OpenedProject {
  const known = typeof input === "object" && input !== null ? issued.get(input) : undefined;
  if (known) {
    if (plugins?.hasPlugins) {
      for (const track of known.snapshot.tracks)
        plugins.validate("track", track.id, track.extensions);
      for (const clip of known.snapshot.clips) plugins.validate("clip", clip.id, clip.extensions);
      for (const marker of known.snapshot.markers ?? [])
        plugins.validate("marker", marker.id, marker.extensions);
      for (const take of known.snapshot.takes ?? [])
        plugins.validate("take", take.id, take.extensions);
    }
    return adopt(known);
  }
  const project = freezeJson(input, new Set());
  const schemaVersion = isRecord(project) ? project["schemaVersion"] : undefined;
  requireEdit(
    isRecord(project) &&
      safeInteger(schemaVersion) &&
      (schemaVersion === SCHEMA_VERSION || (newer && schemaVersion > SCHEMA_VERSION)),
    "unsupported-schema",
    schemaVersion,
    "Editing requires project schema version " + SCHEMA_VERSION,
  );
  const extensionVersions = parseExtensionVersions(project["extensionVersions"]);
  const timebase = project["timebase"];
  requireEdit(
    timebase === undefined || timebase === TICKS_PER_SECOND,
    "invalid-timebase",
    null,
    "Project times must use the timeline tick rate",
  );
  const rawTracks = project["tracks"];
  const rawClips = project["clips"];
  requireEdit(
    isArray(rawTracks) && isArray(rawClips),
    "invalid-project",
    null,
    "The project requires tracks and clips arrays",
  );
  const rawRevision = project["revision"];
  const revision = rawRevision === undefined ? 0 : rawRevision;
  requireEdit(
    safeInteger(revision) && revision >= 0,
    "invalid-project",
    null,
    "Invalid project revision",
  );
  const rawDuration = project["duration"];
  const rawMinimum = project["minClipDuration"];
  const duration = rawDuration === undefined ? MAX_TICK : rawDuration;
  const minimum = rawMinimum === undefined ? 1 : rawMinimum;
  requireEdit(
    safeInteger(duration) &&
      duration >= 0 &&
      duration <= MAX_TICK &&
      safeInteger(minimum) &&
      minimum > 0 &&
      minimum <= MAX_TICK,
    "invalid-project",
    null,
    "Invalid sequence bounds or minimum clip duration",
  );

  const tracks = new Map<string, Track>();
  const trackList: Track[] = [];
  for (const value of rawTracks) {
    const track = parseTrack(value, (id) => tracks.has(id), plugins);
    tracks.set(track.id, track);
    trackList.push(track);
  }
  const rules: Rules = { tracks, duration, minimum };
  const ids = new Set<string>();
  const clipList: Clip[] = [];
  const byTrack = new Map<string, Clip[]>();
  for (const value of rawClips) {
    const clip = parseClip(value, ids, rules, plugins);
    ids.add(clip.id);
    clipList.push(clip);
    let lane = byTrack.get(clip.trackId);
    if (!lane) {
      lane = [];
      byTrack.set(clip.trackId, lane);
    }
    lane.push(clip);
  }
  for (const [id, clips] of byTrack) orderTrack(clips, rules, id);
  const rawMarkers = project["markers"];
  requireEdit(
    rawMarkers === undefined || isArray(rawMarkers),
    "invalid-project",
    null,
    "Expected a markers array",
  );
  const markerIds = new Set<string>();
  const markerList: Marker[] = [];
  for (const value of rawMarkers ?? []) {
    const marker = parseMarker(value, markerIds, duration, plugins);
    markerIds.add(marker.id);
    markerList.push(marker);
  }
  markerList.sort(compareMarkers);
  const rawTakes = project["takes"];
  requireEdit(
    rawTakes === undefined || isArray(rawTakes),
    "invalid-project",
    null,
    "Expected a takes array",
  );
  const takes = new Map<string, Take>();
  for (const value of rawTakes ?? []) {
    const take = parseTake(value, (id) => takes.has(id), plugins);
    takes.set(take.id, take);
  }
  checkLoadedReferences(takes, clipList);
  const takeList = [...takes.values()].sort(compareTakes);
  // Normalized entity data follows the revision, as when the editor normalized it.
  // Empty markers and takes lists are omitted; otherwise they keep their field position.
  const { entityData: rawData, extensionVersions: _versions, ...withLists } = project;
  const { markers: _emptyMarkers, ...withoutMarkers } = withLists;
  const withTakes = markerList.length ? withLists : withoutMarkers;
  const { takes: _emptyTakes, ...withoutTakes } = withTakes;
  const rest = takeList.length ? withTakes : withoutTakes;
  const entityData = Object.hasOwn(project, "entityData")
    ? normalizeEntityData(rawData)
    : undefined;
  const snapshot: ProjectSnapshot = Object.freeze({
    ...rest,
    schemaVersion,
    ...(timebase === undefined ? {} : { timebase }),
    tracks: Object.freeze(trackList),
    clips: Object.freeze(clipList),
    ...(rawDuration === undefined ? {} : { duration }),
    ...(rawMinimum === undefined ? {} : { minClipDuration: minimum }),
    ...(markerList.length ? { markers: Object.freeze(markerList) } : {}),
    ...(takeList.length ? { takes: Object.freeze(takeList) } : {}),
    revision,
    ...(entityData === undefined ? {} : { entityData }),
    ...(extensionVersions === undefined ? {} : { extensionVersions }),
  });
  return { snapshot, rules, byTrack, positions: undefined };
}

/**
 * Validates a project's plugin versions and puts them in canonical form:
 * sorted by namespace, without version 1, and absent when empty.
 */
export function parseExtensionVersions(
  value: JsonValue | undefined,
): ExtensionVersions | undefined {
  if (value === undefined) return undefined;
  requireEdit(isRecord(value), "invalid-project", null, "Expected an extensionVersions map");
  const entries: [string, number][] = [];
  for (const [namespace, version] of Object.entries(value)) {
    requireEdit(
      validId(namespace) && safeInteger(version) && version > 0,
      "invalid-project",
      namespace,
      "An extension version must be a positive safe integer",
    );
    if (version !== 1) entries.push([namespace, version]);
  }
  if (!entries.length) return undefined;
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.freeze(Object.fromEntries(entries));
}

/** Checks placement fields against the rules shared by loading and every edit. */
export function checkPlacement(
  {
    id,
    trackId,
    kind,
    start,
    duration: length,
    contentIn,
    contentBounds,
    rate: rawRate,
  }: PlacementInput,
  { tracks, duration, minimum }: Rules,
): Placement {
  const track = typeof trackId === "string" ? tracks.get(trackId) : undefined;
  requireEdit(track, "missing-track", trackId, "Track does not exist");
  requireEdit(
    validId(kind) && (!track.accepts || track.accepts.includes(kind)),
    "incompatible-kind",
    id,
    "The target track does not accept this clip kind",
  );
  requireEdit(
    safeInteger(start) &&
      safeInteger(length) &&
      start >= 0 &&
      length >= minimum &&
      start + length <= duration,
    "invalid-range",
    id,
    "Clip exceeds the sequence or minimum duration",
  );
  // Content time and take positions both stay within seven days, so a source
  // mapping is always a safe integer.
  const rate = rawRate === undefined ? 1 : rawRate;
  requireEdit(
    typeof rate === "number" && rate >= MIN_CLIP_RATE && rate <= MAX_CLIP_RATE,
    "invalid-rate",
    id,
    "Clip rate must be from " + MIN_CLIP_RATE + " to " + MAX_CLIP_RATE,
  );
  const contentOut = safeInteger(contentIn) ? contentIn + contentLength(length, rate) : NaN;
  requireEdit(
    safeInteger(contentIn) && Math.abs(contentIn) <= MAX_TICK && Math.abs(contentOut) <= MAX_TICK,
    "invalid-range",
    id,
    "Invalid content time",
  );
  let bounds: ContentBounds | undefined;
  if (contentBounds !== undefined) {
    // Reads on a primitive, an array or null yield undefined, as optional chaining did.
    const record: object =
      typeof contentBounds === "object" && contentBounds !== null ? contentBounds : {};
    const boundStart: unknown = Reflect.get(record, "start");
    const boundEnd: unknown = Reflect.get(record, "end");
    requireEdit(
      safeInteger(boundStart) &&
        safeInteger(boundEnd) &&
        contentIn >= boundStart &&
        contentOut <= boundEnd,
      "source-bounds",
      id,
      "Clip exceeds its available content handles",
    );
    bounds = Object.freeze({ ...record, start: boundStart, end: boundEnd });
  }
  return {
    trackId: track.id,
    kind,
    start,
    duration: length,
    contentIn,
    contentBounds: bounds,
    rate,
  };
}

/** Validates a staged clip. Its ID was checked when it entered the document. */
export function validateClip(clip: Clip, rules: Rules): void {
  // A staged clip omits a rate of 1, as a loaded one does.
  requireEdit(clip.rate !== 1, "invalid-rate", clip.id, "A rate of 1 is omitted");
  requireEdit(clip.gain !== 1, "invalid-gain", clip.id, "A gain of 1 is omitted");
  checkGain(clip.id, clip.gain);
  checkPlacement(clip, rules);
}

export function orderTrack(clips: Clip[], rules: Rules, trackId: string): void {
  clips.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const track = rules.tracks.get(trackId);
  if (track?.overlap !== "exclusive") return;
  let previous: Clip | undefined;
  for (const clip of clips) {
    if (previous)
      requireEdit(
        previous.start + previous.duration <= clip.start,
        "overlap",
        track.id,
        "Clips overlap on an exclusive track",
      );
    previous = clip;
  }
}
