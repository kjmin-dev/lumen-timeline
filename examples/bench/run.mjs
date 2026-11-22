// Runs the rendering benchmark in Google Chrome on each backend: the 60-second
// pan, zoom and drag trace with playback, cold and warm seeks, memory, and the
// peak worker's round trips. Prints a summary; --write records it in
// docs/measurements/render.json. Usage (build first):
//   node examples/bench/run.mjs [--backends webgl2,webgpu,canvas2d] [--seconds 60] [--write]
import { writeFileSync } from "node:fs";
import os from "node:os";
import { chromium } from "playwright";
import { serve } from "../vanilla/server.mjs";

const argument = (name, fallback) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const backends = argument("backends", "webgl2,webgpu,canvas2d").split(",");
const seconds = Number(argument("seconds", "60"));
const write = process.argv.includes("--write");

const server = await serve();
const browser = await chromium.launch({
  channel: argument("channel", "chrome"),
  args: ["--enable-unsafe-webgpu", "--autoplay-policy=no-user-gesture-required"],
});
const results = {};
let environment = null;
let worker = null;

async function drags(page, until) {
  let count = 0;
  for (let n = 0; ; n++) {
    const elapsed = await page.evaluate(() => window.bench.elapsed());
    if (elapsed > until) return count;
    // A clip body in the nth visible row, in page coordinates.
    const target = await page.evaluate((row) => {
      const surface = document.querySelector(".lt-surface").getBoundingClientRect();
      const y = row * 46 + 6 + 15;
      for (let x = 120; x < surface.width - 80; x += 10) {
        const hit = window.bench.view.hitTest({ x, y });
        if (hit?.clipId && hit.edge === "move") return { x: surface.left + x, y: surface.top + y };
      }
      return null;
    }, n % 12);
    if (!target) continue;
    const dx = n % 2 ? -40 : 40;
    await page.mouse.move(target.x, target.y);
    await page.mouse.down();
    // One pointer move a frame, as a pointer device reports at 60 Hz.
    for (let step = 1; step <= 30; step++) {
      await page.mouse.move(target.x + (dx * step) / 30, target.y);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    }
    await page.mouse.up();
    count++;
  }
}

try {
  for (const backend of backends) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url + "/examples/bench/index.html?renderer=" + backend);
    await page.waitForFunction(() => window.bench, null, { timeout: 60000 });
    await page.waitForFunction((b) => window.bench.view.getDiagnostics().backend === b, backend, {
      timeout: 15000,
    });
    environment ??= await page.evaluate(() => window.bench.environment());
    worker ??= await page.evaluate(() => window.bench.workerTrips());
    // Seeks first, while no tile is built yet.
    const seeks = await page.evaluate(() => window.bench.seeks());
    const baseline = await page.evaluate(() => window.bench.baseline(10000));
    await page.evaluate((ms) => {
      window.trace = window.bench.runTrace(ms);
    }, seconds * 1000);
    // The last third of the trace is pointer drags of visible clips.
    await page.waitForFunction((ms) => window.bench.elapsed() > ms, (seconds * 2000) / 3, {
      timeout: seconds * 2000,
      polling: 100,
    });
    const dragged = await drags(page, seconds * 1000 - 500);
    const trace = await page.evaluate(() => window.trace);
    const memory = await page.evaluate(() => window.bench.memory());
    const videoSize = await page.evaluate(() => window.bench.videoSize);
    results[backend] = { trace, baseline, dragged, seeks, memory, videoSize, errors };
    const { work, missedShare } = trace;
    console.log(
      `${backend}: frame work p50 ${work.p50.toFixed(2)} ms, p95 ${work.p95.toFixed(2)} ms, p99 ${work.p99.toFixed(2)} ms; ` +
        `missed ${(missedShare * 100).toFixed(2)}% (idle ${(baseline.missedShare * 100).toFixed(2)}%); seek cold ${seeks.cold.built.p50.toFixed(0)}/${seeks.cold.drawn.p50.toFixed(0)} ms, ` +
        `warm ${seeks.warm.built.p50.toFixed(0)}/${seeks.warm.drawn.p50.toFixed(0)} ms (built/drawn); ` +
        `heap ${((memory.jsHeap ?? 0) / 2 ** 20).toFixed(0)} MiB, tiles ${(memory.tiles / 2 ** 20).toFixed(1)} MiB, GPU ${(memory.gpu / 2 ** 20).toFixed(1)} MiB; ${dragged} drags`,
    );
    if (errors.length) console.log(backend + " page errors: " + errors.join("; "));
    await page.close();
  }
  console.log(
    "worker round trips (p50 ms, JS / WASM): " +
      Object.keys(worker.js)
        .map(
          (size) =>
            `${size}: ${worker.js[size].p50.toFixed(3)} / ${worker.wasm[size].p50.toFixed(3)}`,
        )
        .join(", ") +
      "; WASM is faster from " +
      worker.crossover,
  );
  const record = {
    recorded: new Date().toISOString(),
    machine: {
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model ?? null,
      cores: os.cpus().length,
      memory: os.totalmem(),
      load: os.loadavg(),
    },
    browser: { name: "Google Chrome", version: browser.version(), headless: true },
    environment,
    fixture: {
      viewport: "1440x900",
      dpr: 2,
      hours: 2,
      tracks: 40,
      clips: 20000,
      visibleRows: environment?.rows,
      video: results[backends[0]]?.videoSize,
      audibleTracks: 8,
      seconds,
    },
    worker,
    backends: results,
  };
  if (write) {
    writeFileSync(
      new URL("../../docs/measurements/render.json", import.meta.url),
      JSON.stringify(record, null, 2) + "\n",
    );
    console.log("Wrote docs/measurements/render.json");
  }
} finally {
  await browser.close();
  await server.close();
}
