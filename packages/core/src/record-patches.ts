import { requireEdit } from "./validation.ts";

/** A record keyed by a stable ID, such as a marker or a take. */
export interface Entity {
  readonly id: string;
  readonly [field: string]: unknown;
}

/** One record change. `undefined` represents an absent record. */
export interface RecordPatch<T extends Entity> {
  readonly id: string;
  readonly before: T | undefined;
  readonly after: T | undefined;
}

/** Shallow field equality, which is exact for frozen JSON records. */
export function sameRecord(a: Entity, b: Entity): boolean {
  return (
    a === b ||
    (Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((key) => Object.hasOwn(b, key) && Object.is(a[key], b[key])))
  );
}

/** The patches of a staged map whose value differs from its base. */
export function stagedPatches<T extends Entity>(
  base: ReadonlyMap<string, T>,
  staged: ReadonlyMap<string, T | undefined>,
): readonly RecordPatch<T>[] {
  const patches: RecordPatch<T>[] = [];
  for (const [id, after] of staged) {
    const before = base.get(id);
    if (before === after || (before && after && sameRecord(before, after))) continue;
    patches.push(Object.freeze({ id, before, after }));
  }
  return Object.freeze(patches);
}

export function invertRecords<T extends Entity>(
  patches: readonly RecordPatch<T>[],
): readonly RecordPatch<T>[] {
  return Object.freeze(
    patches.map((p) => Object.freeze({ id: p.id, before: p.after, after: p.before })),
  );
}

function conflict(id: string, reason: string): never {
  requireEdit(false, "history-conflict", id, reason);
}

/**
 * Maps recorded patches onto the current records by ID. An addition needs a
 * free ID. A removal needs the whole recorded record. An update keeps fields
 * changed since and owns only its own. `validate` checks each resulting record.
 */
export function rebaseRecords<T extends Entity>(
  patches: readonly RecordPatch<T>[],
  current: ReadonlyMap<string, T>,
  validate: (record: T) => void,
  noun: string,
): readonly RecordPatch<T>[] {
  let changed = false;
  const result = patches.map((patch) => {
    const found = current.get(patch.id);
    const { before, after } = patch;
    if (before === undefined) {
      if (found !== undefined) conflict(patch.id, noun + " ID is already occupied");
      if (after) validate(after);
      return patch;
    }
    if (found === undefined) conflict(patch.id, "History target is missing");
    if (after === undefined) {
      if (!sameRecord(found, before)) conflict(patch.id, "Undo would remove a modified " + noun);
      if (found === before) return patch;
      changed = true;
      return Object.freeze({ id: patch.id, before: found, after });
    }
    if (found === before) {
      validate(after);
      return patch;
    }
    const merged = { ...found };
    const keys = [
      ...Object.keys(before),
      ...Object.keys(after).filter((k) => !Object.hasOwn(before, k)),
    ];
    for (const key of keys) {
      if (Object.is(before[key], after[key])) continue;
      if (!Object.is(found[key], before[key])) conflict(patch.id, "History field changed: " + key);
      if (Object.hasOwn(after, key)) Reflect.set(merged, key, after[key]);
      else Reflect.deleteProperty(merged, key);
    }
    const record = Object.freeze(merged);
    validate(record);
    changed = true;
    return Object.freeze({ id: patch.id, before: found, after: record });
  });
  return changed ? Object.freeze(result) : patches;
}

/** Applies patches whose `before` states match the base. */
export function applyRecords<T extends Entity>(
  base: readonly T[] | undefined,
  patches: readonly RecordPatch<T>[],
): Map<string, T> {
  const byId = new Map((base ?? []).map((record) => [record.id, record]));
  for (const { id, after } of patches) {
    if (after === undefined) byId.delete(id);
    else byId.set(id, after);
  }
  return byId;
}
