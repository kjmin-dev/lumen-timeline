import { requireEdit } from "./document.ts";

function splice(index, before, after) {
  return Object.freeze({ index, before: Object.freeze(before), after: Object.freeze(after) });
}

export function inverse(patches) {
  let offset = 0;
  return Object.freeze(
    patches.map((patch) => {
      const position = patch.index + offset;
      offset += patch.after.length - patch.before.length;
      return splice(position, patch.after, patch.before);
    }),
  );
}

function sameFields(a, b) {
  return (
    a === b ||
    (Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((key) => Object.hasOwn(b, key) && Object.is(a[key], b[key])))
  );
}

// A split's descendants stay in the original clip's array slot until commit.
// Moves affect placement on the timeline, independently of document array order.
export class ClipDraft {
  constructor(clips, positions) {
    this.clips = clips;
    this.positions = positions;
    this.edited = new Map();
    this.owners = new Map();
    this.groups = new Map();
  }

  get(id) {
    return this.edited.get(id) ?? this.clips[this.positions.get(id)];
  }

  replace(clip, after) {
    const owner = this.owners.get(clip.id) ?? this.positions.get(clip.id);
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

  patches() {
    const patches = [];
    for (const [index, group] of this.groups) {
      const original = this.clips[index];
      if (sameFields(original, group[0])) group[0] = original;
      if (group.length !== 1 || group[0] !== original)
        patches.push(splice(index, [original], group));
    }
    return Object.freeze(patches.sort((a, b) => a.index - b.index));
  }
}

function conflict(id, reason) {
  requireEdit(false, "history-conflict", id, reason);
}

// Recompute indices from stable IDs. A retained clip receives only the fields
// owned by the edit. Removing a split child requires its entire record to match.
export function rebase(patches, clips, positions, validate) {
  let changed = false;
  const result = patches.map((patch) => {
    const index = positions.get(patch.before[0].id);
    if (index === undefined) conflict(patch.before[0].id, "History target is missing");
    const before = clips.slice(index, index + patch.before.length);
    for (const [i, expected] of patch.before.entries()) {
      if (before[i]?.id !== expected.id)
        conflict(expected.id, "Clip structure changed since this edit");
      if (i > 0 && !sameFields(before[i], expected))
        conflict(expected.id, "Undo would remove a modified split child");
    }
    const expected = patch.before[0];
    const desired = patch.after[0];
    let head = desired;
    if (before[0] !== expected) {
      head = { ...before[0] };
      for (const key of Object.keys(desired)) {
        if (Object.is(expected[key], desired[key])) continue;
        if (!Object.is(before[0][key], expected[key]))
          conflict(expected.id, "History field changed: " + key);
        head[key] = desired[key];
      }
      head = Object.freeze(head);
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
