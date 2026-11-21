import { defined } from "./invariant.ts";
import { isArray, requireEdit, safeInteger } from "./validation.ts";
import { visitRange } from "./interval-index.ts";
import { markerIndex } from "./markers.ts";
import { planAudio } from "./playback.ts";
import type {
  AudioPlan,
  Clip,
  ClipQueryOptions,
  Marker,
  ProjectSnapshot,
  ReadHandle,
  TakeCatalog,
  Tick,
  TickRange,
  Track,
} from "./types.ts";

export interface ReadRegistry {
  pin(snapshot: ProjectSnapshot, layout: ReadonlyMap<string, readonly Clip[]>): void;
  read(snapshot: ProjectSnapshot): ReadHandle;
}

function validateTick(tick: Tick): void {
  requireEdit(safeInteger(tick), "invalid-range", null, "Expected an integer tick");
}

function validate(range: TickRange): void {
  requireEdit(
    Number.isSafeInteger(range?.start) &&
      Number.isSafeInteger(range?.end) &&
      range.start <= range.end,
    "invalid-range",
    null,
    "Expected ordered integer range boundaries",
  );
}

// Weak keys allow retained snapshots to pin their layout without retaining
// every revision for the lifetime of the editor.
export function readRegistry(tracks: readonly Track[]): ReadRegistry {
  const layouts = new WeakMap<ProjectSnapshot, ReadonlyMap<string, readonly Clip[]>>();
  const handles = new WeakMap<ProjectSnapshot, ReadHandle>();
  const order = new Map(tracks.map((track, index) => [track.id, index]));
  return {
    pin(snapshot, layout) {
      layouts.set(snapshot, layout);
    },
    read(snapshot) {
      const layout = layouts.get(snapshot);
      requireEdit(layout, "foreign-snapshot", null, "Read requires a snapshot from this editor");
      const cached = handles.get(snapshot);
      if (cached) return cached;
      const handle: ReadHandle = Object.freeze({
        revision: snapshot.revision,
        clipsIn(range: TickRange, { trackIds }: ClipQueryOptions = {}): readonly Clip[] {
          validate(range);
          const found: Clip[] = [];
          const visit = (id: string): number =>
            visitRange(layout.get(id), range.start, range.end, (clip) => found.push(clip));
          if (trackIds === undefined) {
            for (const track of tracks) visit(track.id);
          } else {
            requireEdit(isArray(trackIds), "invalid-selection", null, "Expected track IDs");
            const ids = [...new Set(trackIds)];
            for (const id of ids)
              requireEdit(order.has(id), "missing-track", id, "Unknown query track");
            // Every ID was checked against `order` above.
            const rank = (id: string): number => defined(order.get(id), "track order");
            for (const id of ids.sort((a, b) => rank(a) - rank(b))) visit(id);
          }
          return Object.freeze(found);
        },
        planAudio(range: TickRange, catalog: TakeCatalog): AudioPlan {
          validate(range);
          return planAudio(snapshot.revision, tracks, range, catalog, (id, emit) =>
            visitRange(layout.get(id), range.start, range.end, emit),
          );
        },
        markersIn(range: TickRange): readonly Marker[] {
          validate(range);
          const markers = snapshot.markers ?? [];
          return Object.freeze(
            markers.slice(
              markerIndex(markers, range.start, false),
              markerIndex(markers, range.end, false),
            ),
          );
        },
        nextMarker(tick: Tick): Marker | undefined {
          validateTick(tick);
          const markers = snapshot.markers ?? [];
          return markers[markerIndex(markers, tick, true)];
        },
        previousMarker(tick: Tick): Marker | undefined {
          validateTick(tick);
          const markers = snapshot.markers ?? [];
          return markers[markerIndex(markers, tick, false) - 1];
        },
      });
      handles.set(snapshot, handle);
      return handle;
    },
  };
}
