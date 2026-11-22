import assert from "node:assert/strict";
import test from "node:test";
import { createEditor, TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import type { Project } from "@lumen-timeline/core";
import { createAudioTransport, createVideoTransport } from "@lumen-timeline/media";
import type { AudioBufferLike } from "@lumen-timeline/media";
import type { TestContext } from "node:test";
import { FakeContext, FakeVideo, sink } from "./fakes.ts";

const sec = (n: number): number => Math.round(n * hz);
const rate = 48000;

/** A line from 2 s to 5 s over a ten-second bed, each on its own asset. */
const project: Project = {
  schemaVersion: 1,
  duration: sec(10),
  tracks: [{ id: "voice" }, { id: "music" }],
  clips: [
    {
      id: "line",
      trackId: "voice",
      kind: "audio",
      start: sec(2),
      duration: sec(3),
      contentIn: 0,
      takeIds: ["a", "b"],
      activeTakeId: "a",
    },
    {
      id: "bed",
      trackId: "music",
      kind: "audio",
      start: 0,
      duration: sec(10),
      contentIn: 0,
      takeIds: ["m"],
      activeTakeId: "m",
    },
  ],
  takes: ["a", "b", "m"].map((id) => ({
    id,
    assetId: "asset-" + id,
    streamId: "mono",
    sourceAtContentZero: 0,
  })),
};
const stream = { assetVersion: 1, sampleRate: rate, availableStart: 0, availableEnd: 10 * rate };
const catalog = {
  version: 1,
  streams: Object.fromEntries(["a", "b", "m"].map((id) => ["asset-" + id, { mono: stream }])),
};
const buffers = new Map<string, AudioBufferLike>(
  ["a", "b", "m"].map((id) => ["asset-" + id, { sampleRate: rate, length: 10 * rate }]),
);
const resolveBuffer = ({ assetId }: { assetId: string }): AudioBufferLike => {
  const buffer = buffers.get(assetId);
  assert.ok(buffer);
  return buffer;
};

function audioFixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const editor = createEditor({ project });
  const context = new FakeContext(rate);
  const transport = createAudioTransport({ editor, context, output: sink, catalog, resolveBuffer });
  transport.subscribe(() => {});
  t.after(() => {
    transport.dispose();
    editor.dispose();
  });
  return {
    context,
    transport,
    at: (seconds: number): void => {
      context.currentTime = seconds;
      context.outputTime = seconds;
      t.mock.timers.tick(25);
    },
  };
}
/** The output time that `tick` plays at, for an anchor booked at `audio` for `from`. */
const output = (audio: number, from: number, tick: number): number =>
  Math.round((audio - from / hz + tick / hz) * rate) / rate;
// Play anchors one render quantum ahead of the clock.
const origin = 128 / rate;

test("play with a stop cuts every voice there and pauses at it", async (t) => {
  const { context, transport, at } = audioFixture(t);
  await transport.play({ until: sec(4) });
  assert.equal(transport.snapshot().until, sec(4));
  at(origin + 0.05);
  const [bed] = context.nodes;
  assert.deepEqual(bed?.stops, [output(origin, 0, sec(4))]);
  // The line is booked from 2 s and ends at the stop, not at 5 s.
  at(origin + 1.95);
  const line = context.nodes[1];
  assert.deepEqual(line?.stops, [output(origin, 0, sec(4))]);
  const segment = transport.snapshot().segment;
  at(origin + 4.01);
  assert.deepEqual(
    { ...transport.snapshot() },
    {
      status: "paused",
      playing: false,
      presentedTick: sec(4),
      requestedTick: null,
      precision: "exact",
      // Playback reached the stop, so presentation stays in its segment.
      segment,
      segmentStart: 0,
      audition: null,
      until: null,
    },
  );
  // Play continues from the stop to the end.
  await transport.play();
  at(origin + 4.05);
  assert.equal(transport.snapshot().status, "playing");
  assert.equal(transport.snapshot().until, null);
});

test("moving the stop while playing cuts booked voices or books them again", async (t) => {
  const { context, transport, at } = audioFixture(t);
  await transport.play();
  at(origin + 1.95);
  const [bed, line] = context.nodes;
  assert.deepEqual(bed?.stops, [output(origin, 0, sec(10))]);
  assert.deepEqual(line?.stops, [output(origin, 0, sec(5))]);

  // An earlier stop keeps the booked voices and stops them sooner.
  assert.equal(await transport.play({ until: sec(3) }), "playing");
  assert.equal(transport.snapshot().until, sec(3));
  assert.equal(context.nodes.length, 2);
  assert.equal(bed?.stops.at(-1), output(origin, 0, sec(3)));
  assert.equal(line?.stops.at(-1), output(origin, 0, sec(3)));

  // A later stop books them again from the presented position.
  const from = transport.snapshot().presentedTick;
  const audio = (Math.ceil(context.currentTime * rate) + 128) / rate;
  await transport.play({ until: sec(4) });
  const rebooked = context.nodes.slice(2);
  assert.equal(rebooked.length, 2);
  for (const node of rebooked) assert.deepEqual(node.stops, [output(audio, from, sec(4))]);
  assert.equal(bed?.stops.at(-1), context.currentTime, "the earlier booking was not cancelled");

  // Play without a stop plays on to each clip's end.
  await transport.play();
  assert.equal(transport.snapshot().until, null);
  const ends = context.nodes.slice(4).map((node) => node.stops[0]);
  assert.equal(ends.length, 2);
  assert.ok(ends.every((end) => end !== undefined && end > output(audio, from, sec(4))));
});

