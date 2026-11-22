import { parseClip } from "./document.ts";
import type { Rules } from "./document.ts";
import { parseMarker } from "./markers.ts";
import { parseTake } from "./takes.ts";
import type {
  ClipPatch,
  DataPatch,
  JsonValue,
  MarkerPatch,
  ReplayCommand,
  TakePatch,
} from "./types.ts";
import { EditError, freezeJson, isArray, isRecord, requireEdit, validId } from "./validation.ts";

/** Recorded changes, as a history entry or a replay command holds them. */
export interface Records {
  readonly clips: readonly ClipPatch[];
  readonly data: readonly DataPatch[];
  readonly markers: readonly MarkerPatch[];
  readonly takes: readonly TakePatch[];
}

const none: readonly never[] = Object.freeze([]);

// An absent field and one set to undefined mean the same, as in JSON.
function defined(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map(defined);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]: [string, unknown]) =>
      item === undefined ? [] : [[key, defined(item)]],
    ),
  );
}
const noIds: ReadonlySet<string> = new Set();

/** A replay command that carries these records. */
export function replayOf({ clips, data, markers, takes }: Records): ReplayCommand {
  return Object.freeze({
    type: "replay",
    clipPatches: clips,
    dataPatches: data,
    markerPatches: markers,
    takePatches: takes,
  });
}

/**
 * Parses a replay command from any source, such as another editor or a saved
 * log. Each record is checked as a loaded project's would be. Anything
 * malformed rejects the command with `invalid-replay`.
 */
export function parseReplay(command: ReplayCommand, rules: Rules): Records {
  try {
    const input = freezeJson(defined(command));
    requireEdit(isRecord(input), "invalid-replay", null, "Expected a replay command");
    const list = (key: string): readonly JsonValue[] => {
      const value = input[key];
      if (value === undefined) return none;
      requireEdit(isArray(value), "invalid-replay", key, "Expected an array of patches");
      return value;
    };
    // A patch names its record and carries its state before and after, either absent.
    const patch = <T>(
      value: JsonValue,
      parse: (state: JsonValue) => T & { readonly id: string },
    ): { id: string; before: T | undefined; after: T | undefined } => {
      const record = isRecord(value) ? value : undefined;
      const id = record?.["id"];
      requireEdit(record && validId(id), "invalid-replay", id, "A patch requires an ID");
      const state = (key: string): T | undefined => {
        const raw = record[key];
        if (raw === undefined) return undefined;
        const parsed = parse(raw);
        requireEdit(parsed.id === id, "invalid-replay", id, "A patch changes one record");
        return parsed;
      };
      const before = state("before");
      const after = state("after");
      requireEdit(before || after, "invalid-replay", id, "A patch needs a state");
      return { id, before, after };
    };
    const clips = list("clipPatches").map((value): ClipPatch => {
      const { id, before, after } = patch(value, (state) => parseClip(state, noIds, rules));
      const follows = isRecord(value) ? value["follows"] : undefined;
      // An inverted addition keeps the clip it followed.
      requireEdit(
        follows === undefined || validId(follows),
        "invalid-replay",
        id,
        "A new clip follows a clip ID",
      );
      return Object.freeze({ id, before, after, ...(follows === undefined ? {} : { follows }) });
    });
    const markers = list("markerPatches").map((value): MarkerPatch =>
      Object.freeze(patch(value, (state) => parseMarker(state, noIds, rules.duration))),
    );
    const takes = list("takePatches").map((value): TakePatch =>
      Object.freeze(patch(value, (state) => parseTake(state, () => false))),
    );
    const data = list("dataPatches").map((value): DataPatch => {
      const record = isRecord(value) ? value : undefined;
      const scope = record?.["scope"];
      const id = record?.["id"];
      const key = record?.["key"];
      requireEdit(
        record && validId(scope) && validId(id) && validId(key),
        "invalid-replay",
        id,
        "A data patch requires a scope, an ID and a key",
      );
      return Object.freeze({ scope, id, key, before: record["before"], after: record["after"] });
    });
    return {
      clips: Object.freeze(clips),
      data: Object.freeze(data),
      markers: Object.freeze(markers),
      takes: Object.freeze(takes),
    };
  } catch (error) {
    if (!(error instanceof EditError) || error.code === "invalid-replay") throw error;
    throw new EditError("invalid-replay", error.target, error.message);
  }
}
