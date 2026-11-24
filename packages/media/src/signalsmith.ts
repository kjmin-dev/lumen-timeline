import type { AudioBufferLike, StretchAudio, StretchRequest } from "./types.ts";

/** Decoded audio a rendering reads: the members of an `AudioBuffer` it uses. */
export interface DecodedAudio extends AudioBufferLike {
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** Audio a rendering writes into: an `AudioBuffer`. */
export interface WritableAudio extends DecodedAudio {
  copyToChannel(source: Float32Array<ArrayBuffer>, channel: number): void;
}

/** The members of an `OfflineAudioContext` that a rendering uses. */
export interface OfflineContextLike {
  readonly destination: object;
  createBuffer(channels: number, length: number, sampleRate: number): WritableAudio;
  startRendering(): Promise<DecodedAudio>;
}

/** The fields of a new offline context. */
export interface OfflineContextOptions {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
}

export interface SignalsmithStretchOptions {
  /**
   * Loads Signalsmith Stretch: its module, or its default export. Defaults to
   * `import("signalsmith-stretch")`, which the host installs.
   */
  readonly load?: (() => Promise<unknown>) | undefined;
  /** Creates the offline context of one rendering. Defaults to `new OfflineAudioContext(options)`. */
  readonly createContext?: ((options: OfflineContextOptions) => OfflineContextLike) | undefined;
  /** Bytes of rendered audio kept for reuse, least recently used first out. Defaults to 64 MiB. */
  readonly cacheBytes?: number | undefined;
  /** Renderings that run at once. Defaults to 2. */
  readonly concurrency?: number | undefined;
  /** `"cheaper"` trades quality for speed. Defaults to `"default"`. */
  readonly preset?: "default" | "cheaper" | undefined;
}

/** A stretch engine for `MediaOptions.stretch`, with its rendering cache. */
export interface SignalsmithStretch {
  readonly stretch: StretchAudio;
  /** Bytes of rendered audio the cache holds now. */
  cachedBytes(): number;
  /** Forgets cached renderings. Renderings in progress still settle. */
  clear(): void;
}

/** One method of the Stretch node. */
type Method = (...args: unknown[]) => unknown;

interface StretchNode {
  readonly addBuffers: Method;
  readonly schedule: Method;
  readonly configure: Method;
  readonly connect: Method;
}

interface Entry {
  readonly promise: Promise<DecodedAudio>;
  bytes: number;
  waiters: number;
  /** Removes a rendering that has not started, once nobody waits for it. */
  cancel: (() => void) | null;
}

/**
 * Source context rendered before the first frame, so the stretcher's analysis
 * window has filled when the clip starts.
 */
const PREROLL_SECONDS = 0.1;
/** Source read on both sides of the range, past the stretcher's block length. */
const MARGIN_SECONDS = 0.25;

function method(node: unknown, name: string): Method {
  const value: unknown = typeof node === "object" && node !== null ? Reflect.get(node, name) : null;
  if (typeof value !== "function") throw new TypeError("Signalsmith Stretch node lacks " + name);
  return (...args) => {
    const result: unknown = Reflect.apply(value, node, args);
    return result;
  };
}

function stretchNode(node: unknown): StretchNode {
  return {
    addBuffers: method(node, "addBuffers"),
    schedule: method(node, "schedule"),
    configure: method(node, "configure"),
    connect: method(node, "connect"),
  };
}

type Factory = (context: object, options: object) => Promise<unknown>;

/** The default export of a loaded module, or the factory itself. */
function factoryOf(loaded: unknown): Factory {
  const candidate: unknown =
    typeof loaded === "function"
      ? loaded
      : typeof loaded === "object" && loaded !== null
        ? Reflect.get(loaded, "default")
        : undefined;
  if (typeof candidate !== "function")
    throw new TypeError("Expected the Signalsmith Stretch module or its default export");
  return (context, options) =>
    Promise.resolve(Reflect.apply(candidate, undefined, [context, options]));
}

function isDecoded(buffer: AudioBufferLike): buffer is DecodedAudio {
  return (
    typeof Reflect.get(buffer, "numberOfChannels") === "number" &&
    typeof Reflect.get(buffer, "getChannelData") === "function"
  );
}

function defaultContext(options: OfflineContextOptions): OfflineContextLike {
  return new OfflineAudioContext(options);
}

function aborted(): Error {
  return new DOMException("The rendering is no longer needed", "AbortError");
}

/**
 * A stretch engine on Signalsmith Stretch. Each rendering runs the library's
 * AudioWorklet in an `OfflineAudioContext`, off the main thread, and keeps the
 * result for later voices of the same clip. It changes speed without changing
 * pitch.
 */
export function createSignalsmithStretch(
  options: SignalsmithStretchOptions = {},
): SignalsmithStretch {
  const {
    load = () => import("signalsmith-stretch"),
    createContext = defaultContext,
    cacheBytes = 64 * 1024 * 1024,
    concurrency = 2,
    preset = "default",
  } = options;
  if (!Number.isFinite(cacheBytes) || cacheBytes < 0)
    throw new RangeError("cacheBytes must be a finite nonnegative number");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new RangeError("concurrency must be a positive integer");
  let factory: Promise<Factory> | null = null;
  const ids = new WeakMap<object, number>();
  let nextId = 0;
  // Insertion order is recency: a hit moves its entry to the end.
  const entries = new Map<string, Entry>();
  let running = 0;
  const queue: (() => void)[] = [];

  function idOf(buffer: object): number {
    let id = ids.get(buffer);
    if (id === undefined) {
      id = nextId++;
      ids.set(buffer, id);
    }
    return id;
  }

  function held(): number {
    let total = 0;
    for (const entry of entries.values()) total += entry.bytes;
    return total;
  }

  function evict(): void {
    let total = held();
    for (const [key, entry] of entries) {
      if (total <= cacheBytes) break;
      if (!entry.bytes) continue;
      entries.delete(key);
      total -= entry.bytes;
    }
  }

  // Waits for a free rendering slot. `cancel` withdraws a request still waiting.
  function slot(): { readonly ready: Promise<void>; readonly cancel: () => void } {
    if (running < concurrency) {
      running++;
      return { ready: Promise.resolve(), cancel: () => {} };
    }
    let start: () => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const ready = new Promise<void>((resolve, fail) => {
      start = () => {
        running++;
        resolve();
      };
      reject = fail;
    });
    queue.push(start);
    return {
      ready,
      cancel: () => {
        const at = queue.indexOf(start);
        if (at < 0) return;
        queue.splice(at, 1);
        reject(aborted());
      },
    };
  }

  function release(): void {
    running--;
    queue.shift()?.();
  }

  async function render(source: DecodedAudio, request: StretchRequest): Promise<DecodedAudio> {
    const { sourceStart, sourceEnd, length } = request;
    const { sampleRate } = source;
    const channels = source.numberOfChannels;
    // Source samples per output frame. The rendering ends exactly at sourceEnd.
    const rate = (sourceEnd - sourceStart) / length;
    const preroll = Math.round(PREROLL_SECONDS * sampleRate);
    const margin = Math.ceil(MARGIN_SECONDS * sampleRate);
    const from = Math.max(0, sourceStart - Math.ceil(preroll * rate) - margin);
    const until = Math.min(source.length, sourceEnd + margin);
    const input: Float32Array[] = [];
    for (let channel = 0; channel < channels; channel++)
      input.push(source.getChannelData(channel).slice(from, until));
    factory ??= load().then(factoryOf);
    let create: Factory;
    try {
      create = await factory;
    } catch (error) {
      // A later request may load it after a transient failure.
      factory = null;
      throw error;
    }
    const context = createContext({
      numberOfChannels: channels,
      length: preroll + length,
      sampleRate,
    });
    const node = stretchNode(
      await create(context, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [channels],
      }),
    );
    if (preset === "cheaper") await node.configure({ blockMs: 0, preset: "cheaper" });
    await node.addBuffers(input);
    // Output frame `preroll` reads input `sourceStart`, in the copied region's seconds.
    await node.schedule({
      output: 0,
      input: (sourceStart - from - preroll * rate) / sampleRate,
      rate,
      active: true,
    });
    node.connect(context.destination);
    const rendered = await context.startRendering();
    const result = context.createBuffer(channels, length, sampleRate);
    for (let channel = 0; channel < channels; channel++)
      result.copyToChannel(
        rendered.getChannelData(channel).slice(preroll, preroll + length),
        channel,
      );
    return result;
  }

