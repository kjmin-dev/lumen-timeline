// The roadmap's rendering benchmark project: two hours, 40 tracks and 20,000
// clips, 12 rows visible at 1440 × 900 CSS pixels, a playing 1080p video and
// eight audible tracks, with waveforms from the media package's tiles. The page
// exposes the measurements that examples/bench/run.mjs drives; `?renderer=`
// picks the drawing backend.
import { createEditor, TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import { bufferPeakSource, createAudioTransport, createWaveformTiles } from "@lumen-timeline/media";
import { mountTimeline } from "@lumen-timeline/timeline";

const renderer = new URLSearchParams(location.search).get("renderer") ?? "auto";
const rate = 48000;
const trackCount = 40;
const perTrack = 500;
const slot = 14.4;
const audible = 8;
const waveAssets = 400;
const waveSeconds = 60;
const status = document.querySelector("#status");

// --- Audio: eight voices, one per audible track --------------------------
const context = new AudioContext({ sampleRate: rate, latencyHint: "playback" });
const voices = {};
for (let v = 0; v < audible; v++) {
  const buffer = context.createBuffer(1, 15 * rate, rate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const t = i / rate;
    const phrase = Math.max(0, Math.sin(Math.PI * ((t * (0.6 + v * 0.07)) % 1)));
    data[i] = 0.05 * phrase * Math.sin(2 * Math.PI * (150 + 40 * v) * t);
  }
  voices["voice" + v] = buffer;
}

// --- Peaks for the muted tracks: 400 sources of 60 s, read from a table ---
// A read copies from one second of noise and scales each 4,096 samples, so a
// cold region costs reading and reducing, as a decoded buffer would.
const table = new Float32Array(rate);
for (let i = 0, state = 7; i < table.length; i++) {
  state = (Math.imul(state, 1103515245) + 12345) >>> 0;
  table[i] = state / 2147483648 - 1;
}
function waveSource(n) {
  return {
    version: 1,
    sampleRate: rate,
    length: waveSeconds * rate,
    read(start, end) {
      const out = new Float32Array(end - start);
      for (let at = 0; at < out.length; at += 4096) {
        const from = (start + at + n * 977) % rate;
        const count = Math.min(4096, out.length - at, rate - from);
        out.set(table.subarray(from, from + count), at);
        const level = 0.2 + 0.7 * Math.abs(Math.sin((start + at) / (rate * (1.3 + (n % 7) / 5))));
        for (let i = at; i < at + count; i++) out[i] *= level;
      }
      return out;
    },
  };
}
const sources = new Map();
for (const [id, buffer] of Object.entries(voices)) sources.set(id, bufferPeakSource(buffer));
for (let n = 0; n < waveAssets; n++) sources.set("wave" + n, waveSource(n));

// --- The project -----------------------------------------------------------
const tracks = [];
const clips = [];
const takes = [];
for (let t = 0; t < trackCount; t++) {
  tracks.push({ id: "t" + t, name: "Track " + (t + 1), overlap: "exclusive", mute: t >= audible });
  for (let k = 0; k < perTrack; k++) {
    const id = `c${t}-${k}`;
    const voice = t < audible;
    clips.push({
      id,
      name: `Scene ${t + 1}.${k + 1}`,
      trackId: "t" + t,
      kind: "audio",
      start: Math.round(k * slot * hz),
      duration: (10 + (k % 4)) * hz,
      contentIn: 0,
      takeIds: ["k" + id],
      activeTakeId: "k" + id,
    });
    takes.push({
      id: "k" + id,
      assetId: voice ? "voice" + t : "wave" + ((t * perTrack + k) % waveAssets),
      streamId: "mono",
      sourceAtContentZero: voice ? (k % 3) * hz : (k % 5) * 5 * hz,
    });
  }
}
const editor = createEditor({
  project: { schemaVersion: 1, duration: 7200 * hz, tracks, clips, takes },
});
const binding = (length) => ({
  mono: { assetVersion: 1, sampleRate: rate, availableStart: 0, availableEnd: length },
});
const catalog = {
  version: 1,
  streams: Object.fromEntries([...sources].map(([id, source]) => [id, binding(source.length)])),
};
const transport = createAudioTransport({
  editor,
  context,
  catalog,
  resolveBuffer: (span) => voices[span.assetId],
});
const tiles = createWaveformTiles({ source: (assetId) => sources.get(assetId) ?? null });
const view = mountTimeline(document.querySelector("#timeline"), {
  editor,
  transport,
  waveforms: tiles,
  renderer,
  pixelsPerSecond: 20,
  // Compact rows, 46 px each, as the measurements were taken with.
  layout: { laneHeight: 34, rowInset: 6 },
  snap: { gridTicks: hz / 10 },
});

// --- A 1080p reference video, recorded here so the page needs no media file --
const video = document.querySelector("video");
async function recordVideo() {
  const canvas = document.createElement("canvas");
  canvas.width = 1920;
  canvas.height = 1080;
  const ctx = canvas.getContext("2d");
  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType: "video/webm", videoBitsPerSecond: 8e6 });
  const chunks = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const done = new Promise((resolve) => (recorder.onstop = resolve));
  recorder.start();
  const start = performance.now();
  await new Promise((resolve) => {
    const draw = () => {
      const t = (performance.now() - start) / 1000;
      const gradient = ctx.createLinearGradient(0, 0, 1920, 1080);
      gradient.addColorStop(0, `hsl(${(t * 60) % 360} 60% 30%)`);
      gradient.addColorStop(1, `hsl(${(t * 60 + 120) % 360} 60% 20%)`);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 1920, 1080);
      ctx.fillStyle = "#fff";
      ctx.font = "200px system-ui";
      ctx.fillText(t.toFixed(2), 200 + 600 * Math.sin(t), 600);
      if (t < 3) requestAnimationFrame(draw);
      else resolve();
    };
    draw();
  });
  recorder.stop();
  await done;
  video.src = URL.createObjectURL(new Blob(chunks, { type: "video/webm" }));
  await new Promise((resolve) => (video.onloadeddata = resolve));
  return { width: video.videoWidth, height: video.videoHeight };
}

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;
};

