import assert from "node:assert/strict";
import type {
  EditCommit,
  EditErrorCode,
  EditFailure,
  EditResult,
  PreviewResult,
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
export function pass<R extends EditResult | PreviewResult>(result: R): Exclude<R, EditFailure> {
  assert.ok(result.ok, JSON.stringify(result));
  return result as Exclude<R, EditFailure>;
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