  const stretch: StretchAudio = (request, signal) => {
    const { buffer } = request;
    if (!isDecoded(buffer))
      return Promise.reject(new TypeError("Signalsmith stretching needs a decoded AudioBuffer"));
    if (!(request.length > 0) || !(request.sourceEnd > request.sourceStart))
      return Promise.reject(new RangeError("Nothing to stretch"));
    const key = [idOf(buffer), request.sourceStart, request.sourceEnd, request.length].join(":");
    let entry = entries.get(key);
    if (entry) {
      entries.delete(key);
      entries.set(key, entry);
    } else {
      const waiting = slot();
      const created: Entry = {
        promise: waiting.ready.then(() =>
          render(buffer, request).finally(() => {
            release();
          }),
        ),
        bytes: 0,
        waiters: 0,
        cancel: null,
      };
      created.cancel = () => {
        waiting.cancel();
        if (entries.get(key) === created) entries.delete(key);
      };
      created.promise.then(
        (result) => {
          created.cancel = null;
          if (entries.get(key) !== created) return;
          created.bytes = result.length * result.numberOfChannels * 4;
          evict();
        },
        () => {
          created.cancel = null;
          if (entries.get(key) === created) entries.delete(key);
        },
      );
      void waiting.ready.then(
        () => {
          created.cancel = null;
        },
        () => {},
      );
      entries.set(key, created);
      entry = created;
    }
    const current = entry;
    current.waiters++;
    const leave = (): void => {
      current.waiters--;
      if (current.waiters === 0) current.cancel?.();
    };
    if (signal.aborted) leave();
    else signal.addEventListener("abort", leave, { once: true });
    return current.promise;
  };

  return {
    stretch,
    cachedBytes: held,
    clear() {
      entries.clear();
    },
  };
}
