import assert from "node:assert/strict";
import test from "node:test";
import { commands, createEditor, TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import type { Project, StreamCatalog } from "@lumen-timeline/core";
import { createAudioTransport, createVideoTransport } from "@lumen-timeline/media";
import type { AudioNodeLike, GainNodeLike, VideoElementLike } from "@lumen-timeline/media";
import type { TestContext } from "node:test";
import { FakeContext, FakeVideo, sink } from "./fakes.ts";

const sec = (n: number): number => Math.round(n * hz);
const rate = 48000;

const baseProject = (): Project => ({
  schemaVersion: 1,
  duration: sec(10),
  tracks: [
    { id: "voice", gain: 1 },
    { id: "music", gain: 0.5 },
  ],
  clips: [
    {
      id: "line",
      trackId: "voice",
      kind: "audio",
      start: 0,
      duration: sec(6),
      contentIn: 0,
      source: { assetId: "voice-asset", streamId: "mono" },
    },
    {
      id: "bed",
      trackId: "music",
      kind: "audio",
      start: 0,
      duration: sec(10),
      contentIn: 0,
      source: { assetId: "music-asset", streamId: "mono" },
    },
  ],
});

const catalog: StreamCatalog = {
  version: 1,
  streams: {
    "voice-asset": {
      mono: { assetVersion: 1, sampleRate: rate, availableStart: 0, availableEnd: rate * 10 },
    },
    "music-asset": {
      mono: { assetVersion: 1, sampleRate: rate, availableStart: 0, availableEnd: rate * 10 },
    },
  },
};

test("live track mute, solo and gain updates reconcile active voices without touching unaffected tracks", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const editor = createEditor({ project: baseProject() });
  const context = new FakeContext(rate);
  const transport = createAudioTransport({
    editor,
    context,
    output: sink,
    catalog,
    resolveBuffer: () => ({ sampleRate: rate, length: rate * 10 }),
  });
  t.after(() => {
    transport.dispose();
    editor.dispose();
  });

  await transport.play();
  const origin = context.nodes[0].when;
  context.currentTime = context.outputTime = origin + 0.1;
  t.mock.timers.tick(25);
  const voiceBefore = transport.diagnostics("line");
  const musicBefore = transport.diagnostics("bed");
  assert.ok(voiceBefore.reservation && musicBefore.reservation);

  // Muting music stops its voice while leaving voice running untouched.
  assert.ok(editor.dispatch(commands.updateTrack({ trackId: "music", mute: true })).ok);
  assert.deepEqual(transport.diagnostics("line"), voiceBefore);
  assert.equal(transport.diagnostics("bed").reservation, undefined);

  // Unmuting and changing gain rebooks only music.
  assert.ok(
    editor.dispatch(commands.updateTrack({ trackId: "music", mute: false, gain: 0.25 })).ok,
  );
  assert.deepEqual(transport.diagnostics("line"), voiceBefore);
  assert.ok(transport.diagnostics("bed").reservation);
  assert.notEqual(transport.diagnostics("bed").reservation, musicBefore.reservation);
});

test("trackOutput routes each track to its own Web Audio bus and fadeOutSeconds ramps on cancel", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const editor = createEditor({ project: baseProject() });
  const context = new FakeContext(rate);
  const voiceBus: AudioNodeLike = { connect: () => undefined, disconnect: () => {} };
  const connected: [AudioNodeLike, AudioNodeLike][] = [];
  const ramps: { value: number; endTime: number }[] = [];
  context.createGain = (): GainNodeLike => {
    const node: GainNodeLike = {
      gain: {
        value: 1,
        setValueAtTime() {},
        linearRampToValueAtTime(value, endTime) {
          ramps.push({ value, endTime });
        },
      },
      connect(dest) {
        connected.push([node, dest]);
        return undefined;
      },
      disconnect() {},
    };
    return node;
  };
  const transport = createAudioTransport({
    editor,
    context,
    output: sink,
    trackOutput: (trackId) => (trackId === "voice" ? voiceBus : undefined),
    fadeOutSeconds: 0.01,
    catalog,
    resolveBuffer: () => ({ sampleRate: rate, length: rate * 10 }),
  });
  t.after(() => {
    transport.dispose();
    editor.dispose();
  });

  await transport.play();
  // Voice routes to voiceBus; music falls back to default sink.
  assert.equal(connected[0]?.[1], voiceBus);
  assert.equal(connected[1]?.[1], sink);

  const origin = context.nodes[0].when;
  context.currentTime = context.outputTime = origin + 0.5;
  t.mock.timers.tick(25);
  // Muting voice triggers a smooth linear fade-out ramp to 0.
  assert.ok(editor.dispatch(commands.updateTrack({ trackId: "voice", mute: true })).ok);
  assert.equal(ramps.length, 1);
  assert.equal(ramps[0]?.value, 0);
  assert.ok(Math.abs((ramps[0]?.endTime ?? 0) - (origin + 0.51)) < 1e-6);
});

