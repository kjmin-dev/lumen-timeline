import assert from "node:assert/strict";
import test from "node:test";
import { TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import type { AudioSpan } from "@lumen-timeline/core";
import type { StretchRequest } from "@lumen-timeline/media";
import { createSignalsmithStretch } from "@lumen-timeline/media/signalsmith";
import type {
  DecodedAudio,
  OfflineContextLike,
  OfflineContextOptions,
  WritableAudio,
} from "@lumen-timeline/media/signalsmith";

const rate = 1000;

/** Audio whose every sample holds its own index plus 1000 times its channel. */
class Audio implements WritableAudio {
  readonly channels: Float32Array[];
  readonly sampleRate: number;
  constructor(channels: number, length: number, sampleRate: number, fill = true) {
    this.sampleRate = sampleRate;
    this.channels = Array.from({ length: channels }, (_, c) =>
      Float32Array.from({ length }, (_, i) => (fill ? i + 1000 * c : 0)),
    );
  }
  get length(): number {
    return this.channels[0]?.length ?? 0;
  }
  get numberOfChannels(): number {
    return this.channels.length;
  }
  getChannelData(channel: number): Float32Array {
    const data = this.channels[channel];
    assert.ok(data);
    return data;
  }
  copyToChannel(source: Float32Array<ArrayBuffer>, channel: number): void {
    this.getChannelData(channel).set(source);
  }
}

interface Call {
  readonly context: OfflineContextOptions;
  readonly node: object;
  readonly added: Float32Array[][];
  readonly scheduled: object[];
  readonly configured: object[];
}

/** A fake Stretch module whose rendering is the offline context's frame index. */
function fakes() {
  const calls: Call[] = [];
  let loads = 0;
  const pending: (() => void)[] = [];
  let hold = false;
  const createContext = (options: OfflineContextOptions): OfflineContextLike => {
    const call: Call = { context: options, node: {}, added: [], scheduled: [], configured: [] };
    calls.push(call);
    return {
      destination: {},
      createBuffer: (channels, length, sampleRate) =>
        new Audio(channels, length, sampleRate, false),
      startRendering: () =>
        new Promise<DecodedAudio>((resolve) => {
          const done = () =>
            resolve(new Audio(options.numberOfChannels, options.length, options.sampleRate));
          if (hold) pending.push(done);
          else done();
        }),
    };
  };
  const module = {
    default: (context: object, options: object) => {
      const call = calls.at(-1);
      assert.ok(call);
      assert.deepEqual(options, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [call.context.numberOfChannels],
      });
      return Promise.resolve({
        addBuffers: (buffers: Float32Array[]) => {
          call.added.push(buffers);
          return Promise.resolve(buffers[0]?.length);
        },
        schedule: (change: object) => {
          call.scheduled.push(change);
          return Promise.resolve();
        },
        configure: (config: object) => {
          call.configured.push(config);
          return Promise.resolve();
        },
        connect: (destination: object) => {
          assert.ok(destination);
          return destination;
        },
      });
    },
  };
  const load = () => {
    loads++;
    return Promise.resolve(module);
  };
  return {
    calls,
    createContext,
    load,
    loads: () => loads,
    hold: (on: boolean) => {
      hold = on;
    },
    release: () => pending.splice(0).forEach((done) => done()),
  };
}

const span = { clipId: "line" } satisfies Partial<AudioSpan>;
function request(
  buffer: Audio,
  sourceStart: number,
  sourceEnd: number,
  length: number,
): StretchRequest {
  return {
    span: {
      ...span,
      trackId: "voice",
      chainId: null,
      takeId: null,
      assetId: "a",
      assetVersion: 1,
      streamId: "mono",
      sampleRate: buffer.sampleRate,
      gain: 1,
      rate: (sourceEnd - sourceStart) / length,
      sourceOriginTick: 0,
      audible: { start: 0, end: hz, sourceStart, sourceEnd },
      window: { start: 0, end: hz, sourceStart, sourceEnd },
    },
    buffer,
    sourceStart,
    sourceEnd,
    length,
  };
}
const signal = (): AbortSignal => new AbortController().signal;

test("a rendering reads the source around its range and keeps the frames after the preroll", async () => {
  const f = fakes();
  const engine = createSignalsmithStretch({ load: f.load, createContext: f.createContext });
  const source = new Audio(2, 10 * rate, rate);
  // Two seconds of source from 3 s, stretched to 2.5 s: rate 0.8.
  const result = await engine.stretch(request(source, 3 * rate, 5 * rate, 2.5 * rate), signal());
  const [call] = f.calls;
  assert.ok(call);
  // A 0.1 s preroll ahead of 2.5 s of output.
  assert.deepEqual(call.context, { numberOfChannels: 2, length: 100 + 2500, sampleRate: rate });
  // The copied input starts a margin of 0.25 s and the preroll's 80 samples early.
  const from = 3 * rate - 80 - 250;
  const [input] = call.added;
  assert.ok(input);
  assert.equal(input.length, 2);
  assert.equal(input[0]?.[0], from);
  assert.equal(input[1]?.[0], from + 1000);
  assert.equal(input[0]?.length, 5 * rate + 250 - from);
  assert.deepEqual(call.scheduled, [
    { output: 0, input: (3 * rate - from - 80) / rate, rate: 0.8, active: true },
  ]);
  assert.deepEqual(call.configured, []);
  assert.equal(result.length, 2.5 * rate);
  assert.equal(result.sampleRate, rate);
  assert.ok("getChannelData" in result && typeof result.getChannelData === "function");
  // The fake renders each frame's index: the result starts after the preroll.
  const data = Reflect.apply(result.getChannelData, result, [1]);
  assert.ok(data instanceof Float32Array);
  assert.equal(data[0], 100 + 1000);
  assert.equal(data.at(-1), 100 + 2499 + 1000);
});

