import { defined } from "./invariant.ts";
import { isArray, requireEdit, safeInteger } from "./validation.ts";
import { visitRange } from "./interval-index.ts";
import { markerIndex, markersIntersecting } from "./markers.ts";
import { planAudio } from "./playback.ts";
import { findTake } from "./takes.ts";
import type {
  AudioPlan,
  Clip,
  ClipQueryOptions,
  Marker,
  PlanOptions,
  ProjectSnapshot,
  ReadHandle,
  StreamCatalog,
  Take,
  Tick,
  TickRange,
  Track,
} from "./types.ts";

export interface ReadRegistry {
  /**
   * Keeps what a snapshot's reads need: its clips per track in start order,
   * and each clip's position in `snapshot.clips`. The editor shares both with
   * the revisions an edit leaves them unchanged in.
   */
  pin(
    snapshot: ProjectSnapshot,
    layout: ReadonlyMap<string, readonly Clip[]>,
    positions: ReadonlyMap<string, number>,
  ): void;
  read(snapshot: ProjectSnapshot): ReadHandle;
}

interface Pinned {
  readonly layout: ReadonlyMap<string, readonly Clip[]>;
  readonly positions: ReadonlyMap<string, number>;
}

// A clip lists the same takes in every revision that holds both that clip and
// that take list, so the lists a view or planner asks for again and again are
// made once and outlive an edit elsewhere.
const takeLists = new WeakMap<readonly Take[], WeakMap<Clip, readonly Take[]>>();
const trackOrders = new WeakMap<readonly Track[], ReadonlyMap<string, number>>();
const noTakes: readonly Take[] = Object.freeze([]);

function orderOf(tracks: readonly Track[]): ReadonlyMap<string, number> {
  let order = trackOrders.get(tracks);
  if (!order) {
    order = new Map(tracks.map((track, index) => [track.id, index]));
    trackOrders.set(tracks, order);
  }
  return order;
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
export function readRegistry(): ReadRegistry {
  const pins = new WeakMap<ProjectSnapshot, Pinned>();
  const handles = new WeakMap<ProjectSnapshot, ReadHandle>();
  return {
    pin(snapshot, layout, positions) {
      pins.set(snapshot, { layout, positions });
    },
    read(snapshot) {
      const pinned = pins.get(snapshot);
      requireEdit(pinned, "foreign-snapshot", null, "Read requires a snapshot from this editor");
      const cached = handles.get(snapshot);
      if (cached) return cached;
      const { layout, positions } = pinned;
      const tracks = snapshot.tracks;
      const order = orderOf(tracks);
      // Built on first use, and only for a query that scans every clip.
      let listings: ReadonlyMap<string, readonly string[]> | undefined;
      const takeOf = (id: string): Take | undefined => findTake(snapshot.takes, id);
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
        planAudio(range: TickRange, catalog: StreamCatalog, options?: PlanOptions): AudioPlan {
          validate(range);
          return planAudio(
            snapshot.revision,
            tracks,
            range,
            catalog,
            (id, emit) => visitRange(layout.get(id), range.start, range.end, emit),
            takeOf,
            options,
          );
        },
        takesOf(clipId: string): readonly Take[] {
          const at = typeof clipId === "string" ? positions.get(clipId) : undefined;
          const clip = at === undefined ? undefined : snapshot.clips[at];
          requireEdit(clip, "missing-clip", clipId, "Clip does not exist");
          if (!clip.takeIds || !snapshot.takes) return noTakes;
          let listed = takeLists.get(snapshot.takes);
          if (!listed) {
            listed = new WeakMap();
            takeLists.set(snapshot.takes, listed);
          }
          let takes = listed.get(clip);
          if (!takes) {
            takes = Object.freeze(clip.takeIds.map((id) => defined(takeOf(id), "listed take")));
            listed.set(clip, takes);
          }
          return takes;
        },
        clipsListing(takeId: string): readonly string[] {
          const take = typeof takeId === "string" ? takeOf(takeId) : undefined;
          requireEdit(take, "missing-take", takeId, "Take does not exist");
          if (!listings) {
            const byTake = new Map<string, string[]>();
            for (const clip of snapshot.clips) {
              for (const id of clip.takeIds ?? []) {
                const ids = byTake.get(id);
                if (ids) ids.push(clip.id);
                else byTake.set(id, [clip.id]);
              }
            }
            listings = byTake;
          }
          return Object.freeze([...(listings.get(take.id) ?? [])]);
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
        regionsIn(range: TickRange): readonly Marker[] {
          validate(range);
          const markers = snapshot.markers ?? [];
          return markersIntersecting(markers, range.start, range.end);
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
