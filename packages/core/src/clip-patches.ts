import { jsonEqual } from "./entity-data.ts";
import { defined } from "./invariant.ts";
import { contentEnd, rateOf, roundTick } from "./time.ts";
import type { Clip, ClipFieldChanges, ClipPatch, Tick } from "./types.ts";
import { requireEdit } from "./validation.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// Fields compare by value, so a candidate list rebuilt with the same IDs is unchanged.
export function sameFields(a: Clip, b: Clip): boolean {
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
 * For a clip with a rate, `origin` is rounded to the nearest tick.
 */
interface ContentPlacement {
  readonly origin: Tick;
  readonly in: Tick;
  readonly out: Tick;
}

function placementOf(clip: Clip): ContentPlacement {
  return {
    origin: clip.start - roundTick(clip.contentIn / rateOf(clip)),
    in: clip.contentIn,
    out: contentEnd(clip),
  };
}

const placementFields: ReadonlySet<string> = new Set(["start", "duration", "contentIn", "rate"]);

/** The fields a retimed placement is merged by, as one value. */
function samePlacement(a: Clip, b: Clip): boolean {
  return (
    a.start === b.start &&
    a.duration === b.duration &&
    a.contentIn === b.contentIn &&
    rateOf(a) === rateOf(b)
  );
}
// Replay merges the candidate list by element and the active take as one value.
const candidateFields: ReadonlySet<string> = new Set(["takeIds", "activeTakeId"]);

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
    fields: Object.freeze(
      Object.fromEntries(
        rateOf(before) === rateOf(after)
          ? fields
          : [...fields, ["rate", Object.freeze({ before: before.rate, after: after.rate })]],
      ),
    ),
  });
}

export function inverse(patches: readonly ClipPatch[]): readonly ClipPatch[] {
  return Object.freeze(
    patches.map((patch) => Object.freeze({ ...patch, before: patch.after, after: patch.before })),
  );
}

// A split's descendants stay grouped with the clip they were cut from, in order,
// so each new clip can name the clip it follows. Added clips live in their own
// appended list or inside the group of the clip they follow.
export class ClipDraft {
  readonly clips: readonly Clip[];
  readonly positions: ReadonlyMap<string, number>;
  readonly edited: Map<string, Clip | undefined>;
  readonly owners: Map<string, number>;
  readonly groups: Map<number, Clip[]>;
  /** Clips added without an `after` anchor (or after another appended clip). */
  readonly appended: Clip[];

  constructor(clips: readonly Clip[], positions: ReadonlyMap<string, number>) {
    this.clips = clips;
    this.positions = positions;
    this.edited = new Map();
    this.owners = new Map();
    this.groups = new Map();
    this.appended = [];
  }

  get(id: string): Clip | undefined {
    if (this.edited.has(id)) return this.edited.get(id);
    const index = this.positions.get(id);
    return index === undefined ? undefined : this.clips[index];
  }

  /** Each clip this transaction touched so far, with the clips that now stand in its place. */
  *changes(): Iterable<readonly [Clip | undefined, readonly Clip[]]> {
    for (const [index, group] of this.groups)
      yield [defined(this.clips[index], "original clip"), group];
    if (this.appended.length) yield [undefined, this.appended];
  }

  /** Every clip currently present on `trackId`, in draft state. */
  onTrack(trackId: string): Clip[] {
    const result: Clip[] = [];
    for (let index = 0; index < this.clips.length; index++) {
      const group = this.groups.get(index);
      if (group) {
        for (const clip of group) if (clip.trackId === trackId) result.push(clip);
      } else {
        const clip = defined(this.clips[index], "original clip");
        if (clip.trackId === trackId) result.push(clip);
      }
    }
    for (const clip of this.appended) if (clip.trackId === trackId) result.push(clip);
    return result;
  }

  /** Adds a brand-new clip, optionally right after `afterId`. */
  add(clip: Clip, afterId?: string): void {
    const frozen = Object.freeze(clip);
    if (afterId !== undefined) {
      const owner = this.owners.get(afterId) ?? this.positions.get(afterId);
      if (owner !== undefined) {
        let group = this.groups.get(owner);
        if (!group) {
          group = [defined(this.clips[owner], "original clip")];
          this.groups.set(owner, group);
        }
        const at = group.findIndex((item) => item.id === afterId);
        if (at >= 0) {
          group.splice(at + 1, 0, frozen);
          this.edited.set(frozen.id, frozen);
          this.owners.set(frozen.id, owner);
          return;
        }
      }
      const appendedAt = this.appended.findIndex((item) => item.id === afterId);
      if (appendedAt >= 0) {
        this.appended.splice(appendedAt + 1, 0, frozen);
        this.edited.set(frozen.id, frozen);
        return;
      }
    }
    this.appended.push(frozen);
    this.edited.set(frozen.id, frozen);
  }

