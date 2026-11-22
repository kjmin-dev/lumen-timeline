import { jsonEqual } from "./entity-data.ts";
import { defined } from "./invariant.ts";
import type { Clip, ClipPatch } from "./types.ts";
import { requireEdit } from "./validation.ts";

function splice(index: number, before: readonly Clip[], after: readonly Clip[]): ClipPatch {
  return Object.freeze({ index, before: Object.freeze(before), after: Object.freeze(after) });
}

export function inverse(patches: readonly ClipPatch[]): readonly ClipPatch[] {
  let offset = 0;
  return Object.freeze(
    patches.map((patch) => {
      const position = patch.index + offset;
      offset += patch.after.length - patch.before.length;
      return splice(position, patch.after, patch.before);
    }),
  );
}

// Fields compare by value, so a candidate list rebuilt with the same IDs is unchanged.
function sameFields(a: Clip, b: Clip): boolean {
  return (
    a === b ||
    (Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key])))
  );
}

// A split's descendants stay in the original clip's array slot until commit.
// Moves affect placement on the timeline, independently of document array order.
export class ClipDraft {
  readonly clips: readonly Clip[];
  readonly positions: ReadonlyMap<string, number>;
  readonly edited: Map<string, Clip>;
  readonly owners: Map<string, number>;
  readonly groups: Map<number, Clip[]>;

  constructor(clips: readonly Clip[], positions: ReadonlyMap<string, number>) {
    this.clips = clips;
    this.positions = positions;
    this.edited = new Map();
    this.owners = new Map();
    this.groups = new Map();
  }

  get(id: string): Clip | undefined {
    const index = this.positions.get(id);
    return this.edited.get(id) ?? (index === undefined ? undefined : this.clips[index]);
  }

  /** The clip as it was before this transaction, if it existed. */
  original(id: string): Clip | undefined {
    const index = this.positions.get(id);
    return index === undefined ? undefined : this.clips[index];
  }

  // `clip` is the current version of a clip from `get`, so it has an owner slot.
  replace(clip: Clip, after: readonly Clip[]): void {
    const owner = defined(this.owners.get(clip.id) ?? this.positions.get(clip.id), "clip slot");
    let group = this.groups.get(owner);
    if (!group) {
      group = [clip];
      this.groups.set(owner, group);
    }
    group.splice(group.indexOf(clip), 1, ...after);
    for (const next of after) {
      this.edited.set(next.id, Object.freeze(next));
      this.owners.set(next.id, owner);
    }
  }

  patches(): readonly ClipPatch[] {
    const patches: ClipPatch[] = [];
    for (const [index, group] of this.groups) {
      const original = defined(this.clips[index], "original clip");
      if (sameFields(original, defined(group[0], "group head"))) group[0] = original;
      if (group.length !== 1 || group[0] !== original)
        patches.push(splice(index, [original], group));
    }
    return Object.freeze(patches.sort((a, b) => a.index - b.index));
  }
}

function conflict(id: string, reason: string): never {
  requireEdit(false, "history-conflict", id, reason);
}

// Recompute indices from stable IDs. A retained clip receives only the fields
// owned by the edit. Removing a split child requires its entire record to match.
// Every stored patch replaces at least one clip with at least one clip.
export function rebase(
  patches: readonly ClipPatch[],
  clips: readonly Clip[],
  positions: ReadonlyMap<string, number>,
  validate: (clip: Clip) => void,
): readonly ClipPatch[] {
  let changed = false;
  const result = patches.map((patch) => {
    const expected = defined(patch.before[0], "patch target");
    const desired = defined(patch.after[0], "patch result");
    const index = positions.get(expected.id);
    if (index === undefined) conflict(expected.id, "History target is missing");
    const before = clips.slice(index, index + patch.before.length);
    for (const [i, target] of patch.before.entries()) {
      const found = before[i];
      if (found?.id !== target.id) conflict(target.id, "Clip structure changed since this edit");
      if (i > 0 && !sameFields(found, target))
        conflict(target.id, "Undo would remove a modified split child");
    }
    let head = desired;
    const current = defined(before[0], "current target");
    if (current !== expected) {
      const merged: { -readonly [K in keyof Clip]: Clip[K] } = { ...current };
      // An edit owns the fields it changed, including the ones it removed.
      const keys = [
        ...Object.keys(desired),
        ...Object.keys(expected).filter((key) => !Object.hasOwn(desired, key)),
      ];
      for (const key of keys) {
        if (jsonEqual(expected[key], desired[key])) continue;
        if (!jsonEqual(current[key], expected[key]))
          conflict(expected.id, "History field changed: " + key);
        if (Object.hasOwn(desired, key)) merged[key] = desired[key];
        else delete merged[key];
      }
      head = Object.freeze(merged);
    }
    const after = [head, ...patch.after.slice(1)];
    for (const child of after.slice(1)) {
      if (positions.has(child.id)) conflict(child.id, "Split child ID is already occupied");
    }
    for (const next of after) validate(next);
    if (index === patch.index && before.every((c, i) => c === patch.before[i]) && head === desired)
      return patch;
    changed = true;
    return splice(index, before, after);
  });
  return changed ? Object.freeze(result.sort((a, b) => a.index - b.index)) : patches;
}
