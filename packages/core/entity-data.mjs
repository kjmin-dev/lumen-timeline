import { freezeJson, requireEdit, validId } from "./document.mjs";

const own = (object, key) => (object && Object.hasOwn(object, key) ? object[key] : undefined);
const dictionary = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Canonical sparse maps omit empty buckets, including on JSON import.
export function normalizeEntityData(data) {
  if (data === undefined) return data;
  requireEdit(dictionary(data), "invalid-project", null, "Expected an entityData map");
  const scopes = [];
  for (const [scope, entities] of Object.entries(data)) {
    requireEdit(
      validId(scope) && dictionary(entities),
      "invalid-project",
      scope,
      "Invalid entity data scope",
    );
    const records = [];
    for (const [id, fields] of Object.entries(entities)) {
      requireEdit(
        validId(id) && dictionary(fields) && Object.keys(fields).every(validId),
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

function read(data, scope, id, key) {
  return own(own(own(data, scope), id), key);
}

function equal(a, b) {
  if (Object.is(a, b)) return true;
  if (
    !a ||
    !b ||
    typeof a !== "object" ||
    typeof b !== "object" ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
  );
}

// undefined represents absence within the journal. All persisted values are JSON.
export class DataDraft {
  constructor(base) {
    this.base = base;
    this.writes = new Map();
  }

  stage(command) {
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

  patches() {
    return Object.freeze([...this.writes.values()]);
  }
}

export function invertData(patches) {
  return Object.freeze(
    patches.map((p) => Object.freeze({ ...p, before: p.after, after: p.before })),
  );
}

export function applyData(base, patches) {
  if (!patches.length) return base;
  // Null-prototype drafts treat arbitrary IDs and field names as ordinary keys.
  const copy = (value) => Object.assign(Object.create(null), value);
  const data = copy(base);
  const touched = new Map();
  for (const { scope, id, key, before, after } of patches) {
    requireEdit(
      equal(read(base, scope, id, key), before),
      "history-conflict",
      id,
      "Entity data changed at " + JSON.stringify([scope, id, key]),
    );
    if (!touched.has(scope)) {
      data[scope] = copy(own(base, scope));
      touched.set(scope, new Set());
    }
    const ids = touched.get(scope);
    if (!ids.has(id)) {
      data[scope][id] = copy(own(data[scope], id));
      ids.add(id);
    }
    if (after === undefined) delete data[scope][id][key];
    else data[scope][id][key] = after;
  }
  for (const [scope, ids] of touched) {
    for (const id of ids) {
      const fields = data[scope][id];
      if (Object.keys(fields).length) data[scope][id] = Object.freeze({ ...fields });
      else delete data[scope][id];
    }
    if (Object.keys(data[scope]).length) data[scope] = Object.freeze({ ...data[scope] });
    else delete data[scope];
  }
  return Object.keys(data).length ? Object.freeze({ ...data }) : undefined;
}