test("renderings are cached per source range and length, within the byte budget", async () => {
  const f = fakes();
  const one = new Audio(1, 10 * rate, rate);
  const two = new Audio(1, 10 * rate, rate);
  // Room for one 2,000-frame mono rendering of 8,000 bytes.
  const engine = createSignalsmithStretch({
    load: f.load,
    createContext: f.createContext,
    cacheBytes: 10_000,
  });
  const a = await engine.stretch(request(one, 0, 1000, 2000), signal());
  const again = await engine.stretch(request(one, 0, 1000, 2000), signal());
  assert.equal(again, a);
  assert.equal(f.calls.length, 1);
  assert.equal(f.loads(), 1, "the module loads once");
  assert.equal(engine.cachedBytes(), 8000);
  await engine.stretch(request(two, 0, 1000, 2000), signal());
  assert.equal(f.calls.length, 2, "another buffer renders again");
  assert.equal(engine.cachedBytes(), 8000, "the older rendering is evicted");
  await engine.stretch(request(one, 0, 1000, 2000), signal());
  assert.equal(f.calls.length, 3);
  engine.clear();
  assert.equal(engine.cachedBytes(), 0);
  await engine.stretch(request(one, 0, 1000, 1999), signal());
  assert.equal(f.calls.length, 4, "a different length renders again");
});

test("renderings wait for a free slot, and one nobody waits for never starts", async () => {
  const f = fakes();
  const engine = createSignalsmithStretch({
    load: f.load,
    createContext: f.createContext,
    concurrency: 1,
  });
  const source = new Audio(1, 10 * rate, rate);
  f.hold(true);
  const first = engine.stretch(request(source, 0, 1000, 1250), signal());
  const controller = new AbortController();
  const second = engine.stretch(request(source, 1000, 2000, 1250), controller.signal);
  const third = engine.stretch(request(source, 2000, 3000, 1250), signal());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.length, 1, "one rendering runs at a time");
  controller.abort();
  await assert.rejects(Promise.resolve(second), { name: "AbortError" });
  f.release();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  f.release();
  await third;
  assert.equal(f.calls.length, 2, "the withdrawn rendering never ran");
  // A request whose voice was already gone waits for nothing either.
  f.hold(true);
  const busy = engine.stretch(request(source, 3000, 4000, 1250), signal());
  const gone = AbortSignal.abort();
  await assert.rejects(Promise.resolve(engine.stretch(request(source, 4000, 5000, 1250), gone)), {
    name: "AbortError",
  });
  // Let the running rendering reach its offline context before releasing it.
  await new Promise((resolve) => setImmediate(resolve));
  f.release();
  await busy;
  assert.equal(f.calls.length, 3);
});

test("a cheaper preset configures the node, and unusable input is rejected", async () => {
  const f = fakes();
  const engine = createSignalsmithStretch({
    load: f.load,
    createContext: f.createContext,
    preset: "cheaper",
  });
  await engine.stretch(request(new Audio(1, 4 * rate, rate), 0, 1000, 800), signal());
  assert.deepEqual(f.calls[0]?.configured, [{ blockMs: 0, preset: "cheaper" }]);
  const plain = request(new Audio(1, 4 * rate, rate), 0, 1000, 800);
  await assert.rejects(
    Promise.resolve(
      engine.stretch({ ...plain, buffer: { sampleRate: rate, length: 4000 } }, signal()),
    ),
    TypeError,
  );
  await assert.rejects(
    Promise.resolve(engine.stretch({ ...plain, length: 0 }, signal())),
    RangeError,
  );
  assert.throws(() => createSignalsmithStretch({ concurrency: 0 }), RangeError);
  assert.throws(() => createSignalsmithStretch({ cacheBytes: -1 }), RangeError);
});

test("a failed load is retried by the next rendering", async () => {
  const f = fakes();
  let fail = true;
  const engine = createSignalsmithStretch({
    load: () => (fail ? Promise.reject(new Error("offline")) : f.load()),
    createContext: f.createContext,
  });
  const source = new Audio(1, 4 * rate, rate);
  await assert.rejects(
    Promise.resolve(engine.stretch(request(source, 0, 1000, 800), signal())),
    /offline/,
  );
  fail = false;
  const result = await engine.stretch(request(source, 0, 1000, 800), signal());
  assert.equal(result.length, 800);
  const loaded = { default: 42 };
  const broken = createSignalsmithStretch({
    load: () => Promise.resolve(loaded),
    createContext: f.createContext,
  });
  await assert.rejects(
    Promise.resolve(broken.stretch(request(source, 0, 1000, 800), signal())),
    TypeError,
  );
});
