import type { SyncTransport } from "./types.ts";
export interface LinkOptions {
    /** Defaults to `Math.random`. Tests pass a seeded generator. */
    readonly random?: (() => number) | undefined;
    /** The chance that a message is lost. */
    readonly loss?: number | undefined;
    /** The chance that a delivered message arrives again in a later flush. */
    readonly duplicate?: number | undefined;
    /** Delivers each flush in a random order. */
    readonly reorder?: boolean | undefined;
}
/** Two ends of an in-memory connection, delivered when the test says so. */
export interface MemoryLink {
    /** Give this end to `connectSession`. */
    readonly editor: SyncTransport;
    /** Give this end to `sequencer.connect`. */
    readonly sequencer: SyncTransport;
    /** Messages waiting in either direction. */
    readonly queued: number;
    /**
     * Delivers the messages queued so far, in both directions, as JSON copies.
     * Messages sent during delivery wait for the next flush. Returns how many arrived.
     */
    flush(): number;
    /** Changes how later flushes deliver. */
    configure(options: LinkOptions): void;
}
/** An in-memory connection for tests, with optional loss, duplication and reordering. */
export declare function createLink(options?: LinkOptions): MemoryLink;
