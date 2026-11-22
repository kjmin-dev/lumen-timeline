import { peaksWasm } from "./peaks-wasm.ts";

// Waveform peak kernels. A pair is the minimum and maximum of the finite
// samples in a bucket. A bucket with no finite sample is empty: +Infinity and
// -Infinity, the identity for both. Negative zero is stored as zero, so the
// JavaScript and WebAssembly kernels return the same bits. wasm/peaks.rs holds
// the WebAssembly side.

/** Samples in one tile. */
export const tileSamples = 65536;
/** Samples per bucket of each level in a tile, finest first. */
export const tileLevels: readonly number[] = Object.freeze([16, 64, 256, 1024, 4096, 16384]);
/** Where each level starts in a tile, in pairs. */
export const levelOffsets: readonly number[] = Object.freeze([0, 4096, 5120, 5376, 5440, 5456]);
/** Pairs in one tile. */
export const tilePairs = 5460;
/** The most samples one call accepts: 256 tiles. */
export const maxBatchSamples: number = 256 * tileSamples;

/** The kernel that computed a result. */
export type PeakBackend = "wasm-simd" | "js";

/** Peak kernels over one channel of PCM. Every method validates its lengths first. */
export interface PeakKernel {
  readonly backend: PeakBackend;
  /** Writes `2 * ceil(samples.length / perBucket)` values to `out`. */
  reduce(samples: Float32Array, perBucket: number, out: Float32Array): void;
  /** Combines `factor` pairs to one, writing `2 * ceil(pairs / factor)` values to `out`. */
  fold(pairs: Float32Array, factor: number, out: Float32Array): void;
  /**
   * Writes one tile per 65,536 samples, the last partial, to `out`: `2 *
   * tilePairs` values per tile. Returns the tile count.
   */
  tiles(samples: Float32Array, out: Float32Array): number;
}

const pairsIn = (length: number, per: number): number => Math.ceil(length / per);

function checkCount(value: number, name: string, max: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new RangeError(`Expected ${name} to be an integer from 1 to ${max}`);
}

function checkReduce(samples: Float32Array, perBucket: number, out: Float32Array): number {
  checkCount(perBucket, "samples per bucket", maxBatchSamples);
  if (samples.length > maxBatchSamples)
    throw new RangeError(`Expected at most ${maxBatchSamples} samples`);
  const values = 2 * pairsIn(samples.length, perBucket);
  if (out.length < values) throw new RangeError(`Expected room for ${values} values`);
  return values;
}

function checkFold(pairs: Float32Array, factor: number, out: Float32Array): number {
  checkCount(factor, "the fold factor", maxBatchSamples);
  if (pairs.length % 2) throw new RangeError("Expected whole pairs");
  if (pairs.length > 2 * maxBatchSamples)
    throw new RangeError(`Expected at most ${maxBatchSamples} pairs`);
  const values = 2 * pairsIn(pairs.length / 2, factor);
  if (out.length < values) throw new RangeError(`Expected room for ${values} values`);
  return values;
}

function checkTiles(samples: Float32Array, out: Float32Array): number {
  if (samples.length > maxBatchSamples)
    throw new RangeError(`Expected at most ${maxBatchSamples} samples`);
  const count = pairsIn(samples.length, tileSamples);
  if (out.length < count * 2 * tilePairs)
    throw new RangeError(`Expected room for ${count * 2 * tilePairs} values`);
  return count;
}

function reduceInto(samples: Float32Array, per: number, out: Float32Array, at: number): void {
  for (let start = 0, pair = at; start < samples.length; start += per, pair++) {
    const end = Math.min(samples.length, start + per);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = start; i < end; i++) {
      // Comparisons with NaN are false, and each test leaves out one infinity.
      const value = samples[i] ?? NaN;
      if (value < lo && value !== -Infinity) lo = value;
      if (value > hi && value !== Infinity) hi = value;
    }
    out[2 * pair] = lo + 0;
    out[2 * pair + 1] = hi + 0;
  }
}

function foldInto(
  pairs: Float32Array,
  from: number,
  count: number,
  factor: number,
  out: Float32Array,
  at: number,
): void {
  for (let start = 0, pair = at; start < count; start += factor, pair++) {
    const end = Math.min(count, start + factor);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = from + start; i < from + end; i++) {
      const a = pairs[2 * i] ?? NaN;
      const b = pairs[2 * i + 1] ?? NaN;
      if (a < lo) lo = a;
      if (b > hi) hi = b;
    }
    out[2 * pair] = lo + 0;
    out[2 * pair + 1] = hi + 0;
  }
}

