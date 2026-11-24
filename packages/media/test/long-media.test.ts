import assert from "node:assert/strict";
import test from "node:test";
import { createEditor, TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import type { Clip, Editor, StreamCatalog } from "@lumen-timeline/core";
import {
  createAudioTransport,
  createMediaCache,
  createVideoTransport,
} from "@lumen-timeline/media";
import type {
  ChannelBufferLike,
  MediaCache,
  SampleRequest,
  StreamReader,
  VideoElementLike,
  VideoFrameMetadataLike,
} from "@lumen-timeline/media";
import type { TestContext } from "node:test";
import { FakeContext, FakeSource, FakeVideo, sink } from "./fakes.ts";

const rate = 48000;
const sec = (n: number): number => Math.round(n * hz);
const hours = 3;
const length = hours * 3600 * rate;

/** The request behind each decoded chunk. */
const requests = new WeakMap<object, SampleRequest>();
const empty = new Float32Array(0);
/** A decoded chunk without samples: the scheduler reads only its shape. */
function decoded(request: SampleRequest): ChannelBufferLike {
  const buffer = {
    sampleRate: request.sampleRate,
    length: Math.min(request.end, length) - request.start,
    numberOfChannels: 2,
    getChannelData: () => empty,
  };
  requests.set(buffer, request);
  return buffer;
}
const syncReader: StreamReader = { read: decoded };

/** A three-hour stem under a thousand short lines, each on its own asset range. */
function longProject(): Editor {
  const clips: Clip[] = [
    {
      id: "stem",
      trackId: "stem",
      kind: "audio",
      start: 0,
      duration: sec(hours * 3600),
      contentIn: 0,
      source: { assetId: "stem", streamId: "main" },
    },
  ];
  for (let i = 0; i < 1000; i++)
    clips.push({
      id: "line-" + i,
      trackId: "lines",
      kind: "audio",
      start: sec(i * 10.8 + 1),
      duration: sec(4),
      contentIn: sec(i * 10.8 + 1),
      source: { assetId: "lines", streamId: "main" },
    });
  return createEditor({
    project: {
      schemaVersion: 1,
      duration: sec(hours * 3600),
      tracks: [{ id: "stem" }, { id: "lines" }],
      clips,
    },
  });
}
const binding = { assetVersion: 1, sampleRate: rate, availableStart: 0, availableEnd: length };
const catalog: StreamCatalog = {
  version: 1,
  streams: { stem: { main: binding }, lines: { main: binding } },
};

/** A playing element whose frames the test presents. */
class PlayingVideo extends EventTarget implements VideoElementLike {
  currentTime = 0;
  playbackRate = 1;
  readonly duration = hours * 3600 + 1;
  readonly paused = false;
  readonly ended = false;
  readonly seeking = false;
  readonly readyState = 4;
  private frame: ((now: number, frame: VideoFrameMetadataLike) => void) | null = null;
  play(): void {}
  pause(): void {}
  requestVideoFrameCallback(callback: (now: number, frame: VideoFrameMetadataLike) => void) {
    this.frame = callback;
    return 1;
  }
  cancelVideoFrameCallback(): void {
    this.frame = null;
  }
  present(mediaTime: number): void {
    const callback = this.frame;
    this.frame = null;
    callback?.(1000, { mediaTime });
  }
}

/**
 * Plays three hours against a video clock while the audio device runs 100 ppm
 * fast, one frame every half second, and reports what the transport saw.
 */
function playDrifting(t: TestContext, options: { media?: MediaCache; whole?: boolean }) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const editor = longProject();
  const context = new FakeContext(rate);
  const video = new PlayingVideo();
  const transport = createVideoTransport({
    editor,
    context,
    video,
    output: sink,
    catalog,
    ...(options.media
      ? { media: options.media }
      : { resolveBuffer: () => ({ sampleRate: rate, length }) }),
  });
  t.after(() => {
    transport.dispose();
    editor.dispose();
  });
  let worstPhase = 0;
  let mostSegments = 0;
  for (let step = 0; step <= hours * 3600 * 2; step++) {
    const media = step / 2;
    const audio = 1 + media * (1 + 100e-6);
    context.currentTime = audio;
    context.outputTime = audio;
    video.present(media);
    t.mock.timers.tick(25);
    worstPhase = Math.max(worstPhase, transport.playback().phaseError);
    mostSegments = Math.max(mostSegments, transport.diagnostics("stem").segments);
  }
  return { transport, context, playback: transport.playback(), worstPhase, mostSegments };
}

