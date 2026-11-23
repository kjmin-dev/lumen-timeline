// Waveform tiles in a real browser: the package's module worker builds the same
// columns with the Rust SIMD kernel, with its JS kernel and on the main thread
// with either, bit for bit; and a worker that cannot start leaves main-thread
// slices on the SIMD kernel. Usage:
// node examples/vanilla/verify-peaks.mjs [chromium|firefox|webkit]   (build first)
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { serve } from "./server.mjs";

const engine = process.argv[2] ?? "chromium";
const server = await serve();
const browser = await { chromium, firefox, webkit }[engine].launch();
const errors = [];

try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url + "/examples/vanilla/lab.html");
  const result = await page.evaluate(async () => {
    const { createWaveformTiles } = await import("@lumen-timeline/media");
    const hz = 282240000;
    const rate = 48000;
    // Seven tiles of seeded PCM, the last partial, with silence, NaN, infinities and -0.
    const samples = new Float32Array(6 * 65536 + 30001);
    let state = 99;
    for (let i = 0; i < samples.length; i++) {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      const run = Math.floor(i / 7000) % 9;
      samples[i] =
        run === 2 ? -0 : run === 5 ? NaN : state % 97 === 0 ? Infinity : state / 2147483648 - 1;
    }
    const source = {
      version: 1,
      sampleRate: rate,
      length: samples.length,
      read: (a, b) => samples.subarray(a, b),
    };
    const at = (sample) => (sample * hz) / rate;
    const requests = [7, 16, 90, 700, 3000, 20000, 70000].map((width) => ({
      assetId: "a",
      streamId: "s",
      start: at(-3 * width),
      end: at(-3 * width + 400 * width),
      buckets: 400,
    }));
    async function columns(options) {
      const tiles = createWaveformTiles({ source: () => source, ...options });
      for (let round = 0; round < 100; round++) {
        for (const request of requests) tiles.peaks(request);
        await tiles.idle();
        if (tiles.diagnostics().pending === 0) break;
      }
      const out = requests.map((request) => tiles.peaks(request));
      const report = tiles.diagnostics();
      tiles.dispose();
      return { out, report };
    }
    const runs = {
      wasm: await columns({}),
      js: await columns({ wasm: false }),
      main: await columns({ worker: null }),
      mainJs: await columns({ worker: null, wasm: false }),
      missing: await columns({
        worker: () => new Worker("/packages/media/dist/missing-worker.js", { type: "module" }),
      }),
    };
    // Compare every value's bits with the main-thread run.
    const bits = (values) => new Uint32Array(values.buffer, values.byteOffset, values.length);
    const differences = {};
    const drawn = runs.main.out.reduce((n, values) => n + values.filter(Number.isFinite).length, 0);
    for (const [name, run] of Object.entries(runs)) {
      let count = 0;
      run.out.forEach((values, i) => {
        const a = bits(values);
        const b = bits(runs.main.out[i]);
        for (let j = 0; j < a.length; j++) if (a[j] !== b[j]) count++;
      });
      differences[name] = count;
    }
    const reports = Object.fromEntries(
      Object.entries(runs).map(([name, run]) => [name, run.report]),
    );
    return { differences, drawn, reports };
  });
  const { differences, drawn, reports } = result;
  assert.ok(drawn > 2000, "only " + drawn + " values were drawn");
  assert.deepEqual(
    differences,
    { wasm: 0, js: 0, main: 0, mainJs: 0, missing: 0 },
    JSON.stringify(differences),
  );
  assert.equal(reports.wasm.compute, "worker");
  assert.equal(reports.wasm.kernel, "wasm-simd");
  assert.equal(reports.wasm.fallback, null);
  assert.ok(
    reports.wasm.batches.wasm >= 1 && reports.wasm.batches.js === 0,
    JSON.stringify(reports.wasm),
  );
  assert.equal(reports.js.compute, "worker");
  assert.equal(reports.js.kernel, "js");
  assert.equal(reports.main.compute, "main-thread");
  assert.equal(reports.main.kernel, "wasm-simd");
  assert.ok(
    reports.main.batches.wasm >= 1 && reports.main.batches.js === 0,
    JSON.stringify(reports.main),
  );
  assert.equal(reports.mainJs.compute, "main-thread");
  assert.equal(reports.mainJs.kernel, "js");
  assert.equal(reports.mainJs.batches.wasm, 0);
  assert.equal(reports.missing.compute, "main-thread");
  assert.equal(reports.missing.kernel, "wasm-simd");
  assert.match(reports.missing.fallback ?? "", /peak worker/);
  console.log(
    engine +
      ": the worker's and the main thread's SIMD and JS tiles drew the same " +
      drawn +
      " values, and a missing worker fell back to SIMD on the main thread",
  );
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
