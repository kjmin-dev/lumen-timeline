import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  jsKernel,
  levelOffsets,
  loadWasmKernel,
  maxBatchSamples,
  peakModuleBytes,
  peaksWasmSha256,
  tileLevels,
  tilePairs,
  tileSamples,
} from "@lumen-timeline/media/internal";
import type { PeakKernel } from "@lumen-timeline/media/internal";

const wasm = await loadWasmKernel();

/** A seeded generator that reads the high bits, so short walks do not repeat. */
function random(seed: number): (n: number) => number {
  let state = seed >>> 0;
  return (n) => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return Math.floor((state / 4294967296) * n);
  };
}

/** PCM with every value a decoder could hand over, NaN and infinities included. */
function pcm(length: number, seed: number): Float32Array {
  const next = random(seed);
  const special = [NaN, Infinity, -Infinity, 0, -0, 1, -1, 3.5, -3.5, 1e-45, -1e-45];
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++)
    samples[i] = next(9) === 0 ? special[next(special.length)] : (next(20001) - 10000) / 7919;
  return samples;
}

/** The definition, one bucket at a time over finite samples. */
function expected(samples: Float32Array, per: number): Float32Array {
  const out = new Float32Array(2 * Math.ceil(samples.length / per));
  for (let b = 0; b * per < samples.length; b++) {
    const finite = [...samples.subarray(b * per, (b + 1) * per)].filter(Number.isFinite);
    out[2 * b] = finite.length ? Math.min(...finite) + 0 : Infinity;
    out[2 * b + 1] = finite.length ? Math.max(...finite) + 0 : -Infinity;
  }
  return out;
}

const bits = (values: Float32Array): Uint32Array =>
  new Uint32Array(values.buffer, values.byteOffset, values.length);

function sameBits(actual: Float32Array, wanted: Float32Array, label: string): void {
  assert.equal(actual.length, wanted.length, label);
  const a = bits(actual);
  const b = bits(wanted);
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i]) assert.fail(`${label}: value ${i} is ${actual[i]}, expected ${wanted[i]}`);
}

const kernels: readonly PeakKernel[] = [jsKernel, wasm];

test("both kernels reduce to the definition, bit for bit, across bucket sizes and lengths", () => {
  assert.equal(wasm.backend, "wasm-simd");
  const next = random(7);
  const sizes = [1, 2, 3, 4, 5, 7, 15, 16, 17, 63, 64, 65, 255, 256, 257, 1000, 4096];
  for (let round = 0; round < 120; round++) {
    const per = sizes[round % sizes.length];
    const samples = pcm(next(3 * per + 50), round);
    const wanted = expected(samples, per);
    for (const kernel of kernels) {
      const out = new Float32Array(wanted.length);
      kernel.reduce(samples, per, out);
      sameBits(out, wanted, `${kernel.backend} ${per}/${samples.length}`);
    }
  }
});

test("a bucket of only NaN and infinities is empty, and negative zero reads as zero", () => {
  const samples = Float32Array.from([NaN, Infinity, -Infinity, NaN, -0, -0, 0, -0]);
  for (const kernel of kernels) {
    const out = new Float32Array(4);
    kernel.reduce(samples, 4, out);
    sameBits(out.subarray(0, 2), Float32Array.from([Infinity, -Infinity]), kernel.backend);
    assert.ok(Object.is(out[2], 0) && Object.is(out[3], 0), kernel.backend);
  }
});

test("folding pairs equals reducing the samples directly at the coarser size", () => {
  const samples = pcm(70001, 3);
  for (const kernel of kernels)
    for (const [per, factor] of [
      [16, 4],
      [16, 16],
      [7, 3],
      [1, 5],
    ]) {
      const fine = new Float32Array(2 * Math.ceil(samples.length / per));
      kernel.reduce(samples, per, fine);
      const folded = new Float32Array(2 * Math.ceil(fine.length / 2 / factor));
      kernel.fold(fine, factor, folded);
      sameBits(folded, expected(samples, per * factor), `${kernel.backend} ${per}×${factor}`);
    }
});

test("tiles hold six levels of the same peaks, with the last tile partial and its tail empty", () => {
  const samples = pcm(2 * tileSamples + 12345, 11);
  const tiles = 3;
  const outputs = kernels.map((kernel) => {
    const out = new Float32Array(tiles * 2 * tilePairs);
    assert.equal(kernel.tiles(samples, out), tiles);
    return out;
  });
  sameBits(outputs[0], outputs[1], "js and wasm tiles");
  for (let tile = 0; tile < tiles; tile++) {
    const part = samples.subarray(tile * tileSamples, (tile + 1) * tileSamples);
    tileLevels.forEach((per, level) => {
      const at = 2 * (tile * tilePairs + levelOffsets[level]);
      const count = tileSamples / per;
      const level$ = outputs[0].subarray(at, at + 2 * count);
      const wanted = new Float32Array(2 * count);
      for (let pair = 0; pair < count; pair++) {
        wanted[2 * pair] = Infinity;
        wanted[2 * pair + 1] = -Infinity;
      }
      wanted.set(expected(part, per));
      sameBits(level$, wanted, `tile ${tile} level ${per}`);
    });
  }
});