test("a three-hour stem read in chunks follows a 100 ppm clock difference without a reset", (t) => {
  const media = createMediaCache({ reader: syncReader, budgetBytes: 64 * 1024 * 1024 });
  t.after(() => media.dispose());
  const { context, playback, worstPhase, mostSegments } = playDrifting(t, { media });
  // Each ten-second segment starts on the previous one's end sample, and its
  // far edge follows the clock, so the phase never drifts far enough to reset.
  // A segment is booked about twelve seconds before its far edge plays, so
  // the error stays within 12 s × 100 ppm.
  assert.equal(playback.phaseResets, 0);
  assert.ok(worstPhase < 0.0013, "worst phase error " + worstPhase);
  assert.ok(playback.seams >= hours * 360 - 2, "seams " + playback.seams);
  assert.ok(playback.corrections > 0);
  assert.equal(playback.underruns, 0);
  assert.equal(playback.lateStarts, 0);
  assert.ok(mostSegments <= 2, "segments " + mostSegments);
  // The stem's nodes tile the output without a gap or an overlap.
  const stem = context.nodes.filter(
    (node: FakeSource) => node.buffer !== null && requests.get(node.buffer)?.assetId === "stem",
  );
  assert.equal(stem.length, hours * 360);
  for (let i = 1; i < stem.length; i++) {
    const previous = stem[i - 1];
    const node = stem[i];
    assert.equal(Math.round(node.when * rate), Math.round(previous.stops[0] * rate));
    assert.equal(node.offset, 0);
  }
  // Decoded audio stayed within the budget, and only what plays now is held.
  const stats = media.diagnostics();
  assert.ok(stats.peakBytes <= stats.budgetBytes, "peak " + stats.peakBytes);
  assert.ok(stats.inUse <= 4, "in use " + stats.inUse);
  assert.ok(stats.evictions > 0);
});

test("one whole-stream node drifts until the video clock books it again", (t) => {
  const { playback, worstPhase } = playDrifting(t, { whole: true });
  // The baseline the chunked path removes: every few minutes the stem is cut
  // and booked again, which is audible.
  assert.ok(playback.phaseResets >= 30, "resets " + playback.phaseResets);
  assert.ok(worstPhase > 0.02);
});

interface Pending {
  readonly request: SampleRequest;
  readonly signal: AbortSignal;
  readonly resolve: () => void;
}
function heldReader() {
  const pending: Pending[] = [];
  const reader: StreamReader = {
    read: (request, signal) =>
      new Promise((resolve) => {
        pending.push({ request, signal, resolve: () => resolve(decoded(request)) });
      }),
  };
  const settle = async (filter: (request: SampleRequest) => boolean = () => true) => {
    for (let i = 0; i < pending.length;) {
      const read = pending[i];
      if (filter(read.request)) {
        pending.splice(i, 1);
        read.resolve();
      } else i++;
    }
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { reader, pending, settle };
}

function audioFixture(t: TestContext, reader: StreamReader) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const media = createMediaCache({ reader });
  const editor = longProject();
  const context = new FakeContext(rate);
  const transport = createAudioTransport({ editor, context, output: sink, catalog, media });
  t.after(() => {
    transport.dispose();
    editor.dispose();
    media.dispose();
  });
  return { media, editor, context, transport };
}

