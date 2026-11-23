// Runs in the browser page that experiments/peaks/run.mjs serves. `/current/`
// and `/baseline/` each hold a copy of the media package's dist; the baseline
// differs only in its WebAssembly module.
const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const summary = (times) => ({ p50: quantile(times, 0.5), p95: quantile(times, 0.95) });
const sine = (length) => Float32Array.from({ length }, (_, i) => Math.sin(i / 13));

async function load(dir) {
  const peaks = await import(`/${dir}/peaks.js`);
  return { peaks, wasm: await peaks.loadWasmKernel() };
}

// The JS and WASM tiles of PCM with NaN, infinities, both zeros, denormals and
// extremes at several densities, at lengths that end inside a group, a bucket
// and a tile. With no specials, a lone infinity sits in every third group.
async function parity() {
  const { peaks, wasm } = await load("current");
  const { jsKernel, tilePairs, tileSamples } = peaks;
  let state = 7;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const pool = [NaN, Infinity, -Infinity, 0, -0, 1e-45, -1e-45, 3.4e38, -3.4e38];
  const lengths = [1, 15, 16, 63, 64, 65, 127, 1000, 4097, 65535, 65536, 65600];
  lengths.push(3 * tileSamples + 12345, 16 * tileSamples - 37, 16 * tileSamples);
  let cases = 0;
  let values = 0;
  for (const density of [0, 0.0005, 0.01, 0.11, 0.5, 1])
    for (const n of lengths) {
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++)
        samples[i] = next() < density ? pool[Math.floor(next() * pool.length)] : (next() - 0.5) * 2;
      if (density === 0)
        for (let g = 0; g < Math.floor(n / 64); g += 3)
          samples[64 * g + (g % 64)] = g % 2 ? Infinity : -Infinity;
      const [js, simd] = [jsKernel, wasm].map((kernel) => {
        const out = new Float32Array(Math.ceil(n / tileSamples) * 2 * tilePairs);
        kernel.tiles(samples, out);
        return new Uint32Array(out.buffer);
      });
      for (let i = 0; i < js.length; i++)
        if (js[i] !== simd[i])
          throw new Error(`JS and WASM tiles differ: ${n} samples, density ${density}, value ${i}`);
      cases++;
      values += js.length;
    }
  return { cases, values };
}

// `kernel.tiles` in the page, copies into and out of linear memory included.
// The kernels alternate round by round.
async function kernels(dirs, sizes = [65536, 1048576], rounds = 31) {
  const loaded = await Promise.all(dirs.map(load));
  const runs = [["js", loaded[0].peaks.jsKernel]];
  dirs.forEach((dir, i) => runs.push([dir, loaded[i].wasm]));
  const { tilePairs, tileSamples } = loaded[0].peaks;
  const out = {};
  for (const size of sizes) {
    const samples = sine(size);
    const into = new Float32Array(Math.ceil(size / tileSamples) * 2 * tilePairs);
    const repeats = size <= 65536 ? 32 : 8;
    const times = runs.map(() => []);
    for (let round = 0; round < rounds; round++)
      runs.forEach(([, kernel], k) => {
        const start = performance.now();
        for (let r = 0; r < repeats; r++) kernel.tiles(samples, into);
        if (round >= 3) times[k].push((performance.now() - start) / repeats);
      });
    out[size] = Object.fromEntries(runs.map(([name], k) => [name, summary(times[k])]));
  }
  return out;
}

// The package worker's round trip, samples and tiles transferred, as
// examples/bench measures it. Workers alternate round by round.
async function trips(dirs, sizes = [4096, 65536, 262144, 1048576], rounds = 31) {
  const runs = [["js", dirs[0], false], ...dirs.map((dir) => [dir, dir, true])];
  const workers = runs.map(([, dir, wasm]) => {
    const worker = new Worker(`/${dir}/peak-worker.js`, { type: "module" });
    worker.postMessage({ type: "configure", wasm, wasmFrom: 0 });
    return worker;
  });
  const trip = (worker, samples, size, wasm) =>
    new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        const reply = event.data;
        if (reply.type !== "built" || reply.kernel !== (wasm ? "wasm-simd" : "js"))
          reject(new Error(`Unexpected reply ${reply.type} ${reply.kernel}`));
        else resolve(reply.samples);
      };
      worker.postMessage({ type: "build", id: 1, samples, count: size }, [samples.buffer]);
    });
  const out = {};
  for (const size of sizes) {
    const repeats = size <= 65536 ? 32 : 8;
    const buffers = runs.map(() => sine(size));
    const times = runs.map(() => []);
    for (let round = 0; round < rounds; round++)
      for (let k = 0; k < runs.length; k++) {
        const start = performance.now();
        for (let r = 0; r < repeats; r++)
          buffers[k] = await trip(workers[k], buffers[k], size, runs[k][2]);
        // The first rounds load the module and warm the kernel.
        if (round >= 3) times[k].push((performance.now() - start) / repeats);
      }
    out[size] = Object.fromEntries(runs.map(([name], k) => [name, summary(times[k])]));
  }
  for (const worker of workers) worker.terminate();
  return out;
}

window.peaks = { parity, kernels, trips };