  /** Removes a live clip from the draft. */
  remove(clip: Clip): void {
    const owner = this.owners.get(clip.id) ?? this.positions.get(clip.id);
    if (owner !== undefined) {
      let group = this.groups.get(owner);
      if (!group) {
        group = [defined(this.clips[owner], "original clip")];
        this.groups.set(owner, group);
      }
      const at = group.indexOf(clip);
      if (at >= 0) group.splice(at, 1);
    } else {
      const at = this.appended.indexOf(clip);
      if (at >= 0) this.appended.splice(at, 1);
    }
    this.edited.set(clip.id, undefined);
    this.owners.delete(clip.id);
  }

  // `clip` is the current version of a clip from `get`.
  replace(clip: Clip, after: readonly Clip[]): void {
    const frozen = after.map((next) => Object.freeze(next));
    const owner = this.owners.get(clip.id) ?? this.positions.get(clip.id);
    if (owner !== undefined) {
      let group = this.groups.get(owner);
      if (!group) {
        group = [clip];
        this.groups.set(owner, group);
      }
      group.splice(group.indexOf(clip), 1, ...frozen);
      for (const next of frozen) {
        this.edited.set(next.id, next);
        this.owners.set(next.id, owner);
      }
      return;
    }
    const at = this.appended.indexOf(clip);
    if (at >= 0) this.appended.splice(at, 1, ...frozen);
    for (const next of frozen) this.edited.set(next.id, next);
  }

  // In project order. Each modified original clip leads its group (or emits a
  // removal patch with the previous base clip in `follows`); every added clip
  // names the clip it follows.
  patches(): readonly ClipPatch[] {
    const patches: ClipPatch[] = [];
    const ordered = [...this.groups].sort(([a], [b]) => a - b);
    for (const [index, group] of ordered) {
      const original = defined(this.clips[index], "original clip");
      const prevBase = index > 0 ? this.clips[index - 1]?.id : undefined;
      const kept = group.some((clip) => clip.id === original.id);
      if (!kept) {
        patches.push(
          Object.freeze({
            id: original.id,
            before: original,
            after: undefined,
            ...(prevBase === undefined ? {} : { follows: prevBase }),
          }),
        );
      }
      let previous: string | undefined = kept ? original.id : prevBase;
      for (const clip of group) {
        if (clip.id === original.id) {
          if (!sameFields(original, clip))
            patches.push(Object.freeze({ id: clip.id, before: original, after: clip }));
        } else {
          patches.push(
            Object.freeze({
              id: clip.id,
              before: undefined,
              after: clip,
              ...(previous === undefined ? {} : { follows: previous }),
            }),
          );
        }
        previous = clip.id;
      }
    }
    let tail: string | undefined;
    for (const clip of this.appended) {
      patches.push(
        Object.freeze({
          id: clip.id,
          before: undefined,
          after: clip,
          ...(tail === undefined ? {} : { follows: tail }),
        }),
      );
      tail = clip.id;
    }
    return Object.freeze(patches);
  }
}

function conflict(id: string, reason: string): never {
  requireEdit(false, "history-conflict", id, reason);
}

/**
 * The longest common subsequence of two lists of distinct IDs: the elements
 * whose relative order an edit kept.
 */
function kept(a: readonly string[], b: readonly string[]): ReadonlySet<string> {
  const width = b.length + 1;
  // lengths[i * width + j] is the subsequence length of a[i..] and b[j..].
  const lengths = Array.from({ length: (a.length + 1) * width }, () => 0);
  const at = (i: number, j: number): number => lengths[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i * width + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const result = new Set<string>();
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    const id = a[i];
    if (id !== undefined && id === b[j]) {
      result.add(id);
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) i++;
    else j++;
  }
  return result;
}

/**
 * Replays an edit of a candidate list onto the current list. The edit owns the
 * elements it added, removed or moved; every other element stays where it is
 * now. A removed element that is already gone stays gone. An owned element
 * goes after its nearest predecessor in the edit's result that the list holds,
 * or first.
 */