test("audio transport supports setPlaybackRate and seamless setLoop wrapping", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const editor = createEditor({ project: baseProject() });
  const context = new FakeContext(rate);
  const transport = createAudioTransport({
    editor,
    context,
    output: sink,
    catalog,
    resolveBuffer: () => ({ sampleRate: rate, length: rate * 10 }),
  });
  t.after(() => {
    transport.dispose();
    editor.dispose();
  });

  assert.throws(() => transport.setPlaybackRate(0), RangeError);
  assert.throws(() => transport.setPlaybackRate(-1), RangeError);
  assert.throws(() => transport.setLoop({ start: sec(3), end: sec(3) }), RangeError);

  transport.setPlaybackRate(2);
  transport.setLoop({ start: sec(1), end: sec(3) });
  assert.equal(transport.snapshot().playbackRate, 2);
  assert.deepEqual(transport.snapshot().loop, { start: sec(1), end: sec(3) });

  await transport.seek(sec(1));
  await transport.play();
  const origin = context.nodes[0].when;
  assert.equal(context.nodes[0].playbackRate.value, 2);

  // At 2x speed, 0.5 s of audio clock advances 1.0 s of project timeline (1 s -> 2 s).
  context.currentTime = context.outputTime = origin + 0.5;
  t.mock.timers.tick(25);
  assert.equal(transport.snapshot().presentedTick, sec(2));

  // After 1.0 s of audio clock, playback reaches loop end (3 s) and wraps to loop start (1 s).
  const segBefore = transport.snapshot().segment;
  context.currentTime = context.outputTime = origin + 1.01;
  t.mock.timers.tick(25);
  assert.equal(transport.snapshot().status, "playing");
  assert.equal(transport.snapshot().presentedTick, sec(1));
  assert.equal(transport.snapshot().segment, segBefore + 1);
});

test("video transport supports playbackRate, loop and falls back cleanly without RVFC or output timestamps", async (t: TestContext) => {
  const editor = createEditor({ project: baseProject() });
  const context = new FakeContext(rate);
  context.getOutputTimestamp = undefined;
  const video = new FakeVideo();
  const player = createVideoTransport({
    editor,
    context,
    video,
    catalog,
    resolveBuffer: () => ({ sampleRate: rate, length: rate * 10 }),
  });
  t.after(() => {
    player.dispose();
    editor.dispose();
  });

  player.setPlaybackRate(1.5);
  assert.equal(player.snapshot().playbackRate, 1.5);
  assert.equal(video.playbackRate, 1.5);

  player.setLoop({ start: sec(1), end: sec(3) });
  assert.deepEqual(player.snapshot().loop, { start: sec(1), end: sec(3) });
  video.present(2);
  video.present(2);
  assert.equal(player.snapshot().presentedTick, sec(2));
  // Crossing loop end triggers a seek back to loop start.
  video.present(3.1);
  assert.equal(player.snapshot().requestedTick, sec(1));
  assert.equal(video.currentTime, 1);

  // Also works when video element lacks requestVideoFrameCallback entirely.
  const bareVideo: VideoElementLike = {
    currentTime: 0,
    duration: 10,
    paused: true,
    ended: false,
    seeking: false,
    readyState: 4,
    play() {},
    pause() {},
    addEventListener() {},
  };
  const fallbackPlayer = createVideoTransport({
    editor,
    context,
    video: bareVideo,
    catalog,
    resolveBuffer: () => ({ sampleRate: rate, length: rate * 10 }),
  });
  assert.equal(fallbackPlayer.snapshot().presentedTick, 0);
  fallbackPlayer.dispose();
});

test("a clip's gain multiplies its track's on the voice, and changing it books only that clip again", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const project = baseProject();
  const editor = createEditor({
    project: { ...project, clips: project.clips.map((clip) => ({ ...clip, gain: 0.5 })) },
  });
  const context = new FakeContext(rate);
  const levels: number[] = [];
  context.createGain = (): GainNodeLike => {
    const node: GainNodeLike = {
      gain: {
        get value() {
          return levels[index] ?? 1;
        },
        set value(level: number) {
          levels[index] = level;
        },
      },
      connect: () => undefined,
      disconnect() {},
    };
    const index = levels.push(1) - 1;
    return node;
  };
  const transport = createAudioTransport({
    editor,
    context,
    output: sink,
    catalog,
    resolveBuffer: () => ({ sampleRate: rate, length: rate * 10 }),
  });
  t.after(() => {
    transport.dispose();
    editor.dispose();
  });

  await transport.play();
  const origin = context.nodes[0].when;
  context.currentTime = context.outputTime = origin + 0.1;
  t.mock.timers.tick(25);
  // Voice at 1 × 0.5, music at 0.5 × 0.5.
  assert.deepEqual(
    [...levels].sort((a, b) => a - b),
    [0.25, 0.5],
  );
  const voiceBefore = transport.diagnostics("line");
  const musicBefore = transport.diagnostics("bed");

  assert.ok(editor.dispatch(commands.updateClip({ clipId: "bed", gain: 1.5 })).ok);
  assert.deepEqual(transport.diagnostics("line"), voiceBefore);
  assert.notEqual(transport.diagnostics("bed").reservation, musicBefore.reservation);
  assert.equal(levels.length, 3);
  assert.equal(levels.at(-1), 0.75);

  // A clip at gain 0 plays nothing; its track's other clips are not touched.
  assert.ok(editor.dispatch(commands.updateClip({ clipId: "line", gain: 0 })).ok);
  assert.equal(transport.diagnostics("line").reservation, undefined);
  assert.ok(transport.diagnostics("bed").reservation);
});
