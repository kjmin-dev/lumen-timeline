import assert from "node:assert/strict";
import type {
  EditCommit,
  EditErrorCode,
  EditResult,
  EditUnchanged,
  EntityData,
  PreviewResult,
  PreviewSuccess,
  ProjectSnapshot,
} from "@lumen-timeline/core";

/** A deeply mutable version of a public type, for fixtures that tests modify. */
export type Draft<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? Draft<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Draft<T[K]> }
      : T;

/** Asserts that an edit or preview succeeded, possibly without changes. */
export function pass(result: EditResult): EditCommit | EditUnchanged;
export function pass(result: PreviewResult): PreviewSuccess;
export function pass(
  result: EditResult | PreviewResult,
): EditCommit | EditUnchanged | PreviewSuccess {
  if (!result.ok) assert.fail(JSON.stringify(result));
  return result;
}

/** Asserts that an edit committed a new revision. */
export function commit(result: EditResult): EditCommit {
  assert.ok(result.ok && !result.unchanged, JSON.stringify(result));
  return result;
}

/** The rejection code, or undefined for a successful result. */
export function codeOf(result: EditResult | PreviewResult): EditErrorCode | undefined {
  return result.ok ? undefined : result.code;
}

/** Asserts that a snapshot carries entity data. */
export function dataOf(snapshot: ProjectSnapshot): EntityData {
  const data = snapshot.entityData;
  assert.ok(data, "Expected entity data");
  return data;
}

/** Reads nested own fields of untyped data, or undefined where a field is missing. */
export function readPath(value: unknown, ...keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, key))
      return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}
