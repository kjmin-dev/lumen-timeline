import type { Rules } from "./document.ts";
import type { JsonValue, Marker, MarkerCommand, MarkerPatch, Tick } from "./types.ts";
import { isRecord, requireEdit, safeInteger, validId } from "./validation.ts";

type MutableMarker = { -readonly [K in keyof Marker]: Marker[K] };

export function compareMarkers(a: Marker, b: Marker): number {
  return a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function sameMarker(a: Marker, b: Marker): boolean {
  return (
    a === b ||
    (Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((key) => Object.hasOwn(b, key) && Object.is(a[key], b[key])))
  );
}

const optionalText = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

/** Parses one marker of a loaded project. */
export function parseMarker(value: JsonValue, ids: ReadonlySet<string>, duration: Tick): Marker {
  const marker = isRecord(value) ? value : undefined;
  const id = marker?.["id"];
  requireEdit(
    marker !== undefined && validId(id) && !ids.has(id),
    "invalid-marker",
    id,
    "Marker IDs must be unique",
  );
  const start = marker["start"];
  requireEdit(
    safeInteger(start) && start >= 0 && start <= duration,
    "invalid-marker",
    id,
    "Marker lies outside the sequence",
  );
  const label = marker["label"];
  const color = marker["color"];
  requireEdit(
    optionalText(label) && optionalText(color),
    "invalid-marker",
    id,
    "Expected a string label and color",
  );
  const extensions = marker["extensions"];
  requireEdit(
    extensions === undefined || isRecord(extensions),
    "invalid-marker",
    id,
    "Expected an extensions map",
  );
  return Object.freeze({
    ...marker,
    id,
    start,
    ...(label === undefined ? {} : { label }),
    ...(color === undefined ? {} : { color }),
    ...(extensions === undefined ? {} : { extensions }),
  });
}

function checkStart(start: Tick, id: string, rules: Rules): void {
  requireEdit(
    safeInteger(start) && start >= 0 && start <= rules.duration,
    "invalid-range",
    id,
    "Marker lies outside the sequence",
  );
}

/** Stages marker commands for one transaction. `undefined` marks a removal. */
export class MarkerDraft {
  readonly byId: ReadonlyMap<string, Marker>;
  readonly staged: Map<string, Marker | undefined>;

  constructor(base: readonly Marker[] | undefined) {
    this.byId = new Map((base ?? []).map((marker) => [marker.id, marker]));
    this.staged = new Map();
  }

  get(id: string): Marker | undefined {
    return this.staged.has(id) ? this.staged.get(id) : this.byId.get(id);
  }

  stage(
    command: MarkerCommand,
    rules: Rules,
    newId: (taken: (id: string) => boolean) => string,
  ): void {
    if (command.type === "add-marker") {
      const id =
        command.id === undefined
          ? newId((candidate) => this.get(candidate) !== undefined)
          : command.id;
      requireEdit(
        validId(id) && this.get(id) === undefined,
        "invalid-marker",
        id,
        "A new marker requires an unused ID",
      );
      const { start, label, color } = command;
      checkStart(start, id, rules);
      requireEdit(
        optionalText(label) && optionalText(color),
        "invalid-marker",
        id,
        "Expected a string label and color",
      );
      this.staged.set(
        id,
        Object.freeze({
          id,
          start,
          ...(label === undefined ? {} : { label }),
          ...(color === undefined ? {} : { color }),
        }),
      );
      return;
    }
    const marker = this.get(command.markerId);
    requireEdit(marker, "missing-marker", command.markerId, "Marker does not exist");
    if (command.type === "move-marker") {
      requireEdit(
        safeInteger(command.delta),
        "invalid-delta",
        marker.id,
        "Delta must be an integer tick count",
      );
      if (command.delta === 0) return;
      const start = marker.start + command.delta;
      checkStart(start, marker.id, rules);
      this.staged.set(marker.id, Object.freeze({ ...marker, start }));
    } else if (command.type === "update-marker") {
      const { label, color } = command;
      requireEdit(
        optionalText(label) && optionalText(color),
        "invalid-marker",
        marker.id,
        "Expected a string label and color",
      );
      this.staged.set(
        marker.id,
        Object.freeze({
          ...marker,
          ...(label === undefined ? {} : { label }),
          ...(color === undefined ? {} : { color }),
        }),
      );
    } else {
      this.staged.set(marker.id, undefined);
    }
  }

  patches(): readonly MarkerPatch[] {
    const patches: MarkerPatch[] = [];
    for (const [id, after] of this.staged) {
      const before = this.byId.get(id);
      if (before === after || (before && after && sameMarker(before, after))) continue;
      patches.push(Object.freeze({ id, before, after }));
    }
    return Object.freeze(patches);
  }
}

export function invertMarkers(patches: readonly MarkerPatch[]): readonly MarkerPatch[] {
  return Object.freeze(
    patches.map((p) => Object.freeze({ id: p.id, before: p.after, after: p.before })),
  );
}

function conflict(id: string, reason: string): never {
  requireEdit(false, "history-conflict", id, reason);
}

/**
 * Maps recorded marker patches onto the current markers by ID. An update keeps
 * fields changed since and owns only its own. A removal needs the whole marker.
 */
export function rebaseMarkers(
  patches: readonly MarkerPatch[],
  base: readonly Marker[] | undefined,
  rules: Rules,
): readonly MarkerPatch[] {
  const current = new Map((base ?? []).map((marker) => [marker.id, marker]));
  let changed = false;
  const result = patches.map((patch) => {
    const found = current.get(patch.id);
    const { before, after } = patch;
    if (before === undefined) {
      if (found !== undefined) conflict(patch.id, "Marker ID is already occupied");
      if (after) checkStart(after.start, after.id, rules);
      return patch;
    }
    if (found === undefined) conflict(patch.id, "History target is missing");
    if (after === undefined) {
      if (!sameMarker(found, before)) conflict(patch.id, "Undo would remove a modified marker");
      if (found === before) return patch;
      changed = true;
      return Object.freeze({ id: patch.id, before: found, after });
    }
    if (found === before) {
      checkStart(after.start, after.id, rules);
      return patch;
    }
    const merged: MutableMarker = { ...found };
    const keys = [
      ...Object.keys(before),
      ...Object.keys(after).filter((k) => !Object.hasOwn(before, k)),
    ];
    for (const key of keys) {
      if (Object.is(before[key], after[key])) continue;
      if (!Object.is(found[key], before[key])) conflict(patch.id, "History field changed: " + key);
      if (Object.hasOwn(after, key)) merged[key] = after[key];
      else delete merged[key];
    }
    checkStart(merged.start, merged.id, rules);
    changed = true;
    return Object.freeze({ id: patch.id, before: found, after: Object.freeze(merged) });
  });
  return changed ? Object.freeze(result) : patches;
}

/** Applies patches whose `before` states match the base. Returns the canonical list. */
export function applyMarkers(
  base: readonly Marker[] | undefined,
  patches: readonly MarkerPatch[],
): readonly Marker[] | undefined {
  if (!patches.length) return base;
  const byId = new Map((base ?? []).map((marker) => [marker.id, marker]));
  for (const { id, after } of patches) {
    if (after === undefined) byId.delete(id);
    else byId.set(id, after);
  }
  const list = [...byId.values()].sort(compareMarkers);
  return list.length ? Object.freeze(list) : undefined;
}

/** The first index whose marker starts at or after `tick` (or after it when `strict`). */
export function markerIndex(markers: readonly Marker[], tick: Tick, strict: boolean): number {
  let lo = 0;
  let hi = markers.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const start = markers[mid]?.start ?? Infinity;
    if (strict ? start <= tick : start < tick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