test("tiles reduce four buckets at once, retrying a group an infinity reached, to the same bits", () => {
  // The WASM kernel skips the finite test for whole 64-sample groups and
  // redoes a group only when -inf or +inf reached its extremes.
  const next = random(23);
  const finite = (length: number): Float32Array =>
    Float32Array.from({ length }, () => (next(20001) - 10000) / 7919);
  const cases: [string, Float32Array][] = [];
  // Finite samples, with a tail of 17 after the last whole group.
  cases.push(["finite", finite(tileSamples + 3 * 64 + 17)]);
  // NaN never reaches an extreme, so it keeps the fast path.
  const nan = finite(4 * 64);
  for (let i = 0; i < nan.length; i += 7) nan[i] = NaN;
  cases.push(["NaN", nan]);
  // A lone -inf, then a lone +inf, at every place of a group.
  const lone = finite(128 * 64);
  for (let place = 0; place < 64; place++) {
    lone[64 * place + place] = -Infinity;
    lone[64 * (64 + place) + place] = Infinity;
  }
  cases.push(["lone infinities", lone]);
  // Groups of only NaN, only one infinity, both, zeros of both signs, extremes
  // and denormals.
  const groups = [[NaN], [Infinity], [-Infinity], [Infinity, -Infinity, NaN], [-0], [-0, 0]];
  groups.push([3.4e38, -3.4e38, 1e-45, -1e-45]);
  const special = new Float32Array(64 * groups.length);
  groups.forEach((values, g) => {
    for (let i = 0; i < 64; i++) special[64 * g + i] = values[i % values.length] ?? NaN;
  });
  cases.push(["special groups", special]);
  // Every length of tail after whole groups.
  for (let tail = 1; tail < 64; tail++) cases.push([`tail ${tail}`, finite(2 * 64 + tail)]);
  for (const [label, samples] of cases) {
    const count = Math.ceil(samples.length / tileSamples);
    const [js, simd] = kernels.map((kernel) => {
      const out = new Float32Array(count * 2 * tilePairs);
      kernel.tiles(samples, out);
      return out;
    });
    sameBits(simd, js, label);
    const finest = expected(samples.subarray(0, tileSamples), 16);
    sameBits(simd.subarray(0, finest.length), finest, `${label}, finest level`);
  }
});

test("both kernels refuse lengths they cannot honour before touching memory", () => {
  const samples = new Float32Array(100);
  for (const kernel of kernels) {
    assert.throws(() => kernel.reduce(samples, 0, new Float32Array(200)), RangeError);
    assert.throws(() => kernel.reduce(samples, 1.5, new Float32Array(200)), RangeError);
    assert.throws(() => kernel.reduce(samples, 16, new Float32Array(13)), RangeError);
    assert.throws(() => kernel.fold(new Float32Array(3), 2, new Float32Array(4)), RangeError);
    assert.throws(() => kernel.fold(new Float32Array(8), 2, new Float32Array(3)), RangeError);
    assert.throws(() => kernel.tiles(samples, new Float32Array(2 * tilePairs - 1)), RangeError);
    assert.throws(
      () => kernel.tiles(new Float32Array(maxBatchSamples + 1), new Float32Array(0)),
      RangeError,
    );
    // An empty input writes nothing.
    assert.equal(kernel.tiles(new Float32Array(0), new Float32Array(0)), 0);
  }
});

test("the module grows for a large batch and still answers small ones", () => {
  const big = pcm(16 * tileSamples, 5);
  const out = new Float32Array(16 * 2 * tilePairs);
  const js = new Float32Array(out.length);
  wasm.tiles(big, out);
  jsKernel.tiles(big, js);
  sameBits(out, js, "after growth");
  const small = pcm(33, 6);
  const pairs = new Float32Array(2 * 3);
  wasm.reduce(small, 16, pairs);
  sameBits(pairs, expected(small, 16), "small after large");
});

test("the bundled module is the one its hash names, and one that does not compile is refused", async () => {
  const bytes = peakModuleBytes();
  assert.equal(createHash("sha256").update(bytes).digest("hex"), peaksWasmSha256);
  await assert.rejects(loadWasmKernel(bytes.subarray(0, bytes.length - 9)));
});
