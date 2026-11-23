import assert from "node:assert/strict";
import test from "node:test";
import { TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import { bufferPeakSource, createWaveformTiles } from "@lumen-timeline/media";
import type { PeakSource, PeakWorker, WaveformTiles } from "@lumen-timeline/media";
import {
  createTileBuilder,
  isToPeakWorker,
  peakModuleBytes,
  tileLevels,
  tileSamples,
} from "@lumen-timeline/media/internal";

const rate = 48000;
const at = (sample: number): number => (sample / rate) * hz;

function random(seed: number): (n: number) => number {
  let state = seed >>> 0;
  return (n) => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return Math.floor((state / 4294967296) * n);
  };
}

/** Seeded PCM with runs of silence and of non-finite samples. */
function pcm(length: number, seed: number): Float32Array {
  const next = random(seed);
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const run = Math.floor(i / 5000) % 11;
    samples[i] =
      run === 3 ? 0 : run === 7 ? NaN : next(13) === 0 ? Infinity : (next(2001) - 1000) / 1000;
  }
  return samples;
}

interface Counted extends PeakSource {
  reads: number;
}
function source(samples: Float32Array, version: string | number = 1): Counted {
  const counted: Counted = {
    version,
    sampleRate: rate,
    length: samples.length,
    reads: 0,
    read(start, end) {
      counted.reads++;
      return samples.subarray(start, end);
    },
  };
  return counted;
}

/**
 * What a column must hold: the extremes of the finite samples in the buckets it
 * overlaps, at the coarsest level no wider than it, or NaN when there are none.
 */
function column(samples: Float32Array, from: number, width: number, i: number): [number, number] {
  let per = tileLevels[0];
  for (const level of tileLevels) if (level <= width) per = level;
  if (width >= tileSamples) per = tileSamples;
  const x0 = Math.max(0, from + i * width);
  const x1 = Math.min(samples.length, from + (i + 1) * width);
  if (x1 <= x0) return [NaN, NaN];
  let lo = Infinity;
  let hi = -Infinity;
  const end = Math.min(samples.length, Math.ceil(x1 / per) * per);
  for (let s = Math.floor(x0 / per) * per; s < end; s++)
    if (Number.isFinite(samples[s])) {
      lo = Math.min(lo, samples[s]);
      hi = Math.max(hi, samples[s]);
    }
  return lo <= hi ? [Math.fround(lo) + 0, Math.fround(hi) + 0] : [NaN, NaN];
}

function sameColumns(
  peaks: Float32Array | null,
  samples: Float32Array,
  from: number,
  width: number,
  label: string,
): void {
  assert.ok(peaks, label);
  for (let i = 0; i < peaks.length / 2; i++) {
    const [lo, hi] = column(samples, from, width, i);
    if (!Object.is(peaks[2 * i], lo) || !Object.is(peaks[2 * i + 1], hi))
      assert.fail(
        `${label}: column ${i} is ${peaks[2 * i]}..${peaks[2 * i + 1]}, expected ${lo}..${hi}`,
      );
  }
}

/** Asks until a request is complete: every column the source can fill is filled. */
async function settled(tiles: WaveformTiles, request: Parameters<WaveformTiles["peaks"]>[0]) {
  for (let round = 0; round < 50; round++) {
    tiles.peaks(request);
    await tiles.idle();
    if (tiles.diagnostics().pending === 0) return tiles.peaks(request);
  }
  assert.fail("The tiles did not settle");
}

