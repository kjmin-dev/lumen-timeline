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
  readonly [field: string]: unknown;
}

/** The available content range of a clip, in project ticks of content time. */
export type ContentBounds = { readonly start: Tick; readonly end: Tick };

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
  readonly activeTakeId?: string | null;
  readonly continuityId?: string | null;
  /** Plugin data. A clip with extensions cannot be split until a split policy exists. */
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

export type ClipCommand = MoveCommand | TrimCommand | SplitCommand;
export type DataCommand = SetDataCommand | RemoveDataCommand;
export type EditCommand = ClipCommand | DataCommand;
export type PreviewCommand = MoveCommand | TrimCommand;

/** Every code an `EditError` or a rejected edit can carry. */
export type EditErrorCode =
  | "unknown-command"
  | "invalid-selection"
  | "invalid-delta"
  | "missing-clip"
  | "locked-track"
  | "missing-track"
  | "invalid-edge"
  | "invalid-range"
  | "split-policy-required"
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
  | "foreign-snapshot";

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

/** A replacement of `before` with `after` at an index of the project's clip array. */
export interface ClipPatch {
  readonly index: number;
  readonly before: readonly Clip[];
  readonly after: readonly Clip[];
}

/** One entity field write. `undefined` represents an absent field. */
export interface DataPatch {
  readonly scope: string;
  readonly id: string;
  readonly key: string;
  readonly before: JsonValue | undefined;
  readonly after: JsonValue | undefined;
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
  readonly patches: readonly ClipPatch[];
  readonly inversePatches: readonly ClipPatch[];
  readonly dataPatches: readonly DataPatch[];
  readonly inverseDataPatches: readonly DataPatch[];
  readonly changedIds: readonly string[];
  readonly createdIds: readonly string[];
  readonly affected: {
    readonly before: readonly AffectedInterval[];
    readonly after: readonly AffectedInterval[];
  };
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

/** Maps a take to a decoded audio stream. Sample positions are in the stream's units. */
export interface TakeBinding {
  readonly assetId: string;
  readonly assetVersion: Version;
  readonly streamId: string;
  readonly sampleRate: number;
  readonly availableStart: number;
  readonly availableEnd: number;
  /** Signed source sample index at content time zero. */
  readonly sourceAtContentZero: number;
}

export interface TakeCatalog {
  readonly version: Version;
  readonly takes: { readonly [takeId: string]: TakeBinding };
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

export type PlanIssue =
  | { readonly code: "invalid-gain"; readonly trackId: string }
  | { readonly code: "unresolved-take"; readonly clipId: string; readonly takeId: unknown }
  | {
      readonly code: "invalid-take";
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
  planAudio(range: TickRange, catalog: TakeCatalog): AudioPlan;
}

/** Removes a subscription. Returns whether it was still active. */
export type Unsubscribe = () => boolean;

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
  readonly history: EditorHistory;
  subscribe<T>(
    select: (snapshot: ProjectSnapshot) => T,
    listen: (value: T, result: EditCommit, snapshot: ProjectSnapshot) => void,
  ): Unsubscribe;
  dispose(): void;
}

export interface EditorOptions {
  readonly project: Project;
  readonly history?: HistoryLimits | undefined;
}
