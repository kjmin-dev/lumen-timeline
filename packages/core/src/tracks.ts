import type { PluginRegistry } from "./plugins.ts";
import { invertRecords, rebaseRecords, sameRecord } from "./record-patches.ts";
import type {
  JsonObject,
  JsonValue,
  OverlapPolicy,
  Track,
  TrackCommand,
  TrackPatch,
} from "./types.ts";
import { freezeJson, isArray, isRecord, requireEdit, validId } from "./validation.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const optionalText = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

const distinctIds = (value: unknown): value is readonly string[] =>
  isArray(value) && value.every(validId) && new Set(value).size === value.length;

function checkTrackFields(track: Track, plugins?: PluginRegistry): void {
  const { id, overlap, locked, accepts, name, mute, solo, gain, color, extensions } = track;
  requireEdit(
    overlap === undefined || overlap === "mix" || overlap === "exclusive",
    "invalid-track",
    id,
    "Unknown overlap policy",
  );
  requireEdit(
    locked === undefined || typeof locked === "boolean",
    "invalid-track",
    id,
    "Expected a boolean lock",
  );
  requireEdit(
    accepts === undefined || (isArray(accepts) && accepts.every(validId)),
    "invalid-track",
    id,
    "Expected a list of clip kinds",
  );
  requireEdit(optionalText(name), "invalid-track", id, "Expected a string name");
  requireEdit(
    (mute === undefined || typeof mute === "boolean") &&
      (solo === undefined || typeof solo === "boolean"),
    "invalid-track",
    id,
    "Expected boolean mute and solo flags",
  );
  requireEdit(
    gain === undefined || typeof gain === "number",
    "invalid-track",
    id,
    "Expected a numeric gain",
  );
  requireEdit(optionalText(color), "invalid-track", id, "Expected a string color");
  requireEdit(
    extensions === undefined || isRecord(extensions),
    "invalid-track",
    id,
    "Expected an extensions map",
  );
  plugins?.validate("track", id, extensions);
}

/** Parses one track of a loaded project or a replayed record. */
export function parseTrack(
  value: JsonValue,
  taken: (id: string) => boolean,
  plugins?: PluginRegistry,
): Track {
  const track = isRecord(value) ? value : undefined;
  const id = track?.["id"];
  requireEdit(
    track !== undefined && validId(id) && !taken(id),
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
  requireEdit(optionalText(name), "invalid-track", id, "Expected a string name");
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
  const color = track["color"];
  requireEdit(optionalText(color), "invalid-track", id, "Expected a string color");
  const extensions = track["extensions"];
  requireEdit(
    extensions === undefined || isRecord(extensions),
    "invalid-track",
    id,
    "Expected an extensions map",
  );
  plugins?.validate("track", id, extensions);
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
    ...(color === undefined ? {} : { color }),
    ...(extensions === undefined ? {} : { extensions }),
  });
}

export interface TrackStageContext {
  readonly hasClipsOn: (trackId: string) => boolean;
  readonly removeTrackClips: (trackId: string) => void;
  readonly plugins: PluginRegistry;
}

export interface StagedTracks {
  readonly patches: readonly TrackPatch[];
  readonly order: readonly string[] | undefined;
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Stages track commands for one transaction. */
export class TrackDraft {
  readonly base: readonly Track[];
  readonly baseById: ReadonlyMap<string, Track>;
  readonly baseIndex: ReadonlyMap<string, number>;
  readonly current: Map<string, Track>;
  order: string[];

  constructor(base: readonly Track[]) {
    this.base = base;
    this.baseById = new Map(base.map((track) => [track.id, track]));
    this.baseIndex = new Map(base.map((track, index) => [track.id, index]));
    this.current = new Map(base.map((track) => [track.id, track]));
    this.order = base.map((track) => track.id);
  }

  get(id: string): Track | undefined {
    return this.current.get(id);
  }

