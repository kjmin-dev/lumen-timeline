import { defined } from "./invariant.ts";
import { requireEdit } from "./validation.ts";
import type {
  ClipPatch,
  DataPatch,
  HistoryLimits,
  MarkerPatch,
  TakePatch,
  TrackPatch,
} from "./types.ts";

export interface HistoryEntry {
  readonly forward: readonly ClipPatch[];
  readonly inverse: readonly ClipPatch[];
  readonly data: readonly DataPatch[];
  readonly inverseData: readonly DataPatch[];
  readonly markers?: readonly MarkerPatch[];
  readonly inverseMarkers?: readonly MarkerPatch[];
  readonly takes?: readonly TakePatch[];
  readonly inverseTakes?: readonly TakePatch[];
  readonly tracks?: readonly TrackPatch[];
  readonly inverseTracks?: readonly TrackPatch[];
  readonly trackOrder?: readonly string[];
  readonly inverseTrackOrder?: readonly string[];
}

interface StoredEntry extends HistoryEntry {
  readonly bytes: number;
}

export interface History {
  readonly undoDepth: number;
  readonly redoDepth: number;
  readonly estimatedBytes: number;
  peek(mode: "undo" | "redo"): HistoryEntry | undefined;
  /** Moves the newest entry across. The caller has checked that it exists. */
  advance(mode: "undo" | "redo"): void;
  /** Records an entry and returns it as stored, or undefined when limits keep nothing. */
  record(entry: HistoryEntry): HistoryEntry | undefined;
  /**
   * Replaces a stored entry's records where it stands, in either stack, and
   * returns the replacement. Undefined when the entry is no longer held.
   */
  amend(entry: HistoryEntry, next: HistoryEntry): HistoryEntry | undefined;
  discard(direction: "undo" | "redo"): boolean;
  clear(): void;
}

// Approximate logical payload size. Immutable children are cheap to reweigh.
// Shared values may be counted multiple times; this is not a measurement of heap size.
function estimator(): (value: unknown) => number {
  const sizes = new WeakMap<object, number>();
  function bytes(value: unknown): number {
    if (typeof value === "string") return 16 + value.length * 2;
    if (value === null || typeof value !== "object") return 8;
    const cached = sizes.get(value);
    if (cached !== undefined) return cached;
    let size = 32;
    for (const [key, item] of Object.entries(value)) size += 8 + key.length * 2 + bytes(item);
    sizes.set(value, size);
    return size;
  }
  return bytes;
}

export function createHistory(options: HistoryLimits = {}): History {
  requireEdit(
    options !== null && typeof options === "object" && !Array.isArray(options),
    "invalid-history",
    null,
    "Expected history options",
  );
  const { maxEntries = 200, maxBytes = 16 * 1024 * 1024 } = options;
  requireEdit(
    Number.isSafeInteger(maxEntries) &&
      maxEntries >= 0 &&
      Number.isSafeInteger(maxBytes) &&
      maxBytes >= 0,
    "invalid-history",
    null,
    "History limits must be nonnegative safe integers",
  );
  const past: StoredEntry[] = [];
  const future: StoredEntry[] = [];
  const weigh = estimator();
  let estimatedBytes = 0;

  return {
    get undoDepth() {
      return past.length;
    },
    get redoDepth() {
      return future.length;
    },
    get estimatedBytes() {
      return estimatedBytes;
    },
    peek: (mode) => (mode === "undo" ? past : future).at(-1),
    advance(mode) {
      if (mode === "undo") future.push(defined(past.pop(), "undo entry"));
      else past.push(defined(future.pop(), "redo entry"));
    },
    record(entry) {
      const bytes = maxEntries && maxBytes ? weigh(entry) : 0;
      for (const item of future) estimatedBytes -= item.bytes;
      future.length = 0;
      if (!bytes) return undefined;
      const stored = { ...entry, bytes };
      past.push(stored);
      estimatedBytes += bytes;
      // One atomic edit may exceed the byte budget. Keep the newest edit intact.
      while (past.length > 1 && (past.length > maxEntries || estimatedBytes > maxBytes)) {
        estimatedBytes -= defined(past.shift(), "oldest entry").bytes;
      }
      return past.includes(stored) ? stored : undefined;
    },
    amend(entry, next) {
      for (const stack of [past, future]) {
        const index = stack.findIndex((item) => item === entry);
        const old = stack[index];
        if (!old) continue;
        const stored = { ...next, bytes: weigh(next) };
        stack[index] = stored;
        estimatedBytes += stored.bytes - old.bytes;
        return stored;
      }
      return undefined;
    },
    discard(direction) {
      requireEdit(
        direction === "undo" || direction === "redo",
        "invalid-history",
        null,
        "Choose undo or redo",
      );
      const entry = (direction === "undo" ? past : future).pop();
      if (!entry) return false;
      estimatedBytes -= entry.bytes;
      return true;
    },
    clear() {
      past.length = 0;
      future.length = 0;
      estimatedBytes = 0;
    },
  };
}
