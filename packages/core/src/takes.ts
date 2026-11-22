import type { ClipDraft } from "./clip-patches.ts";
import { applyRecords, invertRecords, rebaseRecords, stagedPatches } from "./record-patches.ts";
import { MAX_TICK } from "./time.ts";
import type {
  Clip,
  ClipPatch,
  JsonObject,
  JsonValue,
  Take,
  TakeCommand,
  TakePatch,
  UpdateTakeCommand,
} from "./types.ts";
import { freezeJson, isArray, isRecord, requireEdit, safeInteger, validId } from "./validation.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function compareTakes(a: Take, b: Take): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const optionalText = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

/** A source position within the seven-day limit, so no clip mapping can overflow. */
const sourcePosition = (value: unknown): value is number =>
  safeInteger(value) && Math.abs(value) <= MAX_TICK;

const distinctIds = (value: unknown): value is readonly string[] =>
  isArray(value) && value.every(validId) && new Set(value).size === value.length;

/** Checks the typed fields of a take. A take's own ID was checked by the caller. */
function checkTake(take: Take): void {
  requireEdit(
    validId(take.assetId) && validId(take.streamId),
    "invalid-take",
    take.id,
    "A take requires asset and stream IDs",
  );
  requireEdit(
    sourcePosition(take.sourceAtContentZero),
    "invalid-take",
    take.id,
    "A take's source position is an integer tick within seven days",
  );
  requireEdit(
    optionalText(take.label) && (take.forkedFrom === undefined || validId(take.forkedFrom)),
    "invalid-take",
    take.id,
    "Expected a string label and source take ID",
  );
  requireEdit(
    take.extensions === undefined || isRecord(take.extensions),
    "invalid-take",
    take.id,
    "Expected an extensions map",
  );
}

/** Parses one take of a loaded project. */
export function parseTake(value: JsonValue, taken: (id: string) => boolean): Take {
  const record = isRecord(value) ? value : undefined;
  const id = record?.["id"];
  requireEdit(
    record !== undefined && validId(id) && !taken(id),
    "invalid-take",
    id,
    "Take IDs must be unique",
  );
  const assetId = record["assetId"];
  const streamId = record["streamId"];
  const sourceAtContentZero = record["sourceAtContentZero"];
  requireEdit(
    validId(assetId) && validId(streamId) && sourcePosition(sourceAtContentZero),
    "invalid-take",
    id,
    "A take requires asset and stream IDs and a source position within seven days",
  );
  const label = record["label"];
  const forkedFrom = record["forkedFrom"];
  const extensions = record["extensions"];
  requireEdit(
    optionalText(label) && (forkedFrom === undefined || validId(forkedFrom)),
    "invalid-take",
    id,
    "Expected a string label and source take ID",
  );
  requireEdit(
    extensions === undefined || isRecord(extensions),
    "invalid-take",
    id,
    "Expected an extensions map",
  );
  return Object.freeze({
    ...record,
    id,
    assetId,
    streamId,
    sourceAtContentZero,
    ...(label === undefined ? {} : { label }),
    ...(forkedFrom === undefined ? {} : { forkedFrom }),
    ...(extensions === undefined ? {} : { extensions }),
  });
}

/** A loaded clip's candidates in their one snapshot form. */
export interface Candidates {
  readonly takeIds: readonly string[];
  readonly activeTakeId: string | null;
}

/**
 * Parses a loaded clip's candidate list and active take. Returns `undefined`
 * for a clip without candidates, which then has no active take either.
 */
export function parseCandidates(
  id: string,
  takeIds: JsonValue | undefined,
  activeTakeId: string | null | undefined,
): Candidates | undefined {
  requireEdit(
    takeIds === undefined || distinctIds(takeIds),
    "invalid-take",
    id,
    "Expected distinct take IDs",
  );
  if (!takeIds?.length) {
    requireEdit(
      activeTakeId === undefined || activeTakeId === null,
      "invalid-take",
      id,
      "List the active take among the clip's takes",
    );
    return undefined;
  }
  requireEdit(
    activeTakeId === undefined || activeTakeId === null || takeIds.includes(activeTakeId),
    "invalid-take",
    id,
    "The active take must be one of the clip's takes",
  );
  return { takeIds: Object.freeze([...takeIds]), activeTakeId: activeTakeId ?? null };
}

