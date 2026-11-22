import { normalizeEntityData } from "./entity-data.ts";
import { compareMarkers, parseMarker } from "./markers.ts";
import {
  checkLoadedReferences,
  compareTakes,
  countReferences,
  parseCandidates,
  parseTake,
} from "./takes.ts";
import { MAX_TICK, TICKS_PER_SECOND } from "./time.ts";
import type {
  Clip,
  ContentBounds,
  JsonValue,
  Marker,
  ProjectSnapshot,
  Take,
  Tick,
  Track,
} from "./types.ts";
import { freezeJson, isArray, isRecord, requireEdit, safeInteger, validId } from "./validation.ts";

/** Validation rules shared by project loading and every staged clip. */
export interface Rules {
  readonly tracks: ReadonlyMap<string, Track>;
  readonly duration: Tick;
  readonly minimum: Tick;
}

/** Start-ordered clips per track ID. The editor replaces arrays it changes. */
export type TrackLayout = Map<string, Clip[]>;

export interface OpenedProject {
  readonly snapshot: ProjectSnapshot;
  readonly rules: Rules;
  readonly byTrack: TrackLayout;
  /** How many clips list each take. */
  readonly takeCounts: Map<string, number>;
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
}

/** Validated placement fields. `contentBounds` is undefined when absent. */
export interface Placement {
  readonly trackId: string;
  readonly kind: string;
  readonly start: Tick;
  readonly duration: Tick;
  readonly contentIn: Tick;
  readonly contentBounds: ContentBounds | undefined;
}

function parseTrack(value: JsonValue, tracks: ReadonlyMap<string, Track>): Track {
  const track = isRecord(value) ? value : undefined;
  const id = track?.["id"];
  requireEdit(
    track !== undefined && validId(id) && !tracks.has(id),
    "invalid-track",
    id,
    "Track IDs must be unique",
  );
  const overlap = track["overlap"];
  requireEdit(
    overlap === undefined || overlap === "mix" || overlap === "exclusive",
    "invalid-track",
    id,
    "Unknown overlap policy",
  );
  const locked = track["locked"];
  requireEdit(
    locked === undefined || typeof locked === "boolean",
    "invalid-track",
    id,
    "Expected a boolean lock",
  );
  const accepts = track["accepts"];
  requireEdit(
    accepts === undefined || (isArray(accepts) && accepts.every(validId)),
    "invalid-track",
    id,
    "Expected a list of clip kinds",
  );
  const name = track["name"];
  requireEdit(
    name === undefined || typeof name === "string",
    "invalid-track",
    id,
    "Expected a string name",
  );
  const mute = track["mute"];
  const solo = track["solo"];
  requireEdit(
    (mute === undefined || typeof mute === "boolean") &&
      (solo === undefined || typeof solo === "boolean"),
    "invalid-track",
    id,
    "Expected boolean mute and solo flags",
  );
  const gain = track["gain"];
  requireEdit(
    gain === undefined || typeof gain === "number",
    "invalid-track",
    id,
    "Expected a numeric gain",
  );
  // Every typed field is re-attached from its checked value. Other JSON fields stay.
  return Object.freeze({
    ...track,
    id,
    ...(overlap === undefined ? {} : { overlap }),
    ...(locked === undefined ? {} : { locked }),
    ...(accepts === undefined ? {} : { accepts }),
    ...(name === undefined ? {} : { name }),
    ...(mute === undefined ? {} : { mute }),
    ...(solo === undefined ? {} : { solo }),
    ...(gain === undefined ? {} : { gain }),
  });
}

