import type { SyncMessage, SyncTransport } from "./types.ts";
import { isMessage } from "./util.ts";

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
export function createLink(options: LinkOptions = {}): MemoryLink {
  let { random = Math.random, loss = 0, duplicate = 0, reorder = false } = options;
  const queue: { readonly to: "editor" | "sequencer"; readonly json: string }[] = [];
  const listeners = {
    editor: new Set<(message: SyncMessage) => void>(),
    sequencer: new Set<(message: SyncMessage) => void>(),
  };
  const end = (from: "editor" | "sequencer", to: "editor" | "sequencer"): SyncTransport => ({
    send(message) {
      queue.push({ to, json: JSON.stringify(message) });
    },
    onMessage(listener) {
      listeners[from].add(listener);
      return () => listeners[from].delete(listener);
    },
  });
  return {
    editor: end("editor", "sequencer"),
    sequencer: end("sequencer", "editor"),
    get queued() {
      return queue.length;
    },
    flush() {
      const batch = queue.splice(0);
      if (reorder)
        for (let i = batch.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          const a = batch[i];
          const b = batch[j];
          if (a && b) {
            batch[i] = b;
            batch[j] = a;
          }
        }
      let delivered = 0;
      for (const item of batch) {
        if (random() < loss) continue;
        if (random() < duplicate) queue.push(item);
        delivered++;
        const message: unknown = JSON.parse(item.json);
        if (!isMessage(message)) continue;
        // oxlint-disable-next-line unicorn/no-useless-spread -- Listeners may unsubscribe during delivery.
        for (const listener of [...listeners[item.to]]) listener(message);
      }
      return delivered;
    },
    configure(next) {
      random = next.random ?? random;
      loss = next.loss ?? loss;
      duplicate = next.duplicate ?? duplicate;
      reorder = next.reorder ?? reorder;
    },
  };
}