// --- The 60-second trace ---------------------------------------------------
// 0–20 s pans across the project, 20–40 s zooms in and out around the middle,
// 40–60 s leaves the viewport to the runner's pointer drags. Each frame records
// its main-thread work until a message posted in its first animation frame
// callback runs, once the frame's script, style, layout and paint end: `frame`
// from the frame's start, input handling included, and `work` from that
// callback.
let traceStart = 0;
function runTrace(total = 60000) {
  const records = [];
  const channel = new MessageChannel();
  let open = null;
  channel.port1.onmessage = () => {
    if (open) {
      open.work = performance.now() - open.start;
      open.frame = performance.now() - open.timestamp;
    }
    open = null;
  };
  const width = document.querySelector(".lt-surface").clientWidth;
  let pan = 0;
  traceStart = performance.now();
  void context.resume();
  void video.play();
  void transport.play();
  return new Promise((resolve) => {
    function tick(timestamp) {
      const start = performance.now();
      const elapsed = start - traceStart;
      const phase = elapsed < 20000 ? "pan" : elapsed < 40000 ? "zoom" : "drag";
      if (phase === "pan") {
        // 20 s of timeline per second, back and forth.
        pan = (elapsed / 1000) * 20;
        const span = 7200 - width / 20;
        const at = pan % (2 * span);
        view.setViewport({
          startTick: Math.round((at < span ? at : 2 * span - at) * hz),
          pixelsPerSecond: 20,
        });
      } else if (phase === "zoom") {
        // From 0.6 to 630 px/s and back every 5 s, around 3,600 s.
        const pps = 20 * 10 ** (1.5 * Math.sin((2 * Math.PI * (elapsed - 20000)) / 5000));
        const center = 3600 * hz;
        view.setViewport({
          pixelsPerSecond: pps,
          startTick: Math.max(0, Math.round(center - ((width / 2) * hz) / pps)),
        });
      } else if (!records.some((r) => r.phase === "drag"))
        view.setViewport({ startTick: 1000 * hz, pixelsPerSecond: 40 });
      open = { start, work: NaN, frame: NaN, timestamp, phase };
      records.push(open);
      channel.port2.postMessage(0);
      if (elapsed < total) requestAnimationFrame(tick);
      else setTimeout(() => resolve(summarize(records)), 50);
    }
    requestAnimationFrame(tick);
  });
}
function summarize(records) {
  const deltas = records.slice(1).map((r, i) => r.timestamp - records[i].timestamp);
  const interval = quantile(deltas, 0.5);
  let missed = 0;
  const missedIn = { pan: 0, zoom: 0, drag: 0, idle: 0 };
  deltas.forEach((delta, i) => {
    const skipped = Math.max(0, Math.round(delta / interval) - 1);
    missed += skipped;
    missedIn[records[i + 1].phase] += skipped;
  });
  const work = (phase, key = "frame") =>
    records
      .filter((r) => (!phase || r.phase === phase) && Number.isFinite(r[key]))
      .map((r) => r[key]);
  const stats = (values) => ({
    frames: values.length,
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99),
    max: Math.max(...values),
  });
  return {
    interval,
    frames: records.length,
    missed,
    missedShare: missed / (records.length - 1 + missed),
    missedIn,
    work: stats(work()),
    callbackWork: stats(work(null, "work")),
    phases: { pan: stats(work("pan")), zoom: stats(work("zoom")), drag: stats(work("drag")) },
    diagnostics: view.getDiagnostics(),
  };
}

// The same measurement with playback running and the view left alone: the
// machine's own rate of missed refreshes, against which the trace's compares.
function baseline(total = 10000) {
  const records = [];
  const start = performance.now();
  void context.resume();
  void video.play();
  void transport.play();
  return new Promise((resolve) => {
    function tick(timestamp) {
      records.push({ timestamp, phase: "idle", work: NaN });
      if (performance.now() - start < total) requestAnimationFrame(tick);
      else {
        transport.pause();
        const deltas = records.slice(1).map((r, i) => r.timestamp - records[i].timestamp);
        const interval = quantile(deltas, 0.5);
        let missed = 0;
        for (const delta of deltas) missed += Math.max(0, Math.round(delta / interval) - 1);
        resolve({
          frames: records.length,
          missed,
          missedShare: missed / (records.length - 1 + missed),
        });
      }
    }
    requestAnimationFrame(tick);
  });
}