/** An in-process stand-in for the module worker, with real transfers. */
function fakeWorker(
  options: {
    readonly module?: Uint8Array<ArrayBuffer>;
    readonly fail?: boolean;
    readonly failBuild?: boolean;
    /** Keep replies in `held` until the test delivers them. */
    readonly hold?: boolean;
  } = {},
) {
  type Listener =
    | ((event: MessageEvent<unknown>) => void)
    | ((event: { readonly message: string }) => void);
  // One event that suits either kind of listener.
  const event = (data: unknown, text = "") =>
    Object.assign(new MessageEvent("message", { data }), { message: text });
  const message = new Set<Listener>();
  const error = new Set<Listener>();
  let builder = createTileBuilder({ wasm: true, wasmFrom: tileSamples, module: options.module });
  const held: (() => void)[] = [];
  const seen = { built: 0, detached: 0, configured: 0, terminated: false, held };
  const worker: PeakWorker = {
    addEventListener(type: string, listener: Listener) {
      if (type === "error") error.add(listener);
      else if (type === "message") message.add(listener);
    },
    postMessage(data: unknown, transfer: Transferable[]) {
      const copy = structuredClone(data, { transfer });
      if (!isToPeakWorker(copy) || seen.terminated) return;
      if (copy.type === "configure") {
        seen.configured++;
        builder = createTileBuilder({ ...copy, module: options.module });
        return;
      }
      if (isToPeakWorker(data) && data.type === "build" && data.samples.byteLength === 0)
        seen.detached++;
      if (options.fail) {
        setTimeout(() => {
          for (const listener of error) listener(event(null, "boom"));
        });
        return;
      }
      void (async () => {
        let reply: unknown;
        let moved: Transferable[];
        if (options.failBuild) {
          reply = { type: "failed", id: copy.id, samples: copy.samples, reason: "no memory" };
          moved = [copy.samples.buffer];
        } else {
          const built = await builder.build(copy.samples.subarray(0, copy.count));
          reply = { type: "built", id: copy.id, samples: copy.samples, ...built };
          moved = [copy.samples.buffer, ...built.tiles.map((t) => t.buffer)];
        }
        seen.built++;
        const back = structuredClone(reply, { transfer: moved });
        const deliver = () => {
          if (!seen.terminated) for (const listener of message) listener(event(back));
        };
        if (options.hold) held.push(deliver);
        else deliver();
      })();
    },
    terminate() {
      seen.terminated = true;
    },
  };
  return { worker, seen };
}

const samples = pcm(5 * tileSamples + 21011, 3);

test("columns hold the extremes of the buckets they overlap, at every level and past both ends", async () => {
  const tiles = createWaveformTiles({ source: () => source(samples), worker: null });
  // Widths from below the finest level to the overview, starting before the
  // source and running past its end.
  for (const width of [3, 16, 40, 64, 300, 1024, 5000, 16384, 40000, 65536, 200000]) {
    for (const from of [-7 * width, 12345, samples.length - 100 * width]) {
      const buckets = 130;
      const request = {
        assetId: "a",
        streamId: "mono",
        start: at(from),
        end: at(from + buckets * width),
        buckets,
      };
      sameColumns(await settled(tiles, request), samples, from, width, `width ${width} at ${from}`);
    }
  }
  const report = tiles.diagnostics();
  assert.equal(report.compute, "main-thread");
  assert.equal(report.kernel, "wasm-simd");
  assert.equal(report.batches.js, 0);
  assert.ok(report.batches.wasm > 0);
  tiles.dispose();
});

test("main-thread slices use the worker's kernels, and name a module that cannot load", async (t) => {
  const request = { assetId: "a", streamId: "s", start: 0, end: at(samples.length), buckets: 300 };
  const width = samples.length / 300;
  // Five whole tiles and one of 21,011 samples: the cutoff sends that one to JS.
  const cutoff = createWaveformTiles({
    source: () => source(samples),
    worker: null,
    wasmFrom: 30000,
  });
  sameColumns(await settled(cutoff, request), samples, 0, width, "cutoff");
  assert.deepEqual(cutoff.diagnostics().batches, { js: 1, wasm: 5 });
  assert.equal(cutoff.diagnostics().fallback, null);
  cutoff.dispose();
  const js = createWaveformTiles({ source: () => source(samples), worker: null, wasm: false });
  sameColumns(await settled(js, request), samples, 0, width, "wasm: false");
  assert.deepEqual(js.diagnostics().batches, { js: 6, wasm: 0 });
  assert.equal(js.diagnostics().fallback, null);
  js.dispose();
  // A content security policy without wasm-unsafe-eval stops the worker and the module.
  t.mock.method(WebAssembly, "instantiate", () => Promise.reject(new Error("refused by policy")));
  const blocked = createWaveformTiles({
    source: () => source(samples),
    worker: () => {
      throw new Error("blocked");
    },
  });
  sameColumns(await settled(blocked, request), samples, 0, width, "blocked");
  const report = blocked.diagnostics();
  assert.equal(report.kernel, "js");
  assert.equal(report.batches.wasm, 0);
  assert.equal(
    report.fallback,
    "No peak worker: blocked; WebAssembly unavailable: refused by policy",
  );
  blocked.dispose();
});

