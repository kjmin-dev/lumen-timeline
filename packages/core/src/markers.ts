import type { Rules } from "./document.ts";
import type { JsonValue, Marker, MarkerCommand, MarkerPatch, Tick } from "./types.ts";
import { applyRecords, invertRecords, rebaseRecords, stagedPatches } from "./record-patches.ts";
import { isRecord, requireEdit, safeInteger, validId } from "./validation.ts";

export function compareMarkers(a: Marker, b: Marker): number {
  return a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// Snapshots share their frozen marker list until an edit replaces it, so one
// index serves every transaction that leaves the markers alone.
const indexes = new WeakMap<readonly Marker[], ReadonlyMap<string, Marker>>();
const noMarkers: ReadonlyMap<string, Marker> = new Map();

/** A snapshot's markers by ID. */
function markersById(list: readonly Marker[] | undefined): ReadonlyMap<string, Marker> {
  if (!list?.length) return noMarkers;
  let byId = indexes.get(list);
  if (!byId) {
    byId = new Map(list.map((marker) => [marker.id, marker]));
    indexes.set(list, byId);
  }
  return byId;
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
    this.byId = markersById(base);
    this.staged = new Map();
  }

  get(id: string): Marker | undefined {
    return this.staged.has(id) ? this.staged.get(id) : this.byId.get(id);
  }

  // The editor fills in a missing ID before staging an addition.
  stage(command: MarkerCommand, rules: Rules): void {
    if (command.type === "add-marker") {
      const { id } = command;
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
    return stagedPatches((id) => this.byId.get(id), this.staged);
  }
}

export function invertMarkers(patches: readonly MarkerPatch[]): readonly MarkerPatch[] {
  return invertRecords(patches);
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
  const current = markersById(base);
  return rebaseRecords(
    patches,
    (id) => current.get(id),
    (marker) => checkStart(marker.start, marker.id, rules),
    "marker",
  );
}

/** Applies patches whose `before` states match the base. Returns the canonical list. */
export function applyMarkers(
  base: readonly Marker[] | undefined,
  patches: readonly MarkerPatch[],
): readonly Marker[] | undefined {
  if (!patches.length) return base;
  const byId = applyRecords(markersById(base), patches);
  if (!byId.size) return undefined;
  const list = Object.freeze([...byId.values()].sort(compareMarkers));
  indexes.set(list, byId);
  return list;
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
