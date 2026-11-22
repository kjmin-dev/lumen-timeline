import type { ClipDraft } from "./clip-patches.ts";
import { applyRecords, invertRecords, rebaseRecords, stagedPatches } from "./record-patches.ts";
import type {
  Clip,
  ClipPatch,
  JsonObject,
  JsonValue,
  Take,
  TakeCommand,
  TakePatch,
} from "./types.ts";
import { freezeJson, isArray, isRecord, requireEdit, safeInteger, validId } from "./validation.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function compareTakes(a: Take, b: Take): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const optionalText = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

/** Checks the typed fields of a take. A take's own ID was checked by the caller. */
function checkTake(take: Take): void {
  requireEdit(
    validId(take.assetId) && validId(take.streamId),
    "invalid-take",
    take.id,
    "A take requires asset and stream IDs",
  );
  requireEdit(
    safeInteger(take.sourceAtContentZero),
    "invalid-take",
    take.id,
    "A take's source origin is an integer tick",
  );
  requireEdit(optionalText(take.label), "invalid-take", take.id, "Expected a string label");
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
    validId(assetId) && validId(streamId) && safeInteger(sourceAtContentZero),
    "invalid-take",
    id,
    "A take requires asset and stream IDs and an integer source origin",
  );
  const label = record["label"];
  const extensions = record["extensions"];
  requireEdit(optionalText(label), "invalid-take", id, "Expected a string label");
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
    ...(extensions === undefined ? {} : { extensions }),
  });
}

/**
 * Parses a loaded clip's candidate list. Returns `undefined` for an absent or
 * empty list. With a list, the active take must be `null` or listed.
 */
export function parseTakeIds(
  id: string,
  takeIds: JsonValue | undefined,
  activeTakeId: string | null | undefined,
): readonly string[] | undefined {
  if (takeIds === undefined) return undefined;
  requireEdit(
    isArray(takeIds) && takeIds.every(validId) && new Set(takeIds).size === takeIds.length,
    "invalid-take",
    id,
    "Expected distinct take IDs",
  );
  const list = takeIds.filter(validId);
  requireEdit(
    activeTakeId === undefined || activeTakeId === null || list.includes(activeTakeId),
    "invalid-take",
    id,
    "The active take must be one of the clip's takes",
  );
  return list.length ? Object.freeze(list) : undefined;
}

