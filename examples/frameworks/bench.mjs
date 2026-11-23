// Compares the framework consumers with vanilla on production builds in Google
// Chrome, on the same viewport and backend. Each run opens every consumer once,
// in an order that rotates from run to run, and drives the same trace with
// playback: a pan and zoom of the view, then pointer drags of clips, each of
// which selects a clip, previews the move and commits it. Per frame it records
// main-thread work until the frame's tasks end, and missed refreshes; per
// pointer move, the time from the event to the end of the frame that shows it.
// Prints medians over the runs with vanilla's run-to-run spread, and --write
// records them in docs/measurements/wrappers.json. Usage:
//   node examples/frameworks/bench.mjs [--runs 5] [--seconds 20] [--renderer webgl2]
//     [--channel chrome] [--no-build] [--write]
import { readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import { extname } from "node:path";
import { chromium } from "playwright";
import { buildConsumers, consumers } from "./build.mjs";

const argument = (name, fallback) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const names = Object.keys(consumers);
const runs = Number(argument("runs", "5"));
const seconds = Number(argument("seconds", "20"));
const renderer = argument("renderer", "webgl2");
const channel = argument("channel", "chrome");
if (!process.argv.includes("--no-build")) await buildConsumers(names);

const dist = new URL("./dist/", import.meta.url);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (!/^\/[\w-]+\/[\w./-]+$/.test(path) || path.includes("..") || !types[extname(path)]) {
    res.writeHead(404).end();
    return;
  }
  try {
    res.writeHead(200, { "Content-Type": types[extname(path)] });
    res.end(await readFile(new URL("." + path, dist)));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({
  channel,
  args: ["--autoplay-policy=no-user-gesture-required"],
});

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;
};
const median = (values) => quantile(values, 0.5);

// Installed before the page's scripts: frame and input recorders the trace reads.
function recorders() {
  const frames = [];
  const inputs = [];
  let recording = false;
  let open = null;
  const channel = new MessageChannel();
  // Runs once the frame's script, style, layout and paint have ended.
  channel.port1.onmessage = () => {
    const end = performance.now();
    if (open) {
      open.work = end - open.start;
      for (const input of open.inputs) inputs.push(end - input);
    }
    open = null;
  };
  let pending = [];
  addEventListener(
    "pointermove",
    (event) => {
      if (recording) pending.push(event.timeStamp);
    },
    { capture: true },
  );
  function tick(timestamp) {
    if (recording) {
      open = { timestamp, start: performance.now(), work: NaN, inputs: pending };
      pending = [];
      frames.push(open);
      channel.port2.postMessage(0);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  window.bench = {
    start() {
      frames.length = inputs.length = 0;
      recording = true;
    },
    stop() {
      recording = false;
      return { frames: frames.map(({ timestamp, work }) => ({ timestamp, work })), inputs };
    },
  };
}

async function trace(name) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(recorders);
  await page.goto(`${origin}/${name}/index.html?renderer=${renderer}`);
  await page.waitForFunction(() => window.consumer?.view);
  const surface = await page.evaluate(() => {
    const r = document.querySelector(".lt-surface").getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width };
  });
  const total = seconds * 1000;
  await page.evaluate(async (total) => {
    const { consumer } = window;
    await consumer.context.resume();
    await consumer.pairs.a.transport.play();
    window.bench.start();
    // The first two fifths pan and zoom the view, once a frame.
    const start = performance.now();
    const hz = consumer.hz;
    await new Promise((resolve) => {
      function step() {
        const elapsed = performance.now() - start;
        if (elapsed > (total * 2) / 5) return resolve();
        const phase = elapsed / 2000;
        consumer.view.setViewport({
          pixelsPerSecond: 40 * 2 ** Math.sin(phase * Math.PI),
          startTick: Math.round(Math.abs(Math.sin(phase)) * 12 * hz),
        });
        requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
    consumer.view.setViewport({ pixelsPerSecond: 40, startTick: 0 });
  }, total);
  // The rest drags clips: one pointer move a frame, as a 60 Hz pointer reports.
  const until = Date.now() + (total * 3) / 5;
  let drags = 0;
  for (let n = 0; Date.now() < until; n++) {
    const row = n % 2;
    const target = await page.evaluate(
      ({ row, k }) => {
        const y = row * 46 + 23;
        for (let x = 40 + ((k * 97) % 600); x < 920; x += 10) {
          const hit = window.consumer.view.hitTest({ x, y });
          if (hit?.clipId && hit.edge === "move") return { x, y };
        }
        return null;
      },
      { row, k: n },
    );
    if (!target) continue;
    const dx = n % 4 < 2 ? 12 : -12;
    await page.mouse.move(surface.x + target.x, surface.y + target.y);
    await page.mouse.down();
    for (let step = 1; step <= 20; step++) {
      await page.mouse.move(surface.x + target.x + (dx * step) / 20, surface.y + target.y);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    }
    await page.mouse.up();
    drags++;
  }
  const recorded = await page.evaluate(() => {
    window.consumer.pairs.a.transport.pause();
    return window.bench.stop();
  });
  const counts = await page.evaluate(() => ({ ...window.consumer.counts }));
  await page.close();
  if (errors.length) throw new Error(name + ": " + errors.join("; "));
  const { frames, inputs } = recorded;
  const deltas = frames.slice(1).map((f, i) => f.timestamp - frames[i].timestamp);
  const interval = median(deltas);
  const missed = deltas.reduce((sum, d) => sum + Math.max(0, Math.round(d / interval) - 1), 0);
  const work = frames.map((f) => f.work).filter(Number.isFinite);
  return {
    frames: frames.length,
    interval,
    work: { p50: quantile(work, 0.5), p95: quantile(work, 0.95), p99: quantile(work, 0.99) },
    missedShare: missed / (frames.length - 1 + missed),
    input: { moves: inputs.length, p50: quantile(inputs, 0.5), p95: quantile(inputs, 0.95) },
    drags,
    inspectorUpdates: counts.inspector,
  };
}

const version = (name) =>
  JSON.parse(
    readFileSync(new URL(`../../node_modules/${name}/package.json`, import.meta.url), "utf8"),
  ).version;

try {
  const results = Object.fromEntries(names.map((name) => [name, []]));
  for (let run = 0; run < runs; run++) {
    const order = names.map((_, i) => names[(i + run) % names.length]);
    for (const name of order) results[name].push(await trace(name));
  }
  const summary = {};
  const spread = (values) => Math.max(...values) - Math.min(...values);
  for (const name of names) {
    const list = results[name];
    summary[name] = {
      workP50: median(list.map((r) => r.work.p50)),
      workP95: median(list.map((r) => r.work.p95)),
      workP95Spread: spread(list.map((r) => r.work.p95)),
      inputP50: median(list.map((r) => r.input.p50)),
      inputP95: median(list.map((r) => r.input.p95)),
      inputP95Spread: spread(list.map((r) => r.input.p95)),
      missedShare: median(list.map((r) => r.missedShare)),
      missedShareSpread: spread(list.map((r) => r.missedShare)),
    };
  }
  const base = summary.vanilla;
  // A wrapper is within variation when its median is no further above
  // vanilla's than vanilla's own runs spread, or than the page's clock can
  // tell apart: without cross-origin isolation Chrome coarsens it to 0.1 ms.
  const resolution = 0.1;
  for (const name of names) {
    const s = summary[name];
    s.withinVariation = {
      workP95: s.workP95 - base.workP95 <= Math.max(base.workP95Spread, resolution),
      inputP95: s.inputP95 - base.inputP95 <= Math.max(base.inputP95Spread, resolution),
      missedShare: s.missedShare - base.missedShare <= base.missedShareSpread,
    };
    const flag = Object.values(s.withinVariation).every(Boolean)
      ? ""
      : "  outside vanilla's spread";
    console.log(
      `${name.padEnd(8)} frame work p50 ${s.workP50.toFixed(2)} ms, p95 ${s.workP95.toFixed(2)} ms ` +
        `(±${s.workP95Spread.toFixed(2)}); pointer move to frame end p50 ${s.inputP50.toFixed(2)} ms, ` +
        `p95 ${s.inputP95.toFixed(2)} ms (±${s.inputP95Spread.toFixed(2)}); ` +
        `missed ${(s.missedShare * 100).toFixed(2)}% (±${(s.missedShareSpread * 100).toFixed(2)})${flag}`,
    );
  }
  const record = {
    recorded: new Date().toISOString(),
    machine: {
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model ?? null,
      cores: os.cpus().length,
      memory: os.totalmem(),
      load: os.loadavg(),
    },
    browser: {
      name: channel === "chrome" ? "Google Chrome" : channel,
      version: browser.version(),
      headless: true,
    },
    frameworks: {
      react: version("react"),
      svelte: version("svelte"),
      "solid-js": version("solid-js"),
      vue: version("vue"),
      vite: version("vite"),
    },
    fixture: { viewport: "1280x800", dpr: 2, renderer, seconds, runs, build: "production" },
    summary,
    runs: results,
  };
  if (process.argv.includes("--write")) {
    writeFileSync(
      new URL("../../docs/measurements/wrappers.json", import.meta.url),
      JSON.stringify(record, null, 2) + "\n",
    );
    console.log("Wrote docs/measurements/wrappers.json");
  }
} finally {
  await browser.close();
  server.close();
  server.closeAllConnections();
}
