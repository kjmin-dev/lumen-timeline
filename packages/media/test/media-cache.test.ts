import assert from "node:assert/strict";
import test from "node:test";
import { TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import { buildPeakOverview, createMediaCache, createWaveformTiles } from "@lumen-timeline/media";
import type {
  ChannelBufferLike,
  MediaCacheEvent,
  SampleRequest,
  StreamReader,
} from "@lumen-timeline/media";

const rate = 48000;

/** A decoded chunk whose samples are their own frame index, scaled. */
function chunk(request: SampleRequest, channels = 1, length = request.end - request.start) {
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) data[i] = (request.start + i) / 1e7;
  return {
    sampleRate: request.sampleRate,
    length,
    numberOfChannels: channels,
    getChannelData: () => data,
  } satisfies ChannelBufferLike;
}

interface Pending {
  readonly request: SampleRequest;
  readonly signal: AbortSignal;
  resolve(buffer?: ChannelBufferLike): void;
  reject(error: unknown): void;
}

/** A reader whose reads wait until the test settles them. */
function manualReader() {
  const pending: Pending[] = [];
  const reader: StreamReader = {
    read: (request, signal) =>
      new Promise<ChannelBufferLike>((resolve, reject) => {
        pending.push({
          request,
          signal,
          resolve: (buffer) => resolve(buffer ?? chunk(request)),
          reject,
        });
      }),
  };
  return {
    reader,
    pending,
    /** Settles every read in flight and lets their continuations run. */
    settle: async (): Promise<void> => {
      for (const read of pending.splice(0)) if (!read.signal.aborted) read.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const key = (index: number, assetId = "stem") => ({
  assetId,
  streamId: "main",
  assetVersion: 1,
  sampleRate: rate,
  start: index * 10 * rate,
  end: (index + 1) * 10 * rate,
});

test("preloads read whole chunks on the grid, at most four at a time, and report progress", async () => {
  const { reader, pending, settle } = manualReader();
  const media = createMediaCache({ reader });
  // 25 seconds starting mid-chunk covers chunks 0 to 3.
  const hold = media.preload([{ ...key(0), start: 5 * rate, end: 35 * rate }]);
  assert.equal(pending.length, 4);
  assert.deepEqual(
    pending.map((read) => [read.request.start, read.request.end]),
    [0, 1, 2, 3].map((i) => [i * 10 * rate, (i + 1) * 10 * rate]),
  );
  assert.deepEqual(hold.progress(), { loaded: 0, total: 4 });
  await settle();
  assert.deepEqual(hold.progress(), { loaded: 4, total: 4 });
  assert.equal(await hold.settled, 0);
  assert.deepEqual(media.loaded("stem", "main", 1), [{ start: 0, end: 40 * rate }]);
  const stats = media.diagnostics();
  assert.equal(stats.chunks, 4);
  assert.equal(stats.bytes, 4 * 10 * rate * 4);
  assert.equal(stats.inUse, 4);
  assert.ok(hold.release());
  assert.ok(!hold.release());
  assert.equal(media.diagnostics().inUse, 0);
  // Released chunks stay until the budget needs their room.
  assert.equal(media.diagnostics().chunks, 4);
  media.dispose();
});

test("the budget drops unused chunks least recently used first and never one in use", async () => {
  const { reader, settle } = manualReader();
  const chunkBytes = 10 * rate * 4;
  const events: MediaCacheEvent[] = [];
  const media = createMediaCache({ reader, budgetBytes: 3 * chunkBytes });
  media.subscribe((event) => events.push(event));
  const first = media.preload([key(0)]);
  const second = media.preload([key(1)]);
  await settle();
  first.release();
  second.release();
  const third = media.preload([key(2)]);
  await settle();
  // Reading chunk 0 again makes chunk 1 the least recently used.
  const again = media.preload([key(0)]);
  assert.equal(media.diagnostics().hits, 1);
  const fourth = media.preload([key(3)]);
  await settle();
  assert.deepEqual(
    events.filter((e) => e.type === "evicted").map((e) => e.start / (10 * rate)),
    [1],
  );
  // Chunks 0, 2 and 3 are all held: a fifth goes over budget rather than drop one.
  const fifth = media.preload([key(4)]);
  await settle();
  const stats = media.diagnostics();
  assert.equal(stats.chunks, 4);
  assert.equal(stats.bytes, 4 * chunkBytes);
  assert.equal(stats.evictions, 1);
  for (const hold of [third, again, fourth, fifth]) hold.release();
  media.clear();
  assert.equal(media.diagnostics().bytes, 0);
  media.dispose();
});

test("a chunk two holders read is aborted only when neither needs it", async () => {
  const { reader, pending } = manualReader();
  const media = createMediaCache({ reader });
  const a = media.preload([key(0)]);
  const b = media.preload([key(0)]);
  assert.equal(pending.length, 1);
  const [read] = pending;
  a.release();
  assert.equal(read?.signal.aborted, false);
  b.release();
  assert.equal(read?.signal.aborted, true);
  assert.equal(media.diagnostics().aborted, 1);
  media.dispose();
});

test("a reader failure is reported, retried by the next hold and not cached", async () => {
  let fail = true;
  const reads: number[] = [];
  const media = createMediaCache({
    reader: {
      read(request) {
        reads.push(request.start);
        if (fail) return Promise.reject(new Error("401 Unauthorized"));
        return chunk(request);
      },
    },
  });
  const events: MediaCacheEvent[] = [];
  media.subscribe((event) => events.push(event));
  const hold = media.preload([key(0)]);
  assert.equal(await hold.settled, 1);
  assert.equal(events[0]?.type, "failed");
  assert.match(String(events[0]?.error), /401/);
  hold.release();
  fail = false;
  const retry = media.preload([key(0)]);
  assert.equal(await retry.settled, 0);
  assert.equal(reads.length, 2);
  assert.equal(media.diagnostics().failures, 1);
  retry.release();
  media.dispose();
});

test("a reader must answer with the asked rate and no more than the asked frames", async () => {
  const media = createMediaCache({
    reader: { read: (request) => ({ ...chunk(request), sampleRate: 44100 }) },
  });
  const hold = media.preload([key(0)]);
  assert.equal(await hold.settled, 1);
  hold.release();
  // The stream's last chunk may end early.
  const short = createMediaCache({ reader: { read: (request) => chunk(request, 2, 1000) } });
  const tail = short.preload([key(7)]);
  assert.equal(await tail.settled, 0);
  assert.deepEqual(short.loaded("stem", "main", 1), [{ start: 70 * rate, end: 70 * rate + 1000 }]);
  assert.equal(short.diagnostics().bytes, 1000 * 2 * 4);
  tail.release();
  media.dispose();
  short.dispose();
});

test("peak sources read across chunk edges and pass the host's overview through", async () => {
  const media = createMediaCache({ reader: { read: (request) => chunk(request) } });
  const overview = buildPeakOverview(new Float32Array([0.5, -0.25, 1, 0, -1, 0.75]), 4);
  const source = media.peakSource({
    assetId: "stem",
    streamId: "main",
    assetVersion: 1,
    sampleRate: rate,
    length: 30 * rate,
    overview,
  });
  assert.equal(source.overview, overview);
  assert.deepEqual([...overview.peaks], [-0.25, 1, -1, 0.75]);
  const from = 10 * rate - 3;
  const samples = await source.read(from, from + 6);
  assert.deepEqual(
    Array.from(samples),
    [0, 1, 2, 3, 4, 5].map((i) => Math.fround((from + i) / 1e7)),
  );
  // Reads hold their chunks only while they copy.
  assert.equal(media.diagnostics().inUse, 0);
  media.dispose();
});

test("zoomed-out waveforms draw from the overview without reading samples", async () => {
  let reads = 0;
  const length = 3 * 3600 * rate;
  const overview = buildPeakOverview(
    Float32Array.from({ length: length / 4096 }, (_, i) => Math.sin(i)),
    1,
  );
  const tiles = createWaveformTiles({
    worker: null,
    source: () => ({
      version: 1,
      sampleRate: rate,
      length,
      overview: { samplesPerPair: 4096, peaks: overview.peaks },
      read(start, end) {
        reads++;
        return new Float32Array(end - start);
      },
    }),
  });
  const peaks = tiles.peaks({
    assetId: "stem",
    streamId: "main",
    start: 0,
    end: 3 * 3600 * hz,
    buckets: 1200,
  });
  assert.ok(peaks);
  assert.ok(peaks.every((value) => Number.isFinite(value)));
  assert.ok(peaks[0] <= peaks[1]);
  await tiles.idle();
  assert.equal(reads, 0);
  // A close view still builds tiles from samples.
  tiles.peaks({ assetId: "stem", streamId: "main", start: 0, end: hz, buckets: 1200 });
  await tiles.idle();
  assert.ok(reads > 0);
  tiles.dispose();
});

test("a disposed cache rejects holds and aborts reads", async () => {
  const { reader, pending } = manualReader();
  const media = createMediaCache({ reader });
  const hold = media.preload([key(0)]);
  media.dispose();
  assert.equal(pending[0]?.signal.aborted, true);
  assert.equal(await hold.settled, 1);
  assert.equal(await media.preload([key(1)]).settled, 1);
});

test("options are checked", () => {
  const reader: StreamReader = { read: (request) => chunk(request) };
  assert.throws(() => createMediaCache({ reader, budgetBytes: 0 }), RangeError);
  assert.throws(() => createMediaCache({ reader, chunkSeconds: -1 }), RangeError);
  // @ts-expect-error A reader is required.
  assert.throws(() => createMediaCache({}), TypeError);
});
