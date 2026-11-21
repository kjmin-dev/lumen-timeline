import type { Tick } from "./types.ts";
/** The fields `sequenceDuration` reads from a snapshot. */
export interface SequenceExtent {
    readonly duration?: Tick;
    readonly clips: readonly {
        readonly start: Tick;
        readonly duration: Tick;
    }[];
    readonly markers?: readonly {
        readonly start: Tick;
    }[];
}
/**
 * The explicit duration, or else the end of the last clip or the last marker,
 * whichever is later. An empty sequence has zero length.
 */
export declare function sequenceDuration(snapshot: SequenceExtent): Tick;
