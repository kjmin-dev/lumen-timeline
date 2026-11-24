import type { AudioSpan } from "@lumen-timeline/core";
import type {
  CachedPeakStream,
  ChannelBufferLike,
  MediaCache,
  MediaCacheDiagnostics,
  MediaCacheEvent,
  MediaCacheOptions,
  PreloadHandle,
  SampleRequest,
  SampleSpan,
  StreamRange,
} from "./types.ts";

/** One chunk of one stream version: frames `index * chunkFrames` onward. */
export interface ChunkKey {
  readonly assetId: string;
  readonly streamId: string;
  readonly assetVersion: string | number;
  readonly sampleRate: number;
  readonly index: number;
}

export type ChunkState = "idle" | "loading" | "ready" | "failed";

/**
 * Who needs a chunk, most urgent first: a voice about to play or a play
 * waiting for its audio, a waveform read, then a host preload.
 */
export type Need = 0 | 1 | 2;
export const playbackNeed: Need = 0;
const peaksNeed: Need = 1;
const preloadNeed: Need = 2;

export interface Chunk {
  readonly key: string;
  readonly stream: string;
  readonly id: ChunkKey;
  /** The frames asked for. A buffer may end early where the stream does. */
  readonly start: number;
  readonly end: number;
  state: ChunkState;
  buffer: ChannelBufferLike | undefined;
  error: unknown;
}

/** A hold on a chunk. The budget never drops a held chunk. */
export interface ChunkLease {
  readonly chunk: Chunk;
  /** Resolves with the buffer, or rejects with the read's failure. */
  wait(): Promise<ChannelBufferLike>;
  release(): void;
}

export interface CacheInternals {
  readonly ahead: number;
  readonly behind: number;
  chunkFrames(sampleRate: number): number;
  acquire(key: ChunkKey, need: Need): ChunkLease;
  /** Replaces what `owner` wants loaded, most wanted first. Wanted chunks are not held. */
  want(owner: object, keys: readonly ChunkKey[]): void;
  /** Calls the listener when a chunk loads or fails. */
  watch(listener: (chunk: Chunk) => void): () => void;
  readonly disposed: boolean;
}

interface Entry extends Chunk {
  bytes: number;
  estimate: number;
  refs: number;
  /** The lowest need among holds, for ordering reads. */
  need: Need;
  /** Order of the first hold, for ordering reads of equal need. */
  asked: number;
  /** Position in the most eager want list, or Infinity. */
  rank: number;
  used: number;
  attempt: number;
  abort: AbortController | null;
  failures: number;
  retryAt: number;
  readonly waiters: Set<(entry: Entry) => void>;
}

const internals = new WeakMap<MediaCache, CacheInternals>();

/** The scheduling side of a cache made by `createMediaCache`. */
export function cacheInternals(media: MediaCache): CacheInternals {
  const found = internals.get(media);
  if (!found) throw new TypeError("Expected a media cache from createMediaCache");
  return found;
}

const streamKey = (
  assetId: string,
  streamId: string,
  assetVersion: string | number,
  sampleRate: number,
): string =>
  JSON.stringify([assetId, streamId, typeof assetVersion, String(assetVersion), sampleRate]);

const thenable = (value: unknown): value is PromiseLike<ChannelBufferLike> =>
  ((typeof value === "object" && value !== null) || typeof value === "function") &&
  typeof Reflect.get(value, "then") === "function";

const positive = (value: number | undefined, fallback: number, name: string): number => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(name + " must be positive");
  return value;
};

/**
 * Decoded audio in chunks of `chunkSeconds`, read through the host's reader and
 * kept within `budgetBytes`. Pass it to transports as `media` and to waveforms
 * through `peakSource`.
 */
