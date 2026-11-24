import type { TICKS_PER_SECOND } from "./time.ts";

/** An integer position or length in project ticks, at `TICKS_PER_SECOND` ticks per second. */
export type Tick = number;

/** A content version: a nonempty string or a nonnegative safe integer. */
export type Version = string | number;

export type JsonPrimitive = null | boolean | number | string;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

export type OverlapPolicy = "mix" | "exclusive";

/**
 * A track in a schema-v1 project. The editor preserves additional JSON fields
 * without interpreting them.
 */
export interface Track {
  readonly id: string;
  /** Display name. Views fall back to the ID. */
  readonly name?: string;
  readonly overlap?: OverlapPolicy;
  readonly locked?: boolean;
  readonly accepts?: readonly string[];
  readonly mute?: boolean;
  readonly solo?: boolean;
  readonly gain?: number;
  /** A CSS color for views. */
  readonly color?: string;
  readonly extensions?: JsonObject;
  readonly [field: string]: unknown;
}

/** The available content range of a clip, in project ticks of content time. */
export type ContentBounds = { readonly start: Tick; readonly end: Tick };

/**
 * A direct media stream binding for a clip that does not list candidate takes.
 * `sourceAtContentZero` defaults to zero.
 */
export interface ClipSource {
  readonly assetId: string;
  readonly streamId: string;
  readonly sourceAtContentZero?: Tick;
}

/**
 * A clip placement in a schema-v1 project. Loading validates the placement
 * fields. The editor preserves other JSON fields without interpreting them.
 */
export interface Clip {
  readonly id: string;
  readonly trackId: string;
  /** Display name. Views fall back to the ID. */
  readonly name?: string;
  /** A CSS color for views. */
  readonly color?: string;
  readonly kind: string;
  readonly start: Tick;
  /** Timeline length in project ticks. */
  readonly duration: Tick;
  /** Content position at the clip's start. */
  readonly contentIn: Tick;
  /**
   * Content ticks played per timeline tick, between `MIN_CLIP_RATE` and
   * `MAX_CLIP_RATE`. The clip covers `duration * rate` of content: above 1 it
   * plays faster and shorter, below 1 slower and longer. Omitted means 1, and
   * a snapshot omits a rate of 1. Change it with a `retime` command.
   */
  readonly rate?: number;
  readonly contentBounds?: ContentBounds;
  /**
   * Direct media source when the clip plays a single stream without candidate takes.
   * Ignored when the clip lists candidate takes.
   */
  readonly source?: ClipSource;
  /**
   * The clip's candidate takes, in display order. Each ID names an entry of
   * `project.takes`. A snapshot omits an empty list.
   */
  readonly takeIds?: readonly string[];
  /**
   * The candidate the clip plays, or `null` for none. A snapshot carries this
   * field exactly when the clip has candidates.
   */
  readonly activeTakeId?: string | null;
  readonly continuityId?: string | null;
  /** Plugin data. Splitting requires an `onSplit` plugin for each namespace carried. */
  readonly extensions?: JsonObject;
  readonly [field: string]: unknown;
}

/**
 * A point or region marker. Point markers omit `duration` and may sit at an
 * explicit sequence duration. Region markers carry a positive `duration` covering
 * `[start, start + duration)`. The editor preserves additional JSON fields
 * without interpreting them.
 */
export interface Marker {
  readonly id: string;
  readonly start: Tick;
  /** Positive duration in project ticks for a region marker. Omitted for a point marker. */
  readonly duration?: Tick;
  readonly label?: string;
  /** A CSS color for views. */
  readonly color?: string;
  readonly extensions?: JsonObject;
  readonly [field: string]: unknown;
}

/**
 * One candidate for a clip's slot: a media stream aligned to content time.
 * Clips list takes by ID, and several clips can share one, as both halves of
 * a split do. A take that no clip lists stays in the project until it is
 * pruned. The editor preserves additional JSON fields without interpreting
 * them.
 */
export interface Take {
  readonly id: string;
  readonly assetId: string;
  readonly streamId: string;
  /** Source position, in project ticks, at the clip's content time zero. May be negative. */
  readonly sourceAtContentZero: Tick;
  /** Display name. Views fall back to the ID. */
  readonly label?: string;
  /** The take this one was copied from when an update applied to only some of its clips. */
  readonly forkedFrom?: string;
  readonly extensions?: JsonObject;
  readonly [field: string]: unknown;
}