  map(): ReadonlyMap<string, Track> {
    return this.current;
  }

  list(): readonly Track[] {
    return this.order.flatMap((id) => {
      const track = this.current.get(id);
      return track ? [track] : [];
    });
  }

  stage(command: TrackCommand, context: TrackStageContext): void {
    if (command.type === "add-track") {
      const input = command.track;
      requireEdit(
        typeof input === "object" && input !== null && !isArray(input),
        "invalid-track",
        null,
        "Expected a track object",
      );
      const id: unknown = Reflect.get(input, "id");
      requireEdit(
        validId(id) && !this.current.has(id),
        "invalid-track",
        id,
        "A new track requires an unused ID",
      );
      if (command.after !== undefined) {
        requireEdit(
          validId(command.after) && this.current.has(command.after),
          "missing-track",
          command.after,
          "Reference track does not exist",
        );
      }
      const name: unknown = Reflect.get(input, "name");
      const overlap: unknown = Reflect.get(input, "overlap");
      const locked: unknown = Reflect.get(input, "locked");
      const accepts: unknown = Reflect.get(input, "accepts");
      const mute: unknown = Reflect.get(input, "mute");
      const solo: unknown = Reflect.get(input, "solo");
      const gain: unknown = Reflect.get(input, "gain");
      const color: unknown = Reflect.get(input, "color");
      const rawExt: unknown = Reflect.get(input, "extensions");
      requireEdit(optionalText(name), "invalid-track", id, "Expected a string name");
      requireEdit(
        overlap === undefined || overlap === "mix" || overlap === "exclusive",
        "invalid-track",
        id,
        "Unknown overlap policy",
      );
      requireEdit(
        locked === undefined || typeof locked === "boolean",
        "invalid-track",
        id,
        "Expected a boolean lock",
      );
      requireEdit(
        accepts === undefined || (isArray(accepts) && accepts.every(validId)),
        "invalid-track",
        id,
        "Expected a list of clip kinds",
      );
      requireEdit(
        (mute === undefined || typeof mute === "boolean") &&
          (solo === undefined || typeof solo === "boolean"),
        "invalid-track",
        id,
        "Expected boolean mute and solo flags",
      );
      requireEdit(
        gain === undefined || (typeof gain === "number" && Number.isFinite(gain) && gain >= 0),
        "invalid-track",
        id,
        "Track gain must be a finite nonnegative number",
      );
      requireEdit(optionalText(color), "invalid-track", id, "Expected a string color");
      let extensions: JsonObject | undefined;
      if (rawExt !== undefined) {
        const frozen = freezeJson(rawExt);
        requireEdit(isRecord(frozen), "invalid-track", id, "Expected an extensions map");
        extensions = frozen;
      }
      const track: Track = Object.freeze({
        id,
        ...(name === undefined ? {} : { name }),
        ...(overlap === undefined ? {} : { overlap }),
        ...(locked === undefined ? {} : { locked }),
        ...(accepts === undefined ? {} : { accepts: Object.freeze([...accepts]) }),
        ...(mute === undefined ? {} : { mute }),
        ...(solo === undefined ? {} : { solo }),
        ...(gain === undefined ? {} : { gain }),
        ...(color === undefined ? {} : { color }),
        ...(extensions === undefined ? {} : { extensions }),
      });
      context.plugins.validate("track", id, extensions);
      this.current.set(id, track);
      if (command.after === undefined) this.order.push(id);
      else this.order.splice(this.order.indexOf(command.after) + 1, 0, id);
      return;
    }

    if (command.type === "reorder-tracks") {
      const { trackIds } = command;
      requireEdit(
        distinctIds(trackIds) &&
          trackIds.length === this.order.length &&
          trackIds.every((id) => this.current.has(id)),
        "invalid-track",
        null,
        "Expected a permutation of the project's tracks",
      );
      this.order = [...trackIds];
      return;
    }

    const track = validId(command.trackId) ? this.current.get(command.trackId) : undefined;
    requireEdit(track, "missing-track", command.trackId, "Track does not exist");

    if (command.type === "remove-track") {
      requireEdit(!track.locked, "locked-track", track.id, "Track is locked");
      if (context.hasClipsOn(track.id)) {
        requireEdit(
          command.removeClips === true,
          "track-not-empty",
          track.id,
          "Track still contains clips",
        );
        context.removeTrackClips(track.id);
      }
      this.current.delete(track.id);
      const index = this.order.indexOf(track.id);
      if (index >= 0) this.order.splice(index, 1);
      return;
    }

    // update-track
    const next: Mutable<Track> = { ...track };
    const setOptional = <K extends keyof Track>(
      key: K,
      value: Track[K] | null | undefined,
    ): void => {
      if (value === undefined) return;
      if (value === null) delete next[key];
      else next[key] = value;
    };
    if (command.name !== undefined) {
      requireEdit(
        command.name === null || typeof command.name === "string",
        "invalid-track",
        track.id,
        "Expected a string name",
      );
      setOptional("name", command.name);
    }
    if (command.overlap !== undefined) {
      requireEdit(
        command.overlap === null || command.overlap === "mix" || command.overlap === "exclusive",
        "invalid-track",
        track.id,
        "Unknown overlap policy",
      );
      setOptional("overlap", command.overlap);
    }
    if (command.locked !== undefined) {
      requireEdit(
        command.locked === null || typeof command.locked === "boolean",
        "invalid-track",
        track.id,
        "Expected a boolean lock",
      );
      setOptional("locked", command.locked);
    }
    if (command.accepts !== undefined) {
      requireEdit(
        command.accepts === null || (isArray(command.accepts) && command.accepts.every(validId)),
        "invalid-track",
        track.id,
        "Expected a list of clip kinds",
      );
      setOptional("accepts", command.accepts === null ? null : Object.freeze([...command.accepts]));
    }
    if (command.mute !== undefined) {
      requireEdit(
        command.mute === null || typeof command.mute === "boolean",
        "invalid-track",
        track.id,
        "Expected a boolean mute flag",
      );
      setOptional("mute", command.mute);
    }
    if (command.solo !== undefined) {
      requireEdit(
        command.solo === null || typeof command.solo === "boolean",
        "invalid-track",
        track.id,
        "Expected a boolean solo flag",
      );
      setOptional("solo", command.solo);
    }
    if (command.gain !== undefined) {
      requireEdit(
        command.gain === null ||
          (typeof command.gain === "number" && Number.isFinite(command.gain) && command.gain >= 0),
        "invalid-track",
        track.id,
        "Track gain must be a finite nonnegative number",
      );
      setOptional("gain", command.gain);
    }
    if (command.color !== undefined) {
      requireEdit(
        command.color === null || typeof command.color === "string",
        "invalid-track",
        track.id,
        "Expected a string color",
      );
      setOptional("color", command.color);
    }
    if (command.extensions !== undefined) {
      if (command.extensions === null) delete next.extensions;
      else {
        const frozen = freezeJson(command.extensions);
        requireEdit(isRecord(frozen), "invalid-track", track.id, "Expected an extensions map");
        context.plugins.validate("track", track.id, frozen);
        next.extensions = frozen;
      }
    }
    this.current.set(track.id, Object.freeze(next));
  }

