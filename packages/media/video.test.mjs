import assert from "node:assert/strict";
import test from "node:test";
import { createEditor, TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import { createVideoTransport } from "@lumen-timeline/media";

test("public video transport accepts ticks and releases borrowed resources without closing them", async () => {
  const editor = createEditor({ project: { schemaVersion: 1, tracks: [], clips: [] } });
  let resume,
    starts = 0,
    pauses = 0,
    framesCancelled = 0;
  const context = {
    currentTime: 1,
    sampleRate: 48000,
    getOutputTimestamp: () => ({ contextTime: 1, performanceTime: 1 }),
    resume: () =>
      new Promise((resolve) => {
        resume = resolve;
      }),
  };
  const video = Object.assign(new EventTarget(), {
    currentTime: 1,
    duration: 12,
    paused: true,
    readyState: 4,
    requestVideoFrameCallback() {
      return 1;
    },
    cancelVideoFrameCallback() {
      framesCancelled++;
    },
    play() {
      starts++;
    },
    pause() {
      pauses++;
    },
  });
  const player = createVideoTransport({
    editor,
    context,
    video,
    catalog: { version: 1, takes: {} },
    resolveBuffer() {},
  });
  assert.equal(player.snapshot().presentedTick, hz);
  const start = player.play();
  player.pause();
  resume();
  await start;
  assert.equal(starts, 0);
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
  assert.equal(pauses, 1);
  assert.equal(framesCancelled, 1);
  await assert.rejects(player.play(), /disposed/);
  await assert.rejects(player.seek(0), /disposed/);
  editor.dispose();
});