/** Sparse entity metadata: scope, then entity ID, then field key. */
export type EntityFields = { readonly [key: string]: JsonValue };
export type EntityRecords = { readonly [id: string]: EntityFields };
export type EntityData = { readonly [scope: string]: EntityRecords };

/** A schema-v1 project document as JSON. */
export interface Project {
  readonly schemaVersion: 1;
  readonly timebase?: typeof TICKS_PER_SECOND;
  readonly revision?: number;
  readonly duration?: Tick;
  readonly minClipDuration?: Tick;
  readonly tracks: readonly Track[];
  readonly clips: readonly Clip[];
  /** Sorted by start, then ID, in a snapshot. Omitted when there are none. */
  readonly markers?: readonly Marker[];
  /** Sorted by ID in a snapshot. Omitted when there are none. */
  readonly takes?: readonly Take[];
  readonly entityData?: EntityData;
  readonly [field: string]: unknown;
}

/** An immutable project revision owned by an editor. */
export interface ProjectSnapshot extends Project {
  readonly revision: number;
}

export interface MoveCommand {
  readonly type: "move";
  readonly clipIds: readonly string[];
  readonly delta: Tick;
  /** Destination track. Omitted or `undefined` keeps each clip on its track. */
  readonly trackId?: string | undefined;
}

export interface TrimCommand {
  readonly type: "trim";
  readonly clipId: string;
  readonly edge: "left" | "right";
  readonly delta: Tick;
}

/**
 * Cuts a clip in two. Name the cut either as a timeline tick, `at`, or as a
 * point in the clip's own content time, `atContent`, which a move does not
 * change. A commit records every split by `atContent`.
 */
export type SplitCommand = SplitAtTick | SplitAtContent;

interface SplitBase {
  readonly type: "split";
  readonly clipId: string;
  /** ID of the right half. Omitted or `undefined` generates one. */
  readonly rightId?: string | undefined;
}

export interface SplitAtTick extends SplitBase {
  /** A timeline tick strictly inside the clip. */
  readonly at: Tick;
  readonly atContent?: undefined;
}

export interface SplitAtContent extends SplitBase {
  readonly at?: undefined;
  /** A content tick strictly between the clip's content edges. */
  readonly atContent: Tick;
}

/**
 * Changes how fast a clip plays its content, keeping the content it covers.
 * Give either the new `rate`, and the clip's length follows, or the new
 * timeline `duration`, and the rate follows. `anchor` names the edge that
 * stays in place: `"start"`, the default, keeps the clip's start and moves its
 * end; `"end"` keeps its end and moves its start.
 */
export type RetimeCommand = RetimeToRate | RetimeToDuration;

interface RetimeBase {
  readonly type: "retime";
  readonly clipId: string;
  readonly anchor?: "start" | "end" | undefined;
}

export interface RetimeToRate extends RetimeBase {
  /** Content ticks per timeline tick, from `MIN_CLIP_RATE` to `MAX_CLIP_RATE`. */
  readonly rate: number;
  readonly duration?: undefined;
}

export interface RetimeToDuration extends RetimeBase {
  readonly rate?: undefined;
  /** The new timeline length in project ticks. */
  readonly duration: Tick;
}

/** The fields of a new clip. Omitting `id` generates one; `contentIn` defaults to 0. */
export interface ClipInput {
  readonly id?: string | undefined;
  readonly trackId: string;
  readonly kind: string;
  readonly start: Tick;
  readonly duration: Tick;
  readonly contentIn?: Tick | undefined;
  /** Content ticks per timeline tick. Omitted or 1 plays at normal speed. */
  readonly rate?: number | undefined;
  readonly name?: string | undefined;
  readonly color?: string | undefined;
  readonly contentBounds?: ContentBounds | undefined;
  readonly source?: ClipSource | undefined;
  readonly takeIds?: readonly string[] | undefined;
  readonly activeTakeId?: string | null | undefined;
  readonly continuityId?: string | null | undefined;
  readonly extensions?: JsonObject | undefined;
}

/** Adds a clip to an unlocked track, optionally placed right after `after`. */
export interface AddClipCommand {
  readonly type: "add-clip";
  readonly clip: ClipInput;
  /** Existing clip ID to place the new clip after. Omitted appends to the end. */
  readonly after?: string | undefined;
}

/** Removes a clip from an unlocked track. */
export interface RemoveClipCommand {
  readonly type: "remove-clip";
  readonly clipId: string;
}

/**
 * Updates metadata and source fields on a clip. `undefined` keeps the existing
 * value; `null` removes an optional field.
 */
