import { TICKS_PER_SECOND as hz, sourceWindow, ticksToUnits } from "@lumen-timeline/core";
import { splitClip } from "@lumen-timeline/core/internal";
import { bufferCatalog } from "./buffer-fixture.mjs";
import { createEditor, commands } from "@lumen-timeline/core";
import { VideoTransport, scheduleWindow, presentationTime } from "./transport.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sec = (s) => Math.round(s * hz);
const check = (condition, reason) => {
  if (!condition) throw new Error(reason);
};

async function until(predicate, reason, timeout = 7000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(reason);
    await wait(10);
  }
}

async function offlineBoundaries() {
  const errors = [];
  for (const rate of [44100, 48000]) {
    const position = sec(14);
    const clip = { start: sec(12), duration: sec(4), contentIn: sec(1) };
    const take = { availableStart: 0, availableEnd: sec(8), sourceAtContentZero: 0 };
    for (const cut of [position, position + hz / rate]) {
      const ctx = new OfflineAudioContext(1, rate / 2, rate);
      const data = ctx.createBuffer(1, rate * 5, rate);
      const boundary = ticksToUnits(cut - clip.start + clip.contentIn, rate);
      data.getChannelData(0).set([0.25, 0.5, 0.75], boundary - 1);
      const start = position - sec(0.25);
      for (const part of splitClip(clip, cut, "right")) {
        const w = sourceWindow(part, take, start, start + sec(0.5));
        const source = ctx.createBufferSource();
        source.buffer = data;
        source.connect(ctx.destination);
        scheduleWindow(source, w, -start / hz, rate);
      }
      const pcm = (await ctx.startRendering()).getChannelData(0);
      const expected = ticksToUnits(cut - start, rate);
      const index = pcm.indexOf(0.5);
      check(
        index !== -1 &&
          pcm[index - 1] === 0.25 &&
          pcm[index + 1] === 0.75 &&
          pcm.filter((x) => x !== 0).length === 3,
        "Unexpected boundary at " +
          JSON.stringify({
            rate,
            cut,
            expected,
            index,
            samples: Array.from(pcm.slice(expected - 5, expected + 5)),
            count: pcm.filter((x) => x !== 0).length,
          }),
      );
      errors.push(Math.abs(index - expected));
    }
  }
  return errors;
}

export function frameObserver(video, cycleFrames = Infinity, allowNeighbor = false) {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 64;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const flashes = [];
  let mismatches = 0;
  let frames = 0;
  let handle;
  let estimatedFrames = 0;
  const sample = (now, meta) => {
    handle = video.requestVideoFrameCallback(sample);
    ctx.drawImage(video, 0, 0);
    const pixels = ctx.getImageData(0, 0, 160, 64).data;
    let id = 0;
    for (let bit = 0; bit < 10; bit++) {
      if (pixels[4 * (48 * 160 + bit * 16 + 8)] > 128) id += 2 ** bit;
    }
    frames++;
    const time = presentationTime(now, meta.expectedDisplayTime);
    if (time !== meta.expectedDisplayTime) estimatedFrames++;
    const absoluteFrame = Math.round(meta.mediaTime * 30);
    const expectedId = absoluteFrame % cycleFrames;
    const delta = id - expectedId;
    if (delta !== 0) mismatches++;
    // drawImage can expose the neighboring decoded frame during a callback.
    // A pair still identifies one flash if both IDs lie in its white interval.
    const sameFlash =
      Math.abs(delta) <= (allowNeighbor ? 1 : 0) &&
      Math.floor(id / 30) === Math.floor(expectedId / 30) &&
      id % 30 < 3 &&
      expectedId % 30 < 3;
    if (pixels[4 * (8 * 160 + 8)] > 128 && sameFlash) {
      const frameWithinFlash = absoluteFrame % 30;
      flashes.push({
        second: Math.floor(absoluteFrame / 30),
        frameWithinFlash,
        pixelFrameDelta: delta,
        time: time - (frameWithinFlash * 1000) / 30,
      });
    }
  };
  handle = video.requestVideoFrameCallback(sample);
  return {
    flashes,
    stop() {
      video.cancelVideoFrameCallback(handle);
      return { frames, mismatches, estimatedFrames };
    },
  };
}

