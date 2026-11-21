import { reducePeaks } from "./peaks.mjs";

export async function measureWorker(moduleBytes) {
  const started = performance.now();
  const worker = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
  function request(payload, transfer = []) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const options = { once: true, signal: controller.signal };
      worker.addEventListener(
        "message",
        (e) => {
          controller.abort();
          resolve(e.data);
        },
        options,
      );
      worker.addEventListener(
        "error",
        (e) => {
          controller.abort();
          reject(new Error(e.message));
        },
        options,
      );
      worker.postMessage(payload, transfer);
    });
  }
  try {
    const largest = 1048576;
    await request({ moduleBytes: Uint8Array.from(moduleBytes), samples: largest });
    const readyMs = performance.now() - started;
    const sizes = {};
    for (const size of [4096, largest]) {
      let pcm = Float32Array.from({ length: size }, (_, i) => Math.sin(i / 13));
      let pairs = new Float32Array((size / 256) * 2);
      const expected = new Float32Array(pairs.length);
      reducePeaks(pcm, expected);
      const times = { js: [], simd: [] };
      const repeats = size === largest ? 8 : 32;
      for (let i = 0; i < 39; i++) {
        for (const backend of i % 2 ? ["js", "simd"] : ["simd", "js"]) {
          const start = performance.now();
          for (let repeat = 0; repeat < repeats; repeat++) {
            const result = await request({ backend, pcm, pairs }, [pcm.buffer, pairs.buffer]);
            pcm = result.pcm;
            pairs = result.pairs;
          }
          const elapsed = (performance.now() - start) / repeats;
          if (!pairs.every((value, index) => value === expected[index]))
            throw new Error("Different worker output");
          if (i >= 8) times[backend].push(elapsed);
        }
      }
      sizes[size] = {};
      for (const [backend, samples] of Object.entries(times)) {
        samples.sort((a, b) => a - b);
        sizes[size][backend] = { median: samples[15], p95: samples[29] };
      }
    }
    return { readyMs, sizes };
  } finally {
    worker.terminate();
  }
}