export interface UpdateClipCommand {
  readonly type: "update-clip";
  readonly clipId: string;
  readonly name?: string | null | undefined;
  readonly color?: string | null | undefined;
  readonly kind?: string | undefined;
  readonly contentBounds?: ContentBounds | null | undefined;
  readonly source?: ClipSource | null | undefined;
  readonly continuityId?: string | null | undefined;
  readonly extensions?: JsonObject | null | undefined;
}

/** The fields of a new track. Omitting `id` generates one. */
export interface TrackInput {
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly overlap?: OverlapPolicy | undefined;
  readonly locked?: boolean | undefined;
  readonly accepts?: readonly string[] | undefined;
  readonly mute?: boolean | undefined;
  readonly solo?: boolean | undefined;
  readonly gain?: number | undefined;
  readonly color?: string | undefined;
  readonly extensions?: JsonObject | undefined;
}

/** Adds a track, optionally placed right after `after`. */
export interface AddTrackCommand {
  readonly type: "add-track";
  readonly track: TrackInput;
  readonly after?: string | undefined;
}

/**
 * Updates a track's properties or mix settings. `undefined` keeps the existing
 * value; `null` removes an optional field.
 */
export interface UpdateTrackCommand {
  readonly type: "update-track";
  readonly trackId: string;
  readonly name?: string | null | undefined;
  readonly overlap?: OverlapPolicy | null | undefined;
  readonly locked?: boolean | null | undefined;
  readonly accepts?: readonly string[] | null | undefined;
  readonly mute?: boolean | null | undefined;
  readonly solo?: boolean | null | undefined;
  readonly gain?: number | null | undefined;
  readonly color?: string | null | undefined;
  readonly extensions?: JsonObject | null | undefined;
}

/**
 * Removes an unlocked track. When the track still holds clips, pass
 * `removeClips: true` to remove them atomically; otherwise rejects with `track-not-empty`.
 */
export interface RemoveTrackCommand {
  readonly type: "remove-track";
  readonly trackId: string;
  readonly removeClips?: boolean | undefined;
}

/** Replaces the project's track order with a permutation of its track IDs. */
export interface ReorderTracksCommand {
  readonly type: "reorder-tracks";
  readonly trackIds: readonly string[];
}

export interface SetDataCommand {
  readonly type: "set-data";
  readonly scope: string;
  readonly id: string;
  readonly key: string;
  readonly value: JsonValue;
}

export interface RemoveDataCommand {
  readonly type: "remove-data";
  readonly scope: string;
  readonly id: string;
  readonly key: string;
}

export interface AddMarkerCommand {
  readonly type: "add-marker";
  /** Omitted or `undefined` generates an ID. */
  readonly id?: string | undefined;
  readonly start: Tick;
  /** Positive duration in project ticks for a region marker. */
  readonly duration?: Tick | undefined;
  readonly label?: string | undefined;
  readonly color?: string | undefined;
  readonly extensions?: JsonObject | undefined;
}

export interface MoveMarkerCommand {
  readonly type: "move-marker";
  readonly markerId: string;
  readonly delta: Tick;
}

/** Changes only the fields given. `null` removes an optional field. */
export interface UpdateMarkerCommand {
  readonly type: "update-marker";
  readonly markerId: string;
  readonly duration?: Tick | null | undefined;
  readonly label?: string | null | undefined;
  readonly color?: string | null | undefined;
  readonly extensions?: JsonObject | null | undefined;
}

export interface RemoveMarkerCommand {
  readonly type: "remove-marker";
  readonly markerId: string;
}

/** The fields of a new take. Omitting `id` generates one. */
export interface TakeInput {
  readonly id?: string | undefined;
  readonly assetId: string;
  readonly streamId: string;
  readonly sourceAtContentZero: Tick;
  readonly label?: string | undefined;
  readonly extensions?: JsonObject | undefined;
}

/**
 * Appends a take to the candidate lists of `clipIds`. Pass `take` to register
 * a new take or `takeId` to share an existing one. A clip that already lists
 * the take keeps its position.
 */
export interface AddTakeCommand {
  readonly type: "add-take";
  readonly clipIds: readonly string[];
  readonly take?: TakeInput | undefined;
  readonly takeId?: string | undefined;
  /** Also make the take active on every listed clip. Defaults to `false`. */
  readonly activate?: boolean | undefined;
}

/** Makes one of the clip's candidates active, or `null` for none. */
export interface SelectTakeCommand {
  readonly type: "select-take";
  readonly clipId: string;
  readonly takeId: string | null;
}

