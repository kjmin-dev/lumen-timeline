import type { EditErrorCode, JsonObject, JsonValue } from "./types.ts";

export class EditError extends Error {
  override name = "EditError";
  readonly code: EditErrorCode;
  /** The rejected ID or value as supplied, which may be invalid input. */
  readonly target: unknown;

  constructor(code: EditErrorCode, target: unknown, message: string) {
    super(message);
    this.code = code;
    this.target = target;
  }
}

export function requireEdit(
  condition: unknown,
  code: EditErrorCode,
  target: unknown,
  reason: string,
): asserts condition {
  if (!condition) throw new EditError(code, target, reason);
}

/** `Array.isArray`, typed so that a successful check does not introduce `any`. */
export const isArray: (value: unknown) => value is readonly unknown[] = Array.isArray;

export function validId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0;
}

/** A JSON object, as opposed to an array, a primitive or a missing field. */
export function isRecord(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !isArray(value);
}

export const safeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

// Document payloads are JSON data. Cloning before freezing preserves host ownership.
export function freezeJson(value: unknown, ancestors: Set<unknown> = new Set()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  requireEdit(
    value && typeof value === "object",
    "invalid-project",
    null,
    "Expected JSON project data",
  );
  const prototype: unknown = Object.getPrototypeOf(value);
  requireEdit(
    isArray(value) || prototype === null || Object.getPrototypeOf(prototype) === null,
    "invalid-project",
    null,
    "Expected a plain project object",
  );
  requireEdit(!ancestors.has(value), "invalid-project", null, "Project data contains a cycle");
  ancestors.add(value);
  const copy: JsonValue = isArray(value)
    ? Array.from(value, (item) => freezeJson(item, ancestors))
    : Object.fromEntries(
        Object.entries(value).map(([key, item]: [string, unknown]) => [
          key,
          freezeJson(item, ancestors),
        ]),
      );
  ancestors.delete(value);
  return Object.freeze(copy);
}
