import { createEditor } from "@lumen-timeline/core";
import type {
  CommitHistory,
  EditCommand,
  EditCommit,
  Editor,
  GateDecision,
  GatedTransaction,
  ProjectSnapshot,
} from "@lumen-timeline/core";
import { canonical, isMessage } from "./util.ts";
import type {
  AcceptedMessage,
  JoinedMessage,
  RejectedMessage,
  SessionOptions,
  SessionStatus,
  SnapshotMessage,
  SyncClock,
  SyncMessage,
  SyncReport,
  SyncSession,
} from "./types.ts";

/** A local transaction the sequencer has not answered. */
interface Pending {
  /** Assigned when it is first sent. */
  n: number | null;
  readonly commands: readonly EditCommand[];
  /** How the user made it: a recorded or ignored edit, an undo or a redo. */
  readonly history: CommitHistory;
  /** The visible commit that applied it, or `null` while it is held. */
  commit: EditCommit | null;
  readonly held: boolean;
  sentAt: number | null;
}

function defaultClock(): SyncClock {
  const set: unknown = Reflect.get(globalThis, "setTimeout");
  const clear: unknown = Reflect.get(globalThis, "clearTimeout");
  return {
    now: () => Date.now(),
    setTimeout(callback, ms) {
      if (typeof set !== "function") return undefined;
      const handle: unknown = Reflect.apply(set, globalThis, [callback, ms]);
      return handle;
    },
    clearTimeout(handle) {
      if (typeof clear === "function") Reflect.apply(clear, globalThis, [handle]);
    },
  };
}

const withoutRevision = ({ revision: _revision, ...rest }: ProjectSnapshot): string =>
  canonical(rest);

/**
 * Keeps an editor in step with a sequencer. The session holds two documents:
 * the confirmed one, which only the sequencer's messages change, and the
 * visible editor, which also shows this session's pending transactions. After
 * another participant's entry, it replaces the visible document with the
 * confirmed one and replays what is pending on top.
 */
