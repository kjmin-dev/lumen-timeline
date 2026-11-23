import {
  checkPlacement,
  issue,
  openProject,
  orderTrack,
  parseClipSource,
  validateClip,
} from "./document.ts";
import type { Rules, TrackLayout } from "./document.ts";
import { ClipDraft, applyClips, inverse, rebase } from "./clip-patches.ts";
import { difference } from "./diff.ts";
import { DataDraft, applyData, invertData, jsonEqual } from "./entity-data.ts";
import { expectClip, expectData } from "./expect.ts";
import { defined } from "./invariant.ts";
import { MarkerDraft, applyMarkers, invertMarkers, rebaseMarkers } from "./markers.ts";
import { createHistory } from "./history.ts";
import type { HistoryEntry } from "./history.ts";
import { createPluginRegistry } from "./plugins.ts";
import type { PluginRegistry } from "./plugins.ts";
import { parseReplay, replayOf } from "./replay.ts";
import type { Records } from "./replay.ts";
import { reportListenerError } from "./host.ts";
import { idAllocator } from "./ids.ts";
import { readRegistry } from "./read.ts";
import {
  TakeDraft,
  applyTakes,
  checkReferences,
  countReferences,
  invertTakes,
  parseCandidates,
  rebaseTakes,
  referenceDelta,
  remapsMedia,
  stagedDelta,
} from "./takes.ts";
import { splitClip } from "./time.ts";
import { TrackDraft, applyTracks, invertTrackPatches, rebaseTracks } from "./tracks.ts";
import { EditError, freezeJson, isArray, isRecord, requireEdit, validId } from "./validation.ts";
import type {
  AddClipCommand,
  AddMarkerCommand,
  AddTakeCommand,
  AddTrackCommand,
  AffectedInterval,
  Clip,
  ClipCommand,
  ClipPatch,
  CommitHistory,
  DispatchGate,
  EditCommand,
  EditCommit,
  EditFailure,
  Editor,
  EditOptions,
  EditorOptions,
  EditResult,
  EditTargets,
  EditUnchanged,
  GateDecision,
  GatedTransaction,
  ExpectClipCommand,
  ExpectDataCommand,
  HistoryState,
  JsonObject,
  MoveMarkerCommand,
  MoveCommand,
  PreviewCommand,
  PruneTakesCommand,
  PreviewResult,
  Project,
  ProjectSnapshot,
  RemoveClipCommand,
  RemoveDataCommand,
  RemoveMarkerCommand,
  RemoveTakeCommand,
  RemoveTrackCommand,
  ReorderTakesCommand,
  ReorderTracksCommand,
  ReplayCommand,
  RevisionOptions,
  SelectTakeCommand,
  SetDataCommand,
  SplitCommand,
  Track,
  TrackCommand,
  TrackPatch,
  TrimCommand,
  UpdateClipCommand,
  UpdateMarkerCommand,
  UpdateTakeCommand,
  UpdateTrackCommand,
} from "./types.ts";

// Distributes over unions, so each form of a command keeps its own fields.
type Arguments<C> = C extends unknown ? Omit<C, "type"> : never;

export interface Commands {
  addClip(args: Arguments<AddClipCommand>): AddClipCommand;
  removeClip(args: Arguments<RemoveClipCommand>): RemoveClipCommand;
  updateClip(args: Arguments<UpdateClipCommand>): UpdateClipCommand;
  addTrack(args: Arguments<AddTrackCommand>): AddTrackCommand;
  updateTrack(args: Arguments<UpdateTrackCommand>): UpdateTrackCommand;
  removeTrack(args: Arguments<RemoveTrackCommand>): RemoveTrackCommand;
  reorderTracks(args: Arguments<ReorderTracksCommand>): ReorderTracksCommand;
  addMarker(args: Arguments<AddMarkerCommand>): AddMarkerCommand;
  moveMarker(args: Arguments<MoveMarkerCommand>): MoveMarkerCommand;
  updateMarker(args: Arguments<UpdateMarkerCommand>): UpdateMarkerCommand;
  removeMarker(args: Arguments<RemoveMarkerCommand>): RemoveMarkerCommand;
  moveClips(args: Arguments<MoveCommand>): MoveCommand;
  trimClip(args: Arguments<TrimCommand>): TrimCommand;
  splitClip(args: Arguments<SplitCommand>): SplitCommand;
  setEntityData(args: Arguments<SetDataCommand>): SetDataCommand;
  removeEntityData(args: Arguments<RemoveDataCommand>): RemoveDataCommand;
  addTake(args: Arguments<AddTakeCommand>): AddTakeCommand;
  selectTake(args: Arguments<SelectTakeCommand>): SelectTakeCommand;
  removeTake(args: Arguments<RemoveTakeCommand>): RemoveTakeCommand;
  reorderTakes(args: Arguments<ReorderTakesCommand>): ReorderTakesCommand;
  updateTake(args: Arguments<UpdateTakeCommand>): UpdateTakeCommand;
  pruneTakes(args?: Arguments<PruneTakesCommand>): PruneTakesCommand;
  expectClip(args: Arguments<ExpectClipCommand>): ExpectClipCommand;
  expectData(args: Arguments<ExpectDataCommand>): ExpectDataCommand;
  replay(args: Arguments<ReplayCommand>): ReplayCommand;
}

export const commands: Readonly<Commands> = Object.freeze({
  addClip: (args) => ({ ...args, type: "add-clip" }),
  removeClip: (args) => ({ ...args, type: "remove-clip" }),
  updateClip: (args) => ({ ...args, type: "update-clip" }),
  addTrack: (args) => ({ ...args, type: "add-track" }),
  updateTrack: (args) => ({ ...args, type: "update-track" }),
  removeTrack: (args) => ({ ...args, type: "remove-track" }),
  reorderTracks: (args) => ({ ...args, type: "reorder-tracks" }),
  moveClips: (args) => ({ ...args, type: "move" }),
  trimClip: (args) => ({ ...args, type: "trim" }),
  splitClip: (args) => ({ ...args, type: "split" }),
  setEntityData: (args) => ({ ...args, type: "set-data" }),
  removeEntityData: (args) => ({ ...args, type: "remove-data" }),
  addMarker: (args) => ({ ...args, type: "add-marker" }),
  moveMarker: (args) => ({ ...args, type: "move-marker" }),
  updateMarker: (args) => ({ ...args, type: "update-marker" }),
  removeMarker: (args) => ({ ...args, type: "remove-marker" }),
  addTake: (args) => ({ ...args, type: "add-take" }),
  selectTake: (args) => ({ ...args, type: "select-take" }),
  removeTake: (args) => ({ ...args, type: "remove-take" }),
  reorderTakes: (args) => ({ ...args, type: "reorder-takes" }),
  updateTake: (args) => ({ ...args, type: "update-take" }),
  pruneTakes: (args) => ({ ...args, type: "prune-takes" }),
  expectClip: (args) => ({ ...args, type: "expect-clip" }),
  expectData: (args) => ({ ...args, type: "expect-data" }),
  replay: (args) => ({ ...args, type: "replay" }),
} satisfies Commands);

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface DocumentSubscriber {
  revision: number;
  update(document: ProjectSnapshot, result: EditCommit): void;
}

