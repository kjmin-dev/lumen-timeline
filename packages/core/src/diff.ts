import { sameFields } from "./clip-patches.ts";
import { jsonEqual } from "./entity-data.ts";
import { stagedPatches } from "./record-patches.ts";
import type { Records } from "./replay.ts";
import type {
  Clip,
  ClipPatch,
  DataPatch,
  EntityData,
  JsonValue,
  Marker,
  ProjectSnapshot,
  Take,
} from "./types.ts";

type Dictionary<T> = { readonly [key: string]: T };

const own = <T>(object: Dictionary<T> | undefined, key: string): T | undefined =>
  object && Object.hasOwn(object, key) ? object[key] : undefined;
const keys = (...objects: (object | undefined)[]): Set<string> =>
  new Set(objects.flatMap((object) => Object.keys(object ?? {})));

const none: readonly never[] = Object.freeze([]);

// The same clips in the same places, as after any edit that adds and removes
// none: the clips that changed, in order, or `null` when the lists differ in
// more than that. Clips the two snapshots share are told apart by identity.
function updates(from: readonly Clip[], to: readonly Clip[]): readonly ClipPatch[] | null {
  if (from.length !== to.length) return null;
  const patches: ClipPatch[] = [];
  for (let index = 0; index < from.length; index++) {
    const before = from[index];
    const after = to[index];
    if (after === before) continue;
    if (!before || after?.id !== before.id) return null;
    if (!sameFields(before, after)) patches.push(Object.freeze({ id: after.id, before, after }));
  }
  return Object.freeze(patches);
}

// Removals first, then each clip of `to` in order: a new one follows the clip
// before it, a changed one is an update.
function clips(from: readonly Clip[], to: readonly Clip[]): readonly ClipPatch[] {
  if (from === to) return none;
  const changed = updates(from, to);
  if (changed) return changed;
  const was = new Map(from.map((clip) => [clip.id, clip]));
  const kept = new Set(to.map((clip) => clip.id));
  const patches: ClipPatch[] = from
    .filter((clip) => !kept.has(clip.id))
    .map((clip) => Object.freeze({ id: clip.id, before: clip, after: undefined }));
  let previous: string | undefined;
  for (const clip of to) {
    const before = was.get(clip.id);
    if (!before)
      patches.push(
        Object.freeze({
          id: clip.id,
          before: undefined,
          after: clip,
          ...(previous === undefined ? {} : { follows: previous }),
        }),
      );
    else if (!sameFields(before, clip))
      patches.push(Object.freeze({ id: clip.id, before, after: clip }));
    previous = clip.id;
  }
  return Object.freeze(patches);
}

function records<T extends Marker | Take>(
  from: readonly T[] | undefined,
  to: readonly T[] | undefined,
): readonly {
  readonly id: string;
  readonly before: T | undefined;
  readonly after: T | undefined;
}[] {
  if (from === to) return none;
  const staged = new Map<string, T | undefined>(
    (from ?? []).map((record) => [record.id, undefined]),
  );
  for (const record of to ?? []) staged.set(record.id, record);
  const was = new Map((from ?? []).map((record) => [record.id, record]));
  return stagedPatches((id) => was.get(id), staged);
}

function data(from: EntityData | undefined, to: EntityData | undefined): readonly DataPatch[] {
  if (from === to) return none;
  const patches: DataPatch[] = [];
  for (const scope of keys(from, to)) {
    const a = own(from, scope);
    const b = own(to, scope);
    if (a === b) continue;
    for (const id of keys(a, b)) {
      const fieldsA = own(a, id);
      const fieldsB = own(b, id);
      if (fieldsA === fieldsB) continue;
      for (const key of keys(fieldsA, fieldsB)) {
        const before: JsonValue | undefined = own(fieldsA, key);
        const after: JsonValue | undefined = own(fieldsB, key);
        if (!jsonEqual(before, after))
          patches.push(Object.freeze({ scope, id, key, before, after }));
      }
    }
  }
  return Object.freeze(patches);
}

/** The records that turn one snapshot of a project into another. */
export function difference(from: ProjectSnapshot, to: ProjectSnapshot): Records {
  return {
    clips: clips(from.clips, to.clips),
    data: data(from.entityData, to.entityData),
    markers: records(from.markers, to.markers),
    takes: records(from.takes, to.takes),
  };
}
