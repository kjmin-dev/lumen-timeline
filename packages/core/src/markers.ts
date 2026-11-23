import type { Rules } from "./document.ts";
import type { PluginRegistry } from "./plugins.ts";
import type { JsonObject, JsonValue, Marker, MarkerCommand, MarkerPatch, Tick } from "./types.ts";
import { applyRecords, invertRecords, rebaseRecords, stagedPatches } from "./record-patches.ts";
import { freezeJson, isRecord, requireEdit, safeInteger, validId } from "./validation.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function compareMarkers(a: Marker, b: Marker): number {
  return a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// Snapshots share their frozen marker list until an edit replaces it, so one
// index serves every transaction that leaves the markers alone.
const indexes = new WeakMap<readonly Marker[], ReadonlyMap<string, Marker>>();
const maxEndIndexes = new WeakMap<readonly Marker[], Float64Array>();
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
export function parseMarker(
  value: JsonValue,
  ids: ReadonlySet<string>,
  maxDuration: Tick,
  plugins?: PluginRegistry,
): Marker {
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
    safeInteger(start) && start >= 0 && start <= maxDuration,
    "invalid-marker",
    id,
    "Marker lies outside the sequence",
  );
  const duration = marker["duration"];
  requireEdit(
    duration === undefined ||
      (safeInteger(duration) && duration > 0 && start + duration <= maxDuration),
    "invalid-marker",
    id,
    "Region marker duration must be positive and stay within the sequence",
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
  plugins?.validate("marker", id, extensions);
  return Object.freeze({
    ...marker,
    id,
    start,
    ...(duration === undefined ? {} : { duration }),
    ...(label === undefined ? {} : { label }),
    ...(color === undefined ? {} : { color }),
    ...(extensions === undefined ? {} : { extensions }),
  });
}

function checkBounds(start: Tick, duration: Tick | undefined, id: string, rules: Rules): void {
  requireEdit(
    safeInteger(start) && start >= 0 && start <= rules.duration,
    "invalid-range",
    id,
    "Marker lies outside the sequence",
  );
  if (duration !== undefined) {
    requireEdit(
      safeInteger(duration) && duration > 0 && start + duration <= rules.duration,
      "invalid-range",
      id,
      "Region marker lies outside the sequence",
    );
  }
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
  stage(command: MarkerCommand, rules: Rules, plugins?: PluginRegistry): void {
    if (command.type === "add-marker") {
      const { id } = command;
      requireEdit(
        validId(id) && this.get(id) === undefined,
        "invalid-marker",
        id,
        "A new marker requires an unused ID",
      );
      const { start, duration, label, color, extensions: rawExt } = command;
      checkBounds(start, duration, id, rules);
      requireEdit(
        optionalText(label) && optionalText(color),
        "invalid-marker",
        id,
        "Expected a string label and color",
      );
      let extensions: JsonObject | undefined;
      if (rawExt !== undefined) {
        const frozen = freezeJson(rawExt);
        requireEdit(isRecord(frozen), "invalid-marker", id, "Expected an extensions map");
        plugins?.validate("marker", id, frozen);
        extensions = frozen;
      }
      this.staged.set(
        id,
        Object.freeze({
          id,
          start,
          ...(duration === undefined ? {} : { duration }),
          ...(label === undefined ? {} : { label }),
          ...(color === undefined ? {} : { color }),
          ...(extensions === undefined ? {} : { extensions }),
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
      checkBounds(start, marker.duration, marker.id, rules);
      this.staged.set(marker.id, Object.freeze({ ...marker, start }));
    } else if (command.type === "update-marker") {
      const { label, color, duration, extensions: rawExt } = command;
      requireEdit(
        (label === undefined || label === null || typeof label === "string") &&
          (color === undefined || color === null || typeof color === "string"),
        "invalid-marker",
        marker.id,
        "Expected a string label and color",
      );
      const next: Mutable<Marker> = { ...marker };
      if (label === null) delete next.label;
      else if (label !== undefined) next.label = label;
      if (color === null) delete next.color;
      else if (color !== undefined) next.color = color;
      if (duration === null) delete next.duration;
      else if (duration !== undefined) {
        requireEdit(
          safeInteger(duration) && duration > 0,
          "invalid-marker",
          marker.id,
          "Region marker duration must be a positive safe integer",
        );
        checkBounds(marker.start, duration, marker.id, rules);
        next.duration = duration;
      }
      if (rawExt === null) delete next.extensions;
      else if (rawExt !== undefined) {
        const frozen = freezeJson(rawExt);
        requireEdit(isRecord(frozen), "invalid-marker", marker.id, "Expected an extensions map");
        plugins?.validate("marker", marker.id, frozen);
        next.extensions = frozen;
      }
      this.staged.set(marker.id, Object.freeze(next));
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
  plugins?: PluginRegistry,
): readonly MarkerPatch[] {
  const current = markersById(base);
  return rebaseRecords(
    patches,
    (id) => current.get(id),
    (marker) => {
      checkBounds(marker.start, marker.duration, marker.id, rules);
      plugins?.validate("marker", marker.id, marker.extensions);
    },
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

function markerEnds(markers: readonly Marker[]): Float64Array {
  const cached = maxEndIndexes.get(markers);
  if (cached) return cached;
  const ends = new Float64Array(markers.length);
  function build(lo: number, hi: number): number {
    if (lo >= hi) return -Infinity;
    const mid = Math.floor((lo + hi) / 2);
    const marker = markers[mid];
    const end = marker ? marker.start + (marker.duration ?? 0) : -Infinity;
    ends[mid] = Math.max(end, build(lo, mid), build(mid + 1, hi));
    return ends[mid];
  }
  build(0, markers.length);
  maxEndIndexes.set(markers, ends);
  return ends;
}

/**
 * Returns every marker intersecting `[start, end)`: point markers with
 * `start <= m.start < end` and region markers with `m.start < end` and
 * `m.start + m.duration > start`, in snapshot order.
 */
export function markersIntersecting(
  markers: readonly Marker[],
  start: Tick,
  end: Tick,
): readonly Marker[] {
  if (!markers.length || start >= end) return Object.freeze([]);
  const ends = markerEnds(markers);
  const found: Marker[] = [];
  const walk = (lo: number, hi: number): void => {
    if (lo >= hi) return;
    const mid = Math.floor((lo + hi) / 2);
    const subEnd = ends[mid] ?? -Infinity;
    const head = markers[lo];
    if (subEnd < start || !head || head.start >= end) return;
    walk(lo, mid);
    const marker = markers[mid];
    if (!marker || marker.start >= end) return;
    if (
      marker.duration === undefined ? marker.start >= start : marker.start + marker.duration > start
    )
      found.push(marker);
    walk(mid + 1, hi);
  };
  walk(0, markers.length);
  return Object.freeze(found);
}