  result(): StagedTracks {
    const patches: TrackPatch[] = [];
    // Removals first, in base order, recording the track they followed for exact undo placement.
    for (let i = 0; i < this.base.length; i++) {
      const before = this.base[i];
      if (!before || this.current.has(before.id)) continue;
      const previous = i > 0 ? this.base[i - 1]?.id : undefined;
      patches.push(
        Object.freeze({
          id: before.id,
          before,
          after: undefined,
          ...(previous === undefined ? {} : { follows: previous }),
        }),
      );
    }
    // Updates and additions in current order.
    let previous: string | undefined;
    for (const id of this.order) {
      const after = this.current.get(id);
      if (!after) continue;
      const before = this.baseById.get(id);
      if (!before) {
        patches.push(
          Object.freeze({
            id,
            before: undefined,
            after,
            ...(previous === undefined ? {} : { follows: previous }),
          }),
        );
      } else if (!sameRecord(before, after)) {
        patches.push(Object.freeze({ id, before, after }));
      }
      previous = id;
    }
    const frozenPatches = Object.freeze(patches);
    const appliedOrder = applyTracks(this.base, frozenPatches).map((track) => track.id);
    const order = sameOrder(appliedOrder, this.order) ? undefined : Object.freeze([...this.order]);
    return { patches: frozenPatches, order };
  }
}

export function invertTrackPatches(patches: readonly TrackPatch[]): readonly TrackPatch[] {
  return Object.freeze(
    patches.map((patch) => Object.freeze({ ...patch, before: patch.after, after: patch.before })),
  );
}

/**
 * Replays recorded track patches onto `base`, preserving disjoint fields and
 * rejecting conflicting ones.
 */
export function rebaseTracks(
  patches: readonly TrackPatch[],
  base: readonly Track[],
  plugins?: PluginRegistry,
): readonly TrackPatch[] {
  const byId = new Map(base.map((track) => [track.id, track]));
  const rebased = rebaseRecords(
    patches,
    (id) => byId.get(id),
    (track) => checkTrackFields(track, plugins),
    "track",
  );
  // Preserve `follows` from the original patches when rebaseRecords rebuilt an entry.
  if (rebased === patches) return patches;
  return Object.freeze(
    rebased.map((patch, index) => {
      const follows = patches[index]?.follows;
      return follows === undefined ? patch : Object.freeze({ ...patch, follows });
    }),
  );
}

/**
 * Applies track patches and an optional explicit track order. Additions go after
 * `follows`, or at the end when `follows` is absent.
 */
export function applyTracks(
  base: readonly Track[],
  patches: readonly TrackPatch[],
  order?: readonly string[],
): readonly Track[] {
  if (!patches.length && !order) return base;
  const updated = new Map<string, Track>();
  const removed = new Set<string>();
  const followers = new Map<string, Track[]>();
  const loose: Track[] = [];
  for (const { id, before, after, follows } of patches) {
    if (after === undefined) removed.add(id);
    else if (before !== undefined) updated.set(id, after);
    else if (follows === undefined) loose.push(after);
    else {
      const list = followers.get(follows);
      if (list) list.push(after);
      else followers.set(follows, [after]);
    }
  }
  const result: Track[] = [];
  const place = (track: Track): void => {
    result.push(track);
    const next = followers.get(track.id);
    if (!next) return;
    followers.delete(track.id);
    for (const follower of next) place(follower);
  };
  for (const track of base) {
    if (!removed.has(track.id)) place(updated.get(track.id) ?? track);
  }
  for (const track of loose) place(track);
  for (;;) {
    const next = followers.entries().next();
    if (next.done) break;
    const [anchor, orphans] = next.value;
    followers.delete(anchor);
    for (const track of orphans) place(track);
  }
  if (!order) return Object.freeze(result);
  const byId = new Map(result.map((track) => [track.id, track]));
  requireEdit(
    order.length === byId.size && order.every((id) => byId.has(id)),
    "history-conflict",
    null,
    "Track order no longer matches the current tracks",
  );
  return Object.freeze(
    order.flatMap((id) => {
      const track = byId.get(id);
      return track ? [track] : [];
    }),
  );
}

/** Whether a track patch changes anything that affects audio planning. */
export function affectsMix({ before, after }: TrackPatch): boolean {
  if (!before || !after) return true;
  return before.mute !== after.mute || before.solo !== after.solo || before.gain !== after.gain;
}

export { invertRecords };
export type { OverlapPolicy };