// --- Seeks: cold, to regions never drawn, then warm, back to the same ------
// A seek moves the playhead and the viewport far away. It is ready when every
// tile the view asked for is built and drawn. Run it on a fresh page, before
// the trace has drawn the project.
async function seeks(regions = 10) {
  transport.pause();
  document.querySelector(".lt-scroll").scrollTop = 20 * 46;
  await frame();
  const ticks = Array.from({ length: regions }, (_, i) => (1800 + i * 450) * hz);
  async function visit(tick) {
    const start = performance.now();
    const seek = Promise.resolve(transport.seek(tick));
    view.setViewport({ startTick: tick, pixelsPerSecond: 40 });
    const asked = tiles.diagnostics().pending;
    let built = 0;
    for (;;) {
      await tiles.idle();
      built ||= performance.now() - start;
      await frame();
      if (tiles.diagnostics().pending === 0) break;
    }
    const drawn = performance.now() - start;
    await seek;
    return { asked, built, drawn, seek: performance.now() - start };
  }
  const cold = [];
  for (const tick of ticks) cold.push(await visit(tick));
  // Somewhere else in between, so a revisit is a seek and not a no-op.
  await visit(600 * hz);
  const warm = [];
  for (const tick of ticks) warm.push(await visit(tick));
  const stats = (list, key) => ({
    p50: quantile(
      list.map((v) => v[key]),
      0.5,
    ),
    max: Math.max(...list.map((v) => v[key])),
  });
  document.querySelector(".lt-scroll").scrollTop = 0;
  view.setViewport({ startTick: 0, pixelsPerSecond: 20 });
  const summary = (list) => ({
    tilesAsked: stats(list, "asked"),
    built: stats(list, "built"),
    drawn: stats(list, "drawn"),
    seek: stats(list, "seek"),
  });
  return {
    regions,
    cold: summary(cold),
    warm: summary(warm),
    tiles: tiles.diagnostics(),
  };
}

// --- Worker round trips: the package worker, JS and WASM kernels ----------
// Browser timers are coarse, so each measurement times a run of round trips:
// 32 for small batches and 8 for large ones, as the earlier experiment did.
async function workerTrips(sizes = [4096, 65536, 262144, 1048576], rounds = 31) {
  const out = {};
  for (const kernel of ["js", "wasm"]) {
    const worker = new Worker("/packages/media/dist/peak-worker.js", { type: "module" });
    worker.postMessage({ type: "configure", wasm: kernel === "wasm", wasmFrom: 0 });
    out[kernel] = {};
    for (const size of sizes) {
      let samples = Float32Array.from({ length: size }, (_, i) => Math.sin(i / 13));
      const times = [];
      const repeats = size <= 65536 ? 32 : 8;
      for (let round = 0; round < rounds; round++) {
        const start = performance.now();
        for (let repeat = 0; repeat < repeats; repeat++) {
          const reply = await new Promise((resolve) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.postMessage({ type: "build", id: round, samples, count: size }, [
              samples.buffer,
            ]);
          });
          if (reply.type !== "built" || reply.kernel !== (kernel === "wasm" ? "wasm-simd" : "js"))
            throw new Error("Unexpected reply " + reply.type + " " + reply.kernel);
          samples = reply.samples;
        }
        // The first rounds load the module and warm the kernel.
        if (round >= 3) times.push((performance.now() - start) / repeats);
      }
      out[kernel][size] = { p50: quantile(times, 0.5), p95: quantile(times, 0.95) };
    }
    worker.terminate();
  }
  const crossover = sizes.find((size) => out.wasm[size].p50 < out.js[size].p50) ?? null;
  return { ...out, crossover };
}

function memory() {
  const heap = performance.memory;
  return {
    jsHeap: heap ? heap.usedJSHeapSize : null,
    tiles: tiles.diagnostics().bytes,
    gpu: view.getDiagnostics().gpuBytes,
  };
}

function environment() {
  const gl = document.createElement("canvas").getContext("webgl2");
  const info = gl?.getExtension("WEBGL_debug_renderer_info");
  return {
    webgl: gl ? gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : null,
    dpr: devicePixelRatio,
    viewport: [innerWidth, innerHeight],
    surface: document.querySelector(".lt-surface").clientWidth,
    rows: Math.round(document.querySelector(".lt-scroll").clientHeight / 46),
  };
}

const videoSize = await recordVideo();
status.textContent = `${clips.length} clips · ${renderer}`;
window.bench = {
  editor,
  view,
  transport,
  tiles,
  videoSize,
  runTrace,
  baseline,
  seeks,
  workerTrips,
  memory,
  environment,
  elapsed: () => performance.now() - traceStart,
};
