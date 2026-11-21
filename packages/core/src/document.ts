import { TICKS_PER_SECOND } from "./time.ts";
import type {
  Clip,
  EditErrorCode,
  JsonPrimitive,
  JsonValue,
  ProjectSnapshot,
  Tick,
  Track,
} from "./types.ts";

const MAX_TICK: number = 7 * 86400 * TICKS_PER_SECOND;

export class EditError extends Error {
  declare readonly code: EditErrorCode;
  /** The rejected ID or value as supplied, which may be invalid input. */
  declare readonly target: unknown;

  constructor(code: EditErrorCode, target: unknown, message: string) {
    super(message);
    this.name = "EditError";
    this.code = code;
    this.target = target;
  }
}

export function requireEdit(
  condition: unknown,
  code: EditErrorCode,
  target: unknown,
  reason: string,
): asserts condition {
  if (!condition) throw new EditError(code, target, reason);
}

/** `Array.isArray`, typed so that a successful check does not introduce `any`. */
export const isArray: (value: unknown) => value is readonly unknown[] = Array.isArray;

export function validId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0;
}

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
}

// Validation reads fields of arbitrary JSON. As in plain JavaScript, an
// optional read on a primitive or an array yields undefined for these keys.
interface UncheckedProject {
  readonly schemaVersion?: unknown;
  readonly timebase?: unknown;
  readonly revision?: unknown;
  readonly duration?: unknown;
  readonly minClipDuration?: unknown;
  readonly tracks?: unknown;
  readonly clips?: unknown;
}

interface UncheckedTrack {
  readonly id?: unknown;
  readonly overlap?: unknown;
  readonly locked?: unknown;
  readonly accepts?: unknown;
}

type Unchecked<T> = T | null | undefined;

// Document payloads are JSON data. Cloning before freezing preserves host ownership.
export function freezeJson(value: unknown, ancestors: Set<unknown> = new Set()): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    Number.isFinite(value)
  )
    return value as JsonPrimitive;
  requireEdit(
    value && typeof value === "object",
    "invalid-project",
    null,
    "Expected JSON project data",
  );
  const prototype: unknown = Object.getPrototypeOf(value);
  requireEdit(
    Array.isArray(value) || prototype === null || Object.getPrototypeOf(prototype) === null,
    "invalid-project",
    null,
    "Expected a plain project object",
  );
  requireEdit(!ancestors.has(value), "invalid-project", null, "Project data contains a cycle");
  ancestors.add(value);
  const copy: JsonValue = Array.isArray(value)
    ? Array.from(value as readonly unknown[], (item) => freezeJson(item, ancestors))
    : Object.fromEntries(
        Object.entries(value).map(([key, item]: [string, unknown]) => [
          key,
          freezeJson(item, ancestors),
        ]),
      );
  ancestors.delete(value);
  return Object.freeze(copy);
}