/** Counts how many clips list each take. */
export function countReferences(clips: readonly Clip[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const clip of clips)
    for (const id of clip.takeIds ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

/** Checks that every listed take exists and every take is listed by a clip. */
export function checkLoadedReferences(
  takes: ReadonlyMap<string, Take>,
  counts: ReadonlyMap<string, number>,
  clips: readonly Clip[],
): void {
  for (const clip of clips)
    for (const id of clip.takeIds ?? [])
      requireEdit(takes.has(id), "invalid-take", clip.id, "Clip lists a missing take: " + id);
  for (const id of takes.keys())
    requireEdit(counts.has(id), "invalid-take", id, "No clip lists this take");
}

/** The change in each take's reference count across clip patches. */
export function referenceDelta(patches: readonly ClipPatch[]): Map<string, number> {
  const delta = new Map<string, number>();
  for (const patch of patches) {
    for (const clip of patch.before)
      for (const id of clip.takeIds ?? []) delta.set(id, (delta.get(id) ?? 0) - 1);
    for (const clip of patch.after)
      for (const id of clip.takeIds ?? []) delta.set(id, (delta.get(id) ?? 0) + 1);
  }
  return delta;
}

function sameIds(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return a === b || (!!a && !!b && a.length === b.length && a.every((id, i) => id === b[i]));
}

function sameActive(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
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

  /**
   * `editable` returns the current version of an existing clip on an unlocked
   * track. `newId` allocates a take ID that `taken` rejects.
   */
  stage(
    command: TakeCommand,
    clips: ClipDraft,
    editable: (id: string) => Clip,
    newId: (taken: (id: string) => boolean) => string,
  ): void {
    if (command.type === "update-take") {
      this.update(command.takeId, command.label, command.sourceAtContentZero);
      return;
    }
    if (command.type === "add-take") {
      const { clipIds, activate } = command;
      requireEdit(
        isArray(clipIds) &&
          clipIds.length > 0 &&
          clipIds.every(validId) &&
          new Set(clipIds).size === clipIds.length,
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
      const id = this.register(command.take, command.takeId, newId);
      for (const clipId of clipIds) {
        const clip = editable(clipId);
        const list = clip.takeIds ?? [];
        const next = list.includes(id) ? list : [...list, id];
        const active = activate ? id : clip.activeTakeId;
        requireEdit(
          active === undefined || active === null || next.includes(active),
          "invalid-take",
          clipId,
          "Add the clip's active take as a candidate first",
        );
        this.write(clips, clip, next, active);
      }
      return;
    }
    const clip = editable(command.clipId);
    const list = clip.takeIds ?? [];
    if (command.type === "select-take") {
      const { takeId } = command;
      requireEdit(
        takeId === null || (validId(takeId) && list.includes(takeId)),
        "missing-take",
        takeId,
        "The take is not a candidate of this clip",
      );
      this.write(clips, clip, clip.takeIds, takeId);
    } else if (command.type === "remove-take") {
      const { takeId } = command;
      requireEdit(
        validId(takeId) && list.includes(takeId),
        "missing-take",
        takeId,
        "The take is not a candidate of this clip",
      );
      requireEdit(
        clip.activeTakeId !== takeId,
        "active-take",
        takeId,
        "Select another take before removing the active one",
      );
      this.write(
        clips,
        clip,
        list.filter((id) => id !== takeId),
        clip.activeTakeId,
      );
    } else if (command.type === "reorder-takes") {
      const { takeIds } = command;
      requireEdit(
        isArray(takeIds) &&
          takeIds.length === list.length &&
          new Set(takeIds).size === takeIds.length &&
          takeIds.every((id) => validId(id) && list.includes(id)),
        "invalid-take",
        clip.id,
        "Expected a permutation of the clip's takes",
      );
      this.write(clips, clip, takeIds.filter(validId), clip.activeTakeId);
    } else {
      requireEdit(false, "unknown-command", null, "Unknown take command");
    }
  }

  private register(
    input: unknown,
    takeId: unknown,
    newId: (taken: (id: string) => boolean) => string,
  ): string {
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
    const given: unknown = Reflect.get(record, "id");
    const id =
      given === undefined ? newId((candidate) => this.get(candidate) !== undefined) : given;
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
      validId(assetId) && validId(streamId) && safeInteger(sourceAtContentZero),
      "invalid-take",
      id,
      "A take requires asset and stream IDs and an integer source origin",
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

  private update(takeId: unknown, label: unknown, sourceAtContentZero: unknown): void {
    const take = validId(takeId) ? this.get(takeId) : undefined;
    requireEdit(take, "missing-take", takeId, "Take does not exist");
    requireEdit(optionalText(label), "invalid-take", take.id, "Expected a string label");
    requireEdit(
      sourceAtContentZero === undefined || safeInteger(sourceAtContentZero),
      "invalid-take",
      take.id,
      "A take's source origin is an integer tick",
    );
    this.staged.set(
      take.id,
      Object.freeze({
        ...take,
        ...(label === undefined ? {} : { label }),
        ...(sourceAtContentZero === undefined ? {} : { sourceAtContentZero }),
      }),
    );
  }

  // Lists equal to the clip's current or original list keep that array, so a
  // net-zero sequence of commands leaves the clip unchanged.
  private write(
    clips: ClipDraft,
    clip: Clip,
    takeIds: readonly string[] | undefined,
    activeTakeId: string | null | undefined,
  ): void {
    const original = clips.original(clip.id);
    const list = !takeIds?.length
      ? undefined
      : sameIds(takeIds, clip.takeIds)
        ? clip.takeIds
        : sameIds(takeIds, original?.takeIds)
          ? original?.takeIds
          : Object.freeze([...takeIds]);
    if (sameIds(list, clip.takeIds) && sameActive(activeTakeId, clip.activeTakeId)) return;
    const next: Mutable<Clip> = { ...clip };
    if (list === undefined) delete next.takeIds;
    else next.takeIds = list;
    if (!sameActive(activeTakeId, clip.activeTakeId)) {
      // Restoring the original value restores its representation, absent or null.
      const restored = original && sameActive(activeTakeId, original.activeTakeId);
      const kept = original?.activeTakeId;
      if (restored && kept !== undefined) next.activeTakeId = kept;
      else if (restored) delete next.activeTakeId;
      else next.activeTakeId = activeTakeId ?? null;
    }
    clips.replace(clip, [next]);
  }

  /** Stages the removal of every take whose reference count drops to zero. */
  collect(counts: ReadonlyMap<string, number>, delta: ReadonlyMap<string, number>): void {
    const candidates = new Set([...delta.keys(), ...this.staged.keys()]);
    for (const id of candidates) {
      if (this.get(id) === undefined) continue;
      if ((counts.get(id) ?? 0) + (delta.get(id) ?? 0) === 0) this.staged.set(id, undefined);
    }
  }

  patches(): readonly TakePatch[] {
    return stagedPatches(this.byId, this.staged);
  }
}

export function invertTakes(patches: readonly TakePatch[]): readonly TakePatch[] {
  return invertRecords(patches);
}

/** Maps recorded take patches onto the current takes by ID. */
export function rebaseTakes(
  patches: readonly TakePatch[],
  base: readonly Take[] | undefined,
): readonly TakePatch[] {
  const current = new Map((base ?? []).map((take) => [take.id, take]));
  return rebaseRecords(patches, current, checkTake, "take");
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
 * existing takes and an active take from its list, and every take that
 * changed is listed exactly when it exists.
 */
export function checkReferences(
  clips: readonly Clip[],
  patches: readonly TakePatch[],
  takes: ReadonlyMap<string, Take>,
  counts: (id: string) => number,
): void {
  for (const clip of clips) {
    const list = clip.takeIds;
    if (list === undefined) continue;
    for (const id of list)
      requireEdit(takes.has(id), "missing-take", id, "Clip lists a missing take");
    requireEdit(
      clip.activeTakeId === undefined ||
        clip.activeTakeId === null ||
        list.includes(clip.activeTakeId),
      "invalid-take",
      clip.id,
      "The active take must be one of the clip's takes",
    );
  }
  // Edits collect unlisted takes, so only an inconsistent replay can list a
  // removed take. The second check guards the no-orphan invariant itself.
  for (const { id, after } of patches) {
    if (after === undefined)
      requireEdit(counts(id) === 0, "invalid-take", id, "A listed take cannot be removed");
    else requireEdit(counts(id) > 0, "invalid-take", id, "No clip lists this take");
  }
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
