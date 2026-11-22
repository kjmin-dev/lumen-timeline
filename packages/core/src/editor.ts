import { openProject, orderTrack, validateClip } from "./document.ts";
import type { TrackLayout } from "./document.ts";
import { ClipDraft, applyClips, inverse, rebase } from "./clip-patches.ts";
import { DataDraft, applyData, invertData } from "./entity-data.ts";
import { expectClip, expectData } from "./expect.ts";
import { defined } from "./invariant.ts";
import { MarkerDraft, applyMarkers, invertMarkers, rebaseMarkers } from "./markers.ts";
import { createHistory } from "./history.ts";
import type { HistoryEntry } from "./history.ts";
import { parseReplay, replayOf } from "./replay.ts";
import type { Records } from "./replay.ts";
import { reportListenerError } from "./host.ts";
import { idAllocator } from "./ids.ts";
import { readRegistry } from "./read.ts";
import {
  TakeDraft,
  applyTakes,
  checkReferences,
  invertTakes,
  rebaseTakes,
  referenceDelta,
  remapsMedia,
  stagedDelta,
} from "./takes.ts";
import { splitClip } from "./time.ts";
import { EditError, isArray, requireEdit, validId } from "./validation.ts";
import type {
  AddMarkerCommand,
  AddTakeCommand,
  AffectedInterval,
  Clip,
  ClipCommand,
  ClipPatch,
  CommitHistory,
  EditCommand,
  EditCommit,
  Editor,
  EditOptions,
  EditorOptions,
  EditResult,
  ExpectClipCommand,
  ExpectDataCommand,
  HistoryState,
  MoveMarkerCommand,
  MoveCommand,
  PreviewCommand,
  PruneTakesCommand,
  PreviewResult,
  ProjectSnapshot,
  RemoveDataCommand,
  RemoveMarkerCommand,
  RemoveTakeCommand,
  ReorderTakesCommand,
  ReplayCommand,
  RevisionOptions,
  SelectTakeCommand,
  SetDataCommand,
  SplitCommand,
  TrimCommand,
  UpdateMarkerCommand,
  UpdateTakeCommand,
} from "./types.ts";

// Distributes over unions, so each form of a command keeps its own fields.
type Arguments<C> = C extends unknown ? Omit<C, "type"> : never;

export interface Commands {
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
  readonly positions: Map<string, number>;
}