export function openProject(input: unknown): OpenedProject {
  const project = freezeJson(input, new Set()) as Unchecked<UncheckedProject>;
  requireEdit(
    project?.schemaVersion === 1,
    "unsupported-schema",
    null,
    "Editing requires project schema version 1",
  );
  requireEdit(
    project.timebase === undefined || project.timebase === TICKS_PER_SECOND,
    "invalid-timebase",
    null,
    "Project times must use the timeline tick rate",
  );
  requireEdit(
    Array.isArray(project.tracks) && Array.isArray(project.clips),
    "invalid-project",
    null,
    "The project requires tracks and clips arrays",
  );
  const revision = project.revision === undefined ? 0 : project.revision;
  requireEdit(
    Number.isSafeInteger(revision) && typeof revision === "number" && revision >= 0,
    "invalid-project",
    null,
    "Invalid project revision",
  );
  const duration = project.duration === undefined ? MAX_TICK : project.duration;
  const minimum = project.minClipDuration === undefined ? 1 : project.minClipDuration;
  requireEdit(
    Number.isSafeInteger(duration) &&
      typeof duration === "number" &&
      duration >= 0 &&
      duration <= MAX_TICK &&
      Number.isSafeInteger(minimum) &&
      typeof minimum === "number" &&
      minimum > 0 &&
      minimum <= MAX_TICK,
    "invalid-project",
    null,
    "Invalid sequence bounds or minimum clip duration",
  );

  const tracks = new Map<string, Track>();
  for (const track of project.tracks as readonly Unchecked<UncheckedTrack>[]) {
    requireEdit(
      validId(track?.id) && !tracks.has(track.id),
      "invalid-track",
      track?.id,
      "Track IDs must be unique",
    );
    requireEdit(
      track.overlap === undefined || ["mix", "exclusive"].includes(track.overlap as string),
      "invalid-track",
      track.id,
      "Unknown overlap policy",
    );
    requireEdit(
      track.locked === undefined || typeof track.locked === "boolean",
      "invalid-track",
      track.id,
      "Expected a boolean lock",
    );
    requireEdit(
      track.accepts === undefined || (Array.isArray(track.accepts) && track.accepts.every(validId)),
      "invalid-track",
      track.id,
      "Expected a list of clip kinds",
    );
    // Every track field the editor reads is validated above.
    tracks.set(track.id, track as Track);
  }
  const rules: Rules = { tracks, duration, minimum };
  const ids = new Set<string>();
  const byTrack: TrackLayout = new Map();
  // validateClip checks every placement field before a clip is used.
  for (const clip of project.clips as readonly Unchecked<Clip>[]) {
    requireEdit(
      validId(clip?.id) && !ids.has(clip.id),
      "invalid-clip",
      clip?.id,
      "Clip IDs must be unique",
    );
    ids.add(clip.id);
    validateClip(clip, rules);
    if (!byTrack.has(clip.trackId)) byTrack.set(clip.trackId, []);
    byTrack.get(clip.trackId)!.push(clip);
  }
  for (const [id, clips] of byTrack) orderTrack(clips, tracks.get(id)!);
  // Tracks, clips and sequence bounds are validated above.
  return { snapshot: Object.freeze({ ...project, revision }) as ProjectSnapshot, rules, byTrack };
}

export function validateClip(clip: Clip, { tracks, duration, minimum }: Rules): void {
  const { id, trackId, kind, start, duration: length, contentIn, contentBounds } = clip;
  const track = tracks.get(trackId);
  requireEdit(track, "missing-track", trackId, "Track does not exist");
  requireEdit(
    validId(kind) && (!track.accepts || track.accepts.includes(kind)),
    "incompatible-kind",
    id,
    "The target track does not accept this clip kind",
  );
  requireEdit(
    Number.isSafeInteger(start) &&
      Number.isSafeInteger(length) &&
      start >= 0 &&
      length >= minimum &&
      start + length <= duration,
    "invalid-range",
    id,
    "Clip exceeds the sequence or minimum duration",
  );
  requireEdit(
    Number.isSafeInteger(contentIn) && Number.isSafeInteger(contentIn + length),
    "invalid-range",
    id,
    "Invalid content time",
  );
  if (contentBounds !== undefined) {
    requireEdit(
      Number.isSafeInteger(contentBounds?.start) &&
        Number.isSafeInteger(contentBounds?.end) &&
        contentIn >= contentBounds.start &&
        contentIn + length <= contentBounds.end,
      "source-bounds",
      id,
      "Clip exceeds its available content handles",
    );
  }
}

export function orderTrack(clips: Clip[], track: Track): void {
  clips.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (track.overlap !== "exclusive") return;
  for (let i = 1; i < clips.length; i++) {
    const previous = clips[i - 1]!;
    requireEdit(
      previous.start + previous.duration <= clips[i]!.start,
      "overlap",
      track.id,
      "Clips overlap on an exclusive track",
    );
  }
}