export function mergeList(
  found: readonly string[],
  before: readonly string[],
  after: readonly string[],
): readonly string[] {
  const was = new Set(before);
  const will = new Set(after);
  const stay = kept(
    before.filter((id) => will.has(id)),
    after.filter((id) => was.has(id)),
  );
  const present = new Set(found);
  // Added elements, and moved ones that the current list still holds.
  const owned = new Set(after.filter((id) => !stay.has(id) && (!was.has(id) || present.has(id))));
  const result = found.filter((id) => (will.has(id) ? !owned.has(id) : !was.has(id)));
  for (const [i, id] of after.entries()) {
    if (!owned.has(id)) continue;
    // The nearest earlier element of the edit's result that the list holds.
    const anchor = after.slice(0, i).findLast((other) => result.includes(other));
    result.splice(anchor === undefined ? 0 : result.indexOf(anchor) + 1, 0, id);
  }
  return result;
}

// The candidate fields in one form: a clip without candidates has an empty
// list and no active take.
function candidatesOf(clip: Clip): { list: readonly string[]; active: string | null } {
  return { list: clip.takeIds ?? [], active: clip.activeTakeId ?? null };
}

// A placement at rate 1 merges its origin and content edges independently. A
// rate makes timeline and content positions round against each other, so a
// placement that has one, before, after or now, merges as one value.
function mergePlacement(merged: Mutable<Clip>, found: Clip, before: Clip, after: Clip): void {
  if (rateOf(found) !== 1 || rateOf(before) !== 1 || rateOf(after) !== 1) {
    if (samePlacement(before, after)) return;
    if (!samePlacement(found, before)) conflict(found.id, "History field changed: placement");
    merged.start = after.start;
    merged.duration = after.duration;
    merged.contentIn = after.contentIn;
    if (after.rate === undefined) delete merged.rate;
    else merged.rate = after.rate;
    return;
  }
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
}

// An update owns the fields it changed, with placement in content space, and
// keeps every other field as it is now.
function merge(found: Clip, before: Clip, after: Clip): Clip {
  const merged: Mutable<Clip> = { ...found };
  mergePlacement(merged, found, before, after);
  const from_ = candidatesOf(before);
  const to_ = candidatesOf(after);
  const now_ = candidatesOf(found);
  const list = jsonEqual(from_.list, to_.list)
    ? now_.list
    : mergeList(now_.list, from_.list, to_.list);
  let active = now_.active;
  if (from_.active !== to_.active) {
    if (now_.active !== from_.active) conflict(found.id, "History field changed: activeTakeId");
    active = to_.active;
  }
  // A clip carries both candidate fields or neither.
  if (list.length === 0 && active === null) {
    delete merged.takeIds;
    delete merged.activeTakeId;
  } else {
    merged.takeIds = jsonEqual(list, now_.list) ? now_.list : Object.freeze([...list]);
    merged.activeTakeId = active;
  }
  for (const key of otherFields(before, after)) {
    if (candidateFields.has(key) || jsonEqual(before[key], after[key])) continue;
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
 * the clip it follows, or to the end when that clip is absent. `positions`
 * holds the index of every clip in `clips`, where the caller keeps them: the
 * patches then cost a copy of the list and the clips they name, not a lookup
 * per clip.
 */
export function applyClips(
  clips: readonly Clip[],
  patches: readonly ClipPatch[],
  positions?: ReadonlyMap<string, number>,
): readonly Clip[] {
  const at = (id: string | undefined): number | undefined =>
    id === undefined ? undefined : positions?.get(id);
  // Updates alone leave every clip in its place. Array.from copies a frozen
  // array as a block, which slice() does not.
  if (positions && patches.every((p) => p.before && p.after && at(p.id) !== undefined)) {
    const result = Array.from(clips);
    for (const { id, after } of patches) {
      const index = at(id);
      if (index !== undefined && after) result[index] = after;
    }
    return Object.freeze(result);
  }
  // The clips a patch names or follows. Every other clip is copied as it is.
  const named = positions ? new Uint8Array(clips.length) : null;
  if (named)
    for (const { id, follows } of patches)
      for (const index of [at(id), at(follows)]) if (index !== undefined) named[index] = 1;
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
  for (let index = 0; index < clips.length; index++) {
    const clip = defined(clips[index], "listed clip");
    if (named && !named[index]) result.push(clip);
    else if (!removed.has(clip.id)) place(updated.get(clip.id) ?? clip);
  }
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