test("a worker builds batches with WASM from 4,096 samples and JS below, transferring its scratch", async () => {
  const fake = fakeWorker();
  const short = pcm(3000, 9);
  const tiles = createWaveformTiles({
    source: (assetId) => source(assetId === "long" ? samples : short),
    worker: () => fake.worker,
  });
  const long = { assetId: "long", streamId: "s", start: 0, end: at(samples.length), buckets: 400 };
  sameColumns(await settled(tiles, long), samples, 0, samples.length / 400, "long");
  const brief = { assetId: "short", streamId: "s", start: 0, end: at(short.length), buckets: 100 };
  sameColumns(await settled(tiles, brief), short, 0, short.length / 100, "short");
  const report = tiles.diagnostics();
  assert.equal(report.compute, "worker");
  assert.equal(report.batches.wasm, 1, "the six-tile source is one batch");
  assert.equal(report.batches.js, 1, "a source shorter than 4,096 samples uses JS");
  assert.equal(fake.seen.configured, 1);
  assert.equal(fake.seen.detached, 2, "the scratch samples were transferred");
  assert.equal(report.tiles, 7);
  tiles.dispose();
  assert.ok(fake.seen.terminated);
});

test("the worker's JS and WASM tiles give the same columns", async () => {
  const request = { assetId: "a", streamId: "s", start: at(100), end: at(300100), buckets: 997 };
  const results = [];
  for (const wasmFrom of [tileSamples, Infinity]) {
    const fake = fakeWorker();
    const tiles = createWaveformTiles({
      source: () => source(samples),
      worker: () => fake.worker,
      wasmFrom,
    });
    results.push(await settled(tiles, request));
    assert.equal(tiles.diagnostics().kernel, wasmFrom === Infinity ? "js" : "wasm-simd");
    tiles.dispose();
  }
  assert.deepEqual(results[0], results[1]);
});

test("a result for an earlier version is never stored, and the new samples are drawn", async () => {
  let version = 1;
  let current = samples;
  const releases: (() => void)[] = [];
  const gated: PeakSource = {
    get version() {
      return version;
    },
    sampleRate: rate,
    length: samples.length,
    read(start, end) {
      const read = current.subarray(start, end);
      return new Promise((resolve) => {
        releases.push(() => resolve(read));
      });
    },
  };
  const tiles = createWaveformTiles({ source: () => gated, worker: null });
  const request = { assetId: "a", streamId: "s", start: 0, end: at(tileSamples), buckets: 64 };
  tiles.peaks(request);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(releases.length, 1, "the first tile is being read");
  // The samples change while the old read is in flight.
  const replaced = pcm(samples.length, 77);
  current = replaced;
  version = 2;
  tiles.peaks(request);
  releases.shift()?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(tiles.diagnostics().stale, 1);
  const pending = tiles.peaks(request);
  assert.ok(pending?.every(Number.isNaN), "an old result was drawn");
  const done = (async () => {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      releases.shift()?.();
      if (tiles.diagnostics().pending === 0) return;
    }
  })();
  await done;
  sameColumns(tiles.peaks(request), replaced, 0, tileSamples / 64, "new version");
  tiles.dispose();
});

test("eviction keeps the budget, spares the current paint, and the overview outlives its tiles", async () => {
  const long = pcm(8 * tileSamples, 21);
  const counted = source(long);
  const tileBytes = 5460 * 8;
  const tiles = createWaveformTiles({
    source: () => counted,
    worker: null,
    cacheBytes: 3 * tileBytes,
  });
  const span = (first: number, count: number) => ({
    assetId: "a",
    streamId: "s",
    start: at(first * tileSamples),
    end: at((first + count) * tileSamples),
    buckets: count * 64,
  });
  await settled(tiles, span(0, 2));
  assert.equal(tiles.diagnostics().tiles, 2);
  // Four tiles drawn in one paint stay, over the budget.
  const four = await settled(tiles, span(4, 4));
  sameColumns(four, long, 4 * tileSamples, tileSamples / 64, "four");
  assert.equal(tiles.diagnostics().tiles, 4);
  assert.ok(tiles.diagnostics().evicted >= 2);
  // The whole source, zoomed out, reads only overview pairs: no new reads once built.
  const whole = { assetId: "a", streamId: "s", start: 0, end: at(long.length), buckets: 4 };
  const overview = await settled(tiles, whole);
  sameColumns(overview, long, 0, long.length / 4, "overview");
  const reads = counted.reads;
  sameColumns(tiles.peaks(whole), long, 0, long.length / 4, "overview again");
  await tiles.idle();
  assert.equal(counted.reads, reads);
  assert.ok(tiles.diagnostics().tiles <= 4);
  tiles.dispose();
});