test("a pause, a seek or an audition clears the stop, and a stop must follow the position", async (t) => {
  const { transport, at } = audioFixture(t);
  await transport.seek(sec(2));
  for (const until of [sec(2), sec(1), 1.5, -1, Number.NaN]) {
    await assert.rejects(transport.play({ until }), RangeError);
  }
  assert.equal(transport.snapshot().status, "paused");
  assert.equal(transport.snapshot().until, null);

  await transport.play({ until: sec(6) });
  transport.pause();
  assert.equal(transport.snapshot().until, null);

  await transport.play({ until: sec(6) });
  at(origin + 0.5);
  const seek = transport.seek(sec(1));
  assert.equal(transport.snapshot().until, null);
  // The seek anchors in a microtask, then lands when the clock reaches it.
  await Promise.resolve();
  at(origin + 1);
  assert.equal(await seek, "arrived");

  await transport.play({ until: sec(6) });
  const heard = transport.audition({ clipId: "line", takeId: "b" });
  assert.equal(transport.snapshot().until, null);
  // A stop before the audition's return position is refused and the audition plays on.
  const back = transport.snapshot().audition?.returnTick ?? 0;
  await assert.rejects(transport.play({ until: back }), RangeError);
  assert.equal(transport.snapshot().audition?.takeId, "b");
  // A valid one ends the audition and plays from its return position.
  await transport.play({ until: back + sec(1) });
  assert.equal(await heard, "cancelled");
  assert.equal(transport.snapshot().until, back + sec(1));
  assert.equal(transport.snapshot().presentedTick, back);
});

test("a stop at or past the sequence end ends there", async (t) => {
  const { transport, at } = audioFixture(t);
  await transport.seek(sec(9));
  await transport.play({ until: sec(20) });
  assert.equal(transport.snapshot().until, sec(20));
  at(origin + 1.01);
  assert.equal(transport.snapshot().status, "ended");
  assert.equal(transport.snapshot().presentedTick, sec(10));
  assert.equal(transport.snapshot().until, null);
});

function videoFixture(t: TestContext) {
  const editor = createEditor({ project });
  const context = new FakeContext(rate);
  const video = new FakeVideo();
  const player = createVideoTransport({ editor, context, video, catalog, resolveBuffer });
  t.after(() => {
    player.dispose();
    editor.dispose();
  });
  return { video, player };
}
/** Presents a frame. The first callback after a clock reset belongs to the old generation. */
function frame(video: FakeVideo, seconds: number): void {
  video.present(seconds);
  video.present(seconds);
}
/** Lets the element finish the seek the transport started. */
async function land(video: FakeVideo): Promise<void> {
  await Promise.resolve();
  video.seeked();
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

test("a video stop pauses at the first frame past it and presents the stop tick", async (t) => {
  const { video, player } = videoFixture(t);
  assert.equal(player.snapshot().presentedTick, hz);
  await assert.rejects(player.play({ until: hz }), RangeError);
  assert.equal(video.starts, 0);

  await player.play({ until: sec(3) });
  assert.equal(video.starts, 1);
  assert.equal(player.snapshot().until, sec(3));
  frame(video, 2);
  assert.equal(video.pauses, 0);
  // The frame after the stop pauses and seeks back to it.
  frame(video, 3.1);
  assert.equal(video.pauses, 1);
  assert.equal(player.snapshot().until, null);
  assert.equal(video.currentTime, 3);
  await land(video);
  assert.equal(player.snapshot().presentedTick, sec(3));

  // A stop that does not follow an audition's return position leaves it playing.
  const heard = player.audition({ clipId: "line", takeId: "b" });
  await land(video);
  await assert.rejects(player.play({ until: sec(3) }), RangeError);
  assert.equal(player.snapshot().audition?.takeId, "b");
  player.cancelAudition();
  await land(video);
  assert.equal(await heard, "cancelled");

  // A pause or a seek clears the stop.
  await player.play({ until: sec(5) });
  player.pause();
  assert.equal(player.snapshot().until, null);
  await player.play({ until: sec(5) });
  const seek = player.seek(sec(1));
  assert.equal(player.snapshot().until, null);
  await land(video);
  assert.equal(await seek, "arrived");
  const pauses = video.pauses;
  frame(video, 5.2);
  assert.equal(video.pauses, pauses, "a cleared stop paused the element");
});
