import assert from "node:assert/strict";
import test from "node:test";
import { commands, createEditor, TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import type { AudioSpan, Clip, StreamCatalog } from "@lumen-timeline/core";
import { createAudioTransport } from "@lumen-timeline/media";
import type { AudioBufferLike, StretchAudio, StretchRequest } from "@lumen-timeline/media";
import type { TestContext } from "node:test";
import { FakeContext, sink } from "./fakes.ts";

const sec = (n: number): number => Math.round(n * hz);
const rate = 48000;
// A four-second line at 2 s, one second into its take, beside a bed from 0 s.
const clips: Clip[] = [
  {
    id: "line",
    trackId: "line",
    kind: "audio",
    start: sec(2),
    duration: sec(4),
    contentIn: sec(1),
    takeIds: ["line"],
    activeTakeId: "line",
  },
  {
    id: "bed",
    trackId: "bed",
    kind: "audio",
    start: 0,
    duration: sec(8),
    contentIn: 0,
    takeIds: ["bed"],
    activeTakeId: "bed",
  },
];

const timed = new WeakSet<TestContext>();

interface Options {
  readonly stretch?: StretchAudio;
}

function fixture(t: TestContext, { stretch }: Options = {}) {
  if (!timed.has(t)) {
    t.mock.timers.enable({ apis: ["setInterval"] });
    timed.add(t);
  }
  const context = new FakeContext(rate);
  const editor = createEditor({
    project: {
      schemaVersion: 1,
      tracks: [{ id: "line" }, { id: "bed" }],
      clips,
      takes: clips.map((c) => ({
        id: c.id,
        assetId: c.id,
        streamId: "mono",
        sourceAtContentZero: 0,
      })),
    },
  });
  const stream = { assetVersion: 1, sampleRate: rate, availableStart: 0, availableEnd: rate * 10 };
  const catalog: StreamCatalog = {
    version: 1,
    streams: { line: { mono: stream }, bed: { mono: stream } },
  };
  const errors: [unknown, AudioSpan][] = [];
  const transport = createAudioTransport({
    editor,
    context,
    output: sink,
    catalog,
    resolveBuffer: () => ({ sampleRate: rate, length: 10 * rate }),
    ...(stretch ? { stretch } : {}),
    onError: (error, span) => errors.push([error, span]),
  });
  t.after(() => {
    transport.dispose();
    editor.dispose();
  });
  /** The newest node that plays a buffer of `length` frames, or the line's source. */
  const nodeOf = (buffer: AudioBufferLike | undefined) => {
    const node = context.nodes.findLast((n) => n.buffer === buffer);
    assert.ok(node, "Expected a node for the buffer");
    return node;
  };
  return { editor, context, transport, errors, nodeOf };
}

/** A stretch engine that records each request and answers with a buffer of its length. */
function recorder(
  answer?: (request: StretchRequest) => AudioBufferLike | PromiseLike<AudioBufferLike>,
) {
  const requests: StretchRequest[] = [];
  const signals: AbortSignal[] = [];
  const rendered: AudioBufferLike[] = [];
  const stretch: StretchAudio = (request, signal) => {
    requests.push(request);
    signals.push(signal);
    if (answer) return answer(request);
    const buffer = { sampleRate: request.span.sampleRate, length: request.length };
    rendered.push(buffer);
    return buffer;
  };
  return { stretch, requests, signals, rendered };
}

test("without a stretch engine a retimed clip plays its source as varispeed", async (t) => {
  const { editor, context, transport } = fixture(t);
  assert.ok(editor.dispatch(commands.retimeClip({ clipId: "line", rate: 1.25 })).ok);
  await transport.seek(sec(3));
  await transport.play();
  const line = context.nodes.find(
    (n) => n.buffer?.length === 10 * rate && n.playbackRate.value !== 1,
  );
  assert.ok(line, "the line plays at its rate");
  // One second into the clip plays 1.25 s of content after content 1 s.
  assert.equal(Math.round(line.offset * rate), 2.25 * rate);
  assert.equal(line.playbackRate.value, 1.25);
  // The clip ends at 5.2 s: 2.2 s of output after 3 s.
  assert.equal(Math.round((line.stops[0] - line.when) * rate), Math.round(2.2 * rate));
  const bed = context.nodes.find((n) => n !== line);
  assert.equal(bed?.playbackRate.value, 1, "other clips keep their speed");

  // The transport's speed multiplies the clip's.
  transport.pause();
  transport.setPlaybackRate(2);
  await transport.play();
  const faster = context.nodes.findLast(
    (n) => n.playbackRate.value !== 1 && n.playbackRate.value !== 2,
  );
  assert.equal(faster?.playbackRate.value, 2.5);
});

test("a stretch engine renders the audible range, which plays from the clip's audible start", async (t) => {
  const { stretch, requests, rendered } = recorder();
  const { editor, transport, errors, nodeOf } = fixture(t, { stretch });
  assert.ok(editor.dispatch(commands.retimeClip({ clipId: "line", rate: 1.25 })).ok);
  await transport.seek(sec(3));
  await transport.play();
  assert.equal(requests.length, 1, "only the retimed clip is stretched");
  const [request] = requests;
  assert.ok(request);
  assert.equal(request.span.clipId, "line");
  assert.equal(request.span.rate, 1.25);
  assert.deepEqual(
    [request.sourceStart, request.sourceEnd, request.length],
    [rate, 5 * rate, Math.round(3.2 * rate)],
  );
  assert.equal(request.buffer.length, 10 * rate);
  const node = nodeOf(rendered[0]);
  // Playback starts one second into the rendering, at the timeline's pace.
  assert.equal(node.offset, 1);
  assert.equal(node.playbackRate.value, 1);
  assert.equal(Math.round((node.stops[0] - node.when) * rate), Math.round(2.2 * rate));
  assert.deepEqual(errors, []);
});

test("a rendering that arrives later is booked at the current position", async (t) => {
  let release: (buffer: AudioBufferLike) => void = () => {};
  const { stretch, requests } = recorder(
    () => new Promise<AudioBufferLike>((resolve) => (release = resolve)),
  );
  const { editor, context, transport, nodeOf } = fixture(t, { stretch });
  assert.ok(editor.dispatch(commands.retimeClip({ clipId: "line", rate: 0.8 })).ok);
  await transport.seek(sec(3));
  await transport.play();
  const before = context.nodes.length;
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  // Four seconds of content take five at rate 0.8.
  assert.equal(request.length, 5 * rate);
  const buffer = { sampleRate: rate, length: request.length };
  release(buffer);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.nodes.length, before + 1);
  const node = nodeOf(buffer);
  assert.equal(node.offset, 1);
});