test("with a media cache a play waits for the audio at the playhead and starts with it", async (t) => {
  const { reader, pending, settle } = heldReader();
  const { context, transport } = audioFixture(t, reader);
  const playing = transport.play();
  await Promise.resolve();
  assert.equal(transport.snapshot().status, "starting");
  assert.equal(context.nodes.length, 0);
  assert.ok(pending.some((read) => read.request.start === 0));
  await settle();
  assert.equal(await playing, "playing");
  assert.equal(transport.snapshot().status, "playing");
  assert.equal(transport.playback().lateStarts, 0);
  // The stem's first chunk plays from its first frame, at the anchor.
  const first = context.nodes[0];
  assert.equal(first.offset, 0);
  assert.equal(Math.round(first.when * rate), 128);
});

test("an audition with a media cache starts once its clip's audio is loaded", async (t) => {
  const { reader, settle } = heldReader();
  const { context, transport } = audioFixture(t, reader);
  // The line has no candidates, so the audition plays the mix with it silent: the stem.
  const auditioning = transport.audition({ clipId: "line-100", takeId: null, mode: "mix" });
  await Promise.resolve();
  assert.equal(transport.snapshot().status, "starting");
  assert.equal(context.nodes.length, 0);
  await settle();
  assert.equal(transport.snapshot().status, "playing");
  assert.equal(transport.playback().lateStarts, 0);
  assert.equal(context.nodes.length, 1);
  transport.cancelAudition();
  assert.equal(await auditioning, "cancelled");
});

test("a playing seek lands once its audio is loaded, and pauses load around the playhead", async (t) => {
  const { reader, pending, settle } = heldReader();
  const { context, transport } = audioFixture(t, reader);
  const playing = transport.play();
  await settle();
  await playing;
  const target = sec(2 * 3600 + 0.5);
  const seek = transport.seek(target);
  await Promise.resolve();
  assert.equal(transport.snapshot().status, "seeking");
  assert.equal(transport.snapshot().requestedTick, target);
  const frame = (2 * 3600 + 0.5) * rate;
  const chunk = Math.floor(frame / (10 * rate)) * 10 * rate;
  assert.ok(pending.some((read) => read.request.start === chunk));
  await settle();
  context.currentTime = context.outputTime = 1;
  t.mock.timers.tick(25);
  assert.equal(await seek, "arrived");
  // Paused elsewhere, the cache loads the chunks around the new playhead.
  transport.pause();
  await transport.seek(sec(3600));
  t.mock.timers.tick(25);
  // Reads for the old position that nothing wants any more were aborted.
  assert.ok(pending.some((read) => read.signal.aborted));
  const around = pending
    .filter((read) => !read.signal.aborted)
    .map((read) => read.request.start / rate);
  assert.ok(around.length > 0);
  assert.ok(
    around.every((s) => s >= 3600 - 10 && s < 3600 + 40),
    "reads at " + around.join(", "),
  );
});

test("a chunk that arrives after its segment was due rejoins the clip in time", async (t) => {
  const { reader, settle } = heldReader();
  const { context, transport } = audioFixture(t, reader);
  const playing = transport.play();
  // Only the first chunk of each stream arrives.
  await settle((request) => request.start === 0);
  await playing;
  const lines = transport.diagnostics("stem");
  assert.equal(lines.segments, 1);
  // The clock passes the edge at ten seconds while the second chunk is missing.
  for (const time of [5, 9.95, 10.5, 11]) {
    context.currentTime = context.outputTime = time;
    t.mock.timers.tick(25);
  }
  assert.equal(transport.diagnostics("stem").segments, 0);
  await settle();
  const late = context.nodes.at(-1);
  assert.ok(late);
  const playback = transport.playback();
  assert.equal(playback.underruns, 1);
  // It joins where playback is, a quantum ahead of the anchor, reading the same frame.
  const anchor = 128 / rate;
  const tick = Math.round((late.when - anchor) * rate);
  assert.ok(Math.abs(late.when - context.currentTime) < 0.2);
  assert.equal(Math.round(late.offset * rate), tick - 10 * rate);
});

