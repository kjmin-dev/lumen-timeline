import { jsonEqual } from "./entity-data.ts";
import { defined } from "./invariant.ts";
import type { Clip, ClipFieldChanges, ClipPatch, Tick } from "./types.ts";
import { requireEdit } from "./validation.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// Fields compare by value, so a candidate list rebuilt with the same IDs is unchanged.
function sameFields(a: Clip, b: Clip): boolean {
  return (
    a === b ||
    (Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key])))
  );
}

/**
 * A clip's placement as three values that edits change independently: where
 * content time zero sits on the timeline, and the clip's two content edges.
 * A move changes only `origin`, a left trim only `in` and a right trim only `out`.
 */
interface ContentPlacement {
  readonly origin: Tick;
  readonly in: Tick;
  readonly out: Tick;
}

function placementOf(clip: Clip): ContentPlacement {
  return {
    origin: clip.start - clip.contentIn,
    in: clip.contentIn,
    out: clip.contentIn + clip.duration,
  };
}

const placementFields: ReadonlySet<string> = new Set(["start", "duration", "contentIn"]);

/** Every other field name that either clip carries. */
function otherFields(a: Clip, b: Clip): string[] {
  return [...Object.keys(a), ...Object.keys(b).filter((key) => !Object.hasOwn(a, key))].filter(
    (key) => !placementFields.has(key),
  );
}

/** What a clip patch changed, field by field, with placement in content space. */
export function clipFieldChanges(patch: ClipPatch): ClipFieldChanges {
  const { before, after } = patch;
  if (before === undefined || after === undefined)
    return Object.freeze({ placement: Object.freeze({}), fields: Object.freeze({}) });
  const from = placementOf(before);
  const to = placementOf(after);
  const fields: [string, { before: unknown; after: unknown }][] = [];
  for (const key of otherFields(before, after)) {
    if (!jsonEqual(before[key], after[key]))
      fields.push([key, Object.freeze({ before: before[key], after: after[key] })]);
  }
  return Object.freeze({
    placement: Object.freeze({
      ...(from.origin === to.origin
        ? {}
        : { origin: Object.freeze({ before: from.origin, after: to.origin }) }),
      ...(from.in === to.in ? {} : { in: Object.freeze({ before: from.in, after: to.in }) }),
      ...(from.out === to.out ? {} : { out: Object.freeze({ before: from.out, after: to.out }) }),
    }),
    fields: Object.freeze(Object.fromEntries(fields)),
  });
}

export function inverse(patches: readonly ClipPatch[]): readonly ClipPatch[] {
  return Object.freeze(
    patches.map((patch) => Object.freeze({ ...patch, before: patch.after, after: patch.before })),
  );
}

// A split's descendants stay grouped with the clip they were cut from, in order,
// so each new clip can name the clip it follows.
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

  /** Each clip this transaction touched so far, with the clips that now stand in its place. */
  *changes(): Iterable<readonly [Clip, readonly Clip[]]> {
    for (const [index, group] of this.groups)
      yield [defined(this.clips[index], "original clip"), group];
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

  // In project order. The original clip keeps its ID and leads its group; every
  // other member is new and follows the member before it.
  patches(): readonly ClipPatch[] {
    const patches: ClipPatch[] = [];
    const ordered = [...this.groups].sort(([a], [b]) => a - b);
    for (const [index, group] of ordered) {
      const original = defined(this.clips[index], "original clip");
      let previous = original.id;
      for (const clip of group) {
        if (clip.id === original.id) {
          if (!sameFields(original, clip))
            patches.push(Object.freeze({ id: clip.id, before: original, after: clip }));
        } else {
          patches.push(
            Object.freeze({ id: clip.id, before: undefined, after: clip, follows: previous }),
          );
        }
        previous = clip.id;
      }
    }
    return Object.freeze(patches);
  }
}

function conflict(id: string, reason: string): never {
  requireEdit(false, "history-conflict", id, reason);
}

// An update owns the fields it changed, with placement in content space, and
// keeps every other field as it is now.
function merge(found: Clip, before: Clip, after: Clip): Clip {
  const merged: Mutable<Clip> = { ...found };
  const from = placementOf(before);
  const to = placementOf(after);
  const now = placementOf(found);
  const owned = (key: "origin" | "in" | "out"): Tick => {
    if (from[key] === to[key]) return now[key];
    if (now[key] !== from[key]) conflict(found.id, "History field changed: " + key);
    return to[key];
  };
  const origin = owned("origin");
  const contentIn = owned("in");
  const out = owned("out");
  merged.start = origin + contentIn;
  merged.duration = out - contentIn;
  merged.contentIn = contentIn;
  for (const key of otherFields(before, after)) {
    if (jsonEqual(before[key], after[key])) continue;
    if (!jsonEqual(found[key], before[key])) conflict(found.id, "History field changed: " + key);
    if (Object.hasOwn(after, key)) merged[key] = after[key];
    else delete merged[key];
  }
  return Object.freeze(merged);
}

/**
 * Maps recorded clip patches onto the current clips by ID. An addition needs a
 * free ID. A removal needs the whole recorded clip. An update is merged field
 * by field. `validate` checks each resulting clip.
 */
export function rebase(
  patches: readonly ClipPatch[],
  clips: readonly Clip[],
  positions: ReadonlyMap<string, number>,
  validate: (clip: Clip) => void,
): readonly ClipPatch[] {
  let changed = false;
  const result = patches.map((patch) => {
    const { id, before, after } = patch;
    const index = positions.get(id);
    const found = index === undefined ? undefined : clips[index];
    if (before === undefined) {
      if (found !== undefined) conflict(id, "Clip ID is already occupied");
      if (after) validate(after);
      return patch;
    }
    if (found === undefined) conflict(id, "History target is missing");
    if (after === undefined) {
      if (!sameFields(found, before)) conflict(id, "Undo would remove a modified clip");
      if (found === before) return patch;
      changed = true;
      return Object.freeze({ ...patch, before: found });
    }
    if (found === before) {
      validate(after);
      return patch;
    }
    const merged = merge(found, before, after);
    validate(merged);
    changed = true;
    return Object.freeze({ ...patch, before: found, after: merged });
  });
  return changed ? Object.freeze(result) : patches;
}

/**
 * Applies patches whose `before` states match the clips. A new clip goes after
 * the clip it follows, or to the end when that clip is absent.
 */
export function applyClips(clips: readonly Clip[], patches: readonly ClipPatch[]): readonly Clip[] {
  const updated = new Map<string, Clip>();
  const removed = new Set<string>();
  const followers = new Map<string, Clip[]>();
  const loose: Clip[] = [];
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
  const result: Clip[] = [];
  const place = (clip: Clip): void => {
    result.push(clip);
    const next = followers.get(clip.id);
    if (!next) return;
    followers.delete(clip.id);
    for (const follower of next) place(follower);
  };
  for (const clip of clips) if (!removed.has(clip.id)) place(updated.get(clip.id) ?? clip);
  for (const clip of loose) place(clip);
  // What remains follows a clip that is not in the project. Placing one takes
  // its own followers with it.
  for (;;) {
    const next = followers.entries().next();
    if (next.done) break;
    const [anchor, orphans] = next.value;
    followers.delete(anchor);
    for (const clip of orphans) place(clip);
  }
  return Object.freeze(result);
}