/** Parses one clip of a loaded project or a replayed record. */
export function parseClip(value: JsonValue, ids: ReadonlySet<string>, rules: Rules): Clip {
  const clip = isRecord(value) ? value : undefined;
  const id = clip?.["id"];
  requireEdit(
    clip !== undefined && validId(id) && !ids.has(id),
    "invalid-clip",
    id,
    "Clip IDs must be unique",
  );
  const { trackId, kind, start, duration, contentIn, contentBounds } = checkPlacement(
    {
      id,
      trackId: clip["trackId"],
      kind: clip["kind"],
      start: clip["start"],
      duration: clip["duration"],
      contentIn: clip["contentIn"],
      contentBounds: clip["contentBounds"],
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
  // A clip carries both candidate fields or neither. Kept fields keep their position.
  const { takeIds: _noTakes, activeTakeId: _noActive, ...withoutCandidates } = clip;
  return Object.freeze({
    ...(candidates === undefined ? withoutCandidates : clip),
    id,
    trackId,
    kind,
    start,
    duration,
    contentIn,
    ...(contentBounds === undefined ? {} : { contentBounds }),
    ...candidates,
    ...(continuityId === undefined ? {} : { continuityId }),
    ...(extensions === undefined ? {} : { extensions }),
    ...(name === undefined ? {} : { name }),
  });
}

export function openProject(input: unknown): OpenedProject {
  const project = freezeJson(input, new Set());
  requireEdit(
    isRecord(project) && project["schemaVersion"] === 1,
    "unsupported-schema",
    null,
    "Editing requires project schema version 1",
  );
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
    const track = parseTrack(value, tracks);
    tracks.set(track.id, track);
    trackList.push(track);
  }
  const rules: Rules = { tracks, duration, minimum };
  const ids = new Set<string>();
  const clipList: Clip[] = [];
  const byTrack: TrackLayout = new Map();
  for (const value of rawClips) {
    const clip = parseClip(value, ids, rules);
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
    const marker = parseMarker(value, markerIds, duration);
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
    const take = parseTake(value, (id) => takes.has(id));
    takes.set(take.id, take);
  }
  const takeCounts = countReferences(clipList);
  checkLoadedReferences(takes, clipList);
  const takeList = [...takes.values()].sort(compareTakes);
  // Normalized entity data follows the revision, as when the editor normalized it.
  // Empty markers and takes lists are omitted; otherwise they keep their field position.
  const { entityData: rawData, ...withLists } = project;
  const { markers: _emptyMarkers, ...withoutMarkers } = withLists;
  const withTakes = markerList.length ? withLists : withoutMarkers;
  const { takes: _emptyTakes, ...withoutTakes } = withTakes;
  const rest = takeList.length ? withTakes : withoutTakes;
  const entityData = Object.hasOwn(project, "entityData")
    ? normalizeEntityData(rawData)
    : undefined;
  const snapshot: ProjectSnapshot = Object.freeze({
    ...rest,
    schemaVersion: 1,
    ...(timebase === undefined ? {} : { timebase }),
    tracks: Object.freeze(trackList),
    clips: Object.freeze(clipList),
    ...(rawDuration === undefined ? {} : { duration }),
    ...(rawMinimum === undefined ? {} : { minClipDuration: minimum }),
    ...(markerList.length ? { markers: Object.freeze(markerList) } : {}),
    ...(takeList.length ? { takes: Object.freeze(takeList) } : {}),
    revision,
    ...(entityData === undefined ? {} : { entityData }),
  });
  return { snapshot, rules, byTrack, takeCounts };
}

/** Checks placement fields against the rules shared by loading and every edit. */
export function checkPlacement(
  { id, trackId, kind, start, duration: length, contentIn, contentBounds }: PlacementInput,
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
  requireEdit(
    safeInteger(contentIn) && Math.abs(contentIn) <= MAX_TICK,
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
        contentIn + length <= boundEnd,
      "source-bounds",
      id,
      "Clip exceeds its available content handles",
    );
    bounds = Object.freeze({ ...record, start: boundStart, end: boundEnd });
  }
  return { trackId: track.id, kind, start, duration: length, contentIn, contentBounds: bounds };
}

/** Validates a staged clip. Its ID was checked when it entered the document. */
export function validateClip(clip: Clip, rules: Rules): void {
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