test("a failed or short rendering is reported and the clip plays as varispeed", async (t) => {
  for (const answer of [
    (): AudioBufferLike => {
      throw new Error("no worklet");
    },
    (): Promise<AudioBufferLike> => Promise.reject(new Error("render failed")),
    (request: StretchRequest): AudioBufferLike => ({
      sampleRate: rate,
      length: request.length - 1,
    }),
  ]) {
    const { stretch } = recorder(answer);
    const { editor, context, transport, errors } = fixture(t, { stretch });
    assert.ok(editor.dispatch(commands.retimeClip({ clipId: "line", rate: 1.25 })).ok);
    await transport.seek(sec(3));
    await transport.play();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1, "the failure is reported once");
    assert.equal(errors[0]?.[1].clipId, "line");
    const line = context.nodes.find((n) => n.playbackRate.value === 1.25);
    assert.ok(line, "the clip still plays");
    assert.equal(Math.round(line.offset * rate), 2.25 * rate);
  }
});

test("a retime during playback replaces only the retimed clip's voice", async (t) => {
  const { stretch, requests, signals } = recorder();
  const { editor, context, transport } = fixture(t, { stretch });
  await transport.seek(sec(3));
  await transport.play();
  assert.equal(requests.length, 0, "clips at rate 1 are not stretched");
  const bed = transport.diagnostics("bed");
  const plain = context.nodes.find((n) => n.offset === 2);
  assert.ok(plain, "the line plays from its source");
  assert.ok(editor.dispatch(commands.retimeClip({ clipId: "line", rate: 0.8 })).ok);
  assert.equal(requests.length, 1);
  assert.ok(plain.stops.length > 0, "the old voice stops");
  assert.deepEqual(transport.diagnostics("bed"), bed, "the bed keeps its reservation");
  transport.pause();
  assert.equal(signals[0]?.aborted, true, "pausing aborts the rendering's signal");
});