/**
 * Removes a candidate from one clip. The active take cannot be removed; select
 * another in the same transaction first. The take itself stays in the project
 * until it is pruned.
 */
export interface RemoveTakeCommand {
  readonly type: "remove-take";
  readonly clipId: string;
  readonly takeId: string;
}

/** Replaces a clip's candidate order with a permutation of the same IDs. */
export interface ReorderTakesCommand {
  readonly type: "reorder-takes";
  readonly clipId: string;
  readonly takeIds: readonly string[];
}

/**
 * Changes only the fields given. A take's asset and stream are fixed; add a
 * new take for different media.
 *
 * Without `clipIds` the change reaches every clip that lists the take. With
 * `clipIds`, each of which must list the take, it reaches only those clips:
 * if another clip lists the take too, the take is copied first. The copy
 * replaces the take in the named clips, at the same list position and as the
 * active take where it was active, and records its source in `forkedFrom`.
 */
export interface UpdateTakeCommand {
  readonly type: "update-take";
  readonly takeId: string;
  readonly clipIds?: readonly string[] | undefined;
  /** ID of the copy, when one is made. Omitted or `undefined` generates one. */
  readonly newId?: string | undefined;
  readonly label?: string | undefined;
  readonly sourceAtContentZero?: Tick | undefined;
}

/**
 * Removes takes that no clip lists. Without `takeIds` it removes every such
 * take. A listed take in `takeIds` rejects the command with `listed-take`.
 */
export interface PruneTakesCommand {
  readonly type: "prune-takes";
  readonly takeIds?: readonly string[] | undefined;
}

/**
 * Rejects the whole transaction with `expectation-failed` unless the clip
 * exists and each field deep-equals its value at this point in the
 * transaction. `undefined` expects an absent field.
 */
export interface ExpectClipCommand {
  readonly type: "expect-clip";
  readonly clipId: string;
  readonly fields: { readonly [field: string]: JsonValue | undefined };
}

/**
 * Rejects the whole transaction with `expectation-failed` unless the entity
 * field deep-equals `value` at this point in the transaction. `undefined`
 * expects an absent field.
 */
export interface ExpectDataCommand {
  readonly type: "expect-data";
  readonly scope: string;
  readonly id: string;
  readonly key: string;
  readonly value: JsonValue | undefined;
}

/**
 * Applies recorded changes the way undo and redo do. Each patch replays by ID
 * against the current document, owns only the fields it changed and conflicts
 * where they changed since, so a conflicting replay is rejected whole. Undo
 * and redo commits carry one, which another editor or a saved log applies like
 * any command. A replay forms a transaction by itself.
 */
export interface ReplayCommand {
  readonly type: "replay";
  readonly clipPatches?: readonly ClipPatch[] | undefined;
  readonly dataPatches?: readonly DataPatch[] | undefined;
  readonly markerPatches?: readonly MarkerPatch[] | undefined;
  readonly takePatches?: readonly TakePatch[] | undefined;
  readonly trackPatches?: readonly TrackPatch[] | undefined;
  readonly trackOrder?: readonly string[] | undefined;
}

export type ClipCommand =
  | MoveCommand
  | TrimCommand
  | SplitCommand
  | RetimeCommand
  | AddClipCommand
  | RemoveClipCommand
  | UpdateClipCommand;
export type TrackCommand =
  | AddTrackCommand
  | UpdateTrackCommand
  | RemoveTrackCommand
  | ReorderTracksCommand;
export type DataCommand = SetDataCommand | RemoveDataCommand;
export type MarkerCommand =
  | AddMarkerCommand
  | MoveMarkerCommand
  | UpdateMarkerCommand
  | RemoveMarkerCommand;
export type TakeCommand =
  | AddTakeCommand
  | SelectTakeCommand
  | RemoveTakeCommand
  | ReorderTakesCommand
  | UpdateTakeCommand
  | PruneTakesCommand;
export type ExpectCommand = ExpectClipCommand | ExpectDataCommand;
export type EditCommand =
  | ClipCommand
  | TrackCommand
  | DataCommand
  | MarkerCommand
  | TakeCommand
  | ExpectCommand
  | ReplayCommand;
export type PreviewCommand = MoveCommand | TrimCommand | RetimeCommand;

