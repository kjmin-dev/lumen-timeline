import type { SessionOptions, SyncSession } from "./types.ts";
/**
 * Keeps an editor in step with a sequencer. The session holds two documents:
 * the confirmed one, which only the sequencer's messages change, and the
 * visible editor, which also shows this session's pending transactions. After
 * another participant's entry, it replaces the visible document with the
 * confirmed one and replays what is pending on top.
 */
export declare function connectSession({ id, transport: first, policy, deadline, retry, poll, retain, history, clock, }: SessionOptions): SyncSession;