/** Counts how many clips list each take. */
export function countReferences(clips: readonly Clip[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const clip of clips)
    for (const id of clip.takeIds ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

/** Checks that every take a loaded clip lists exists. */
export function checkLoadedReferences(
  takes: ReadonlyMap<string, Take>,
  clips: readonly Clip[],
): void {
  for (const clip of clips)
    for (const id of clip.takeIds ?? [])
      requireEdit(takes.has(id), "invalid-take", clip.id, "Clip lists a missing take: " + id);
}

function count(delta: Map<string, number>, clips: readonly Clip[], change: number): void {
  for (const clip of clips)
    for (const id of clip.takeIds ?? []) delta.set(id, (delta.get(id) ?? 0) + change);
}

/** The change in each take's reference count across clip patches. */
export function referenceDelta(patches: readonly ClipPatch[]): Map<string, number> {
  const delta = new Map<string, number>();
  for (const patch of patches) {
    count(delta, patch.before, -1);
    count(delta, patch.after, 1);
  }
  return delta;
}

/** The same change for a transaction that is still being staged. */
export function stagedDelta(clips: ClipDraft): Map<string, number> {
  const delta = new Map<string, number>();
  for (const [original, current] of clips.changes()) {
    count(delta, [original], -1);
    count(delta, current, 1);
  }
  return delta;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a === b || (a.length === b.length && a.every((id, i) => id === b[i]));
}

/** What staging needs from the editor. */
export interface TakeStage {
  readonly clips: ClipDraft;
  /** The current version of an existing clip on an unlocked track. */
  editable(id: string): Clip;
  /** How many clips list the take at this point in the transaction. */
  listings(id: string): number;
}

/** Stages take commands for one transaction. `undefined` marks a removal. */
export class TakeDraft {
  readonly byId: ReadonlyMap<string, Take>;
  readonly staged: Map<string, Take | undefined>;

  constructor(base: readonly Take[] | undefined) {
    this.byId = new Map((base ?? []).map((take) => [take.id, take]));
    this.staged = new Map();
  }

  get(id: string): Take | undefined {
    return this.staged.has(id) ? this.staged.get(id) : this.byId.get(id);
  }

  stage(command: TakeCommand, stage: TakeStage): void {
    if (command.type === "update-take") this.update(command, stage);
    else if (command.type === "prune-takes") this.prune(command.takeIds, stage);
    else if (command.type === "add-take") {
      const { clipIds, activate } = command;
      requireEdit(
        distinctIds(clipIds) && clipIds.length > 0,
        "invalid-selection",
        null,
        "Expected distinct clip IDs",
      );
      requireEdit(
        activate === undefined || typeof activate === "boolean",
        "invalid-take",
        null,
        "Expected a boolean activate flag",
      );
      const id = this.register(command.take, command.takeId);
      for (const clipId of clipIds) {
        const clip = stage.editable(clipId);
        const list = clip.takeIds ?? [];
        this.write(
          stage.clips,
          clip,
          list.includes(id) ? list : [...list, id],
          activate ? id : (clip.activeTakeId ?? null),
        );
      }
    } else {
      const clip = stage.editable(command.clipId);
      const list = clip.takeIds ?? [];
      const active = clip.activeTakeId ?? null;
      if (command.type === "select-take") {
        const { takeId } = command;
        requireEdit(
          takeId === null || (validId(takeId) && list.includes(takeId)),
          "missing-take",
          takeId,
          "The take is not a candidate of this clip",
        );
        this.write(stage.clips, clip, list, takeId);
      } else if (command.type === "remove-take") {
        const { takeId } = command;
        requireEdit(
          validId(takeId) && list.includes(takeId),
          "missing-take",
          takeId,
          "The take is not a candidate of this clip",
        );
        requireEdit(
          active !== takeId,
          "active-take",
          takeId,
          "Select another take before removing the active one",
        );
        this.write(
          stage.clips,
          clip,
          list.filter((id) => id !== takeId),
          active,
        );
      } else if (command.type === "reorder-takes") {
        const { takeIds } = command;
        requireEdit(
          distinctIds(takeIds) &&
            takeIds.length === list.length &&
            takeIds.every((id) => list.includes(id)),
          "invalid-take",
          clip.id,
          "Expected a permutation of the clip's takes",
        );
        this.write(stage.clips, clip, takeIds, active);
      } else {
        requireEdit(false, "unknown-command", null, "Unknown take command");
      }
    }
  }

  // The editor fills in a missing ID before staging a new take or a copy.
  private register(input: unknown, takeId: unknown): string {
    requireEdit(
      (input === undefined) !== (takeId === undefined),
      "invalid-take",
      null,
      "Pass either a new take or an existing take ID",
    );
    if (input === undefined) {
      requireEdit(
        validId(takeId) && this.get(takeId) !== undefined,
        "missing-take",
        takeId,
        "Take does not exist",
      );
      return takeId;
    }
    const record = typeof input === "object" && input !== null ? input : {};
    const id: unknown = Reflect.get(record, "id");
    requireEdit(
      validId(id) && this.get(id) === undefined,
      "invalid-take",
      id,
      "A new take requires an unused ID",
    );
    const assetId: unknown = Reflect.get(record, "assetId");
    const streamId: unknown = Reflect.get(record, "streamId");
    const sourceAtContentZero: unknown = Reflect.get(record, "sourceAtContentZero");
    const label: unknown = Reflect.get(record, "label");
    const extensions: unknown = Reflect.get(record, "extensions");
    requireEdit(
      validId(assetId) && validId(streamId) && sourcePosition(sourceAtContentZero),
      "invalid-take",
      id,
      "A take requires asset and stream IDs and a source position within seven days",
    );
    requireEdit(optionalText(label), "invalid-take", id, "Expected a string label");
    let data: JsonObject | undefined;
    if (extensions !== undefined) {
      const frozen = freezeJson(extensions);
      requireEdit(isRecord(frozen), "invalid-take", id, "Expected an extensions map");
      data = frozen;
    }
    const take: Take = Object.freeze({
      id,
      assetId,
      streamId,
      sourceAtContentZero,
      ...(label === undefined ? {} : { label }),
      ...(data === undefined ? {} : { extensions: data }),
    });
    this.staged.set(id, take);
    return id;
  }

  private update(command: UpdateTakeCommand, stage: TakeStage): void {
    const { takeId, clipIds, newId, label, sourceAtContentZero } = command;
    const take = validId(takeId) ? this.get(takeId) : undefined;
    requireEdit(take, "missing-take", takeId, "Take does not exist");
    requireEdit(optionalText(label), "invalid-take", take.id, "Expected a string label");
    requireEdit(
      sourceAtContentZero === undefined || sourcePosition(sourceAtContentZero),
      "invalid-take",
      take.id,
      "A take's source position is an integer tick within seven days",
    );
    const changes = {
      ...(label === undefined ? {} : { label }),
      ...(sourceAtContentZero === undefined ? {} : { sourceAtContentZero }),
    };
    if (clipIds === undefined) {
      requireEdit(
        newId === undefined,
        "invalid-take",
        newId,
        "Only an update of some clips can copy the take",
      );
      this.staged.set(take.id, Object.freeze({ ...take, ...changes }));
      return;
    }
    requireEdit(
      distinctIds(clipIds) && clipIds.length > 0,
      "invalid-selection",
      null,
      "Expected distinct clip IDs",
    );
    const clips = clipIds.map((clipId) => {
      const clip = stage.editable(clipId);
      requireEdit(
        clip.takeIds?.includes(take.id),
        "missing-take",
        take.id,
        "The take is not a candidate of this clip",
      );
      return clip;
    });
    // Every named clip lists the take, so more listings mean a clip outside the scope.
    if (stage.listings(take.id) <= clips.length) {
      this.staged.set(take.id, Object.freeze({ ...take, ...changes }));
      return;
    }
    const id = newId;
    requireEdit(
      validId(id) && this.get(id) === undefined,
      "invalid-take",
      id,
      "A copied take requires an unused ID",
    );
    this.staged.set(id, Object.freeze({ ...take, ...changes, id, forkedFrom: take.id }));
    for (const clip of clips) {
      this.write(
        stage.clips,
        clip,
        (clip.takeIds ?? []).map((listed) => (listed === take.id ? id : listed)),
        clip.activeTakeId === take.id ? id : (clip.activeTakeId ?? null),
      );
    }
  }

  private prune(takeIds: unknown, stage: TakeStage): void {
    requireEdit(
      takeIds === undefined || distinctIds(takeIds),
      "invalid-take",
      null,
      "Expected distinct take IDs",
    );
    const targets = takeIds ?? new Set([...this.byId.keys(), ...this.staged.keys()]);
    for (const id of targets) {
      const take = this.get(id);
      requireEdit(take || takeIds === undefined, "missing-take", id, "Take does not exist");
      if (!take) continue;
      const listed = stage.listings(id) > 0;
      requireEdit(!listed || takeIds === undefined, "listed-take", id, "A clip lists this take");
      if (!listed) this.staged.set(id, undefined);
    }
  }

  // A clip carries both candidate fields or neither, so each state has one form.
  private write(
    clips: ClipDraft,
    clip: Clip,
    takeIds: readonly string[],
    activeTakeId: string | null,
  ): void {
    const next: Mutable<Clip> = { ...clip };
    if (takeIds.length) {
      if (
        clip.takeIds !== undefined &&
        sameIds(takeIds, clip.takeIds) &&
        clip.activeTakeId === activeTakeId
      )
        return;
      next.takeIds = Object.freeze([...takeIds]);
      next.activeTakeId = activeTakeId;
    } else {
      if (clip.takeIds === undefined) return;
      delete next.takeIds;
      delete next.activeTakeId;
    }
    clips.replace(clip, [next]);
  }

  patches(): readonly TakePatch[] {
    return stagedPatches(this.byId, this.staged);
  }
}

export function invertTakes(patches: readonly TakePatch[]): readonly TakePatch[] {
  return invertRecords(patches);
}

/**
 * Maps recorded take patches onto the current takes by ID. A take's presence
 * follows its listings rather than the recording: replay skips adding a take
 * that already exists, and skips removing one that is gone or that a clip
 * still lists after the replayed clip changes. Updates follow the marker rules.
 */
export function rebaseTakes(
  patches: readonly TakePatch[],
  base: readonly Take[] | undefined,
  listed: (id: string) => boolean,
): readonly TakePatch[] {
  const current = new Map((base ?? []).map((take) => [take.id, take]));
  const kept = patches.filter(({ id, before, after }) =>
    before === undefined
      ? !current.has(id)
      : after !== undefined || (current.has(id) && !listed(id)),
  );
  return rebaseRecords(kept.length === patches.length ? patches : kept, current, checkTake, "take");
}

/** The resulting takes by ID and their canonical list. */
export function applyTakes(
  base: readonly Take[] | undefined,
  patches: readonly TakePatch[],
): { readonly byId: ReadonlyMap<string, Take>; readonly list: readonly Take[] | undefined } {
  const byId = applyRecords(base, patches);
  if (!patches.length) return { byId, list: base };
  const list = [...byId.values()].sort(compareTakes);
  return { byId, list: list.length ? Object.freeze(list) : undefined };
}

/**
 * Checks references after a transaction: every clip that changed lists only
 * existing takes and carries an active take exactly when it has candidates,
 * and no removed take is still listed.
 */
export function checkReferences(
  clips: readonly Clip[],
  patches: readonly TakePatch[],
  takes: ReadonlyMap<string, Take>,
  listings: (id: string) => number,
): void {
  for (const clip of clips) {
    const list = clip.takeIds;
    const active = clip.activeTakeId;
    if (list === undefined) {
      // Replay conflicts on the field before it can leave an active take behind.
      requireEdit(active === undefined, "invalid-take", clip.id, "Clip has no such candidate");
      continue;
    }
    for (const id of list)
      requireEdit(takes.has(id), "missing-take", id, "Clip lists a missing take");
    requireEdit(
      list.length > 0 && (active === null || (active !== undefined && list.includes(active))),
      "invalid-take",
      clip.id,
      "The active take must be one of the clip's takes",
    );
  }
  // Pruning checks listings while staging and replay skips a listed take, so
  // this guards the invariant itself.
  for (const { id, after } of patches)
    requireEdit(
      after !== undefined || listings(id) === 0,
      "listed-take",
      id,
      "A clip lists this take",
    );
}

/** Whether a take patch changes what its clips play. */
export function remapsMedia({ before, after }: TakePatch): boolean {
  return (
    before !== undefined &&
    after !== undefined &&
    (before.assetId !== after.assetId ||
      before.streamId !== after.streamId ||
      before.sourceAtContentZero !== after.sourceAtContentZero)
  );
}