/** Every code an `EditError` or a rejected edit can carry. */
export type EditErrorCode =
  | "unknown-command"
  | "invalid-selection"
  | "invalid-delta"
  | "missing-clip"
  | "locked-track"
  | "missing-track"
  | "track-not-empty"
  | "invalid-edge"
  | "invalid-range"
  | "invalid-rate"
  | "split-policy-required"
  | "invalid-extension"
  | "invalid-id"
  | "disposed"
  | "stale-revision"
  | "revision-overflow"
  | "unsupported-preview"
  | "invalid-history-policy"
  | "empty-history"
  | "history-conflict"
  | "invalid-project"
  | "unsupported-schema"
  | "invalid-timebase"
  | "invalid-track"
  | "invalid-clip"
  | "incompatible-kind"
  | "source-bounds"
  | "overlap"
  | "invalid-data-key"
  | "invalid-history"
  | "foreign-snapshot"
  | "missing-marker"
  | "invalid-marker"
  | "missing-take"
  | "invalid-take"
  | "active-take"
  | "listed-take"
  | "invalid-expectation"
  | "expectation-failed"
  | "invalid-replay"
  | "read-only";

export type HistoryPolicy = "record" | "ignore";
/** How a commit relates to history. `replace` is an adopted snapshot. */
export type CommitHistory = HistoryPolicy | "undo" | "redo" | "replace";

export interface RevisionOptions {
  /** Reject the request with `stale-revision` unless the project is at this revision. */
  readonly expectedRevision?: number | undefined;
}

export interface EditOptions extends RevisionOptions {
  /**
   * An earlier commit of this editor that these commands replay after a
   * replacement, as a sync layer replays an edit that is not yet confirmed.
   * The transaction records no entry of its own. Instead the history entry
   * that commit recorded, or moved by undo or redo, takes this transaction's
   * records, so undo reverses what the edit did after the replay. Nothing in
   * history changes when that entry is gone. Leave `history` unset.
   */
  readonly rebases?: EditCommit | undefined;
  /** `record` (default) adds an undo entry. `ignore` preserves both history stacks. */
  readonly history?: HistoryPolicy | undefined;
}

/** One clip change. `undefined` represents an absent clip. */
export interface ClipPatch {
  readonly id: string;
  readonly before: Clip | undefined;
  readonly after: Clip | undefined;
  /**
   * For a clip the patch adds: the clip it is placed after in the project's
   * clip array. A split places each new clip after the one it was cut from.
   * Absent, the clip goes to the end.
   */
  readonly follows?: string;
}

/** One field's value before and after a change. `undefined` is an absent field. */
export interface FieldChange<T> {
  readonly before: T;
  readonly after: T;
}

/**
 * What a clip patch changed, field by field. Placement is in content space:
 * `origin` is where content time zero sits on the timeline (`start -
 * contentIn`), and `in` and `out` are the clip's content edges (`contentIn` and
 * `contentIn + duration`). A move changes only `origin`, a left trim only `in`,
 * and a right trim or the left half of a split only `out`. Both maps are empty
 * for a patch that adds or removes a clip.
 */
export interface ClipFieldChanges {
  readonly placement: {
    readonly origin?: FieldChange<Tick>;
    readonly in?: FieldChange<Tick>;
    readonly out?: FieldChange<Tick>;
  };
  /** Every other field that changed, by name, with a rate change as `rate`. */
  readonly fields: { readonly [key: string]: FieldChange<unknown> };
}

/** One entity field write. `undefined` represents an absent field. */
export interface DataPatch {
  readonly scope: string;
  readonly id: string;
  readonly key: string;
  readonly before: JsonValue | undefined;
  readonly after: JsonValue | undefined;
}

/** One marker change. `undefined` represents an absent marker. */
export interface MarkerPatch {
  readonly id: string;
  readonly before: Marker | undefined;
  readonly after: Marker | undefined;
}

/** One take change. `undefined` represents an absent take. */
export interface TakePatch {
  readonly id: string;
  readonly before: Take | undefined;
  readonly after: Take | undefined;
}

/** One track change. `undefined` represents an absent track. */
export interface TrackPatch {
  readonly id: string;
  readonly before: Track | undefined;
  readonly after: Track | undefined;
  /** For an added or removed track: the track it sits after. Absent puts it at the end. */
  readonly follows?: string;
}

/** A clip's half-open placement interval in project ticks. */
export interface AffectedInterval {
  readonly clipId: string;
  readonly trackId: string;
  readonly start: Tick;
  readonly end: Tick;
}

