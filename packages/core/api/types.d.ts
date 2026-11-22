import type { TICKS_PER_SECOND } from "./time.ts";
/** An integer position or length in project ticks, at `TICKS_PER_SECOND` ticks per second. */
export type Tick = number;
/** A content version: a nonempty string or a nonnegative safe integer. */
export type Version = string | number;
export type JsonPrimitive = null | boolean | number | string;
export type JsonObject = {
    readonly [key: string]: JsonValue;
};
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
    readonly [field: string]: unknown;
}
/** The available content range of a clip, in project ticks of content time. */
export type ContentBounds = {
    readonly start: Tick;
    readonly end: Tick;
};
/**
 * A clip placement in a schema-v1 project. Loading validates the placement
 * fields. The editor preserves other JSON fields without interpreting them.
 */
export interface Clip {
    readonly id: string;
    readonly trackId: string;
    /** Display name. Views fall back to the ID. */
    readonly name?: string;
    readonly kind: string;
    readonly start: Tick;
    readonly duration: Tick;
    readonly contentIn: Tick;
    readonly contentBounds?: ContentBounds;
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
    /** Plugin data. A clip with extensions cannot be split until a split policy exists. */
    readonly extensions?: JsonObject;
    readonly [field: string]: unknown;
}
/**
 * A point marker. `start` may equal an explicit sequence duration. The editor
 * preserves additional JSON fields without interpreting them.
 */
export interface Marker {
    readonly id: string;
    readonly start: Tick;
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
export type EntityFields = {
    readonly [key: string]: JsonValue;
};
export type EntityRecords = {
    readonly [id: string]: EntityFields;
};
export type EntityData = {
    readonly [scope: string]: EntityRecords;
};
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
export interface SplitCommand {
    readonly type: "split";
    readonly clipId: string;
    readonly at: Tick;
    /** ID of the right half. Omitted or `undefined` generates one. */
    readonly rightId?: string | undefined;
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
    readonly label?: string | undefined;
    readonly color?: string | undefined;
}
export interface MoveMarkerCommand {
    readonly type: "move-marker";
    readonly markerId: string;
    readonly delta: Tick;
}
/** Changes only the fields given. */
export interface UpdateMarkerCommand {
    readonly type: "update-marker";
    readonly markerId: string;
    readonly label?: string | undefined;
    readonly color?: string | undefined;
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
    readonly fields: {
        readonly [field: string]: JsonValue | undefined;
    };
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
export type ClipCommand = MoveCommand | TrimCommand | SplitCommand;
export type DataCommand = SetDataCommand | RemoveDataCommand;
export type MarkerCommand = AddMarkerCommand | MoveMarkerCommand | UpdateMarkerCommand | RemoveMarkerCommand;
export type TakeCommand = AddTakeCommand | SelectTakeCommand | RemoveTakeCommand | ReorderTakesCommand | UpdateTakeCommand | PruneTakesCommand;
export type ExpectCommand = ExpectClipCommand | ExpectDataCommand;
export type EditCommand = ClipCommand | DataCommand | MarkerCommand | TakeCommand | ExpectCommand;
export type PreviewCommand = MoveCommand | TrimCommand;
/** Every code an `EditError` or a rejected edit can carry. */
export type EditErrorCode = "unknown-command" | "invalid-selection" | "invalid-delta" | "missing-clip" | "locked-track" | "missing-track" | "invalid-edge" | "invalid-range" | "split-policy-required" | "invalid-id" | "disposed" | "stale-revision" | "revision-overflow" | "unsupported-preview" | "invalid-history-policy" | "empty-history" | "history-conflict" | "invalid-project" | "unsupported-schema" | "invalid-timebase" | "invalid-track" | "invalid-clip" | "incompatible-kind" | "source-bounds" | "overlap" | "invalid-data-key" | "invalid-history" | "foreign-snapshot" | "missing-marker" | "invalid-marker" | "missing-take" | "invalid-take" | "active-take" | "listed-take" | "invalid-expectation" | "expectation-failed";
export type HistoryPolicy = "record" | "ignore";
export type CommitHistory = HistoryPolicy | "undo" | "redo";
export interface RevisionOptions {
    /** Reject the request with `stale-revision` unless the project is at this revision. */
    readonly expectedRevision?: number | undefined;
}
export interface EditOptions extends RevisionOptions {
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
    /** Every other field that changed, by name. */
    readonly fields: {
        readonly [key: string]: FieldChange<unknown>;
    };
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
    /**
     * The transaction's commands with every generated ID made explicit, so
     * another editor at the same revision replays them to the same result. They
     * share nested values with the dispatched commands. Empty for undo and redo,
     * which replay recorded changes.
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
    readonly revision: number;
    readonly code: EditErrorCode;
    /** The rejected ID or value as supplied, which may be invalid input. */
    readonly target: unknown;
    readonly reason: string;
}
export type EditResult = EditCommit | EditUnchanged | EditFailure;
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
        readonly [assetId: string]: {
            readonly [streamId: string]: StreamBinding;
        };
    };
}
export interface PlanOptions {
    /**
     * Plays a different candidate, or none for `null`, in the named clips
     * without editing the project. A take the clip does not list is reported as
     * `unresolved-take`.
     */
    readonly takeOverrides?: {
        readonly [clipId: string]: string | null;
    } | undefined;
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
    readonly takeId: string;
    readonly assetId: string;
    readonly assetVersion: Version;
    readonly streamId: string;
    readonly sampleRate: number;
    readonly gain: number;
    /** Source position, in project ticks, that corresponds to project tick zero. */
    readonly sourceOriginTick: Tick;
    /** The whole audible part of the clip. */
    readonly audible: SourceRange;
    /** The audible part inside the queried range. */
    readonly window: SourceRange;
}
export type PlanIssue = {
    readonly code: "invalid-gain";
    readonly trackId: string;
} | {
    readonly code: "unresolved-take";
    readonly clipId: string;
    readonly takeId: unknown;
} | {
    readonly code: "unresolved-stream";
    readonly clipId: string;
    readonly takeId: string;
    readonly assetId: string;
    readonly streamId: string;
} | {
    readonly code: "invalid-stream";
    readonly clipId: string;
    readonly takeId: string;
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
    preview(input: PreviewCommand | readonly PreviewCommand[], options?: RevisionOptions): PreviewResult;
    readonly session: EditorSession;
    /** Throws an `EditError` for a snapshot this editor did not produce. */
    read(snapshot?: ProjectSnapshot): ReadHandle;
    dispatch(input: EditCommand | readonly EditCommand[], options?: EditOptions): EditResult;
    readonly history: EditorHistory;
    subscribe<T>(select: (snapshot: ProjectSnapshot) => T, listen: (value: T, result: EditCommit, snapshot: ProjectSnapshot) => void): Unsubscribe;
    dispose(): void;
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
}
