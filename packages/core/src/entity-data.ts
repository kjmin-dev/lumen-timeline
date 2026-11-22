import type {
  DataCommand,
  DataPatch,
  EntityData,
  EntityFields,
  EntityRecords,
  JsonValue,
} from "./types.ts";
import { freezeJson, isArray, isRecord, requireEdit, validId } from "./validation.ts";

type Dictionary<T> = { readonly [key: string]: T };

const own = <T>(object: Dictionary<T> | undefined, key: string): T | undefined =>
  object && Object.hasOwn(object, key) ? object[key] : undefined;

// Canonical sparse maps omit empty buckets, including on JSON import.
export function normalizeEntityData(data: JsonValue | undefined): EntityData | undefined {
  if (data === undefined) return data;
  requireEdit(isRecord(data), "invalid-project", null, "Expected an entityData map");
  const scopes: [string, EntityRecords][] = [];
  for (const [scope, entities] of Object.entries(data)) {
    requireEdit(
      validId(scope) && isRecord(entities),
      "invalid-project",
      scope,
      "Invalid entity data scope",
    );
    const records: [string, EntityFields][] = [];
    for (const [id, fields] of Object.entries(entities)) {
      requireEdit(
        validId(id) && isRecord(fields) && Object.keys(fields).every(validId),
        "invalid-project",
        id,
        "Invalid entity data fields",
      );
      if (Object.keys(fields).length) records.push([id, fields]);
    }
    if (records.length) scopes.push([scope, Object.freeze(Object.fromEntries(records))]);
  }
  return scopes.length ? Object.freeze(Object.fromEntries(scopes)) : undefined;
}

function read(
  data: EntityData | undefined,
  scope: string,
  id: string,
  key: string,
): JsonValue | undefined {
  return own(own(own(data, scope), id), key);
}

// JSON arrays are dense, so comparing indices matches comparing own keys.
/** Deep equality of frozen JSON values. `undefined` equals only itself. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (isArray(a) || isArray(b)) {
    return (
      isArray(a) &&
      isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => jsonEqual(item, b[index]))
    );
  }
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => {
      const left: unknown = Reflect.get(a, key);
      const right: unknown = Reflect.get(b, key);
      return Object.hasOwn(b, key) && jsonEqual(left, right);
    })
  );
}

const equal = jsonEqual;

// undefined represents absence within the journal. All persisted values are JSON.
export class DataDraft {
  readonly base: EntityData | undefined;
  readonly writes: Map<string, DataPatch>;

  constructor(base: EntityData | undefined) {
    this.base = base;
    this.writes = new Map();
  }

  stage(command: DataCommand): void {
    const { scope, id, key } = command;
    requireEdit(
      [scope, id, key].every(validId),
      "invalid-data-key",
      id,
      "Expected nonempty scope, entity ID and field key",
    );
    const path = JSON.stringify([scope, id, key]);
    const before = read(this.base, scope, id, key);
    const after = command.type === "remove-data" ? undefined : freezeJson(command.value);
    if (equal(before, after)) this.writes.delete(path);
    else this.writes.set(path, Object.freeze({ scope, id, key, before, after }));
  }

  /** The field as staged so far in this transaction. */
  current(scope: string, id: string, key: string): JsonValue | undefined {
    const write = this.writes.get(JSON.stringify([scope, id, key]));
    return write ? write.after : read(this.base, scope, id, key);
  }

  patches(): readonly DataPatch[] {
    return Object.freeze([...this.writes.values()]);
  }
}

export function invertData(patches: readonly DataPatch[]): readonly DataPatch[] {
  return Object.freeze(
    patches.map((p) => Object.freeze({ ...p, before: p.after, after: p.before })),
  );
}

interface ScopeDraft {
  readonly records: Map<string, EntityFields>;
  readonly edited: Map<string, Map<string, JsonValue>>;
}

const emptyRecords: EntityRecords = Object.freeze({});
const emptyFields: EntityFields = Object.freeze({});

// Maps keep insertion order and treat every ID and field name, including
// "__proto__", as an ordinary key. Object.fromEntries defines own properties.
export function applyData(
  base: EntityData | undefined,
  patches: readonly DataPatch[],
): EntityData | undefined {
  if (!patches.length) return base;
  const data = new Map<string, EntityRecords>(Object.entries(base ?? {}));
  const scopes = new Map<string, ScopeDraft>();
  for (const { scope, id, key, before, after } of patches) {
    requireEdit(
      equal(read(base, scope, id, key), before),
      "history-conflict",
      id,
      "Entity data changed at " + JSON.stringify([scope, id, key]),
    );
    let draft = scopes.get(scope);
    if (!draft) {
      draft = { records: new Map(Object.entries(own(base, scope) ?? {})), edited: new Map() };
      scopes.set(scope, draft);
      // Reserve the scope's position, as assigning a new key would.
      data.set(scope, data.get(scope) ?? emptyRecords);
    }
    let fields = draft.edited.get(id);
    if (!fields) {
      fields = new Map(Object.entries(draft.records.get(id) ?? {}));
      draft.edited.set(id, fields);
      draft.records.set(id, draft.records.get(id) ?? emptyFields);
    }
    if (after === undefined) fields.delete(key);
    else fields.set(key, after);
  }
  for (const [scope, { records, edited }] of scopes) {
    for (const [id, fields] of edited) {
      if (fields.size) records.set(id, Object.freeze(Object.fromEntries(fields)));
      else records.delete(id);
    }
    if (records.size) data.set(scope, Object.freeze(Object.fromEntries(records)));
    else data.delete(scope);
  }
  return data.size ? Object.freeze(Object.fromEntries(data)) : undefined;
}
