import type { Tick } from "./types.ts";
/** The fields `sequenceDuration` reads from a snapshot. */
export interface SequenceExtent {
    readonly duration?: Tick;
    readonly clips: readonly {
        readonly start: Tick;
        readonly duration: Tick;
    }[];
}
export declare function sequenceDuration(snapshot: SequenceExtent): Tick;