test("a failed or missing worker falls back to main-thread slices and says why", async () => {
  const request = { assetId: "a", streamId: "s", start: 0, end: at(samples.length), buckets: 300 };
  for (const [make, reason] of [
    [() => fakeWorker({ fail: true }).worker, /worker failed: boom/],
    [
      () => {
        throw new Error("blocked");
      },
      /No peak worker: blocked/,
    ],
    [() => fakeWorker({ failBuild: true }).worker, /build failed: no memory/],
  ] as const) {
    const tiles = createWaveformTiles({ source: () => source(samples), worker: make });
    sameColumns(await settled(tiles, request), samples, 0, samples.length / 300, String(reason));
    const report = tiles.diagnostics();
    assert.match(report.fallback ?? "", reason);
    assert.equal(report.kernel, "wasm-simd");
    tiles.dispose();
  }
});

test("a module that cannot load leaves the worker on JS and records why", async () => {
  const bytes = peakModuleBytes();
  const fake = fakeWorker({ module: bytes.subarray(0, 40) });
  const tiles = createWaveformTiles({ source: () => source(samples), worker: () => fake.worker });
  const request = { assetId: "a", streamId: "s", start: 0, end: at(samples.length), buckets: 50 };
  sameColumns(await settled(tiles, request), samples, 0, samples.length / 50, "js");
  assert.equal(tiles.diagnostics().kernel, "js");
  assert.match(tiles.diagnostics().fallback ?? "", /WebAssembly unavailable/);
  tiles.dispose();
});

test("listeners hear each asset once per batch, and invalidation reads the source again", async () => {
  const counted = source(samples);
  const tiles = createWaveformTiles({ source: () => counted, worker: null });
  const heard: string[] = [];
  const stop = tiles.subscribe((id) => heard.push(id));
  const request = { assetId: "a", streamId: "s", start: 0, end: at(2 * tileSamples), buckets: 8 };
  await settled(tiles, request);
  assert.ok(heard.length >= 1 && heard.every((id) => id === "a"), heard.join());
  heard.length = 0;
  tiles.invalidate("a");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(heard, ["a"]);
  assert.ok(tiles.peaks(request)?.every(Number.isNaN), "an invalidated tile was drawn");
  const reads = counted.reads;
  await settled(tiles, request);
  assert.ok(counted.reads > reads);
  stop();
  heard.length = 0;
  tiles.invalidate("a");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(heard, []);
  tiles.dispose();
});

test("short and failing reads, unknown sources, bad requests and disposal", async () => {
  const short: PeakSource = {
    version: 1,
    sampleRate: rate,
    length: tileSamples,
    read: (start) => samples.subarray(start, start + 1000),
  };
  let failures = 0;
  const broken: PeakSource = {
    version: 1,
    sampleRate: rate,
    length: tileSamples,
    read() {
      failures++;
      throw new Error("decode failed");
    },
  };
  const tiles = createWaveformTiles({
    source: (assetId) => (assetId === "short" ? short : assetId === "broken" ? broken : null),
    worker: null,
  });
  const request = (assetId: string) => ({
    assetId,
    streamId: "s",
    start: 0,
    end: at(tileSamples),
    buckets: 64,
  });
  // Samples a read did not return count as no samples.
  const partial = await settled(tiles, request("short"));
  sameColumns(partial, samples.subarray(0, 1000), 0, tileSamples / 64, "short read");
  // A read that throws is reported and not retried.
  await settled(tiles, request("broken"));
  await settled(tiles, request("broken"));
  assert.equal(failures, 1);
  assert.equal(tiles.diagnostics().error, "decode failed");
  assert.equal(tiles.peaks(request("missing")), null);
  assert.equal(tiles.peaks({ ...request("short"), buckets: 0 }), null);
  assert.equal(tiles.peaks({ ...request("short"), end: NaN }), null);
  tiles.dispose();
  assert.equal(tiles.peaks(request("short")), null);
  assert.equal(tiles.diagnostics().tiles, 0);
  await tiles.idle();
});

test("a buffer source reads one channel and refuses a channel the buffer lacks", () => {
  const left = Float32Array.from([1, 2, 3]);
  const right = Float32Array.from([4, 5, 6]);
  const buffer = {
    sampleRate: rate,
    length: 3,
    numberOfChannels: 2,
    getChannelData: (channel: number) => (channel ? right : left),
  };
  assert.deepEqual([...bufferPeakSource(buffer, { channel: 1 }).read(1, 3)], [5, 6]);
  assert.equal(bufferPeakSource(buffer, { version: "v2" }).version, "v2");
  assert.throws(() => bufferPeakSource(buffer, { channel: 2 }), RangeError);
});

