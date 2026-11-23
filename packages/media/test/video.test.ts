import assert from "node:assert/strict";
import test from "node:test";
import { createEditor, TICKS_PER_SECOND as hz, watchMarkerCrossings } from "@lumen-timeline/core";
import type { Editor, PresentationSource } from "@lumen-timeline/core";
import { createVideoTransport } from "@lumen-timeline/media";
import type { VideoTransport } from "@lumen-timeline/media";
import { FakeContext, FakeVideo } from "./fakes.ts";

test("public video transport accepts ticks and releases borrowed resources without closing them", async () => {
  const editor = createEditor({ project: { schemaVersion: 1, tracks: [], clips: [] } });
  let resume: (() => void) | undefined;
  const context = new FakeContext(48000);
  context.currentTime = 1;
  context.getOutputTimestamp = () => ({ contextTime: 1, performanceTime: 1 });
  context.resume = () =>
    new Promise((resolve) => {
      resume = resolve;
    });
  const video = new FakeVideo();
  const player = createVideoTransport({
    editor,
    context,
    video,
    catalog: { version: 1, streams: {} },
    // The empty project never resolves a buffer.
    resolveBuffer: () => ({ sampleRate: 48000, length: 0 }),
  });
  assert.equal(player.snapshot().presentedTick, hz);
  const start = player.play();
  player.pause();
  assert.ok(resume);
  resume();
  await start;
  assert.equal(video.starts, 0);
  const request = player.seek(3 * hz);
  assert.equal(player.snapshot().requestedTick, 3 * hz);
  video.dispatchEvent(new Event("seeked"));
  assert.equal(await request, "arrived");
  assert.deepEqual(player.snapshot(), {
    playing: false,
    presentedTick: 3 * hz,
    requestedTick: null,
    segment: 1,
    segmentStart: 3 * hz,
    audition: null,
    until: null,
    playbackRate: 1,
    loop: null,
  });
  player.dispose();
  player.dispose();
  assert.equal(video.pauses, 1);
  assert.equal(video.framesCancelled, 1);
  await assert.rejects(player.play(), /disposed/);
  await assert.rejects(player.seek(0), /disposed/);
  editor.dispose();
});

function videoFixture(editor: Editor): { video: FakeVideo; player: VideoTransport } {
  const context = new FakeContext(48000);
  context.getOutputTimestamp = () => ({ contextTime: 1, performanceTime: 1 });
  const video = new FakeVideo();
  const player = createVideoTransport({
    editor,
    context,
    video,
    catalog: { version: 1, streams: {} },
    resolveBuffer: () => ({ sampleRate: 48000, length: 0 }),
  });
  return { video, player };
}

test("native seeks publish their target and start a segment; frames advance within it", async (t) => {
  const markers = [1.5, 2, 5, 6].map((s) => ({ id: "m" + s, start: s * hz }));
  const editor = createEditor({
    project: { schemaVersion: 1, duration: 12 * hz, tracks: [], clips: [], markers },
  });
  const { video, player } = videoFixture(editor);
  t.after(() => {
    player.dispose();
    editor.dispose();
  });
  const source: PresentationSource = player;
  const crossed: string[][] = [];
  const stop = watchMarkerCrossings(editor, source, ({ markers: found }) =>
    crossed.push(found.map((m) => m.id)),
  );
  assert.deepEqual(player.snapshot(), {
    playing: false,
    presentedTick: hz,
    requestedTick: null,
    segment: 0,
    segmentStart: hz,
    audition: null,
    until: null,
    playbackRate: 1,
    loop: null,
  });
  video.present(1.5);
  video.present(2.5);
  assert.deepEqual(crossed, [["m1.5"], ["m2"]]);

  // Native controls: the target is published at once, and the landing skips m5.
  video.nativeSeek(5.5);
  assert.equal(player.snapshot().requestedTick, 5.5 * hz);
  assert.equal(player.snapshot().segment, 0);
  video.dispatchEvent(new Event("seeked")); // a stale event while still seeking
  assert.equal(player.snapshot().requestedTick, 5.5 * hz);
  video.seeked();
  assert.deepEqual(player.snapshot(), {
    playing: false,
    presentedTick: 5.5 * hz,
    requestedTick: null,
    segment: 1,
    segmentStart: 5.5 * hz,
    audition: null,
    until: null,
    playbackRate: 1,
    loop: null,
  });
  // Seeking invalidated the clock, so the first callback after it only re-arms.
  video.present(5.5);
  video.present(6);
  assert.deepEqual(crossed, [["m1.5"], ["m2"], ["m6"]]);

  // The transport's own seek keeps its target while the element reports seeking.
  const request = player.seek(2 * hz);
  assert.equal(video.currentTime, 2);
  video.seeking = true;
  video.dispatchEvent(new Event("seeking"));
  assert.equal(player.snapshot().requestedTick, 2 * hz);
  video.seeked();
  assert.equal(await request, "arrived");
  assert.deepEqual(player.snapshot(), {
    playing: false,
    presentedTick: 2 * hz,
    requestedTick: null,
    segment: 2,
    segmentStart: 2 * hz,
    audition: null,
    until: null,
    playbackRate: 1,
    loop: null,
  });
  // As above, the first callback after the seek only re-arms.
  video.present(2.4);
  video.present(5.2);
  assert.equal(player.snapshot().presentedTick, 5.2 * hz);
  assert.deepEqual(crossed, [["m1.5"], ["m2"], ["m6"], ["m5"]]);

  // A second native seek replaces the published target.
  video.nativeSeek(7);
  video.nativeSeek(8);
  assert.equal(player.snapshot().requestedTick, 8 * hz);
  // A transport seek takes over an unfinished native seek and lands once.
  const takeover = player.seek(4 * hz);
  assert.equal(player.snapshot().requestedTick, 4 * hz);
  video.dispatchEvent(new Event("seeking"));
  video.seeked();
  assert.equal(await takeover, "arrived");
  assert.deepEqual(player.snapshot(), {
    playing: false,
    presentedTick: 4 * hz,
    requestedTick: null,
    segment: 3,
    segmentStart: 4 * hz,
    audition: null,
    until: null,
    playbackRate: 1,
    loop: null,
  });
  assert.equal(stop(), true);
});
