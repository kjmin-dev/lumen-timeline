import type { Sequencer, SequencerOptions } from "./types.ts";
/**
 * Orders transactions from every connected editor. It applies each with the
 * core, in arrival order, rejects what no longer fits and announces the rest
 * as consecutive revisions. Each actor's transactions apply once, in their
 * own order: a resent one is answered again and a later one waits for the
 * one before it.
 */
export declare function createSequencer({ id, project, review, retain, newActor, }: SequencerOptions): Sequencer;
