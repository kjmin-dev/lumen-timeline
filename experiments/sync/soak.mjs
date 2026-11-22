import { TICKS_PER_SECOND as hz, createEditor } from "@lumen-timeline/core";
import { bufferCatalog, bufferTakes, listTakes } from "./buffer-fixture.mjs";
import { VideoTransport } from "./transport.mjs";
import { createTake, frameObserver } from "./browser.mjs";

export async function soak(seconds) {
  const video = document.querySelector("video");
  const ctx = new AudioContext({ latencyHint: "interactive" });
  await ctx.resume();
  await ctx.audioWorklet.addModule("/experiments/sync/probe.js");
  const probe = new AudioWorkletNode(ctx, "sample-probe");
  probe.connect(ctx.destination);
  const pulses = [];
  probe.port.onmessage = ({ data }) => {
    if (data.code < 128) return;
    const stamp = ctx.getOutputTimestamp();
    pulses.push({
      index: data.code - 160,
      time: stamp.performanceTime + (data.audioTime - stamp.contextTime) * 1000,
    });
  };
  video.src = "/fixture/soak.mp4";
  const frames = frameObserver(video, 300);
  const takes = { guide: createTake(ctx, 1, 0) };
  const clips = Array.from({ length: Math.ceil((seconds + 2) / 10) }, (_, i) => ({
    id: String(i),
    start: i * 10 * hz,
    duration: 10 * hz,
    contentIn: 0,
    activeTakeId: "guide",
    trackId: "guide",
    kind: "audio",
  }));
  const editor = createEditor({
    project: {
      schemaVersion: 1,
      tracks: [{ id: "guide" }],
      clips: listTakes(clips),
      takes: bufferTakes(takes),
    },
  });
  const transport = new VideoTransport(video, ctx, probe, {
    editor,
    catalog: bufferCatalog(takes),
    resolveBuffer: (span) => takes[span.assetId].buffer,
  });
  const wallStart = performance.now();
  try {
    await video.play();
    let progress = 0;
    while (video.currentTime < seconds + 0.4) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (video.error || video.ended)
        throw new Error("Video ended before the measurement interval");
      if (Math.floor(video.currentTime / 60) > progress) {
        progress = Math.floor(video.currentTime / 60);
        console.log("Soak " + progress + " min / " + Math.ceil(seconds / 60));
      }
    }
    video.pause();
    const observations = frames.stop();
    const samples = [];
    const missingSeconds = [];
    const used = new Set();
    const firstFrames = new Map();
    for (const f of frames.flashes) if (!firstFrames.has(f.second)) firstFrames.set(f.second, f);
    for (let second = 1; second <= seconds; second++) {
      const f = firstFrames.get(second);
      const matches = f
        ? pulses.filter((p) => p.index === second % 10 && Math.abs(p.time - f.time) < 500)
        : [];
      if (matches.length !== 1) {
        missingSeconds.push(second);
        continue;
      }
      used.add(matches[0]);
      samples.push({ second, offset: matches[0].time - f.time });
    }
    const absolute = samples.map((x) => Math.abs(x.offset)).sort((a, b) => a - b);
    const p95 = absolute[Math.ceil(absolute.length * 0.95) - 1] ?? Infinity;
    const mean = (group) =>
      group.length ? group.reduce((sum, p) => sum + p.offset, 0) / group.length : null;
    const segments = [];
    for (let start = 1; start <= seconds; start += 10) {
      const group = samples.filter((x) => x.second >= start && x.second < start + 10);
      segments.push({
        startSecond: start,
        pairs: group.length,
        meanMs: mean(group),
        maxAbsoluteMs: group.length ? Math.max(...group.map((x) => Math.abs(x.offset))) : null,
      });
    }
    return {
      seconds,
      segments,
      phaseResets: transport.phaseResets,
      elapsedSeconds: (performance.now() - wallStart) / 1000,
      observed: samples.length,
      unpairedPulses: pulses.length - used.size,
      missingSeconds,
      observations,
      sampleRate: ctx.sampleRate,
      firstMinuteMeanMs: mean(samples.filter((x) => x.second <= 60)),
      lastMinuteMeanMs: mean(samples.filter((x) => x.second > seconds - 60)),
      maxAbsoluteMs: absolute.at(-1),
      p95AbsoluteMs: p95,
      withinOneFrame:
        p95 <= 1000 / 30 &&
        missingSeconds.length <= seconds * 0.01 &&
        pulses.length - used.size <= seconds * 0.01 + 1,
    };
  } finally {
    frames.stop();
    transport.dispose();
    editor.dispose();
    probe.disconnect();
    video.pause();
    await ctx.close();
  }
}