export function createMediaCache(options: MediaCacheOptions): MediaCache {
  const reader = options.reader;
  if (typeof reader?.read !== "function") throw new TypeError("Expected a stream reader");
  const chunkSeconds = positive(options.chunkSeconds, 10, "chunkSeconds");
  const budgetBytes = positive(options.budgetBytes, 256 * 1024 * 1024, "budgetBytes");
  const concurrency = Math.floor(positive(options.concurrency, 4, "concurrency"));
  if (concurrency < 1) throw new RangeError("concurrency must be at least 1");
  const ahead = positive(options.ahead, 30, "ahead");
  const behind = options.behind === 0 ? 0 : positive(options.behind, 5, "behind");
  const entries = new Map<string, Entry>();
  const owners = new Map<object, Map<string, number>>();
  const channels = new Map<string, number>();
  const listeners = new Set<(event: MediaCacheEvent) => void>();
  const watchers = new Set<(chunk: Chunk) => void>();
  const counts = { loads: 0, hits: 0, evictions: 0, failures: 0, aborted: 0 };
  let bytes = 0;
  let peakBytes = 0;
  let active = 0;
  let asked = 0;
  let clock = 0;
  let pumping = false;
  let again = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const chunkFrames = (sampleRate: number): number => {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0)
      throw new RangeError("Expected a positive sample rate");
    return Math.max(1, Math.round(chunkSeconds * sampleRate));
  };

  function entryOf(key: ChunkKey): Entry {
    const stream = streamKey(key.assetId, key.streamId, key.assetVersion, key.sampleRate);
    const id = stream + "#" + key.index;
    let entry = entries.get(id);
    if (!entry) {
      if (!Number.isSafeInteger(key.index) || key.index < 0)
        throw new RangeError("Expected a chunk index");
      const frames = chunkFrames(key.sampleRate);
      const start = key.index * frames;
      entry = {
        key: id,
        stream,
        id: Object.freeze({ ...key }),
        start,
        end: start + frames,
        state: "idle",
        buffer: undefined,
        error: undefined,
        bytes: 0,
        estimate: 0,
        refs: 0,
        need: preloadNeed,
        asked: 0,
        rank: Infinity,
        used: 0,
        attempt: 0,
        abort: null,
        failures: 0,
        retryAt: 0,
        waiters: new Set(),
      };
      entry.estimate = frames * (channels.get(stream) ?? 2) * 4;
      entries.set(id, entry);
    }
    return entry;
  }

  function emit(type: MediaCacheEvent["type"], entry: Entry, error?: unknown): void {
    if (!listeners.size) return;
    const { assetId, streamId, assetVersion } = entry.id;
    const event: MediaCacheEvent = Object.freeze({
      type,
      assetId,
      streamId,
      assetVersion,
      start: entry.start,
      end: entry.buffer ? entry.start + entry.buffer.length : entry.end,
      ...(error === undefined ? {} : { error }),
    });
    // oxlint-disable-next-line unicorn/no-useless-spread -- A listener may unsubscribe during delivery, so iterate a snapshot.
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (failure) {
        report(failure);
      }
    }
  }

  function settled(entry: Entry): void {
    const waiters = [...entry.waiters];
    entry.waiters.clear();
    for (const waiter of waiters) waiter(entry);
    // oxlint-disable-next-line unicorn/no-useless-spread -- A watcher may unsubscribe during delivery, so iterate a snapshot.
    for (const watcher of [...watchers]) {
      try {
        watcher(entry);
      } catch (failure) {
        report(failure);
      }
    }
  }

  // Drops an idle chunk nothing holds or wants, so the map holds only live chunks.
  function forget(entry: Entry): void {
    if (entry.state === "idle" && !entry.refs && entry.rank === Infinity) entries.delete(entry.key);
  }

  function cancel(entry: Entry): void {
    if (entry.state !== "loading") return;
    entry.attempt++;
    entry.abort?.abort();
    entry.abort = null;
    entry.state = "idle";
    active--;
    counts.aborted++;
    forget(entry);
  }

  function drop(entry: Entry): void {
    bytes -= entry.bytes;
    entry.bytes = 0;
    emit("evicted", entry);
    entry.buffer = undefined;
    entry.state = "idle";
    counts.evictions++;
    forget(entry);
  }

  /** Drops unused chunks, least recently used first, until `need` more bytes fit. */
  function evict(need: number, wanted: boolean): boolean {
    while (bytes + need > budgetBytes) {
      let victim: Entry | null = null;
      for (const entry of entries.values()) {
        if (entry.state !== "ready" || entry.refs) continue;
        if (entry.rank === Infinity) {
          if (!victim || victim.rank !== Infinity || entry.used < victim.used) victim = entry;
        } else if (wanted && (!victim || (victim.rank !== Infinity && entry.rank > victim.rank)))
          victim = entry;
      }
      if (!victim) return false;
      drop(victim);
    }
    return true;
  }

  function loadingBytes(): number {
    let total = 0;
    for (const entry of entries.values()) if (entry.state === "loading") total += entry.estimate;
    return total;
  }

  function next(now: number): Entry | null {
    let held: Entry | null = null;
    let wanted: Entry | null = null;
    let soonest = Infinity;
    for (const entry of entries.values()) {
      if (entry.state === "loading" || entry.state === "ready") continue;
      // A held chunk that failed stays failed until it is held again.
      if (entry.refs) {
        if (entry.state === "failed") continue;
        if (
          !held ||
          entry.need < held.need ||
          (entry.need === held.need && entry.asked < held.asked)
        )
          held = entry;
      } else if (entry.rank !== Infinity) {
        if (entry.state === "failed" && entry.retryAt > now) {
          soonest = Math.min(soonest, entry.retryAt);
          continue;
        }
        if (!wanted || entry.rank < wanted.rank) wanted = entry;
      }
    }
    if (soonest !== Infinity && retry === null && !disposed)
      retry = setTimeout(
        () => {
          retry = null;
          pump();
        },
        Math.max(0, soonest - now),
      );
    if (held) {
      evict(held.estimate + loadingBytes(), true);
      return held;
    }
    if (wanted && evict(wanted.estimate + loadingBytes(), false)) return wanted;
    return null;
  }

  function pump(): void {
    if (pumping) {
      again = true;
      return;
    }
    pumping = true;
    try {
      do {
        again = false;
        while (!disposed && active < concurrency) {
          const entry = next(Date.now());
          if (!entry) break;
          begin(entry);
        }
      } while (again);
    } finally {
      pumping = false;
    }
  }

  function begin(entry: Entry): void {
    const attempt = ++entry.attempt;
    const abort = new AbortController();
    entry.abort = abort;
    entry.state = "loading";
    entry.error = undefined;
    active++;
    counts.loads++;
    const { assetId, streamId, assetVersion, sampleRate } = entry.id;
    const request: SampleRequest = Object.freeze({
      assetId,
      streamId,
      assetVersion,
      sampleRate,
      start: entry.start,
      end: entry.end,
    });
    const done = (buffer: ChannelBufferLike): void => {
      if (entry.attempt !== attempt) return;
      if (
        buffer?.sampleRate !== sampleRate ||
        !Number.isSafeInteger(buffer.length) ||
        buffer.length <= 0 ||
        buffer.length > entry.end - entry.start
      ) {
        failed(new Error("Stream reader returned a buffer that does not match the request"));
        return;
      }
      entry.abort = null;
      active--;
      const count = Number.isSafeInteger(buffer.numberOfChannels)
        ? Math.max(1, buffer.numberOfChannels)
        : 1;
      channels.set(entry.stream, count);
      entry.buffer = buffer;
      entry.bytes = buffer.length * count * 4;
      entry.state = "ready";
      entry.failures = 0;
      entry.used = ++clock;
      bytes += entry.bytes;
      peakBytes = Math.max(peakBytes, bytes);
      emit("loaded", entry);
      settled(entry);
      evict(0, false);
      pump();
    };
    const failed = (error: unknown): void => {
      if (entry.attempt !== attempt) return;
      entry.abort = null;
      active--;
      entry.state = "failed";
      entry.error = error;
      entry.failures++;
      entry.retryAt = Date.now() + Math.min(30_000, 1000 * 2 ** (entry.failures - 1));
      counts.failures++;
      emit("failed", entry, error);
      settled(entry);
      pump();
    };
    try {
      const result = reader.read(request, abort.signal);
      if (thenable(result)) Promise.resolve(result).then(done, failed);
      else done(result);
    } catch (error) {
      failed(error);
    }
  }

  function acquire(key: ChunkKey, need: Need): ChunkLease {
    if (disposed) {
      const gone: Chunk = Object.freeze({
        key: "",
        stream: "",
        id: key,
        start: 0,
        end: 0,
        state: "failed",
        buffer: undefined,
        error: new Error("Media cache disposed"),
      });
      return {
        chunk: gone,
        wait: () => Promise.reject(gone.error),
        release: () => {},
      };
    }
    const entry = entryOf(key);
    if (!entry.refs) {
      entry.need = need;
      entry.asked = ++asked;
    } else if (need < entry.need) entry.need = need;
    entry.refs++;
    entry.used = ++clock;
    if (entry.state === "ready") counts.hits++;
    // A hold retries a failed chunk at once.
    if (entry.state === "failed") entry.state = "idle";
    let held = true;
    if (entry.state === "idle") pump();
    return {
      chunk: entry,
      wait: () =>
        new Promise<ChannelBufferLike>((resolve, reject) => {
          const finish = (settledEntry: Entry): void => {
            if (settledEntry.state === "ready" && settledEntry.buffer) resolve(settledEntry.buffer);
            else reject(settledEntry.error ?? new Error("Chunk was not loaded"));
          };
          if (entry.state === "ready" || entry.state === "failed") finish(entry);
          else entry.waiters.add(finish);
        }),
      release() {
        if (!held) return;
        held = false;
        entry.refs--;
        entry.used = ++clock;
        if (!entry.refs && entry.rank === Infinity) {
          cancel(entry);
          forget(entry);
        }
      },
    };
  }

  function rerank(entry: Entry): void {
    let rank = Infinity;
    for (const wants of owners.values()) rank = Math.min(rank, wants.get(entry.key) ?? Infinity);
    entry.rank = rank;
    if (rank === Infinity && !entry.refs) {
      cancel(entry);
      forget(entry);
    }
  }

  function want(owner: object, keys: readonly ChunkKey[]): void {
    if (disposed) return;
    const previous = owners.get(owner);
    const wants = new Map<string, number>();
    const touched: Entry[] = [];
    keys.forEach((key, rank) => {
      const entry = entryOf(key);
      if (!wants.has(entry.key)) {
        wants.set(entry.key, rank);
        touched.push(entry);
      }
    });
    if (wants.size) owners.set(owner, wants);
    else owners.delete(owner);
    for (const entry of touched) rerank(entry);
    if (previous)
      for (const key of previous.keys()) {
        if (wants.has(key)) continue;
        const entry = entries.get(key);
        if (entry) rerank(entry);
      }
    pump();
  }

  function rangeKeys(range: StreamRange | AudioSpan): ChunkKey[] {
    const [start, end] =
      "window" in range
        ? [range.window.sourceStart, range.window.sourceEnd]
        : [range.start, range.end];
    const { assetId, streamId, assetVersion, sampleRate } = range;
    if (!Number.isFinite(start) || !Number.isFinite(end))
      throw new RangeError("Expected a sample range");
    const frames = chunkFrames(sampleRate);
    const keys: ChunkKey[] = [];
    const last = Math.ceil(end / frames) - 1;
    for (let index = Math.max(0, Math.floor(start / frames)); index <= last; index++)
      keys.push({ assetId, streamId, assetVersion, sampleRate, index });
    return keys;
  }

  function preload(ranges: readonly (StreamRange | AudioSpan)[]): PreloadHandle {
    const seen = new Set<string>();
    const leases: ChunkLease[] = [];
    for (const range of ranges)
      for (const key of rangeKeys(range)) {
        const lease = acquire(key, preloadNeed);
        if (seen.has(lease.chunk.key)) lease.release();
        else {
          seen.add(lease.chunk.key);
          leases.push(lease);
        }
      }
    let held = true;
    const settledCount = Promise.allSettled(leases.map((lease) => lease.wait())).then(
      (results) => results.filter((result) => result.status === "rejected").length,
    );
    return {
      settled: settledCount,
      progress: () => ({
        loaded: leases.filter((lease) => lease.chunk.state === "ready").length,
        total: leases.length,
      }),
      release() {
        if (!held) return false;
        held = false;
        for (const lease of leases) lease.release();
        return true;
      },
    };
  }

  function loaded(
    assetId: string,
    streamId: string,
    assetVersion: string | number,
  ): readonly SampleSpan[] {
    const spans: { start: number; end: number }[] = [];
    for (const entry of entries.values()) {
      const { id } = entry;
      if (
        entry.state !== "ready" ||
        !entry.buffer ||
        id.assetId !== assetId ||
        id.streamId !== streamId ||
        id.assetVersion !== assetVersion
      )
        continue;
      spans.push({ start: entry.start, end: entry.start + entry.buffer.length });
    }
    spans.sort((a, b) => a.start - b.start);
    const merged: SampleSpan[] = [];
    for (const span of spans) {
      const last = merged.at(-1);
      if (last && span.start <= last.end)
        merged[merged.length - 1] = Object.freeze({
          start: last.start,
          end: Math.max(last.end, span.end),
        });
      else merged.push(Object.freeze(span));
    }
    return Object.freeze(merged);
  }

  const media: MediaCache = {
    chunkSeconds,
    budgetBytes,
    preload,
    peakSource(stream: CachedPeakStream) {
      const { assetId, streamId, assetVersion, sampleRate, length } = stream;
      const channel = stream.channel ?? 0;
      if (!Number.isSafeInteger(length) || length < 0)
        throw new RangeError("Expected a stream length in frames");
      if (!Number.isSafeInteger(channel) || channel < 0)
        throw new RangeError("Expected a channel index");
      const frames = chunkFrames(sampleRate);
      return Object.freeze({
        version: assetVersion,
        sampleRate,
        length,
        ...(stream.overview ? { overview: stream.overview } : {}),
        async read(start: number, end: number): Promise<Float32Array> {
          const out = new Float32Array(Math.max(0, end - start)).fill(Number.NaN);
          if (end <= start) return out;
          const leases: ChunkLease[] = [];
          const last = Math.ceil(end / frames) - 1;
          for (let index = Math.max(0, Math.floor(start / frames)); index <= last; index++)
            leases.push(acquire({ assetId, streamId, assetVersion, sampleRate, index }, peaksNeed));
          try {
            const buffers = await Promise.all(leases.map((lease) => lease.wait()));
            buffers.forEach((buffer, i) => {
              const lease = leases[i];
              if (!lease || channel >= buffer.numberOfChannels) return;
              const data = buffer.getChannelData(channel);
              const from = Math.max(start, lease.chunk.start);
              const to = Math.min(end, lease.chunk.start + data.length);
              if (to > from)
                out.set(
                  data.subarray(from - lease.chunk.start, to - lease.chunk.start),
                  from - start,
                );
            });
            return out;
          } finally {
            for (const lease of leases) lease.release();
          }
        },
      });
    },
    loaded,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    diagnostics(): MediaCacheDiagnostics {
      let chunks = 0;
      let inUse = 0;
      let loading = 0;
      let queued = 0;
      for (const entry of entries.values()) {
        if (entry.state === "ready") chunks++;
        if (entry.state === "loading") loading++;
        if (entry.refs) inUse++;
        if (entry.rank !== Infinity && entry.state !== "ready" && entry.state !== "loading")
          queued++;
      }
      return Object.freeze({
        budgetBytes,
        bytes,
        peakBytes,
        chunks,
        inUse,
        loading,
        queued,
        ...counts,
      });
    },
    clear() {
      for (const entry of entries.values()) if (entry.state === "ready" && !entry.refs) drop(entry);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (retry !== null) clearTimeout(retry);
      retry = null;
      const error = new Error("Media cache disposed");
      for (const entry of entries.values()) {
        if (entry.state === "loading") {
          entry.attempt++;
          entry.abort?.abort();
          entry.abort = null;
          active--;
        }
        entry.state = "failed";
        entry.error = error;
        entry.buffer = undefined;
        settled(entry);
      }
      entries.clear();
      owners.clear();
      bytes = 0;
      listeners.clear();
      watchers.clear();
    },
  };
  internals.set(media, {
    ahead,
    behind,
    chunkFrames,
    acquire,
    want,
    watch(listener) {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
    get disposed() {
      return disposed;
    },
  });
  return media;
}

function report(error: unknown): void {
  if (typeof globalThis.reportError === "function") globalThis.reportError(error);
  else
    queueMicrotask(() => {
      throw error;
    });
}
