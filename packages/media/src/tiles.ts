import { TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import { createTileBuilder, defaultWasmFrom } from "./peak-builder.ts";
import type { TileBuilder } from "./peak-builder.ts";
import { isFromPeakWorker } from "./peak-messages.ts";
import type { BuildTiles, ConfigureWorker, FromPeakWorker } from "./peak-messages.ts";
import { levelOffsets, tileLevels, tilePairs, tileSamples } from "./peaks.ts";
import type { PeakBackend } from "./peaks.ts";
import type {
  BufferPeakSource,
  ChannelBufferLike,
  PeakRequest,
  PeakSource,
  PeakWorker,
  WaveformTileDiagnostics,
  WaveformTiles,
  WaveformTilesOptions,
} from "./types.ts";

const tileBytes = 2 * tilePairs * 4;
/** Tiles in one batch: 1,048,576 samples. */
const batchTiles = 16;
const inFlight = 2;
/** Paints after which a tile nobody asked for again is no longer wanted. */
const forgetAfter = 120;
/** Main-thread slice budget in milliseconds. */
const sliceMs = 4;
const coarsest = tileLevels.length - 1;

/** One version of one stream and the tiles built from it. */
interface Stream {
  readonly key: string;
  readonly assetId: string;
  readonly source: PeakSource;
  // The source's identity when the stream began; a getter may change later.
  readonly version: string | number;
  readonly sampleRate: number;
  readonly length: number;
  readonly count: number;
  readonly tiles: Map<number, Float32Array>;
  /** One pair per tile, NaN until that tile is built. */
  readonly overview: Float32Array;
  /** Tiles wanted or being built, with the paint that last asked for each. */
  readonly wanted: Map<number, number>;
  readonly building: Set<number>;
  readonly failed: Set<number>;
}

interface Batch {
  readonly stream: Stream;
  readonly first: number;
  readonly count: number;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const defaultWorker = (): Worker =>
  new Worker(new URL("./peak-worker.js", import.meta.url), { type: "module" });
const usable = (source: PeakSource): boolean =>
  Number.isFinite(source.sampleRate) &&
  source.sampleRate > 0 &&
  Number.isSafeInteger(source.length) &&
  source.length >= 0;

/**
 * Waveform peaks from tiles of 65,536 samples at six levels, built in a worker
 * and kept within a byte budget. Pass it as the timeline's `waveforms`.
 */
export function createWaveformTiles(options: WaveformTilesOptions): WaveformTiles {
  const wasm = options.wasm ?? true;
  const wasmFrom = options.wasmFrom ?? defaultWasmFrom;
  const budget = options.cacheBytes ?? 64 * 1024 * 1024;
  const streams = new Map<string, Stream>();
  // Least recently used first. A tile's key is its stream key and index.
  const lru = new Map<string, { readonly stream: Stream; readonly index: number; used: number }>();
  const listeners = new Set<(assetId: string) => void>();
  const notices = new Set<string>();
  const idlers: (() => void)[] = [];
  const scratch: Float32Array<ArrayBuffer>[] = [];
  const replies = new Map<number, (reply: unknown) => void>();
  const counts = { js: 0, wasm: 0, evicted: 0, stale: 0 };
  let kernel: PeakBackend | null = null;
  let fallback: string | null = null;
  let error: string | null = null;
  let overviewBytes = 0;
  let epoch = 0;
  let epochOpen = false;
  let flushing = false;
  let active = 0;
  let nextId = 1;
  let disposed = false;
  let worker: PeakWorker | null | undefined = options.worker === null ? null : undefined;
  let local: TileBuilder | null = null;

  function streamOf(assetId: string, streamId: string): Stream | null {
    const source = options.source(assetId, streamId);
    const key = assetId + "\u0000" + streamId;
    const found = streams.get(key);
    if (!source || !usable(source)) {
      if (found) drop(found);
      return null;
    }
    if (
      found &&
      found.version === source.version &&
      found.sampleRate === source.sampleRate &&
      found.length === source.length
    )
      return found;
    if (found) drop(found);
    const count = Math.ceil(source.length / tileSamples);
    const stream: Stream = {
      key,
      assetId,
      source,
      version: source.version,
      sampleRate: source.sampleRate,
      length: source.length,
      count,
      tiles: new Map(),
      overview: new Float32Array(2 * count).fill(NaN),
      wanted: new Map(),
      building: new Set(),
      failed: new Set(),
    };
    overviewBytes += stream.overview.byteLength;
    streams.set(key, stream);
    return stream;
  }
  function drop(stream: Stream): void {
    if (streams.get(stream.key) !== stream) return;
    streams.delete(stream.key);
    overviewBytes -= stream.overview.byteLength;
    for (const index of stream.tiles.keys()) lru.delete(stream.key + "\u0000" + index);
    stream.tiles.clear();
    stream.wanted.clear();
  }
  const current = (stream: Stream): boolean => !disposed && streams.get(stream.key) === stream;

  // Requests made in one task, such as one paint, share an epoch.
  function begin(): void {
    if (epochOpen) return;
    epoch++;
    epochOpen = true;
    queueMicrotask(() => {
      epochOpen = false;
    });
  }
  function tileOf(stream: Stream, index: number): Float32Array | undefined {
    const tile = stream.tiles.get(index);
    if (tile) {
      const key = stream.key + "\u0000" + index;
      const entry = lru.get(key);
      if (entry && entry.used !== epoch) {
        entry.used = epoch;
        lru.delete(key);
        lru.set(key, entry);
      }
    } else want(stream, index);
    return tile;
  }
  function want(stream: Stream, index: number): void {
    if (stream.failed.has(index)) return;
    stream.wanted.set(index, epoch);
    if (!flushing) {
      flushing = true;
      queueMicrotask(flush);
    }
  }

  function peaks(request: PeakRequest): Float32Array | null {
    if (disposed) return null;
    const { assetId, streamId, start, end, buckets } = request;
    if (
      typeof assetId !== "string" ||
      typeof streamId !== "string" ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      !Number.isSafeInteger(buckets) ||
      buckets <= 0
    )
      return null;
    const stream = streamOf(assetId, streamId);
    if (!stream) return null;
    begin();
    const { sampleRate, length } = stream;
    // Multiply before dividing, so whole samples stay whole.
    const from = (start * sampleRate) / hz;
    const width = ((end - start) * sampleRate) / hz / buckets;
    const out = new Float32Array(2 * buckets).fill(NaN);
    if (!(width > 0)) return out;
    // The coarsest level no wider than a column, or the overview beyond them.
    let level = 0;
    while (level < coarsest && (tileLevels[level + 1] ?? Infinity) <= width) level++;
    const overview = width >= tileSamples;
    const per = overview ? tileSamples : (tileLevels[level] ?? 16);
    const perTile = tileSamples / per;
    const base = levelOffsets[level] ?? 0;
    let cached = -1;
    let tile: Float32Array | undefined;
    for (let column = 0; column < buckets; column++) {
      const x0 = Math.max(0, from + column * width);
      const x1 = Math.min(length, from + (column + 1) * width);
      if (x1 <= x0) continue;
      const last = Math.ceil(x1 / per) - 1;
      let lo = Infinity;
      let hi = -Infinity;
      let ready = true;
      for (let bucket = Math.floor(x0 / per); bucket <= last; bucket++) {
        let a: number;
        let b: number;
        if (overview) {
          a = stream.overview[2 * bucket] ?? NaN;
          b = stream.overview[2 * bucket + 1] ?? NaN;
          if (Number.isNaN(a)) {
            ready = false;
            want(stream, bucket);
            continue;
          }
        } else {
          const index = Math.floor(bucket / perTile);
          if (index !== cached) {
            cached = index;
            tile = tileOf(stream, index);
          }
          if (!tile) {
            ready = false;
            continue;
          }
          const at = 2 * (base + bucket - index * perTile);
          a = tile[at] ?? NaN;
          b = tile[at + 1] ?? NaN;
        }
        if (a < lo) lo = a;
        if (b > hi) hi = b;
      }
      // An empty column, +Infinity over -Infinity, has no finite sample.
      if (ready && lo <= hi) {
        out[2 * column] = lo;
        out[2 * column + 1] = hi;
      }
    }
    return out;
  }

  function store(stream: Stream, index: number, tile: Float32Array): void {
    stream.building.delete(index);
    if (!current(stream)) {
      counts.stale++;
      return;
    }
    stream.tiles.set(index, tile);
    lru.set(stream.key + "\u0000" + index, { stream, index, used: epoch });
    // The overview pair folds the coarsest level's four pairs.
    let lo = Infinity;
    let hi = -Infinity;
    const at = 2 * (levelOffsets[coarsest] ?? 0);
    for (let i = at; i < at + 8; i += 2) {
      const a = tile[i] ?? NaN;
      const b = tile[i + 1] ?? NaN;
      if (a < lo) lo = a;
      if (b > hi) hi = b;
    }
    stream.overview[2 * index] = lo;
    stream.overview[2 * index + 1] = hi;
    evict();
    notify(stream.assetId);
  }
  function evict(): void {
    for (const [key, entry] of lru) {
      if (lru.size * tileBytes <= budget || entry.used === epoch) return;
      lru.delete(key);
      entry.stream.tiles.delete(entry.index);
      counts.evicted++;
    }
  }
  function notify(assetId: string): void {
    if (!notices.size)
      queueMicrotask(() => {
        const ids = [...notices];
        notices.clear();
        if (disposed) return;
        // Each listener runs in its own microtask, so one that throws stops no other.
        for (const id of ids) for (const listener of listeners) queueMicrotask(() => listener(id));
      });
    notices.add(assetId);
  }

  // Starts batches while fewer than two are building: the most recently wanted
  // tile first, with the wanted tiles contiguous with it in its stream.
  function flush(): void {
    flushing = false;
    if (disposed) return;
    while (active < inFlight) {
      const batch = take();
      if (!batch) break;
      active++;
      void run(batch).finally(() => {
        active--;
        flush();
      });
    }
    if (!active) settle();
  }
  function take(): Batch | null {
    let best: { stream: Stream; index: number; at: number } | null = null;
    for (const stream of streams.values())
      for (const [index, at] of stream.wanted) {
        if (at < epoch - forgetAfter) {
          stream.wanted.delete(index);
          continue;
        }
        if (stream.building.has(index)) continue;
        if (stream.tiles.has(index)) {
          stream.wanted.delete(index);
          continue;
        }
        if (!best || at > best.at || (at === best.at && index < best.index))
          best = { stream, index, at };
      }
    if (!best) return null;
    const { stream } = best;
    const free = (index: number): boolean =>
      stream.wanted.has(index) && !stream.building.has(index) && !stream.tiles.has(index);
    let first = best.index;
    while (first > 0 && best.index - first < batchTiles - 1 && free(first - 1)) first--;
    let count = best.index - first + 1;
    while (count < batchTiles && first + count < stream.count && free(first + count)) count++;
    for (let index = first; index < first + count; index++) {
      stream.wanted.delete(index);
      stream.building.add(index);
    }
    return { stream, first, count };
  }

  async function run(batch: Batch): Promise<void> {
    const { stream, first, count } = batch;
    const start = first * tileSamples;
    const end = Math.min(stream.length, (first + count) * tileSamples);
    let samples = scratch.pop() ?? new Float32Array(batchTiles * tileSamples);
    try {
      const data = await stream.source.read(start, end);
      if (!current(stream)) {
        counts.stale += count;
        return;
      }
      const n = end - start;
      if (data instanceof Float32Array) samples.set(data.subarray(0, n));
      else for (let i = 0; i < Math.min(n, data.length); i++) samples[i] = data[i] ?? NaN;
      if (data.length < n) samples.fill(NaN, Math.max(0, data.length), n);
      const target = worker === undefined ? start$() : worker;
      if (target) {
        const reply = await build(target, samples, n);
        if (reply === null) {
          // The worker is gone and took the samples: read them again on the main thread.
          for (let index = first; index < first + count; index++) stream.wanted.set(index, epoch);
          return;
        }
        samples = reply.samples;
        if (reply.type === "built") {
          record(reply.kernel, reply.note);
          reply.tiles.forEach((tile, i) => store(stream, first + i, tile));
          return;
        }
        // The worker could not build this batch: build it here.
      }
      await sliced(batch, samples, n);
    } catch (failure) {
      error = describe(failure);
      for (let index = first; index < first + count; index++) stream.failed.add(index);
    } finally {
      for (let index = first; index < first + count; index++) stream.building.delete(index);
      if (samples.byteLength) scratch.push(samples);
    }
  }
  function record(used: PeakBackend, note: string | null): void {
    kernel = used;
    counts[used === "js" ? "js" : "wasm"]++;
    if (note && !fallback) fallback = note;
  }

  // The worker, started on the first batch. A failure leaves main-thread slices.
  function start$(): PeakWorker | null {
    try {
      const created: PeakWorker = (options.worker ?? defaultWorker)();
      created.addEventListener("message", (event) => {
        const data = event.data;
        if (isFromPeakWorker(data)) replies.get(data.id)?.(data);
      });
      const lost = (reason: string): void => {
        if (worker !== created) return;
        fallback = reason;
        worker = null;
        created.terminate();
        for (const resolve of replies.values()) resolve(null);
        replies.clear();
      };
      created.addEventListener("error", (event) =>
        lost("The peak worker failed: " + (event.message || "error")),
      );
      created.addEventListener("messageerror", () =>
        lost("The peak worker sent an unreadable reply"),
      );
      const configure: ConfigureWorker = { type: "configure", wasm, wasmFrom };
      created.postMessage(configure, []);
      worker = created;
    } catch (failure) {
      fallback = "No peak worker: " + describe(failure);
      worker = null;
    }
    return worker;
  }
  // Resolves with the worker's reply, or `null` when the worker is gone.
  function build(
    target: PeakWorker,
    samples: Float32Array<ArrayBuffer>,
    count: number,
  ): Promise<FromPeakWorker | null> {
    const id = nextId++;
    return new Promise((resolve) => {
      replies.set(id, (reply) => {
        replies.delete(id);
        if (!isFromPeakWorker(reply)) return resolve(null);
        if (reply.type === "failed") fallback ??= "A peak build failed: " + reply.reason;
        resolve(reply);
      });
      const message: BuildTiles = { type: "build", id, samples, count };
      target.postMessage(message, [samples.buffer]);
    });
  }
  // Builds on the main thread, one tile at a time, yielding every few
  // milliseconds and stopping when the stream changes.
  async function sliced(batch: Batch, samples: Float32Array, n: number): Promise<void> {
    local ??= createTileBuilder({ wasm: false, wasmFrom });
    let since = performance.now();
    for (let t = 0; t < batch.count; t++) {
      if (!current(batch.stream)) {
        counts.stale += batch.count - t;
        return;
      }
      const part = samples.subarray(t * tileSamples, Math.min(n, (t + 1) * tileSamples));
      const built = await local.build(part);
      record(built.kernel, null);
      const tile = built.tiles[0];
      if (tile) store(batch.stream, batch.first + t, tile);
      if (performance.now() - since > sliceMs) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        since = performance.now();
      }
    }
  }

  // Idle waits one macrotask, so a repaint that a notification caused can ask
  // for more before it resolves.
  function settle(): void {
    if (!idlers.length) return;
    setTimeout(() => {
      if (active || flushing || [...streams.values()].some((s) => pendingOf(s) > 0)) return;
      for (const resolve of idlers.splice(0)) resolve();
    }, 0);
  }
  const pendingOf = (stream: Stream): number => {
    let count = stream.building.size;
    for (const index of stream.wanted.keys()) if (!stream.building.has(index)) count++;
    return count;
  };

  return {
    peaks,
    subscribe(listener: (assetId: string) => void): () => void {
      const own = (assetId: string): void => listener(assetId);
      listeners.add(own);
      return () => {
        listeners.delete(own);
      };
    },
    invalidate(assetId: string): void {
      for (const stream of streams.values()) if (stream.assetId === assetId) drop(stream);
      notify(assetId);
    },
    idle(): Promise<void> {
      return new Promise((resolve) => {
        idlers.push(resolve);
        if (!active && !flushing) settle();
      });
    },
    diagnostics(): WaveformTileDiagnostics {
      let pending = 0;
      for (const stream of streams.values()) pending += pendingOf(stream);
      return {
        compute: worker === null ? "main-thread" : "worker",
        kernel,
        batches: { js: counts.js, wasm: counts.wasm },
        tiles: lru.size,
        bytes: lru.size * tileBytes + overviewBytes,
        pending,
        evicted: counts.evicted,
        stale: counts.stale,
        fallback,
        error,
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      worker?.terminate();
      worker = null;
      for (const resolve of replies.values()) resolve(null);
      replies.clear();
      for (const stream of streams.values()) drop(stream);
      listeners.clear();
      for (const resolve of idlers.splice(0)) resolve();
    },
  };
}

/** A peak source over one channel of a decoded buffer. */
export function bufferPeakSource(
  buffer: ChannelBufferLike,
  {
    channel = 0,
    version = 0,
  }: { readonly channel?: number; readonly version?: string | number } = {},
): BufferPeakSource {
  if (!Number.isSafeInteger(channel) || channel < 0 || channel >= buffer.numberOfChannels)
    throw new RangeError("Expected a channel of the buffer");
  return Object.freeze({
    version,
    sampleRate: buffer.sampleRate,
    length: buffer.length,
    read: (start: number, end: number): Float32Array =>
      buffer.getChannelData(channel).subarray(start, end),
  });
}
