import assert from "node:assert/strict";
import test from "node:test";
import { createEditor, TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import { createVideoTransport } from "@lumen-timeline/media";
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
    catalog: { version: 1, takes: {} },
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
  });
  player.dispose();
  player.dispose();
  assert.equal(video.pauses, 1);
  assert.equal(video.framesCancelled, 1);
  await assert.rejects(player.play(), /disposed/);
  await assert.rejects(player.seek(0), /disposed/);
  editor.dispose();
});