function tilesInto(samples: Float32Array, out: Float32Array, count: number): void {
  const finest = tileSamples / 16;
  for (let tile = 0; tile < count; tile++) {
    const base = tile * tilePairs;
    const part = samples.subarray(tile * tileSamples, (tile + 1) * tileSamples);
    reduceInto(part, 16, out, base);
    // Buckets past the last sample are empty.
    for (let pair = base + pairsIn(part.length, 16); pair < base + finest; pair++) {
      out[2 * pair] = Infinity;
      out[2 * pair + 1] = -Infinity;
    }
    for (let level = 1; level < tileLevels.length; level++) {
      const from = base + (levelOffsets[level - 1] ?? 0);
      const to = base + (levelOffsets[level] ?? 0);
      foldInto(out, from, to - from, 4, out, to);
    }
  }
}

/** The JavaScript kernels, available everywhere. */
export const jsKernel: PeakKernel = Object.freeze({
  backend: "js",
  reduce(samples: Float32Array, perBucket: number, out: Float32Array): void {
    checkReduce(samples, perBucket, out);
    reduceInto(samples, perBucket, out, 0);
  },
  fold(pairs: Float32Array, factor: number, out: Float32Array): void {
    checkFold(pairs, factor, out);
    foldInto(pairs, 0, pairs.length / 2, factor, out, 0);
  },
  tiles(samples: Float32Array, out: Float32Array): number {
    const count = checkTiles(samples, out);
    tilesInto(samples, out, count);
    return count;
  },
} satisfies PeakKernel);

type Entry = (input: number, count: number, size: number, output: number) => void;
type TileEntry = (input: number, count: number, output: number) => void;
const isEntry = (value: unknown): value is Entry => typeof value === "function";
const isTileEntry = (value: unknown): value is TileEntry => typeof value === "function";

/** The bytes of the bundled module, built from wasm/peaks.rs with Rust 1.100.0. */
export function peakModuleBytes(): Uint8Array<ArrayBuffer> {
  const text = atob(peaksWasm);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/**
 * Instantiates the WebAssembly SIMD kernels. Rejects where WebAssembly or its
 * SIMD extension is unavailable, so the caller can keep the JavaScript ones. A
 * call whose memory cannot grow throws a `RangeError` and leaves the module
 * usable for smaller inputs.
 */
export async function loadWasmKernel(bytes: BufferSource = peakModuleBytes()): Promise<PeakKernel> {
  const { instance } = await WebAssembly.instantiate(bytes);
  const { memory, reduce, fold, tiles, __heap_base: heapBase } = instance.exports;
  if (
    !(memory instanceof WebAssembly.Memory) ||
    !(heapBase instanceof WebAssembly.Global) ||
    typeof heapBase.value !== "number" ||
    !isEntry(reduce) ||
    !isEntry(fold) ||
    !isTileEntry(tiles)
  )
    throw new TypeError("The peak module lacks its exports");
  const heap: WebAssembly.Memory = memory;
  const run: { reduce: Entry; fold: Entry; tiles: TileEntry } = { reduce, fold, tiles };
  const memoryBase = Math.ceil(heapBase.value / 16) * 16;
  // Input at the heap base, then output, both 16-byte aligned. Views are made
  // after any growth, since growing replaces the memory's buffer.
  function region(inputs: number, outputs: number): [Float32Array, Float32Array] {
    const outputAt = memoryBase + Math.ceil((inputs * 4) / 16) * 16;
    const end = outputAt + outputs * 4;
    const short = end - heap.buffer.byteLength;
    if (short > 0) {
      try {
        heap.grow(Math.ceil(short / 65536));
      } catch {
        throw new RangeError(`The peak module cannot grow to ${end} bytes`);
      }
    }
    return [
      new Float32Array(heap.buffer, memoryBase, inputs),
      new Float32Array(heap.buffer, outputAt, outputs),
    ];
  }
  return Object.freeze({
    backend: "wasm-simd",
    reduce(samples: Float32Array, perBucket: number, out: Float32Array): void {
      const values = checkReduce(samples, perBucket, out);
      const [input, output] = region(samples.length, values);
      input.set(samples);
      run.reduce(input.byteOffset, samples.length, perBucket, output.byteOffset);
      out.set(output);
    },
    fold(pairs: Float32Array, factor: number, out: Float32Array): void {
      const values = checkFold(pairs, factor, out);
      const [input, output] = region(pairs.length, values);
      input.set(pairs);
      run.fold(input.byteOffset, pairs.length / 2, factor, output.byteOffset);
      out.set(output);
    },
    tiles(samples: Float32Array, out: Float32Array): number {
      const count = checkTiles(samples, out);
      const [input, output] = region(samples.length, count * 2 * tilePairs);
      input.set(samples);
      run.tiles(input.byteOffset, samples.length, output.byteOffset);
      out.set(output);
      return count;
    },
  } satisfies PeakKernel);
}