interface VersionedSubscriber<T> {
  readonly listen: (value: T) => void;
  version: number;
}

interface Notification {
  readonly result: EditCommit | null;
  readonly document: ProjectSnapshot;
  readonly state: HistoryState | null;
  readonly version: number;
  readonly selection: readonly string[] | null;
  readonly selectionVersion: number;
}

interface Geometry {
  readonly clips: readonly Clip[];
  readonly layout: TrackLayout;
  readonly positions: ReadonlyMap<string, number>;
}

function positions(clips: readonly Clip[]): Map<string, number> {
  const byId = new Map<string, number>();
  for (let index = 0; index < clips.length; index++)
    byId.set(defined(clips[index], "listed clip").id, index);
  return byId;
}

function intervals(clips: readonly Clip[]): readonly AffectedInterval[] {
  return Object.freeze(
    clips.map((clip) =>
      Object.freeze({
        clipId: clip.id,
        trackId: clip.trackId,
        start: clip.start,
        end: clip.start + clip.duration,
      }),
    ),
  );
}

/** What a transaction changes and the inverse that undoes it. */
interface Staged {
  readonly forward: Records;
  readonly backward: Records;
  /** The change in each take's listing count. */
  readonly delta: ReadonlyMap<string, number>;
}

const emptyTrackPatches: readonly TrackPatch[] = Object.freeze([]);

/** A history entry holding these records, as `forward` and their inverse. */
function entryOf(forward: Records, backward: Records): HistoryEntry {
  return {
    forward: forward.clips,
    inverse: backward.clips,
    data: forward.data,
    inverseData: backward.data,
    // Marker-free entries keep their former shape and logical size.
    ...(forward.markers.length
      ? { markers: forward.markers, inverseMarkers: backward.markers }
      : {}),
    ...(forward.takes.length ? { takes: forward.takes, inverseTakes: backward.takes } : {}),
    ...(forward.tracks?.length
      ? { tracks: forward.tracks, inverseTracks: backward.tracks ?? emptyTrackPatches }
      : {}),
    ...(forward.trackOrder || backward.trackOrder
      ? {
          ...(forward.trackOrder ? { trackOrder: forward.trackOrder } : {}),
          ...(backward.trackOrder ? { inverseTrackOrder: backward.trackOrder } : {}),
        }
      : {}),
  };
}

/** The records a transaction changes, as a gate or a held result names them. */
function targetsOf(changedIds: readonly string[], forward: Records): EditTargets {
  const entities = new Map(forward.data.map((p) => [JSON.stringify([p.scope, p.id]), p]));
  const trackIds = new Set((forward.tracks ?? []).map((p) => p.id));
  if (forward.trackOrder) for (const id of forward.trackOrder) trackIds.add(id);
  return Object.freeze({
    clipIds: changedIds,
    markerIds: Object.freeze(forward.markers.map((p) => p.id)),
    takeIds: Object.freeze(forward.takes.map((p) => p.id)),
    ...(trackIds.size ? { trackIds: Object.freeze([...trackIds]) } : {}),
    entities: Object.freeze(
      [...entities.values()].map(({ scope, id }) => Object.freeze({ scope, id })),
    ),
  });
}

function decided(decision: GateDecision): GateDecision {
  if (decision === "commit" || decision === "hold") return decision;
  if (typeof decision === "object" && decision !== null && typeof decision.readOnly === "string")
    return decision;
  throw new TypeError("A gate returns commit, hold or { readOnly }");
}