export function createTake(context, tag, origin) {
  const seconds = 20;
  const rate = context.sampleRate;
  const buffer = context.createBuffer(1, rate * seconds, rate);
  const pcm = buffer.getChannelData(0);
  for (let second = 0; second < seconds; second++) {
    const code = tag * 32 + second;
    pcm.fill((code + 128) / 256, second * rate, second * rate + Math.round(rate * 0.008));
    pcm.fill(code / 256, second * rate + Math.round(rate * 0.008), (second + 1) * rate);
  }
  return { buffer, sourceAtContentZero: Math.round(origin * rate) };
}

async function startMedia(video) {
  const media = new MediaSource();
  const url = URL.createObjectURL(media);
  const open = new Promise((resolve) =>
    media.addEventListener("sourceopen", resolve, { once: true }),
  );
  video.src = url;
  await open;
  const source = media.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');
  async function append(name) {
    const response = await fetch("/fixture/" + name);
    check(response.ok, "Missing media fragment " + name);
    const data = await response.arrayBuffer();
    const done = new Promise((resolve, reject) => {
      source.addEventListener("updateend", resolve, { once: true });
      source.addEventListener("error", reject, { once: true, signal: AbortSignal.timeout(3000) });
    });
    source.appendBuffer(data);
    await done;
  }
  await append("init.mp4");
  for (let i = 1; i <= 4; i++) await append("chunk-" + i + ".m4s");
  media.duration = 20;
  return {
    async rest() {
      for (let i = 5; i <= 20; i++) await append("chunk-" + i + ".m4s");
      media.endOfStream();
    },
    close() {
      URL.revokeObjectURL(url);
    },
  };
}