export interface EditCommit {
  readonly ok: true;
  readonly unchanged?: never;
  readonly revision: number;
  readonly history: CommitHistory;
  readonly clipPatches: readonly ClipPatch[];
  readonly inverseClipPatches: readonly ClipPatch[];
  readonly dataPatches: readonly DataPatch[];
  readonly inverseDataPatches: readonly DataPatch[];
  readonly changedIds: readonly string[];
  readonly createdIds: readonly string[];
  readonly affected: {
    readonly before: readonly AffectedInterval[];
    readonly after: readonly AffectedInterval[];
  };
  /** Marker changes. `changedIds`, `createdIds` and `affected` describe clips only. */
  readonly markerPatches: readonly MarkerPatch[];
  readonly inverseMarkerPatches: readonly MarkerPatch[];
  /**
   * Take changes. A clip that lists a take whose media mapping changed appears
   * in `changedIds` and `affected` without a clip patch of its own.
   */
  readonly takePatches: readonly TakePatch[];
  readonly inverseTakePatches: readonly TakePatch[];
  /** Track changes. Empty when no track was added, updated or removed. */
  readonly trackPatches: readonly TrackPatch[];
  readonly inverseTrackPatches: readonly TrackPatch[];
  /**
   * The transaction's commands with every generated ID made explicit and each
   * split named by `atContent`, so another editor at the same revision replays
   * them to the same result, and a split replayed after a concurrent move cuts
   * the same content point. They share nested values with the dispatched
   * commands. Undo, redo and a dispatched replay list one `replay` command with
   * the records they applied.
   */
  readonly commands: readonly EditCommand[];
}

export interface EditUnchanged {
  readonly ok: true;
  readonly revision: number;
  readonly unchanged: true;
}

export interface EditFailure {
  readonly ok: false;
  readonly held?: never;
  readonly revision: number;
  readonly code: EditErrorCode;
  /** The rejected ID or value as supplied, which may be invalid input. */
  readonly target: unknown;
  readonly reason: string;
}

/** What a transaction changes, by kind of record. */
export interface EditTargets {
  /** Clips it changes, adds or removes, and clips whose listed take changes media. */
  readonly clipIds: readonly string[];
  readonly markerIds: readonly string[];
  readonly takeIds: readonly string[];
  /** Tracks added, updated, removed or reordered. Omitted when unchanged. */
  readonly trackIds?: readonly string[];
  /** Entity data records it writes. */
  readonly entities: readonly { readonly scope: string; readonly id: string }[];
}

/** A validated transaction, as a dispatch gate sees it before it commits. */
export interface GatedTransaction {
  /** `record` or `ignore` for a dispatch, `undo` or `redo` for history. */
  readonly history: CommitHistory;
  /** Its commands with every generated ID written in. Undo and redo list one `replay`. */
  readonly commands: readonly EditCommand[];
  readonly targets: EditTargets;
  /** The revision it would commit as. */
  readonly revision: number;
}

/**
 * `commit` lets the transaction through. `hold` keeps it out of the document
 * and returns it to the caller. `{ readOnly }` rejects it with `read-only`,
 * naming the reason as the failure's target.
 */
export type GateDecision = "commit" | "hold" | { readonly readOnly: string };

/** Decides each validated transaction. It must not edit the project itself. */
export type DispatchGate = (transaction: GatedTransaction) => GateDecision;

/**
 * A transaction a gate held. Nothing changed: no revision, history entry or
 * notification. Its commands can be dispatched later, as a sync layer does
 * once another participant accepts them.
 */
export interface EditHeld {
  readonly ok: false;
  readonly held: true;
  readonly code: "held";
  readonly revision: number;
  readonly target: null;
  readonly reason: string;
  readonly history: CommitHistory;
  readonly commands: readonly EditCommand[];
  readonly targets: EditTargets;
}

export type EditResult = EditCommit | EditUnchanged | EditFailure | EditHeld;

export interface PreviewSuccess {
  readonly ok: true;
  readonly revision: number;
  readonly placements: readonly Clip[];
}

export type PreviewResult = PreviewSuccess | EditFailure;

export interface HistoryLimits {
  /** Defaults to 200. Zero disables recording. */
  readonly maxEntries?: number | undefined;
  /** Logical byte budget. Defaults to 16 MiB. Zero disables recording. */
  readonly maxBytes?: number | undefined;
}

export interface HistoryState {
  readonly undoDepth: number;
  readonly redoDepth: number;
  readonly estimatedBytes: number;
}

/** A half-open interval of project ticks. */
export interface TickRange {
  readonly start: Tick;
  readonly end: Tick;
}

export interface ClipQueryOptions {
  /** Restrict the query to these tracks. Results stay in document track order. */
  readonly trackIds?: readonly string[] | undefined;
}