export function connectSession({
  id,
  transport: first,
  policy = "queue",
  deadline = 30000,
  retry = 1000,
  poll = 5000,
  retain = 1000,
  history,
  clock = defaultClock(),
}: SessionOptions): SyncSession {
  let transport = first;
  let status: SessionStatus = "connecting";
  let actor: string | null = null;
  let visible: Editor | null = null;
  let confirmed: Editor | null = null;
  let offVisible: () => unknown = () => {};
  const pending: Pending[] = [];
  // The last sequence number assigned.
  let next = 0;
  const actors = new Map<string, number>();
  const log: AcceptedMessage[] = [];
  // Set while the session itself edits the visible editor.
  let replaying = false;
  // Ask for a snapshot rather than the entries after this revision.
  let refresh = false;
  let disposed = false;
  let retryTimer: unknown = null;
  // A retry waits for answers; a poll checks for entries an idle session missed.
  let timerKind: "retry" | "poll" | null = null;
  let deadlineTimer: unknown = null;
  const listeners = new Set<(report: SyncReport) => void>();
  const { promise: ready, resolve, reject: fail } = Promise.withResolvers<Editor>();
  // A session disposed before it is ready rejects `ready`, which a host may not await.
  ready.catch(() => {});

  function report(message: SyncReport): void {
    // oxlint-disable-next-line unicorn/no-useless-spread -- Listeners may unsubscribe during delivery.
    for (const listener of [...listeners]) listener(message);
  }
  function setStatus(next: SessionStatus): void {
    if (status === next) return;
    status = next;
    report({ type: "status", status });
  }
  // Every number up to here is answered or abandoned, so it is never sent again.
  function floor(): number {
    let lowest = Infinity;
    for (const item of pending) if (item.n !== null && item.n < lowest) lowest = item.n;
    return lowest === Infinity ? next : lowest - 1;
  }
  function hello(): void {
    transport.send({
      type: "hello",
      project: id,
      revision: refresh ? null : (confirmed?.getSnapshot().revision ?? null),
      ...(actor === null ? {} : { actor }),
      n: floor(),
    });
    arm();
  }
  function submit(item: Pending): void {
    if (actor === null) return;
    if (item.n === null) item.n = ++next;
    item.sentAt = clock.now();
    transport.send({ type: "submit", actor, n: item.n, commands: item.commands });
    arm();
  }
  function enqueue(item: Pending): void {
    pending.push(item);
    if (status === "connected") submit(item);
    report({ type: "pending", count: pending.length });
  }
  function remove(item: Pending): void {
    const index = pending.indexOf(item);
    if (index >= 0) pending.splice(index, 1);
  }

  function stopTimer(): void {
    if (retryTimer !== null) clock.clearTimeout(retryTimer);
    retryTimer = null;
    timerKind = null;
  }
  // One timer serves rejoining, polling and the confirmation deadline.
  function arm(): void {
    if (disposed || status === "disconnected") return;
    const kind =
      status === "connecting" || pending.some((item) => item.sentAt !== null)
        ? "retry"
        : poll > 0
          ? "poll"
          : null;
    if (kind === timerKind || (kind === null && retryTimer === null)) return;
    // A retry replaces a slower poll; a poll waits for a retry already set.
    if (kind === "poll" && timerKind === "retry") return;
    stopTimer();
    if (kind === null) return;
    timerKind = kind;
    retryTimer = clock.setTimeout(tick, kind === "retry" ? retry : poll);
  }
  function tick(): void {
    retryTimer = null;
    timerKind = null;
    if (disposed || status === "disconnected") return;
    const now = clock.now();
    if (policy === "confirmed") {
      const late = pending.filter(
        (item) => item.held && item.sentAt !== null && now - item.sentAt >= deadline,
      );
      if (late.length) discard(late);
    }
    const sent = pending.filter((item) => item.sentAt !== null);
    // Rejoin when connecting, when an answer is overdue, or when an idle poll is due.
    if (
      status === "connecting" ||
      !sent.length ||
      sent.some((item) => item.sentAt !== null && now - item.sentAt >= retry)
    )
      hello();
    else arm();
  }

  // Replays pending transactions over the confirmed document. Each takes over
  // its history entry. One that no longer applies is left out of the visible
  // document. If it was sent, the sequencer still decides it, so it waits for
  // the answer; if not, it is dropped and reported.
  function rebuild(): void {
    if (!visible || !confirmed) return;
    const view = visible;
    replaying = true;
    try {
      view.replace(confirmed.getSnapshot());
      for (const item of pending.slice()) {
        if (item.held) continue;
        const result = view.dispatch(
          item.commands,
          item.commit ? { rebases: item.commit } : { history: "ignore" },
        );
        if (!result.ok) {
          if (item.n !== null) continue;
          remove(item);
          report({
            type: "dropped",
            code: result.code,
            reason: result.reason,
            commands: item.commands,
          });
        } else if (!result.unchanged) item.commit = result;
      }
    } finally {
      replaying = false;
    }
    report({ type: "pending", count: pending.length });
  }

  // Answers for numbers up to `n` that never arrived: the confirmed document
  // shows what happened to them.
  function settle(n: number): boolean {
    let changed = false;
    for (const item of pending.slice()) {
      if (item.n === null || item.n > n) continue;
      remove(item);
      changed ||= !item.held;
      report({ type: "settled", commands: item.commands });
    }
    next = Math.max(next, n);
    return changed;
  }
  function connected(n: number): void {
    if (deadlineTimer !== null) clock.clearTimeout(deadlineTimer);
    deadlineTimer = null;
    setStatus("connected");
    for (const item of pending) if (item.n === null || item.n > n) submit(item);
    arm();
  }

  function adopt(message: SnapshotMessage): void {
    if (actor !== null && message.actor !== actor) return;
    refresh = false;
    actor = message.actor;
    confirmed?.dispose();
    confirmed = createEditor({
      project: message.project,
      actor: "confirmed",
      history: { maxEntries: 0 },
    });
    actors.clear();
    for (const [name, n] of Object.entries(message.actors)) actors.set(name, n);
    log.length = 0;
    settle(message.n);
    if (!visible) {
      const view = createEditor({ project: message.project, actor, history });
      visible = view;
      view.setGate(gate);
      offVisible = view.subscribe(
        (s) => s,
        (_snapshot, commit) => captured(commit),
      );
      connected(message.n);
      resolve(view);
      return;
    }
    rebuild();
    connected(message.n);
  }
  function joined(message: JoinedMessage): void {
    if (message.actor !== actor || !confirmed) return;
    // Entries sent before this answer were lost: ask again.
    if (confirmed.getSnapshot().revision !== message.revision) {
      hello();
      return;
    }
    if (settle(message.n)) rebuild();
    connected(message.n);
  }
  function accepted(message: AcceptedMessage): void {
    if (!confirmed || !visible) return;
    const revision = confirmed.getSnapshot().revision;
    if (message.revision <= revision) return;
    if (message.revision !== revision + 1) {
      hello();
      return;
    }
    const result = confirmed.dispatch(message.commands, { history: "ignore" });
    if (!result.ok || result.unchanged || result.revision !== message.revision) {
      // The confirmed document no longer matches the sequencer's: start over from its snapshot.
      refresh = true;
      hello();
      return;
    }
    log.push(message);
    while (log.length > retain) log.shift();
    actors.set(message.actor, Math.max(actors.get(message.actor) ?? 0, message.n));
    const item =
      message.actor === actor ? pending.find((candidate) => candidate.n === message.n) : undefined;
    if (item) {
      const ahead = pending.indexOf(item) > 0;
      remove(item);
      if (item.held) return applyHeld(item, message);
      // The visible document already shows exactly this.
      if (!ahead && canonical(item.commands) === canonical(message.commands)) {
        report({ type: "pending", count: pending.length });
        return;
      }
    }
    rebuild();
  }
  // A held transaction was accepted: apply it as the user's own edit, so it
  // enters local history, then match the confirmed document exactly.
  function applyHeld(item: Pending, message: AcceptedMessage): void {
    if (!visible || !confirmed) return;
    const view = visible;
    replaying = true;
    try {
      if (item.history === "undo") view.history.undo();
      else if (item.history === "redo") view.history.redo();
      else
        view.dispatch(message.commands, {
          history: item.history === "ignore" ? "ignore" : "record",
        });
    } finally {
      replaying = false;
    }
    if (withoutRevision(view.getSnapshot()) !== withoutRevision(confirmed.getSnapshot())) rebuild();
    else report({ type: "pending", count: pending.length });
  }
  function rejected(message: RejectedMessage): void {
    if (message.actor !== actor) return;
    const item = pending.find((candidate) => candidate.n === message.n);
    if (!item) return;
    remove(item);
    report({
      type: "rejected",
      code: message.code,
      target: message.target,
      reason: message.reason,
      commands: item.commands,
    });
    if (item.held) report({ type: "pending", count: pending.length });
    else rebuild();
  }

  function receive(message: SyncMessage): void {
    if (disposed || !isMessage(message)) return;
    if (message.type === "snapshot") adopt(message);
    else if (message.type === "joined") joined(message);
    else if (message.type === "accepted") accepted(message);
    else if (message.type === "rejected") rejected(message);
    else if (message.type === "presence" && message.actor !== actor)
      report({ type: "presence", actor: message.actor, state: message.state });
    else if (message.type === "refused") report({ type: "refused", reason: message.reason });
  }

  // A local edit the gate let through.
  function captured(commit: EditCommit): void {
    if (replaying || commit.history === "replace") return;
    enqueue({
      n: null,
      commands: commit.commands,
      history: commit.history,
      commit,
      held: false,
      sentAt: null,
    });
  }
  function gate(transaction: GatedTransaction): GateDecision {
    if (replaying) return "commit";
    if (status !== "connected" && policy !== "queue") return { readOnly: "offline" };
    if (policy !== "confirmed") return "commit";
    enqueue({
      n: null,
      commands: transaction.commands,
      history: transaction.history,
      commit: null,
      held: true,
      sentAt: null,
    });
    return "hold";
  }

  function discard(items: readonly Pending[]): void {
    for (const item of items) remove(item);
    report({ type: "discarded", transactions: items.map((item) => item.commands) });
    report({ type: "pending", count: pending.length });
  }
  // The reconnect deadline passed: unconfirmed edits roll back as one commit.
  function rollback(): void {
    deadlineTimer = null;
    if (status === "connected" || !pending.length) return;
    const items = pending.splice(0);
    rebuild();
    report({ type: "rolled-back", transactions: items.map((item) => item.commands) });
  }

  let off = transport.onMessage(receive);
  hello();

  return {
    ready,
    get editor() {
      return visible;
    },
    get actor() {
      return actor;
    },
    get status() {
      return status;
    },
    get pending() {
      return pending.length;
    },
    get revision() {
      return confirmed?.getSnapshot().revision ?? null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    presence(state) {
      if (status === "connected" && actor !== null)
        transport.send({ type: "presence", actor, state });
    },
    disconnect() {
      if (disposed || status === "disconnected") return;
      off();
      stopTimer();
      setStatus("disconnected");
      if (policy === "online" && pending.length && deadlineTimer === null)
        deadlineTimer = clock.setTimeout(rollback, deadline);
      if (policy === "confirmed") {
        const held = pending.filter((item) => item.held);
        if (held.length) discard(held);
      }
    },
    reconnect(next) {
      if (disposed) return;
      off();
      transport = next;
      off = transport.onMessage(receive);
      setStatus("connecting");
      hello();
    },
    state() {
      if (!confirmed) return null;
      return {
        project: confirmed.getSnapshot(),
        actors: Object.fromEntries(actors),
        log: [...log],
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      off();
      stopTimer();
      if (deadlineTimer !== null) clock.clearTimeout(deadlineTimer);
      visible?.setGate(null);
      offVisible();
      confirmed?.dispose();
      listeners.clear();
      fail(new Error("Session disposed"));
    },
  };
}
