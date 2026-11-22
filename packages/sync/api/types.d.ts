import type { EditCommand, Editor, HistoryLimits, JsonObject, Project, ProjectSnapshot } from "@lumen-timeline/core";
/** Each actor's last processed sequence number. */
export type ActorTable = {
    readonly [actor: string]: number;
};
/**
 * Join, or rejoin after a disconnect. `revision` is the last confirmed
 * revision the editor holds, `null` when it holds none. `n` is the highest
 * sequence number the editor will never send again.
 */
export interface HelloMessage {
    readonly type: "hello";
    readonly project: string;
    readonly revision: number | null;
    readonly actor?: string | undefined;
    readonly n: number;
}
/** Start from this project at `revision`, under `actor`. */
export interface SnapshotMessage {
    readonly type: "snapshot";
    readonly actor: string;
    readonly revision: number;
    readonly project: ProjectSnapshot;
    readonly actors: ActorTable;
    /** The actor's last processed sequence number. */
    readonly n: number;
}
/** The accepted entries the editor lacked came first; it is now current. */
export interface JoinedMessage {
    readonly type: "joined";
    readonly actor: string;
    readonly revision: number;
    readonly n: number;
}
/** A hello for another project. */
export interface RefusedMessage {
    readonly type: "refused";
    readonly reason: string;
}
/** One local transaction, numbered from 1 for its actor. */
export interface SubmitMessage {
    readonly type: "submit";
    readonly actor: string;
    readonly n: number;
    readonly commands: readonly EditCommand[];
}
/** Entry `revision` of the shared history: the commands the sequencer applied. */
export interface AcceptedMessage {
    readonly type: "accepted";
    readonly revision: number;
    readonly actor: string;
    readonly n: number;
    readonly commands: readonly EditCommand[];
}
/** The transaction did not fit. `unchanged` when it would have changed nothing. */
export interface RejectedMessage {
    readonly type: "rejected";
    readonly actor: string;
    readonly n: number;
    readonly code: string;
    readonly target: unknown;
    readonly reason: string;
}
/** Selection, playhead or any host field. Not ordered or stored: the last value wins. */
export interface PresenceMessage {
    readonly type: "presence";
    readonly actor: string;
    readonly state: JsonObject;
}
/** A JSON message between editors and the sequencer. */
export type SyncMessage = HelloMessage | SnapshotMessage | JoinedMessage | RefusedMessage | SubmitMessage | AcceptedMessage | RejectedMessage | PresenceMessage;
/** One connection between an editor and the sequencer. The host carries the messages. */
export interface SyncTransport {
    send(message: SyncMessage): void;
    onMessage(listener: (message: SyncMessage) => void): () => unknown;
}
/** What a new sequencer resumes from, and what each session can supply for it. */
export interface SequencerState {
    readonly project: ProjectSnapshot;
    readonly actors: ActorTable;
    /** Accepted entries up to `project.revision`, oldest first. */
    readonly log: readonly AcceptedMessage[];
}
/** A submitted transaction, as the host's review sees it before it applies. */
export interface Submission {
    readonly actor: string;
    readonly n: number;
    readonly commands: readonly EditCommand[];
    /** The document the transaction would apply to. */
    readonly snapshot: ProjectSnapshot;
}
/** Apply other commands instead, or reject the transaction for the host's own reason. */
export type Review = {
    readonly commands: readonly EditCommand[];
    readonly reject?: undefined;
} | {
    readonly reject: string;
    readonly commands?: undefined;
};
export interface SequencerOptions {
    /** Names the project. A hello for another one is refused. */
    readonly id: string;
    /** The project to start from, or the state of a sequencer to resume. */
    readonly project: Project | SequencerState;
    /** Decides each transaction before it applies. Returning nothing applies it as sent. */
    readonly review?: ((submission: Submission) => Review | undefined) | undefined;
    /** Accepted entries kept for editors that rejoin. Defaults to 1000. */
    readonly retain?: number | undefined;
    /** Issues an actor for a new session. Defaults to random. */
    readonly newActor?: (() => string) | undefined;
}
export interface Sequencer {
    /** Serves one editor's connection until the returned function ends it. */
    connect(transport: SyncTransport): () => void;
    getSnapshot(): ProjectSnapshot;
    /** The project, actor table and retained log, for storage or a successor. */
    state(): SequencerState;
    dispose(): void;
}
/**
 * How an editor treats its own edits. `queue` applies them at once and sends
 * them when it can. `online` does the same while connected and turns read-only
 * while not, rolling unconfirmed edits back after the deadline. `confirmed`
 * holds each edit until the sequencer accepts it and turns read-only while
 * disconnected, discarding held edits.
 */
