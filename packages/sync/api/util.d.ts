import type { SyncMessage } from "./types.ts";
/** A value that names a known message type. Each handler checks its own fields. */
export declare function isMessage(value: unknown): value is SyncMessage;
/** An actor name the core accepts: nonempty, and safe as an ID prefix. */
export declare function validActor(value: unknown): value is string;
/** A random actor of twelve lowercase letters and digits. */
export declare function randomActor(): string;
/**
 * Whether two JSON values hold the same data, whatever the order of their
 * keys. Values that are one object are equal without a look inside, which is
 * most of two snapshots that share their records.
 */
export declare function sameJson(a: unknown, b: unknown): boolean;
/** JSON with object keys sorted and undefined fields dropped, for comparing values. */
export declare function canonical(value: unknown): string;