test("a video transport given a frame rate seeks to the middle of the target's frame", async (t) => {
  const editor = createEditor({
    project: { schemaVersion: 1, duration: 12 * hz, tracks: [], clips: [] },
  });
  const video = new FakeVideo();
  const fps = 30000 / 1001;
  const player = createVideoTransport({
    editor,
    context: new FakeContext(rate),
    video,
    catalog: { version: 1, streams: {} },
    resolveBuffer: () => ({ sampleRate: rate, length: rate }),
    frameRate: fps,
  });
  t.after(() => {
    player.dispose();
    editor.dispose();
  });
  // The first tick of frame 100, whose time in seconds rounds below the frame.
  const boundary = 100 * 1001 * (hz / 30000);
  const request = player.seek(boundary);
  assert.equal(video.currentTime, 100.5 / fps);
  video.seeked();
  assert.equal(await request, "arrived");
  assert.equal(player.snapshot().presentedTick, boundary);
  // The last tick of frame 99 asks for frame 99.
  const before = player.seek(boundary - 1);
  assert.equal(video.currentTime, 99.5 / fps);
  video.seeked();
  await before;
  assert.equal(player.snapshot().presentedTick, boundary - 1);
  assert.throws(
    () =>
      createVideoTransport({
        editor,
        context: new FakeContext(rate),
        video,
        catalog: { version: 1, streams: {} },
        resolveBuffer: () => ({ sampleRate: rate, length: rate }),
        frameRate: 0,
      }),
    RangeError,
  );
});

test("a transport takes either a resolver or a media cache", (t) => {
  const editor = longProject();
  t.after(() => editor.dispose());
  const context = new FakeContext(rate);
  assert.throws(() => createAudioTransport({ editor, context, catalog }), TypeError);
  const media = createMediaCache({ reader: syncReader });
  assert.throws(
    () =>
      createAudioTransport({
        editor,
        context,
        catalog,
        media,
        resolveBuffer: () => ({ sampleRate: rate, length }),
      }),
    TypeError,
  );
  media.dispose();
});

test("a retimed clip read in chunks plays each chunk as varispeed over its share of the timeline", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const media = createMediaCache({ reader: syncReader });
  const editor = createEditor({
    project: {
      schemaVersion: 1,
      duration: sec(40),
      tracks: [{ id: "stem" }],
      clips: [
        {
          id: "fast",
          trackId: "stem",
          kind: "audio",
          start: 0,
          duration: sec(30),
          contentIn: 0,
          rate: 2,
          source: { assetId: "stem", streamId: "main" },
        },
      ],
    },
  });
  const context = new FakeContext(rate);
  const transport = createAudioTransport({ editor, context, output: sink, catalog, media });
  t.after(() => {
    transport.dispose();
    editor.dispose();
    media.dispose();
  });
  assert.equal(await transport.play(), "playing");
  for (let step = 1; step <= 32 * 4; step++) {
    context.currentTime = step / 4;
    t.mock.timers.tick(25);
  }
  // Thirty seconds at 2× read sixty seconds of source: six ten-second chunks,
  // each played over five seconds and continuing from its predecessor's end.
  const nodes = context.nodes;
  assert.equal(nodes.length, 6);
  for (const [i, node] of nodes.entries()) {
    assert.equal(requests.get(node.buffer ?? {})?.start, i * 10 * rate);
    assert.equal(node.offset, 0);
    assert.ok(Math.abs(node.playbackRate.value - 2) < 1e-3);
    const end = node.stops[0] ?? NaN;
    assert.equal(Math.round((end - node.when) * rate), 5 * rate);
    if (i > 0) assert.equal(node.when, nodes[i - 1].stops[0]);
  }
  assert.equal(transport.playback().underruns, 0);
});