export async function run(audioDelaySeconds = 0) {
  const video = document.querySelector("video");
  const ctx = new AudioContext({ latencyHint: "interactive" });
  await ctx.resume();
  await ctx.audioWorklet.addModule("/experiments/sync/probe.js");
  const probe = new AudioWorkletNode(ctx, "sample-probe");
  probe.connect(ctx.destination);
  const events = [];
  const stateTrace = [];
  for (const type of ["playing", "waiting", "seeking", "seeked", "pause", "ended"]) {
    video.addEventListener(type, () => stateTrace.push([type, video.currentTime, ctx.currentTime]));
  }
  probe.onprocessorerror = () => stateTrace.push(["processorerror"]);

  probe.port.onmessage = ({ data }) => {
    const stamp = ctx.getOutputTimestamp();
    const time = stamp.performanceTime + (data.audioTime - stamp.contextTime) * 1000;
    events.push({ ...data, time });
  };
  const mse = await startMedia(video);
  const observer = frameObserver(video, Infinity, true);
  const a = { id: "guide", start: 0, duration: sec(10), contentIn: 0, activeTakeId: "guide" };
  const b = {
    id: "line",
    start: sec(12),
    duration: sec(6),
    contentIn: sec(1),
    activeTakeId: "line",
  };
  const takes = {
    guide: createTake(ctx, 1, 0),
    line: createTake(ctx, 2, 0),
    fresh: createTake(ctx, 3, -3),
  };
  // A known delay inserted after scheduling is a negative control for the observer.
  const delay = ctx.createDelay(1);
  delay.delayTime.value = audioDelaySeconds;
  delay.connect(probe);
  const editor = createEditor({
    project: {
      schemaVersion: 1,
      tracks: [{ id: "dialogue" }],
      clips: [a, b].map((clip) => ({ ...clip, kind: "audio", trackId: "dialogue" })),
    },
  });
  const catalog = bufferCatalog(takes);
  const transport = new VideoTransport(video, ctx, delay, {
    editor,
    catalog,
    resolveBuffer: (span) => takes[span.assetId].buffer,
  });
  const points = [];
  const positions = [];
  const missingFrames = [];
  function compare(start, pairs) {
    for (const [second, tag, sourceSecond] of pairs) {
      const flash = observer.flashes.find((x) => x.second === second && x.time >= start);
      const pulses = events.filter(
        (x) => x.code === 128 + 32 * tag + sourceSecond && x.time >= start,
      );
      check(pulses.length === 1, "Missing or duplicate audio onset at " + second + "s");
      if (!flash) {
        missingFrames.push(second);
        continue;
      }
      points.push({
        second,
        frameWithinFlash: flash.frameWithinFlash,
        pixelFrameDelta: flash.pixelFrameDelta,
        offsetMs: pulses[0].time - flash.time,
      });
    }
  }
  function held(start, tag, sourceSecond) {
    const slice = events.filter((x) => x.time >= start);
    check(
      slice.some((x) => (x.code & 127) === tag * 32 + sourceSecond),
      "Missing expected source position",
    );
    for (const e of slice.filter((x) => x.time >= start + 200 && x.code !== 0)) {
      check((e.code & 127) >> 5 === tag, "Old or mixed take detected");
    }
    positions.push({ tag, sourceSecond });
  }
  try {
    const offlineSampleErrors = await offlineBoundaries();
    const start = performance.now();
    let stalled = false;
    video.addEventListener("waiting", () => {
      if (video.currentTime > 3.8) stalled = true;
    });
    await video.play();
    await until(() => stalled, "No native buffering stall");
    await wait(350);
    check(
      events.at(-1)?.code === 0,
      "Expected silence during native stall: " +
        JSON.stringify({
          last: events.slice(-4),
          stamp: ctx.getOutputTimestamp?.(),
          contextState: ctx.state,
          trace: stateTrace,
          running: transport.running,
          nodes: transport.voices.size,
          anchor: transport.anchor,
          frames: observer.flashes.length,
        }),
    );
    compare(start, [
      [1, 1, 1],
      [2, 1, 2],
      [3, 1, 3],
    ]);
    const stalledAt = video.currentTime;
    await mse.rest();
    await until(() => video.currentTime > 6.4, "Playback did not resume");
    compare(start, [
      [5, 1, 5],
      [6, 1, 6],
    ]);

    const seekStart = performance.now();
    const requests = Array.from({ length: 100 }, (_, i) =>
      transport.seek(i === 99 ? 14.2 : 1 + ((i * 7) % 16)),
    );
    const outcomes = await Promise.all(requests);
    check(
      outcomes.at(-1) === "arrived" && outcomes.filter((x) => x === "arrived").length === 1,
      "Seek race",
    );
    await until(() => video.currentTime > 15.35, "Mid-clip seek did not resume");
    held(seekStart, 2, 3);
    compare(seekStart, [[15, 2, 4]]);

    const editStart = performance.now();
    const cut = editor.dispatch(
      commands.splitClip({ clipId: b.id, at: sec(14), rightId: "right" }),
    );
    check(cut.ok, "Split dispatch failed");
    // Audition an updated recording bound to the selected take.
    transport.setCatalog({ version: 2, takes: { ...catalog.takes, line: catalog.takes.fresh } });
    await until(() => video.currentTime > 16.35, "Take edit failed to play");
    held(editStart, 3, 1);
    compare(editStart, [[16, 3, 2]]);

    const undoStart = performance.now();
    check(editor.history.undo().ok, "Undo dispatch failed");
    transport.setCatalog(catalog);
    await until(() => video.currentTime > 17.35, "Undo failed to play");
    held(undoStart, 2, 5);
    compare(undoStart, [[17, 2, 6]]);

    const loopStart = performance.now();
    await transport.seek(13.25);
    await until(() => video.currentTime > 14.35, "Backward seek failed");
    held(loopStart, 2, 2);
    compare(loopStart, [[14, 2, 3]]);
    video.pause(); // Check individual arrivals at fixed positions after the playing seek burst.
    let acknowledgedSeeks = 0;
    for (let i = 0; i < 100; i++) {
      const target = i % 2 === 0 ? 1.25 + (i % 3) : 12.25 + (i % 4);
      check((await transport.seek(target)) === "arrived", "Native seek superseded unexpectedly");
      check(
        Math.abs(video.currentTime - target) < 0.05,
        "Native seek acknowledged the wrong position",
      );
      acknowledgedSeeks++;
    }
    const observations = observer.stop();
    const offsets = points.map((x) => Math.abs(x.offsetMs)).sort((x, y) => x - y);
    const p95 = offsets[Math.ceil(offsets.length * 0.95) - 1] ?? null;
    return {
      offlineSampleErrors,
      stalledAt,
      supersededSeeks: outcomes.length - 1,
      acknowledgedSeeks,
      positions,
      observations,
      sampleRate: ctx.sampleRate,
      points,
      missingFrames,
      p95AbsoluteMs: p95,
      withinOneFrame: missingFrames.length === 0 && p95 !== null && p95 <= 1000 / 30,
    };
  } finally {
    observer.stop();
    transport.dispose();
    editor.dispose();
    video.pause();
    delay.disconnect();
    probe.disconnect();
    await ctx.close();
    mse.close();
  }
}