/** A decoded audio stream. Sample positions are in the stream's units. */
export interface StreamBinding {
  readonly assetVersion: Version;
  readonly sampleRate: number;
  readonly availableStart: number;
  readonly availableEnd: number;
}

/** Runtime media facts for planning: the decoded stream behind each take's asset. */
export interface StreamCatalog {
  readonly version: Version;
  readonly streams: {
    readonly [assetId: string]: { readonly [streamId: string]: StreamBinding };
  };
}

export interface PlanOptions {
  /**
   * Plays a different candidate, or none for `null`, in the named clips
   * without editing the project. A take the clip does not list is reported as
   * `unresolved-take`.
   */
  readonly takeOverrides?: { readonly [clipId: string]: string | null } | undefined;
  /**
   * Plans this clip alone, as if its track were soloed and unmuted. The
   * track's gain still applies. An unknown clip plans nothing.
   */
  readonly isolate?: string | undefined;
}

/** A project interval and the half-open source sample range it plays. */
export interface SourceRange {
  readonly start: Tick;
  readonly end: Tick;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

export interface AudioSpan {
  readonly clipId: string;
  readonly trackId: string;
  readonly chainId: string | null;
  /** The active take ID, or `null` when played directly from `clip.source`. */
  readonly takeId: string | null;
  readonly assetId: string;
  readonly assetVersion: Version;
  readonly streamId: string;
  readonly sampleRate: number;
  readonly gain: number;
  /**
   * Source ticks played per timeline tick: the clip's rate, 1 for a clip at
   * normal speed. A transport either plays the source this much faster, as
   * varispeed, or plays a time-stretched rendering of `audible`.
   */
  readonly rate: number;
  /**
   * Source position, in project ticks, that corresponds to project tick zero,
   * extended at `rate` from the clip's own mapping.
   */
  readonly sourceOriginTick: Tick;
  /** The whole audible part of the clip. */
  readonly audible: SourceRange;
  /** The audible part inside the queried range. */
  readonly window: SourceRange;
}

export type PlanIssue =
  | { readonly code: "invalid-gain"; readonly trackId: string }
  | { readonly code: "unresolved-take"; readonly clipId: string; readonly takeId: unknown }
  | {
      readonly code: "unresolved-stream";
      readonly clipId: string;
      readonly takeId: string | null;
      readonly assetId: string;
      readonly streamId: string;
    }
  | {
      readonly code: "invalid-stream";
      readonly clipId: string;
      readonly takeId: string | null;
      readonly reason: string;
    };

export interface AudioPlan {
  readonly revision: number;
  readonly catalogVersion: Version;
  readonly spans: readonly AudioSpan[];
  readonly issues: readonly PlanIssue[];
}

/** Synchronous queries pinned to one project revision. */
export interface ReadHandle {
  readonly revision: number;
  clipsIn(range: TickRange, options?: ClipQueryOptions): readonly Clip[];
  planAudio(range: TickRange, catalog: StreamCatalog, options?: PlanOptions): AudioPlan;
  /**
   * The clip's candidate takes in list order. Throws an `EditError` with
   * `missing-clip` for an unknown clip.
   */
  takesOf(clipId: string): readonly Take[];
  /**
   * IDs of the clips that list the take, in snapshot order. Empty for a take
   * awaiting pruning. Throws an `EditError` with `missing-take` for an
   * unknown take.
   */
  clipsListing(takeId: string): readonly string[];
  /** Markers with `range.start <= start < range.end`, in snapshot order. */
  markersIn(range: TickRange): readonly Marker[];
  /**
   * Point and region markers intersecting `[range.start, range.end)`, in snapshot
   * order. Includes a region marker whose start lies before `range.start` as long
   * as `start + duration > range.start`.
   */
  regionsIn(range: TickRange): readonly Marker[];
  /** The first marker after `tick`. */
  nextMarker(tick: Tick): Marker | undefined;
  /** The last marker before `tick`. */
  previousMarker(tick: Tick): Marker | undefined;
}

/** Removes a subscription. Returns whether it was still active. */
export type Unsubscribe = () => boolean;

/**
 * The presentation fields of a transport snapshot. Within one segment the
 * presented tick moves only by playback. Any other move, such as a seek,
 * starts a new segment.
 */
export interface PresentationState {
  readonly presentedTick: Tick;
  /** Changes whenever the presented position moves other than by playback. */
  readonly segment: number;
  /** The tick that presentation continues from in this segment. */
  readonly segmentStart: Tick;
}

/** A transport, or any player adapter, that reports presentation segments. */
export interface PresentationSource {
  snapshot(): PresentationState;
  subscribe(listener: (state: PresentationState) => void): () => unknown;
}

/** Markers that playback crossed between two presented ticks. */
export interface MarkerCrossing {
  /** Markers with `after < start <= through`, in snapshot order. Never empty. */
  readonly markers: readonly Marker[];
  readonly after: Tick;
  readonly through: Tick;
  /** The project revision the markers were read from. */
  readonly revision: number;
}

export interface EditorSession {
  getSelection(): readonly string[];
  /** Throws an `EditError` for unknown clip IDs or after disposal. */
  select(ids: readonly string[]): void;
  subscribeSelection(listen: (selection: readonly string[]) => void): Unsubscribe;
}

export interface EditorHistory {
  undo(options?: RevisionOptions): EditResult;
  redo(options?: RevisionOptions): EditResult;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoDepth: number;
  readonly redoDepth: number;
  readonly estimatedBytes: number;
  subscribe(listen: (state: HistoryState) => void): Unsubscribe;
  /** Drops the newest entry in one direction. Returns whether one existed. */
  discard(direction: "undo" | "redo"): boolean;
  clear(): void;
}

export interface Editor {
  getSnapshot(): ProjectSnapshot;
  preview(
    input: PreviewCommand | readonly PreviewCommand[],
    options?: RevisionOptions,
  ): PreviewResult;
  readonly session: EditorSession;
  /** Throws an `EditError` for a snapshot this editor did not produce. */
  read(snapshot?: ProjectSnapshot): ReadHandle;
  dispatch(input: EditCommand | readonly EditCommand[], options?: EditOptions): EditResult;
  /**
   * Adopts another snapshot of the same project in place: one with the same
   * tracks, sequence bounds and timebase. Subscribers keep their subscriptions
   * and see one commit, with `history: "replace"`, whose patches describe the
   * difference. The selection drops clips the snapshot lacks. History stays,
   * and its entries replay against the new document. The revision moves
   * forward to the snapshot's when that is later, and to the next one
   * otherwise. The ID counter moves past the snapshot's IDs and never back.
   * A gate does not see a replacement. Fails with `foreign-snapshot` for
   * another project, and with the loading codes for an invalid snapshot.
   */
  replace(project: Project): EditCommit | EditUnchanged | EditFailure;
  /**
   * Installs a gate that decides every validated dispatch, undo and redo
   * before it commits, or removes it with `null`.
   */
  setGate(gate: DispatchGate | null): void;
  readonly history: EditorHistory;
  subscribe<T>(
    select: (snapshot: ProjectSnapshot) => T,
    listen: (value: T, result: EditCommit, snapshot: ProjectSnapshot) => void,
  ): Unsubscribe;
  dispose(): void;
}

/** Context passed to `TimelinePlugin.validate`. */
export interface ValidateExtensionContext {
  readonly target: "clip" | "track" | "marker" | "take";
  readonly id: string;
  readonly value: JsonValue;
}

/** Context passed to `TimelinePlugin.onSplit` when a clip carrying the namespace is split. */
export interface SplitExtensionContext {
  readonly clip: Clip;
  readonly left: Clip;
  readonly right: Clip;
  readonly at: Tick;
  readonly value: JsonValue;
}

/**
 * The namespace payload to store on each half of a split clip. Return
 * `undefined` for a half to omit the namespace on that side.
 */
export interface SplitExtensionResult {
  readonly left: JsonValue | undefined;
  readonly right: JsonValue | undefined;
}

/**
 * Registers domain semantics for one `extensions[namespace]` payload: optional
 * validation on load and edits, and optional split behavior for clips.
 */
export interface TimelinePlugin {
  readonly namespace: string;
  readonly version: number;
  /** Return a nonempty string reason to reject the payload with `invalid-extension`. */
  readonly validate?: ((context: ValidateExtensionContext) => string | undefined) | undefined;
  readonly onSplit?: ((context: SplitExtensionContext) => SplitExtensionResult) | undefined;
}

export interface EditorOptions {
  readonly project: Project;
  readonly history?: HistoryLimits | undefined;
  /**
   * Names this editing session in the IDs it generates: `<actor>-<n>`, counting
   * on from the IDs the project already carries for that actor. Give every
   * session that edits a project its own actor, such as a user ID joined with
   * a session token. Omitted, the editor draws a random one.
   */
  readonly actor?: string | undefined;
  /** Domain plugins owning extension namespaces on tracks, clips, markers and takes. */
  readonly plugins?: readonly TimelinePlugin[] | undefined;
}
