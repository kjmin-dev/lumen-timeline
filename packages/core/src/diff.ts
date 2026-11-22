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

// Removals first, then each clip of `to` in order: a new one follows the clip
// before it, a changed one is an update.
function clips(from: readonly Clip[], to: readonly Clip[]): readonly ClipPatch[] {
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
  const staged = new Map<string, T | undefined>(
    (from ?? []).map((record) => [record.id, undefined]),
  );
  for (const record of to ?? []) staged.set(record.id, record);
  return stagedPatches(new Map((from ?? []).map((record) => [record.id, record])), staged);
}

function data(from: EntityData | undefined, to: EntityData | undefined): readonly DataPatch[] {
  const patches: DataPatch[] = [];
  for (const scope of keys(from, to)) {
    const a = own(from, scope);
    const b = own(to, scope);
    for (const id of keys(a, b)) {
      const fieldsA = own(a, id);
      const fieldsB = own(b, id);
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