export type ConfirmationPolicy = "queue" | "online" | "confirmed";
/** A clock for deadlines and retries. Tests pass a manual one. */
export interface SyncClock {
    now(): number;
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}
export interface SessionOptions {
    readonly id: string;
    readonly transport: SyncTransport;
    /** Defaults to `queue`. */
    readonly policy?: ConfirmationPolicy | undefined;
    /**
     * Milliseconds. Under `online`, how long unconfirmed edits wait for a
     * reconnect before they roll back. Under `confirmed`, how long a held edit
     * waits for the sequencer before it is discarded. Defaults to 30000.
     */
    readonly deadline?: number | undefined;
    /** Milliseconds without an answer before the session rejoins. Defaults to 1000. */
    readonly retry?: number | undefined;
    /**
     * Milliseconds between checks for entries an idle session may have missed,
     * as when the last broadcast was lost. Zero turns polling off. Defaults to 5000.
     */
    readonly poll?: number | undefined;
    /** Accepted entries kept for a successor sequencer. Defaults to 1000. */
    readonly retain?: number | undefined;
    readonly history?: HistoryLimits | undefined;
    readonly clock?: SyncClock | undefined;
}
export type SessionStatus = "connecting" | "connected" | "disconnected";
/** What the session tells its host. Each report names the commands it concerns. */
export type SyncReport = {
    readonly type: "status";
    readonly status: SessionStatus;
}
/** How many transactions wait for the sequencer. */
 | {
    readonly type: "pending";
    readonly count: number;
} | {
    readonly type: "rejected";
    readonly code: string;
    readonly target: unknown;
    readonly reason: string;
    readonly commands: readonly EditCommand[];
}
/** A transaction not yet sent no longer applies, so it will not be sent. */
 | {
    readonly type: "dropped";
    readonly code: string;
    readonly reason: string;
    readonly commands: readonly EditCommand[];
}
/** Processed while the session was out of contact. The confirmed document shows the outcome. */
 | {
    readonly type: "settled";
    readonly commands: readonly EditCommand[];
}
/** Unconfirmed edits rolled back after the reconnect deadline under `online`. */
 | {
    readonly type: "rolled-back";
    readonly transactions: readonly (readonly EditCommand[])[];
}
/** Held edits discarded under `confirmed`. */
 | {
    readonly type: "discarded";
    readonly transactions: readonly (readonly EditCommand[])[];
} | {
    readonly type: "presence";
    readonly actor: string;
    readonly state: JsonObject;
} | {
    readonly type: "refused";
    readonly reason: string;
};
export interface SyncSession {
    /** Resolves with the visible editor once the first snapshot arrives. */
    readonly ready: Promise<Editor>;
    /** The editor the host's views use. `null` until ready. */
    readonly editor: Editor | null;
    readonly actor: string | null;
    readonly status: SessionStatus;
    /** Transactions the sequencer has not answered yet. */
    readonly pending: number;
    /** The last revision of the shared history this session holds. */
    readonly revision: number | null;
    subscribe(listener: (report: SyncReport) => void): () => boolean;
    /** Sends presence to the other sessions while connected. */
    presence(state: JsonObject): void;
    /** The connection dropped. The policy decides what editing does now. */
    disconnect(): void;
    /** Rejoins over a new connection. */
    reconnect(transport: SyncTransport): void;
    /** The confirmed project, actor table and log, for a successor sequencer. */
    state(): SequencerState | null;
    /** Stops syncing. The visible editor stays, as an ordinary editor. */
    dispose(): void;
}