function recordsOf(entry: HistoryEntry): { forward: Records; backward: Records } {
  return {
    forward: {
      clips: entry.forward,
      data: entry.data,
      markers: entry.markers ?? [],
      takes: entry.takes ?? [],
      ...(entry.tracks ? { tracks: entry.tracks } : {}),
      ...(entry.trackOrder ? { trackOrder: entry.trackOrder } : {}),
    },
    backward: {
      clips: entry.inverse,
      data: entry.inverseData,
      markers: entry.inverseMarkers ?? [],
      takes: entry.inverseTakes ?? [],
      ...(entry.inverseTracks ? { tracks: entry.inverseTracks } : {}),
      ...(entry.inverseTrackOrder ? { trackOrder: entry.inverseTrackOrder } : {}),
    },
  };
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function isTrackCommand(command: EditCommand | null): command is TrackCommand {
  return (
    command !== null &&
    (command.type === "add-track" ||
      command.type === "update-track" ||
      command.type === "remove-track" ||
      command.type === "reorder-tracks")
  );
}

export function createEditor({ project, history: limits, actor, plugins }: EditorOptions): Editor {
  requireEdit(actor === undefined || validId(actor), "invalid-id", actor, "Expected an actor name");
  const registry: PluginRegistry = createPluginRegistry(plugins);
  const opened = openProject(project, registry);
  let { snapshot, rules, byTrack } = opened;
  const ids = idAllocator(actor, snapshot);
  let byId = opened.positions ?? positions(snapshot.clips);
  const reads = readRegistry();
  // Keeps the current snapshot readable, here and by an editor that opens it.
  function pin(): void {
    reads.pin(snapshot, byTrack, byId);
    issue(snapshot, byTrack, byId);
  }
  pin();
  // How many clips of the current snapshot list each take, counted when a
  // transaction first asks. An editor that only follows another's snapshots
  // never does.
  let takeCounts: Map<string, number> | undefined;
  const listings = (): Map<string, number> => (takeCounts ??= countReferences(snapshot.clips));
  // Counts never taken need no upkeep: a later transaction takes them from its own clips.
  function recount(delta: ReadonlyMap<string, number>): void {
    if (!takeCounts) return;
    for (const [id, change] of delta) {
      const count = (takeCounts.get(id) ?? 0) + change;
      if (count) takeCounts.set(id, count);
      else takeCounts.delete(id);
    }
  }
  const history = createHistory(limits);
  const subscribers = new Set<DocumentSubscriber>();
  const historySubscribers = new Set<VersionedSubscriber<HistoryState>>();
  const selectionSubscribers = new Set<VersionedSubscriber<readonly string[]>>();
  let selection: readonly string[] = Object.freeze([]);
  let selectionVersion = 0;
  let historyVersion = 0;
  const notifications: Notification[] = [];
  let notifying = false;
  let disposed = false;
  let gate: DispatchGate | null = null;
  let gating = false;
  // The history entry each commit recorded, or moved by undo or redo.
  // A rebased commit keeps the kind of the commit it replays, so an undo's
  // entry stays an undo's however many times it is rebased.
  const entries = new WeakMap<
    EditCommit,
    { readonly entry: HistoryEntry; readonly kind: "record" | "undo" | "redo" }
  >();

  // Fills in every ID a command would otherwise leave the editor to generate,
  // so the commands of a commit replay to the same IDs in another editor.
  function withIds(
    command: EditCommand | null,
    clips: ClipDraft,
    markers: MarkerDraft,
    takes: TakeDraft,
    tracks: TrackDraft,
  ): EditCommand | null {
    if (command?.type === "split") return splitRecord(command, clips);
    if (
      command?.type === "add-clip" &&
      typeof command.clip === "object" &&
      command.clip !== null &&
      command.clip.id === undefined
    )
      return Object.freeze({
        ...command,
        clip: Object.freeze({ ...command.clip, id: ids.next((id) => clips.get(id) !== undefined) }),
      });
    if (
      command?.type === "add-track" &&
      typeof command.track === "object" &&
      command.track !== null &&
      command.track.id === undefined
    )
      return Object.freeze({
        ...command,
        track: Object.freeze({
          ...command.track,
          id: ids.next((id) => tracks.get(id) !== undefined),
        }),
      });
    if (command?.type === "add-marker" && command.id === undefined)
      return Object.freeze({ ...command, id: ids.next((id) => markers.get(id) !== undefined) });
    const takeTaken = (id: string): boolean => takes.get(id) !== undefined;
    if (
      command?.type === "add-take" &&
      typeof command.take === "object" &&
      command.take !== null &&
      command.take.id === undefined
    )
      return Object.freeze({
        ...command,
        take: Object.freeze({ ...command.take, id: ids.next(takeTaken) }),
      });
    if (
      command?.type === "update-take" &&
      command.clipIds !== undefined &&
      command.newId === undefined
    )
      return Object.freeze({ ...command, newId: ids.next(takeTaken) });
    return command;
  }

  // A split is recorded by content position, so a replay after a concurrent
  // move cuts the same point of the clip's content. A command that staging will
  // reject is recorded as given.
  function splitRecord(command: SplitCommand, clips: ClipDraft): SplitCommand {
    const clip = validId(command.clipId) ? clips.get(command.clipId) : undefined;
    const converts = command.atContent === undefined && clip && Number.isSafeInteger(command.at);
    if (!converts && command.rightId !== undefined) return command;
    const rightId = command.rightId ?? ids.next((id) => clips.get(id) !== undefined);
    if (!converts) return Object.freeze({ ...command, rightId });
    const atContent = command.at - clip.start + clip.contentIn;
    return Object.freeze({ type: "split", clipId: command.clipId, atContent, rightId });
  }

  // The current version of a clip that take commands may edit.
  function editable(draft: ClipDraft, activeRules: () => Rules): (id: string) => Clip {
    return (id) => {
      const clip = validId(id) ? draft.get(id) : undefined;
      requireEdit(clip, "missing-clip", id, "Clip does not exist");
      requireEdit(
        !defined(activeRules().tracks.get(clip.trackId), "clip track").locked,
        "locked-track",
        clip.trackId,
        "Track is locked",
      );
      return clip;
    };
  }

  function stageClip(
    command: ClipCommand | null,
    draft: ClipDraft,
    activeRules: Rules,
    takes?: TakeDraft,
  ): void {
    const type = command?.type;
    requireEdit(
      command !== null &&
        (type === "move" ||
          type === "trim" ||
          type === "split" ||
          type === "add-clip" ||
          type === "remove-clip" ||
          type === "update-clip"),
      "unknown-command",
      null,
      "Unknown clip command",
    );
    if (type === "add-clip") {
      const input = command.clip;
      requireEdit(
        typeof input === "object" && input !== null && !isArray(input),
        "invalid-clip",
        null,
        "Expected a clip object",
      );
      const id: unknown = Reflect.get(input, "id");
      requireEdit(
        validId(id) && draft.get(id) === undefined,
        "invalid-clip",
        id,
        "A new clip requires an unused ID",
      );
      if (command.after !== undefined) {
        requireEdit(
          validId(command.after) && draft.get(command.after) !== undefined,
          "missing-clip",
          command.after,
          "Reference clip does not exist",
        );
      }
      const trackId: unknown = Reflect.get(input, "trackId");
      const track = typeof trackId === "string" ? activeRules.tracks.get(trackId) : undefined;
      requireEdit(track, "missing-track", trackId, "Track does not exist");
      requireEdit(!track.locked, "locked-track", track.id, "Track is locked");
      const rawContentIn: unknown = Reflect.get(input, "contentIn");
      const contentIn = rawContentIn === undefined ? 0 : rawContentIn;
      const rawKind: unknown = Reflect.get(input, "kind");
      const rawStart: unknown = Reflect.get(input, "start");
      const rawDuration: unknown = Reflect.get(input, "duration");
      const rawBounds: unknown = Reflect.get(input, "contentBounds");
      const rawName: unknown = Reflect.get(input, "name");
      const rawColor: unknown = Reflect.get(input, "color");
      const rawSource: unknown = Reflect.get(input, "source");
      const rawTakeIds: unknown = Reflect.get(input, "takeIds");
      const rawActiveTakeId: unknown = Reflect.get(input, "activeTakeId");
      const rawContinuityId: unknown = Reflect.get(input, "continuityId");
      const rawExt: unknown = Reflect.get(input, "extensions");
      requireEdit(
        rawName === undefined || typeof rawName === "string",
        "invalid-clip",
        id,
        "Expected a string name",
      );
      requireEdit(
        rawColor === undefined || typeof rawColor === "string",
        "invalid-clip",
        id,
        "Expected a string color",
      );
      requireEdit(
        (rawActiveTakeId === undefined ||
          rawActiveTakeId === null ||
          typeof rawActiveTakeId === "string") &&
          (rawContinuityId === undefined ||
            rawContinuityId === null ||
            typeof rawContinuityId === "string"),
        "invalid-clip",
        id,
        "Expected string take and continuity IDs",
      );
      const frozenTakeIds = rawTakeIds === undefined ? undefined : freezeJson(rawTakeIds);
      const candidates = parseCandidates(id, frozenTakeIds, rawActiveTakeId);
      if (candidates && takes) {
        for (const takeId of candidates.takeIds)
          requireEdit(takes.get(takeId), "missing-take", takeId, "Take does not exist");
      }
      const source = parseClipSource(id, rawSource);
      let extensions: JsonObject | undefined;
      if (rawExt !== undefined) {
        const frozen = freezeJson(rawExt);
        requireEdit(isRecord(frozen), "invalid-clip", id, "Expected an extensions map");
        registry.validate("clip", id, frozen);
        extensions = frozen;
      }
      const placement = checkPlacement(
        {
          id,
          trackId: track.id,
          kind: rawKind,
          start: rawStart,
          duration: rawDuration,
          contentIn,
          contentBounds: rawBounds,
        },
        activeRules,
      );
      const added: Clip = Object.freeze({
        id,
        trackId: placement.trackId,
        kind: placement.kind,
        start: placement.start,
        duration: placement.duration,
        contentIn: placement.contentIn,
        ...(placement.contentBounds === undefined
          ? {}
          : { contentBounds: placement.contentBounds }),
        ...(source === undefined ? {} : { source }),
        ...candidates,
        ...(rawContinuityId === undefined ? {} : { continuityId: rawContinuityId }),
        ...(extensions === undefined ? {} : { extensions }),
        ...(rawName === undefined ? {} : { name: rawName }),
        ...(rawColor === undefined ? {} : { color: rawColor }),
      });
      draft.add(added, command.after);
      return;
    }
    if (type === "remove-clip") {
      const clip = validId(command.clipId) ? draft.get(command.clipId) : undefined;
      requireEdit(clip, "missing-clip", command.clipId, "Clip does not exist");
      requireEdit(
        !defined(activeRules.tracks.get(clip.trackId), "source track").locked,
        "locked-track",
        clip.trackId,
        "Track is locked",
      );
      draft.remove(clip);
      return;
    }
    if (type === "update-clip") {
      const clip = validId(command.clipId) ? draft.get(command.clipId) : undefined;
      requireEdit(clip, "missing-clip", command.clipId, "Clip does not exist");
      requireEdit(
        !defined(activeRules.tracks.get(clip.trackId), "source track").locked,
        "locked-track",
        clip.trackId,
        "Track is locked",
      );
      const next: Mutable<Clip> = { ...clip };
      if (command.name !== undefined) {
        requireEdit(
          command.name === null || typeof command.name === "string",
          "invalid-clip",
          clip.id,
          "Expected a string name",
        );
        if (command.name === null) delete next.name;
        else next.name = command.name;
      }
      if (command.color !== undefined) {
        requireEdit(
          command.color === null || typeof command.color === "string",
          "invalid-clip",
          clip.id,
          "Expected a string color",
        );
        if (command.color === null) delete next.color;
        else next.color = command.color;
      }
      if (command.kind !== undefined) {
        requireEdit(validId(command.kind), "incompatible-kind", clip.id, "Expected a clip kind");
        next.kind = command.kind;
      }
      if (command.contentBounds !== undefined) {
        if (command.contentBounds === null) delete next.contentBounds;
        else {
          const checked = checkPlacement(
            {
              id: clip.id,
              trackId: clip.trackId,
              kind: next.kind,
              start: clip.start,
              duration: clip.duration,
              contentIn: clip.contentIn,
              contentBounds: command.contentBounds,
            },
            activeRules,
          );
          if (checked.contentBounds !== undefined) next.contentBounds = checked.contentBounds;
        }
      }
      if (command.source !== undefined) {
        if (command.source === null) delete next.source;
        else {
          const source = parseClipSource(clip.id, command.source);
          if (source !== undefined) next.source = source;
        }
      }
      if (command.continuityId !== undefined) {
        requireEdit(
          command.continuityId === null || typeof command.continuityId === "string",
          "invalid-clip",
          clip.id,
          "Expected a string continuity ID",
        );
        if (command.continuityId === null) delete next.continuityId;
        else next.continuityId = command.continuityId;
      }
      if (command.extensions !== undefined) {
        if (command.extensions === null) delete next.extensions;
        else {
          const frozen = freezeJson(command.extensions);
          requireEdit(isRecord(frozen), "invalid-clip", clip.id, "Expected an extensions map");
          registry.validate("clip", clip.id, frozen);
          next.extensions = frozen;
        }
      }
      validateClip(next, activeRules);
      draft.replace(clip, [next]);
      return;
    }
    const ids = type === "move" ? command.clipIds : [command.clipId];
    requireEdit(
      isArray(ids) && ids.length > 0 && ids.every(validId) && new Set(ids).size === ids.length,
      "invalid-selection",
      null,
      "Expected distinct clip IDs",
    );
    if (type !== "split") {
      requireEdit(
        Number.isSafeInteger(command.delta),
        "invalid-delta",
        null,
        "Delta must be an integer tick count",
      );
    }

    for (const id of ids) {
      const clip = draft.get(id);
      requireEdit(clip, "missing-clip", id, "Clip does not exist");
      requireEdit(
        !defined(activeRules.tracks.get(clip.trackId), "source track").locked,
        "locked-track",
        clip.trackId,
        "Source track is locked",
      );

      let after: readonly Clip[];
      if (type === "move") {
        const trackId = command.trackId === undefined ? clip.trackId : command.trackId;
        const destination = activeRules.tracks.get(trackId);
        requireEdit(destination, "missing-track", trackId, "Destination does not exist");
        requireEdit(!destination.locked, "locked-track", trackId, "Destination is locked");
        if (command.delta === 0 && trackId === clip.trackId) continue;
        after = [{ ...clip, trackId, start: clip.start + command.delta }];
      } else if (type === "trim") {
        requireEdit(
          command.edge === "left" || command.edge === "right",
          "invalid-edge",
          id,
          "Choose left or right",
        );
        if (command.delta === 0) continue;
        after =
          command.edge === "left"
            ? [
                {
                  ...clip,
                  start: clip.start + command.delta,
                  duration: clip.duration - command.delta,
                  contentIn: clip.contentIn + command.delta,
                },
              ]
            : [{ ...clip, duration: clip.duration + command.delta }];
      } else {
        requireEdit(
          (command.at === undefined) !== (command.atContent === undefined),
          "invalid-range",
          id,
          "Name a split by either at or atContent",
        );
        const at =
          command.atContent === undefined
            ? command.at
            : clip.start + command.atContent - clip.contentIn;
        requireEdit(
          Number.isSafeInteger(at) && at > clip.start && at < clip.start + clip.duration,
          "invalid-range",
          id,
          "Split must be inside the clip",
        );
        const { rightId } = command;
        requireEdit(
          validId(rightId) && !draft.get(rightId),
          "invalid-id",
          rightId,
          "The right clip requires a new ID",
        );
        const [leftRaw, rightRaw] = splitClip(clip, at, rightId);
        if (Object.keys(clip.extensions ?? {}).length) {
          const splitExt = registry.split(clip, leftRaw, rightRaw, at);
          const withExt = (half: Clip, ext: JsonObject | undefined): Clip => {
            const copy: Mutable<Clip> = { ...half };
            if (ext === undefined) delete copy.extensions;
            else copy.extensions = ext;
            return copy;
          };
          after = [withExt(leftRaw, splitExt.left), withExt(rightRaw, splitExt.right)];
        } else {
          after = [leftRaw, rightRaw];
        }
      }
      for (const next of after) validateClip(next, activeRules);
      draft.replace(clip, after);
    }
  }

  function deliver(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      reportListenerError(error);
    }
  }

  function notify(
    result: EditCommit | null,
    historyChanged: boolean,
    selectionChanged = false,
  ): void {
    const state = historyChanged
      ? Object.freeze({
          undoDepth: history.undoDepth,
          redoDepth: history.redoDepth,
          estimatedBytes: history.estimatedBytes,
        })
      : null;
    if (state) historyVersion++;
    if (selectionChanged) selectionVersion++;
    notifications.push({
      result,
      document: snapshot,
      state,
      version: historyVersion,
      selection: selectionChanged ? selection : null,
      selectionVersion,
    });
    if (notifying) return;
    notifying = true;
    try {
      for (const event of notifications) {
        const { result, selection: changed, state } = event;
        if (result) {
          // oxlint-disable-next-line unicorn/no-useless-spread -- Listeners may subscribe or unsubscribe during delivery, so iterate a snapshot.
          for (const sub of [...subscribers]) {
            if (!subscribers.has(sub) || sub.revision >= event.document.revision) continue;
            sub.revision = event.document.revision;
            deliver(() => sub.update(event.document, result));
          }
        }
        if (changed) {
          // oxlint-disable-next-line unicorn/no-useless-spread -- Listeners may subscribe or unsubscribe during delivery, so iterate a snapshot.
          for (const sub of [...selectionSubscribers]) {
            if (!selectionSubscribers.has(sub) || sub.version >= event.selectionVersion) continue;
            sub.version = event.selectionVersion;
            deliver(() => sub.listen(changed));
          }
        }
        if (state) {
          // oxlint-disable-next-line unicorn/no-useless-spread -- Listeners may subscribe or unsubscribe during delivery, so iterate a snapshot.
          for (const sub of [...historySubscribers]) {
            if (!historySubscribers.has(sub) || sub.version >= event.version) continue;
            sub.version = event.version;
            deliver(() => sub.listen(state));
          }
        }
      }
    } finally {
      notifications.length = 0;
      notifying = false;
    }
  }

  // Staged clips passed validateClip, so every touched track exists in `activeRules`.
  function stageTracks(
    before: readonly Clip[],
    after: readonly Clip[],
    activeRules: Rules = rules,
    trackPatches: readonly TrackPatch[] = emptyTrackPatches,
  ): TrackLayout {
    const removedIds = new Set(before.map((clip) => clip.id));
    const touched = new Set(before.concat(after).map((clip) => clip.trackId));
    for (const patch of trackPatches) touched.add(patch.id);
    const layout = new Map<string, readonly Clip[]>(byTrack);
    const staged = new Map<string, Clip[]>();
    for (const trackId of touched) {
      if (!activeRules.tracks.has(trackId)) {
        const leftover = (byTrack.get(trackId) ?? []).filter((clip) => !removedIds.has(clip.id));
        requireEdit(
          leftover.length === 0,
          "track-not-empty",
          trackId,
          "Track still contains clips",
        );
        layout.delete(trackId);
        continue;
      }
      const lane = (byTrack.get(trackId) ?? []).filter((clip) => !removedIds.has(clip.id));
      staged.set(trackId, lane);
      layout.set(trackId, lane);
    }
    for (const clip of after) defined(staged.get(clip.trackId), "staged lane").push(clip);
    for (const [id, lane] of staged) {
      for (const clip of lane) validateClip(clip, activeRules);
      orderTrack(lane, activeRules, id);
    }
    return layout;
  }

  function prepareLayout(
    patches: readonly ClipPatch[],
    before: readonly Clip[],
    after: readonly Clip[],
    activeRules: Rules = rules,
    trackPatches: readonly TrackPatch[] = emptyTrackPatches,
  ): Geometry {
    const layout = stageTracks(before, after, activeRules, trackPatches);
    const clips = patches.length ? applyClips(snapshot.clips, patches, byId) : snapshot.clips;
    // Placement-only changes keep every ID at its existing array position.
    const structural = patches.some((p) => p.before === undefined || p.after === undefined);
    return { clips, layout, positions: structural ? positions(clips) : byId };
  }

  function checkRevision(options: RevisionOptions | undefined): void {
    requireEdit(!disposed, "disposed", null, "Editor has been disposed");
    requireEdit(
      options?.expectedRevision === undefined || options.expectedRevision === snapshot.revision,
      "stale-revision",
      null,
      "Project changed before the edit",
    );
  }

  function nextRevision(): number {
    const revision = snapshot.revision + 1;
    requireEdit(
      Number.isSafeInteger(revision),
      "revision-overflow",
      null,
      "Project revision exceeds safe integer range",
    );
    return revision;
  }

  function preview(
    input: PreviewCommand | readonly PreviewCommand[],
    options?: RevisionOptions,
  ): PreviewResult {
    try {
      checkRevision(options);
      const draft = new ClipDraft(snapshot.clips, byId);
      for (const command of isArray(input) ? input : [input]) {
        requireEdit(
          command?.type === "move" || command?.type === "trim",
          "unsupported-preview",
          null,
          "Preview supports placement moves and trims",
        );
        stageClip(command, draft, rules);
      }
      const patches = draft.patches();
      const placements = Object.freeze(patches.flatMap((p) => (p.after ? [p.after] : [])));
      if (patches.length) {
        stageTracks(
          patches.flatMap((p) => (p.before ? [p.before] : [])),
          placements,
        );
        nextRevision();
      }
      return { ok: true, revision: snapshot.revision, placements };
    } catch (error) {
      if (!(error instanceof EditError)) throw error;
      return {
        ok: false,
        revision: snapshot.revision,
        code: error.code,
        target: error.target,
        reason: error.message,
      };
    }
  }

  function rulesFor(tracks: readonly Track[]): Rules {
    return {
      tracks: new Map(tracks.map((track) => [track.id, track])),
      duration: rules.duration,
      minimum: rules.minimum,
    };
  }

  function inverseTrackOrder(
    baseTracks: readonly Track[],
    nextTracks: readonly Track[],
    inversePatches: readonly TrackPatch[],
  ): readonly string[] | undefined {
    const applied = applyTracks(nextTracks, inversePatches).map((t) => t.id);
    const baseIds = baseTracks.map((t) => t.id);
    return sameIds(applied, baseIds) ? undefined : Object.freeze(baseIds);
  }

  // Stages dispatched commands in order and returns what they change, adding
  // each command with its generated IDs filled in to `resolved`.
  function stage(list: readonly (EditCommand | null)[], resolved: EditCommand[]): Staged {
    const clips = new ClipDraft(snapshot.clips, byId);
    const fields = new DataDraft(snapshot.entityData);
    const markers = new MarkerDraft(snapshot.markers);
    const takes = new TakeDraft(snapshot.takes);
    const tracks = new TrackDraft(snapshot.tracks);
    const currentRules = (): Rules => ({
      tracks: tracks.map(),
      duration: rules.duration,
      minimum: rules.minimum,
    });
    for (const dispatched of list) {
      const command = withIds(dispatched, clips, markers, takes, tracks);
      if (command) resolved.push(command);
      if (command?.type === "set-data" || command?.type === "remove-data") fields.stage(command);
      else if (
        command?.type === "add-marker" ||
        command?.type === "move-marker" ||
        command?.type === "update-marker" ||
        command?.type === "remove-marker"
      )
        markers.stage(command, currentRules(), registry);
      else if (
        command?.type === "add-take" ||
        command?.type === "select-take" ||
        command?.type === "remove-take" ||
        command?.type === "reorder-takes" ||
        command?.type === "update-take" ||
        command?.type === "prune-takes"
      )
        takes.stage(command, {
          clips,
          editable: editable(clips, currentRules),
          listings: (id) => (listings().get(id) ?? 0) + (stagedDelta(clips).get(id) ?? 0),
          plugins: registry,
        });
      else if (isTrackCommand(command))
        tracks.stage(command, {
          hasClipsOn: (trackId) => clips.onTrack(trackId).length > 0,
          removeTrackClips: (trackId) => {
            for (const clip of clips.onTrack(trackId)) clips.remove(clip);
          },
          plugins: registry,
        });
      else if (command?.type === "expect-clip") expectClip(command, clips);
      else if (command?.type === "expect-data") expectData(command, fields);
      else if (command?.type === "replay")
        requireEdit(false, "invalid-replay", null, "A replay forms a transaction by itself");
      else stageClip(command, clips, currentRules(), takes);
    }
    const stagedTracks = tracks.result();
    const invTracks = invertTrackPatches(stagedTracks.patches);
    const nextTracks =
      stagedTracks.patches.length || stagedTracks.order
        ? applyTracks(snapshot.tracks, stagedTracks.patches, stagedTracks.order)
        : snapshot.tracks;
    const invOrder =
      stagedTracks.patches.length || stagedTracks.order
        ? inverseTrackOrder(snapshot.tracks, nextTracks, invTracks)
        : undefined;
    const forward: Records = {
      clips: clips.patches(),
      data: fields.patches(),
      markers: markers.patches(),
      takes: takes.patches(),
      ...(stagedTracks.patches.length ? { tracks: stagedTracks.patches } : {}),
      ...(stagedTracks.order ? { trackOrder: stagedTracks.order } : {}),
    };
    return {
      forward,
      backward: {
        clips: inverse(forward.clips),
        data: invertData(forward.data),
        markers: invertMarkers(forward.markers),
        takes: invertTakes(forward.takes),
        ...(invTracks.length ? { tracks: invTracks } : {}),
        ...(invOrder ? { trackOrder: invOrder } : {}),
      },
      delta: referenceDelta(forward.clips),
    };
  }

  // Rebases recorded changes onto the current document, as undo, redo and a
  // replay command apply them. `backward` holds the recorded inverses, which
  // stay in use where nothing needed rebasing.
  function replayed(forward: Records, backward?: Records): Staged {
    const trackPatches = forward.tracks?.length
      ? rebaseTracks(forward.tracks, snapshot.tracks, registry)
      : emptyTrackPatches;
    const nextTracks =
      trackPatches.length || forward.trackOrder
        ? applyTracks(snapshot.tracks, trackPatches, forward.trackOrder)
        : snapshot.tracks;
    const nextRules = trackPatches.length ? rulesFor(nextTracks) : rules;
    const clips = rebase(forward.clips, snapshot.clips, byId, (clip) => {
      validateClip(clip, nextRules);
      registry.validate("clip", clip.id, clip.extensions);
    });
    const markers = rebaseMarkers(forward.markers, snapshot.markers, nextRules, registry);
    const delta = referenceDelta(clips);
    const takes = rebaseTakes(
      forward.takes,
      snapshot.takes,
      (id) => (listings().get(id) ?? 0) + (delta.get(id) ?? 0) > 0,
      registry,
    );
    const invTracks =
      backward && trackPatches === (forward.tracks ?? emptyTrackPatches)
        ? (backward.tracks ?? emptyTrackPatches)
        : invertTrackPatches(trackPatches);
    const invOrder =
      trackPatches.length || forward.trackOrder
        ? inverseTrackOrder(snapshot.tracks, nextTracks, invTracks)
        : undefined;
    return {
      forward: {
        clips,
        data: forward.data,
        markers,
        takes,
        ...(trackPatches.length ? { tracks: trackPatches } : {}),
        ...(forward.trackOrder ? { trackOrder: forward.trackOrder } : {}),
      },
      backward: {
        clips: backward && clips === forward.clips ? backward.clips : inverse(clips),
        data: backward ? backward.data : invertData(forward.data),
        markers:
          backward && markers === forward.markers ? backward.markers : invertMarkers(markers),
        takes: backward && takes === forward.takes ? backward.takes : invertTakes(takes),
        ...(invTracks.length ? { tracks: invTracks } : {}),
        ...(invOrder ? { trackOrder: invOrder } : {}),
      },
      delta,
    };
  }

  function execute(
    input: EditCommand | readonly EditCommand[] | null,
    mode: "edit" | "undo" | "redo",
    options: EditOptions | undefined,
  ): EditResult {
    // A dispatched replay reports a rule its records break as a history conflict.
    let replaying = false;
    if (gating) throw new Error("A gate cannot edit the project");
    try {
      checkRevision(options);
      const rebases = mode === "edit" ? options?.rebases : undefined;
      // The entry undo or redo moves.
      let moving: HistoryEntry | undefined;
      let staged: Staged;
      const resolved: EditCommand[] = [];
      let policy: CommitHistory = options?.history === undefined ? "record" : options.history;
      if (mode === "edit") {
        requireEdit(
          policy === "record" || policy === "ignore",
          "invalid-history-policy",
          null,
          "Choose record or ignore for the transaction",
        );
        if (rebases) {
          requireEdit(
            options?.history === undefined,
            "invalid-history-policy",
            null,
            "A rebased transaction records into the entry of the commit it rebases",
          );
          policy = "ignore";
        }
        const list = isArray(input) ? input : [input];
        const replay = list.find((command) => command?.type === "replay");
        if (replay?.type === "replay") {
          requireEdit(
            list.length === 1,
            "invalid-replay",
            null,
            "A replay forms a transaction by itself",
          );
          replaying = true;
          staged = replayed(parseReplay(replay, rules, snapshot.tracks, registry));
        } else staged = stage(list, resolved);
        const { forward } = staged;
        if (
          !forward.clips.length &&
          !forward.data.length &&
          !forward.markers.length &&
          !forward.takes.length &&
          !forward.tracks?.length &&
          !forward.trackOrder
        )
          return { ok: true, revision: snapshot.revision, unchanged: true };
      } else {
        const entry = history.peek(mode);
        requireEdit(entry, "empty-history", null, "No history entry available");
        moving = entry;
        const recorded = recordsOf(entry);
        staged =
          mode === "undo"
            ? replayed(recorded.backward, recorded.forward)
            : replayed(recorded.forward, recorded.backward);
        policy = mode;
      }
      // Undo, redo and a replay record what they applied, so it replays elsewhere.
      if (mode !== "edit" || replaying) resolved.push(replayOf(staged.forward));
      const {
        forward: {
          clips: patches,
          data,
          markers: markerPatches,
          takes: takePatches,
          tracks: trackPatches = emptyTrackPatches,
          trackOrder,
        },
        backward: {
          clips: inverses,
          data: inverseData,
          markers: inverseMarkerPatches,
          takes: inverseTakePatches,
          tracks: inverseTrackPatches = emptyTrackPatches,
        },
        delta,
      } = staged;

      const trackList =
        trackPatches.length || trackOrder
          ? applyTracks(snapshot.tracks, trackPatches, trackOrder)
          : snapshot.tracks;
      const nextRules = trackPatches.length ? rulesFor(trackList) : rules;
      const before = patches.flatMap((p) => (p.before ? [p.before] : []));
      const after = patches.flatMap((p) => (p.after ? [p.after] : []));
      const geometry =
        patches.length || trackPatches.length
          ? prepareLayout(patches, before, after, nextRules, trackPatches)
          : null;
      const entityData = applyData(snapshot.entityData, data);
      const markerList = applyMarkers(snapshot.markers, markerPatches);
      const takeList = applyTakes(snapshot.takes, takePatches);
      const counted = (id: string): number => (listings().get(id) ?? 0) + (delta.get(id) ?? 0);
      checkReferences(after, takePatches, takeList, counted);
      const clipList = geometry?.clips ?? snapshot.clips;
      // Clips that list a remapped take play different media without a patch of their own.
      const remapped = new Set(takePatches.filter(remapsMedia).map((p) => p.id));
      const patchedIds = new Set(after.map((c) => c.id));
      const relisted = remapped.size
        ? clipList.filter(
            (clip) =>
              !patchedIds.has(clip.id) && (clip.takeIds ?? []).some((id) => remapped.has(id)),
          )
        : [];
      const revision = nextRevision();
      const oldIds = new Set(before.map((c) => c.id));
      const result: EditCommit = Object.freeze({
        ok: true,
        revision,
        history: policy,
        clipPatches: patches,
        inverseClipPatches: inverses,
        dataPatches: data,
        inverseDataPatches: inverseData,
        changedIds: Object.freeze([
          ...new Set([...oldIds, ...after.map((c) => c.id), ...relisted.map((c) => c.id)]),
        ]),
        createdIds: Object.freeze(after.filter((c) => !oldIds.has(c.id)).map((c) => c.id)),
        affected: Object.freeze({
          before: intervals([...before, ...relisted]),
          after: intervals([...after, ...relisted]),
        }),
        markerPatches,
        inverseMarkerPatches,
        takePatches,
        inverseTakePatches,
        trackPatches,
        inverseTrackPatches,
        commands: Object.freeze(resolved),
      });
      if (gate) {
        const transaction: GatedTransaction = Object.freeze({
          history: policy,
          commands: result.commands,
          targets: targetsOf(result.changedIds, staged.forward),
          revision,
        });
        let decision: GateDecision;
        gating = true;
        try {
          decision = decided(gate(transaction));
        } finally {
          gating = false;
        }
        if (decision === "hold")
          return Object.freeze({
            ok: false,
            held: true,
            code: "held",
            revision: snapshot.revision,
            target: null,
            reason: "The transaction is held",
            history: policy,
            commands: transaction.commands,
            targets: transaction.targets,
          });
        if (decision !== "commit")
          return {
            ok: false,
            revision: snapshot.revision,
            code: "read-only",
            target: decision.readOnly,
            reason: "The project is read-only: " + decision.readOnly,
          };
      }
      const next: Mutable<ProjectSnapshot> = {
        ...snapshot,
        revision,
        tracks: trackList,
        clips: clipList,
      };
      if (entityData === undefined) delete next.entityData;
      else next.entityData = entityData;
      if (markerList === undefined) delete next.markers;
      else next.markers = markerList;
      if (takeList === undefined) delete next.takes;
      else next.takes = takeList;

      // Validation, conflict checks, staging and the gate finish before any observable write.
      let amended = false;
      if (moving) {
        const kind = mode === "undo" ? "undo" : "redo";
        history.advance(kind);
        entries.set(result, { entry: moving, kind });
      } else if (rebases) {
        // The entry keeps its direction: an undo's entry redoes the inverse.
        const link = entries.get(rebases);
        const stored =
          link &&
          history.amend(
            link.entry,
            link.kind === "undo"
              ? entryOf(staged.backward, staged.forward)
              : entryOf(staged.forward, staged.backward),
          );
        if (link && stored) {
          entries.set(result, { entry: stored, kind: link.kind });
          amended = true;
        }
      } else if (policy === "record") {
        const stored = history.record(entryOf(staged.forward, staged.backward));
        if (stored) entries.set(result, { entry: stored, kind: "record" });
      }
      recount(delta);
      rules = nextRules;
      if (geometry) {
        byId = geometry.positions;
        byTrack = geometry.layout;
      }
      snapshot = Object.freeze(next);
      pin();
      const pruned = geometry !== null && selection.some((id) => !byId.has(id));
      if (pruned) selection = Object.freeze(selection.filter((id) => byId.has(id)));
      notify(
        result,
        amended || (policy !== "ignore" && history.undoDepth + history.redoDepth > 0),
        pruned,
      );
      return result;
    } catch (error) {
      if (!(error instanceof EditError)) throw error;
      const conflict =
        (mode !== "edit" || replaying) &&
        [
          "overlap",
          "source-bounds",
          "invalid-range",
          "missing-take",
          "invalid-take",
          "listed-take",
          "missing-track",
          "track-not-empty",
          "incompatible-kind",
          "invalid-extension",
        ].includes(error.code);
      return {
        ok: false,
        revision: snapshot.revision,
        code: conflict ? "history-conflict" : error.code,
        target: error.target,
        reason: error.message,
      };
    }
  }

  function replace(input: Project): EditCommit | EditUnchanged | EditFailure {
    if (gating) throw new Error("A gate cannot edit the project");
    try {
      requireEdit(!disposed, "disposed", null, "Editor has been disposed");
      const opened = openProject(input, registry);
      const target = opened.snapshot;
      const currentId = snapshot["id"];
      const targetId = target["id"];
      requireEdit(
        target.duration === snapshot.duration &&
          target.minClipDuration === snapshot.minClipDuration &&
          target.timebase === snapshot.timebase &&
          (currentId === undefined || targetId === undefined || currentId === targetId),
        "foreign-snapshot",
        null,
        "The snapshot belongs to another project",
      );
      const forward = difference(snapshot, target);
      // A patch means a difference, so only snapshots without one are compared
      // whole: they may still differ in the order of their clips or in a field
      // the editor does not interpret.
      if (
        !forward.clips.length &&
        !forward.data.length &&
        !forward.markers.length &&
        !forward.takes.length &&
        !forward.tracks?.length &&
        !forward.trackOrder
      ) {
        const { revision: _current, ...current } = snapshot;
        const { revision: _adopted, ...adopted } = target;
        if (jsonEqual(current, adopted))
          return { ok: true, revision: snapshot.revision, unchanged: true };
      }
      const trackPatches = forward.tracks ?? emptyTrackPatches;
      const inverseTrackPatches = invertTrackPatches(trackPatches);
      const backward: Records = {
        clips: inverse(forward.clips),
        data: invertData(forward.data),
        markers: invertMarkers(forward.markers),
        takes: invertTakes(forward.takes),
        ...(inverseTrackPatches.length ? { tracks: inverseTrackPatches } : {}),
      };
      const before = forward.clips.flatMap((p) => (p.before ? [p.before] : []));
      const after = forward.clips.flatMap((p) => (p.after ? [p.after] : []));
      // Clips that list a remapped take play different media without a patch of their own.
      const remapped = new Set(forward.takes.filter(remapsMedia).map((p) => p.id));
      const patchedIds = new Set(after.map((c) => c.id));
      const relisted = remapped.size
        ? target.clips.filter(
            (clip) =>
              !patchedIds.has(clip.id) && (clip.takeIds ?? []).some((id) => remapped.has(id)),
          )
        : [];
      // The revision only moves forward.
      const revision = Math.max(nextRevision(), target.revision);
      const oldIds = new Set(before.map((c) => c.id));
      const result: EditCommit = Object.freeze({
        ok: true,
        revision,
        history: "replace",
        clipPatches: forward.clips,
        inverseClipPatches: backward.clips,
        dataPatches: forward.data,
        inverseDataPatches: backward.data,
        changedIds: Object.freeze([
          ...new Set([...oldIds, ...after.map((c) => c.id), ...relisted.map((c) => c.id)]),
        ]),
        createdIds: Object.freeze(after.filter((c) => !oldIds.has(c.id)).map((c) => c.id)),
        affected: Object.freeze({
          before: intervals([...before, ...relisted]),
          after: intervals([...after, ...relisted]),
        }),
        markerPatches: forward.markers,
        inverseMarkerPatches: backward.markers,
        takePatches: forward.takes,
        inverseTakePatches: backward.takes,
        trackPatches,
        inverseTrackPatches,
        commands: Object.freeze([replayOf(forward)]),
      });
      ids.advance(target);
      rules = opened.rules;
      byTrack = opened.byTrack;
      recount(referenceDelta(forward.clips));
      byId = opened.positions ?? positions(target.clips);
      snapshot = Object.freeze({ ...target, revision });
      pin();
      const pruned = selection.some((id) => !byId.has(id));
      if (pruned) selection = Object.freeze(selection.filter((id) => byId.has(id)));
      notify(result, false, pruned);
      return result;
    } catch (error) {
      if (!(error instanceof EditError)) throw error;
      return {
        ok: false,
        revision: snapshot.revision,
        code: error.code,
        target: error.target,
        reason: error.message,
      };
    }
  }

  return {
    getSnapshot: () => snapshot,
    preview,
    replace,
    setGate(next) {
      requireEdit(!disposed, "disposed", null, "Editor has been disposed");
      requireEdit(
        next === null || typeof next === "function",
        "invalid-history-policy",
        null,
        "Expected a gate function or null",
      );
      gate = next;
    },
    session: {
      getSelection: () => selection,
      select(ids) {
        requireEdit(!disposed, "disposed", null, "Editor has been disposed");
        requireEdit(
          isArray(ids) && ids.every((id) => byId.has(id)),
          "invalid-selection",
          null,
          "Expected existing clip IDs",
        );
        const next = [...new Set(ids)];
        if (selection.length === next.length && next.every((id, i) => selection[i] === id)) return;
        selection = Object.freeze(next);
        notify(null, false, true);
      },
      subscribeSelection(listen) {
        requireEdit(!disposed, "disposed", null, "Editor has been disposed");
        const sub = { listen, version: selectionVersion };
        selectionSubscribers.add(sub);
        return () => selectionSubscribers.delete(sub);
      },
    },
    read: (document = snapshot) => reads.read(document),
    dispatch: (command, options) => execute(command, "edit", options),
    history: {
      undo: (options) => execute(null, "undo", options),
      redo: (options) => execute(null, "redo", options),
      get canUndo() {
        return history.undoDepth > 0;
      },
      get canRedo() {
        return history.redoDepth > 0;
      },
      get undoDepth() {
        return history.undoDepth;
      },
      get redoDepth() {
        return history.redoDepth;
      },
      get estimatedBytes() {
        return history.estimatedBytes;
      },
      subscribe(listen) {
        requireEdit(!disposed, "disposed", null, "Editor has been disposed");
        const sub = { listen, version: historyVersion };
        historySubscribers.add(sub);
        return () => historySubscribers.delete(sub);
      },
      discard(direction) {
        const removed = history.discard(direction);
        if (removed) notify(null, true);
        return removed;
      },
      clear() {
        if (history.undoDepth + history.redoDepth === 0) return;
        history.clear();
        notify(null, true);
      },
    },
    subscribe(select, listen) {
      requireEdit(!disposed, "disposed", null, "Editor has been disposed");
      let value = select(snapshot);
      const sub: DocumentSubscriber = {
        revision: snapshot.revision,
        update(document, result) {
          const next = select(document);
          if (!Object.is(value, next)) {
            value = next;
            listen(next, result, document);
          }
        },
      };
      subscribers.add(sub);
      return () => subscribers.delete(sub);
    },
    dispose() {
      disposed = true;
      gate = null;
      subscribers.clear();
      historySubscribers.clear();
      selectionSubscribers.clear();
      selection = Object.freeze([]);
      history.clear();
    },
  };
}