test("a worker reply that lands after the source changed is discarded", async () => {
  let version = 1;
  let current = samples;
  const changing: PeakSource = {
    get version() {
      return version;
    },
    sampleRate: rate,
    length: samples.length,
    read: (start, end) => current.subarray(start, end),
  };
  const fake = fakeWorker({ hold: true });
  const tiles = createWaveformTiles({ source: () => changing, worker: () => fake.worker });
  const request = { assetId: "a", streamId: "s", start: 0, end: at(tileSamples), buckets: 32 };
  tiles.peaks(request);
  for (let i = 0; i < 20 && !fake.seen.held.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fake.seen.held.length, 1, "the worker built the first version");
  const replaced = pcm(samples.length, 5);
  current = replaced;
  version = 2;
  tiles.peaks(request);
  fake.seen.held.shift()?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(tiles.diagnostics().stale, 1, "the old tile was discarded");
  assert.ok(tiles.peaks(request)?.every(Number.isNaN), "a reply for the old version was drawn");
  for (let i = 0; i < 50 && tiles.diagnostics().pending; i++) {
    fake.seen.held.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  sameColumns(tiles.peaks(request), replaced, 0, tileSamples / 32, "new version");
  tiles.dispose();
});

test("a column across two tiles is drawn only when both are built", async () => {
  const two = pcm(2 * tileSamples, 8);
  const halfBroken: PeakSource = {
    version: 1,
    sampleRate: rate,
    length: two.length,
    read(start, end) {
      if (end > tileSamples) throw new Error("second tile unreadable");
      return two.subarray(start, end);
    },
  };
  const tiles = createWaveformTiles({ source: () => halfBroken, worker: null });
  await settled(tiles, { assetId: "a", streamId: "s", start: 0, end: at(1000), buckets: 1 });
  // Ten columns of 1,000 samples around the boundary: the sixth spans it.
  const from = tileSamples - 5500;
  const across = {
    assetId: "a",
    streamId: "s",
    start: at(from),
    end: at(from + 10000),
    buckets: 10,
  };
  const peaks = await settled(tiles, across);
  assert.ok(peaks);
  const drawn = Array.from({ length: 10 }, (_, i) => Number.isFinite(peaks[2 * i]));
  // The run of NaN samples in the first tile leaves some of its columns empty too.
  const filled = Array.from({ length: 10 }, (_, i) => {
    const [lo] = column(two, from, 1000, i);
    return from + (i + 1) * 1000 <= tileSamples && Number.isFinite(lo);
  });
  assert.deepEqual(drawn, filled);
  assert.ok(drawn.slice(0, 5).some(Boolean) && !drawn.slice(5).some(Boolean), drawn.join());
  tiles.dispose();
});

test("tiles built only for zoomed-out columns are summarised and not kept", async () => {
  const long = pcm(6 * tileSamples, 31);
  const counted = source(long);
  const tiles = createWaveformTiles({ source: () => counted, worker: null });
  const whole = { assetId: "a", streamId: "s", start: 0, end: at(long.length), buckets: 3 };
  sameColumns(await settled(tiles, whole), long, 0, long.length / 3, "overview");
  assert.equal(tiles.diagnostics().tiles, 0, "an overview kept its tiles");
  // Columns of 4,096 and 16,384 samples read the summary too.
  for (const width of [5000, 20000]) {
    const mid = {
      assetId: "a",
      streamId: "s",
      start: at(777),
      end: at(777 + 70 * width),
      buckets: 70,
    };
    sameColumns(await settled(tiles, mid), long, 777, width, "mid " + width);
  }
  assert.equal(tiles.diagnostics().tiles, 0, "a mid zoom kept its tiles");
  // A closer view of one tile builds it again and keeps it.
  const reads = counted.reads;
  const close = { assetId: "a", streamId: "s", start: at(100), end: at(5000), buckets: 49 };
  sameColumns(await settled(tiles, close), long, 100, 100, "close");
  assert.equal(tiles.diagnostics().tiles, 1);
  assert.equal(counted.reads, reads + 1);
  // The overview still answers without reading.
  sameColumns(tiles.peaks(whole), long, 0, long.length / 3, "overview again");
  await tiles.idle();
  assert.equal(counted.reads, reads + 1);
  tiles.dispose();
});