function positions(clips: readonly Clip[]): Map<string, number> {
  return new Map(clips.map((clip, index) => [clip.id, index]));
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

function recordsOf(entry: HistoryEntry): { forward: Records; backward: Records } {
  return {
    forward: {
      clips: entry.forward,
      data: entry.data,
      markers: entry.markers ?? [],
      takes: entry.takes ?? [],
    },
    backward: {
      clips: entry.inverse,
      data: entry.inverseData,
      markers: entry.inverseMarkers ?? [],
      takes: entry.inverseTakes ?? [],
    },
  };
}

export function createEditor({ project, history: limits, actor }: EditorOptions): Editor {
  requireEdit(actor === undefined || validId(actor), "invalid-id", actor, "Expected an actor name");
  let { snapshot, rules, byTrack, takeCounts } = openProject(project);
  const newId = idAllocator(actor, snapshot);
  let byId = positions(snapshot.clips);
  const reads = readRegistry(snapshot.tracks);
  reads.pin(snapshot, byTrack);
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

  // Fills in every ID a command would otherwise leave the editor to generate,
  // so the commands of a commit replay to the same IDs in another editor.
  function withIds(
    command: EditCommand | null,
    clips: ClipDraft,
    markers: MarkerDraft,
    takes: TakeDraft,
  ): EditCommand | null {
    if (command?.type === "split") return splitRecord(command, clips);
    if (command?.type === "add-marker" && command.id === undefined)
      return Object.freeze({ ...command, id: newId((id) => markers.get(id) !== undefined) });
    const takeTaken = (id: string): boolean => takes.get(id) !== undefined;
    if (
      command?.type === "add-take" &&
      typeof command.take === "object" &&
      command.take !== null &&
      command.take.id === undefined
    )
      return Object.freeze({
        ...command,
        take: Object.freeze({ ...command.take, id: newId(takeTaken) }),
      });
    if (
      command?.type === "update-take" &&
      command.clipIds !== undefined &&
      command.newId === undefined
    )
      return Object.freeze({ ...command, newId: newId(takeTaken) });
    return command;
  }

  // A split is recorded by content position, so a replay after a concurrent
  // move cuts the same point of the clip's content. A command that staging will
  // reject is recorded as given.
  function splitRecord(command: SplitCommand, clips: ClipDraft): SplitCommand {
    const clip = validId(command.clipId) ? clips.get(command.clipId) : undefined;
    const converts = command.atContent === undefined && clip && Number.isSafeInteger(command.at);
    if (!converts && command.rightId !== undefined) return command;
    const rightId = command.rightId ?? newId((id) => clips.get(id) !== undefined);
    if (!converts) return Object.freeze({ ...command, rightId });
    const atContent = command.at - clip.start + clip.contentIn;
    return Object.freeze({ type: "split", clipId: command.clipId, atContent, rightId });
  }

  // The current version of a clip that take commands may edit.
  function editable(draft: ClipDraft): (id: string) => Clip {
    return (id) => {
      const clip = validId(id) ? draft.get(id) : undefined;
      requireEdit(clip, "missing-clip", id, "Clip does not exist");
      requireEdit(
        !defined(rules.tracks.get(clip.trackId), "clip track").locked,
        "locked-track",
        clip.trackId,
        "Track is locked",
      );
      return clip;
    };
  }

  function stageClip(command: ClipCommand | null, draft: ClipDraft): void {
    const type = command?.type;
    requireEdit(
      command !== null && (type === "move" || type === "trim" || type === "split"),
      "unknown-command",
      null,
      "Unknown clip command",
    );
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
        !defined(rules.tracks.get(clip.trackId), "source track").locked,
        "locked-track",
        clip.trackId,
        "Source track is locked",
      );

      let after: readonly Clip[];
      if (type === "move") {
        const trackId = command.trackId === undefined ? clip.trackId : command.trackId;
        const destination = rules.tracks.get(trackId);
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
        requireEdit(
          !Object.keys(clip.extensions ?? {}).length,
          "split-policy-required",
          id,
          "A split policy is required for this clip extension",
        );
        const { rightId } = command;
        requireEdit(
          validId(rightId) && !draft.get(rightId),
          "invalid-id",
          rightId,
          "The right clip requires a new ID",
        );
        after = splitClip(clip, at, rightId);
      }
      for (const next of after) validateClip(next, rules);
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

  // Staged clips passed validateClip, so every touched track exists.
  function stageTracks(before: readonly Clip[], after: readonly Clip[]): TrackLayout {
    const removedIds = new Set(before.map((clip) => clip.id));
    const touched = new Set(before.concat(after).map((clip) => clip.trackId));
    const layout = new Map(byTrack);
    const staged = new Map<string, Clip[]>();
    for (const trackId of touched) {
      const lane = (byTrack.get(trackId) ?? []).filter((clip) => !removedIds.has(clip.id));
      staged.set(trackId, lane);
      layout.set(trackId, lane);
    }
    for (const clip of after) defined(staged.get(clip.trackId), "staged lane").push(clip);
    for (const [id, lane] of staged) orderTrack(lane, rules, id);

    return layout;
  }

  function prepareLayout(
    patches: readonly ClipPatch[],
    before: readonly Clip[],
    after: readonly Clip[],
  ): Geometry {
    const layout = stageTracks(before, after);
    const clips = applyClips(snapshot.clips, patches);
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
        stageClip(command, draft);
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

  // Stages dispatched commands in order and returns what they change, adding
  // each command with its generated IDs filled in to `resolved`.
  function stage(list: readonly (EditCommand | null)[], resolved: EditCommand[]): Staged {
    const clips = new ClipDraft(snapshot.clips, byId);
    const fields = new DataDraft(snapshot.entityData);
    const markers = new MarkerDraft(snapshot.markers);
    const takes = new TakeDraft(snapshot.takes);
    for (const dispatched of list) {
      const command = withIds(dispatched, clips, markers, takes);
      if (command) resolved.push(command);
      if (command?.type === "set-data" || command?.type === "remove-data") fields.stage(command);
      else if (
        command?.type === "add-marker" ||
        command?.type === "move-marker" ||
        command?.type === "update-marker" ||
        command?.type === "remove-marker"
      )
        markers.stage(command, rules);
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
          editable: editable(clips),
          listings: (id) => (takeCounts.get(id) ?? 0) + (stagedDelta(clips).get(id) ?? 0),
        });
      else if (command?.type === "expect-clip") expectClip(command, clips);
      else if (command?.type === "expect-data") expectData(command, fields);
      else if (command?.type === "replay")
        requireEdit(false, "invalid-replay", null, "A replay forms a transaction by itself");
      else stageClip(command, clips);
    }
    const forward: Records = {
      clips: clips.patches(),
      data: fields.patches(),
      markers: markers.patches(),
      takes: takes.patches(),
    };
    return {
      forward,
      backward: {
        clips: inverse(forward.clips),
        data: invertData(forward.data),
        markers: invertMarkers(forward.markers),
        takes: invertTakes(forward.takes),
      },
      delta: referenceDelta(forward.clips),
    };
  }

  // Rebases recorded changes onto the current document, as undo, redo and a
  // replay command apply them. `backward` holds the recorded inverses, which
  // stay in use where nothing needed rebasing.
  function replayed(forward: Records, backward?: Records): Staged {
    const clips = rebase(forward.clips, snapshot.clips, byId, (clip) => validateClip(clip, rules));
    const markers = rebaseMarkers(forward.markers, snapshot.markers, rules);
    const delta = referenceDelta(clips);
    const takes = rebaseTakes(
      forward.takes,
      snapshot.takes,
      (id) => (takeCounts.get(id) ?? 0) + (delta.get(id) ?? 0) > 0,
    );
    return {
      forward: { clips, data: forward.data, markers, takes },
      backward: {
        clips: backward && clips === forward.clips ? backward.clips : inverse(clips),
        data: backward ? backward.data : invertData(forward.data),
        markers:
          backward && markers === forward.markers ? backward.markers : invertMarkers(markers),
        takes: backward && takes === forward.takes ? backward.takes : invertTakes(takes),
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
    try {
      checkRevision(options);
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
          staged = replayed(parseReplay(replay, rules));
        } else staged = stage(list, resolved);
        const { forward } = staged;
        if (
          !forward.clips.length &&
          !forward.data.length &&
          !forward.markers.length &&
          !forward.takes.length
        )
          return { ok: true, revision: snapshot.revision, unchanged: true };
      } else {
        const entry = history.peek(mode);
        requireEdit(entry, "empty-history", null, "No history entry available");
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
        forward: { clips: patches, data, markers: markerPatches, takes: takePatches },
        backward: {
          clips: inverses,
          data: inverseData,
          markers: inverseMarkerPatches,
          takes: inverseTakePatches,
        },
        delta,
      } = staged;

      const before = patches.flatMap((p) => (p.before ? [p.before] : []));
      const after = patches.flatMap((p) => (p.after ? [p.after] : []));
      const geometry = patches.length ? prepareLayout(patches, before, after) : null;
      const entityData = applyData(snapshot.entityData, data);
      const markerList = applyMarkers(snapshot.markers, markerPatches);
      const takeState = applyTakes(snapshot.takes, takePatches);
      const counted = (id: string): number => (takeCounts.get(id) ?? 0) + (delta.get(id) ?? 0);
      checkReferences(after, takePatches, takeState.byId, counted);
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
        commands: Object.freeze(resolved),
      });
      const next: Mutable<ProjectSnapshot> = {
        ...snapshot,
        revision,
        clips: clipList,
      };
      if (entityData === undefined) delete next.entityData;
      else next.entityData = entityData;
      if (markerList === undefined) delete next.markers;
      else next.markers = markerList;
      if (takeState.list === undefined) delete next.takes;
      else next.takes = takeState.list;

      // Validation, conflict checks and staging finish before any observable write.
      if (mode !== "edit") history.advance(mode);
      else if (policy === "record")
        history.record({
          forward: patches,
          inverse: inverses,
          data,
          inverseData,
          // Marker-free entries keep their former shape and logical size.
          ...(markerPatches.length
            ? { markers: markerPatches, inverseMarkers: inverseMarkerPatches }
            : {}),
          ...(takePatches.length ? { takes: takePatches, inverseTakes: inverseTakePatches } : {}),
        });
      for (const [id, change] of delta) {
        const count = (takeCounts.get(id) ?? 0) + change;
        if (count) takeCounts.set(id, count);
        else takeCounts.delete(id);
      }
      if (geometry) {
        byId = geometry.positions;
        byTrack = geometry.layout;
      }
      snapshot = Object.freeze(next);
      reads.pin(snapshot, byTrack);
      const pruned = geometry !== null && selection.some((id) => !byId.has(id));
      if (pruned) selection = Object.freeze(selection.filter((id) => byId.has(id)));
      notify(result, policy !== "ignore" && history.undoDepth + history.redoDepth > 0, pruned);
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

  return {
    getSnapshot: () => snapshot,
    preview,
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
      subscribers.clear();
      historySubscribers.clear();
      selectionSubscribers.clear();
      selection = Object.freeze([]);
      history.clear();
    },
  };
}
