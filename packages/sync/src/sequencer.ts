import { createEditor } from "@lumen-timeline/core";
import type { EditCommand, Editor, Project } from "@lumen-timeline/core";
import { isMessage, randomActor, validActor } from "./util.ts";
import type {
  AcceptedMessage,
  HelloMessage,
  RejectedMessage,
  Sequencer,
  SequencerOptions,
  SequencerState,
  SubmitMessage,
  SyncMessage,
  SyncTransport,
} from "./types.ts";

interface Connection {
  readonly transport: SyncTransport;
  actor: string | null;
}

function isState(value: Project | SequencerState): value is SequencerState {
  return "log" in value && "actors" in value && "project" in value;
}

/**
 * Orders transactions from every connected editor. It applies each with the
 * core, in arrival order, rejects what no longer fits and announces the rest
 * as consecutive revisions. Each actor's transactions apply once, in their
 * own order: a resent one is answered again and a later one waits for the
 * one before it.
 */
export function createSequencer({
  id,
  project,
  review,
  retain = 1000,
  newActor = randomActor,
}: SequencerOptions): Sequencer {
  const resumed = isState(project) ? project : null;
  const editor: Editor = createEditor({
    project: isState(project) ? project.project : project,
    actor: "sequencer",
    history: { maxEntries: 0 },
  });
  const actors = new Map<string, number>(Object.entries(resumed?.actors ?? {}));
  const log: AcceptedMessage[] = [];
  for (const entry of resumed?.log ?? []) {
    if (entry.revision > editor.getSnapshot().revision) continue;
    log.push(entry);
    actors.set(entry.actor, Math.max(actors.get(entry.actor) ?? 0, entry.n));
  }
  // Rejections each actor may still ask about again, newest last.
  const rejections = new Map<string, RejectedMessage>();
  const connections = new Set<Connection>();
  let disposed = false;

  const key = (actor: string, n: number): string => actor + "\n" + n;
  function send(connection: Connection, message: SyncMessage): void {
    if (connections.has(connection)) connection.transport.send(message);
  }
  function trim(): void {
    while (log.length > retain) log.shift();
    while (rejections.size > retain) {
      const oldest = rejections.keys().next();
      if (oldest.done) break;
      rejections.delete(oldest.value);
    }
  }

  function hello(connection: Connection, message: HelloMessage): void {
    if (message.project !== id) {
      send(connection, { type: "refused", reason: "This sequencer orders another project" });
      return;
    }
    let actor = validActor(message.actor) ? message.actor : null;
    if (actor === null) {
      do actor = newActor();
      while (actors.has(actor));
      actors.set(actor, 0);
    }
    // Numbers the editor will never send again count as processed.
    const floor = Number.isSafeInteger(message.n) && message.n > 0 ? message.n : 0;
    actors.set(actor, Math.max(actors.get(actor) ?? 0, floor));
    connection.actor = actor;
    const snapshot = editor.getSnapshot();
    const n = actors.get(actor) ?? 0;
    const first = log[0];
    const base = first ? first.revision - 1 : snapshot.revision;
    const known = message.revision;
    if (
      message.actor === actor &&
      typeof known === "number" &&
      known >= base &&
      known <= snapshot.revision
    ) {
      for (const entry of log) if (entry.revision > known) send(connection, entry);
      send(connection, { type: "joined", actor, revision: snapshot.revision, n });
      return;
    }
    send(connection, {
      type: "snapshot",
      actor,
      revision: snapshot.revision,
      project: snapshot,
      actors: Object.fromEntries(actors),
      n,
    });
  }

  function reject(
    connection: Connection,
    actor: string,
    n: number,
    code: string,
    target: unknown,
    reason: string,
  ): void {
    const message: RejectedMessage = { type: "rejected", actor, n, code, target, reason };
    rejections.set(key(actor, n), message);
    trim();
    send(connection, message);
  }

  function submit(connection: Connection, message: SubmitMessage): void {
    const { actor, n } = message;
    if (actor !== connection.actor || !Number.isSafeInteger(n)) return;
    const last = actors.get(actor) ?? 0;
    if (n <= last) {
      // Answer a resent transaction again without applying it.
      const answer =
        log.find((entry) => entry.actor === actor && entry.n === n) ??
        rejections.get(key(actor, n));
      if (answer) send(connection, answer);
      return;
    }
    // A later transaction waits for the one before it to be resent.
    if (n !== last + 1) return;
    actors.set(actor, n);
    let commands: readonly EditCommand[] = Array.isArray(message.commands) ? message.commands : [];
    const decision = review?.({ actor, n, commands, snapshot: editor.getSnapshot() });
    if (decision?.reject !== undefined) {
      reject(connection, actor, n, "refused", null, decision.reject);
      return;
    }
    if (decision?.commands) commands = decision.commands;
    let result;
    try {
      result = editor.dispatch(commands, { history: "ignore" });
    } catch (error) {
      reject(connection, actor, n, "invalid", null, String(error));
      return;
    }
    if (!result.ok) {
      reject(connection, actor, n, result.code, result.target ?? null, result.reason);
      return;
    }
    if (result.unchanged) {
      reject(connection, actor, n, "unchanged", null, "The transaction changed nothing");
      return;
    }
    const entry: AcceptedMessage = {
      type: "accepted",
      revision: result.revision,
      actor,
      n,
      commands: result.commands,
    };
    log.push(entry);
    trim();
    for (const other of connections) send(other, entry);
  }

  return {
    connect(transport) {
      if (disposed) throw new Error("Sequencer disposed");
      const connection: Connection = { transport, actor: null };
      connections.add(connection);
      const off = transport.onMessage((message) => {
        if (!connections.has(connection) || !isMessage(message)) return;
        if (message.type === "hello") hello(connection, message);
        else if (message.type === "submit") submit(connection, message);
        else if (message.type === "presence" && message.actor === connection.actor)
          for (const other of connections) if (other !== connection) send(other, message);
      });
      return () => {
        connections.delete(connection);
        off();
      };
    },
    getSnapshot: () => editor.getSnapshot(),
    state: () => ({
      project: editor.getSnapshot(),
      actors: Object.fromEntries(actors),
      log: [...log],
    }),
    dispose() {
      disposed = true;
      connections.clear();
      editor.dispose();
    },
  };
}
