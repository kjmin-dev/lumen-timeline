import type { EditErrorCode, JsonObject, JsonValue } from "./types.ts";
export declare class EditError extends Error {
    name: string;
    readonly code: EditErrorCode;
    /** The rejected ID or value as supplied, which may be invalid input. */
    readonly target: unknown;
    constructor(code: EditErrorCode, target: unknown, message: string);
}
export declare function requireEdit(condition: unknown, code: EditErrorCode, target: unknown, reason: string): asserts condition;
/** `Array.isArray`, typed so that a successful check does not introduce `any`. */
export declare const isArray: (value: unknown) => value is readonly unknown[];
export declare function validId(id: unknown): id is string;
/** A JSON object, as opposed to an array, a primitive or a missing field. */
export declare function isRecord(value: JsonValue | undefined): value is JsonObject;
export declare const safeInteger: (value: unknown) => value is number;
export declare function freezeJson(value: unknown, ancestors?: Set<unknown>): JsonValue;
