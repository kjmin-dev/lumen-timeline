import assert from "node:assert/strict";

const hz = 282240000;

// Records the markers playback crosses, through the public core API.
async function record(page) {
  return page.evaluateHandle(async () => {
    const { watchMarkerCrossings } = await import("@lumen-timeline/core");
    const { studio } = await import("./app.mjs");
    const entries = [];
    const stop = watchMarkerCrossings(studio.editor, studio.transport, (crossing) => {
      for (const marker of crossing.markers)
        entries.push({ id: marker.id, after: crossing.after, through: crossing.through });
    });
    return { entries, stop };
  });
}
// waitForFunction treats a returned promise as truthy, so the predicate stays
// synchronous and reads the live module namespace.
async function reach(page, seconds) {
  await page.evaluate(async () => {
    window.lumenApp = await import("./app.mjs");
  });
  await page.waitForFunction(
    (tick) => {
      const s = window.lumenApp.studio.transport.snapshot();
      return s.requestedTick === null && s.presentedTick >= tick;
    },
    seconds * hz,
    { timeout: 20000 },
  );
}
const transport = (page, fn, arg) =>
  page.evaluate(
    async ({ fn, arg }) => {
      const { studio } = await import("./app.mjs");
      if (fn === "seek") return studio.transport.seek(arg);
      if (fn === "pause") return studio.transport.pause();
      return studio.transport.play();
    },
    { fn, arg },
  );

// Audio workspace: markers at 2 s ("Narration") and 20 s ("Fade").
export async function verifyAudioCrossings(page) {
  const cue = page.locator("#marker-cue");
  assert.equal(await cue.textContent(), "none");
  await transport(page, "pause");
  await transport(page, "seek", hz);
  const log = await record(page);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await reach(page, 2.3);
  assert.equal(await cue.textContent(), "Narration");
  // A playing seek lands without crossing anything; playback then crosses Fade.
  await transport(page, "seek", 19.6 * hz);
  await reach(page, 20.3);
  assert.equal(await cue.textContent(), "Fade");
  // A marker added just ahead of the playhead is crossed when playback reaches it.
  const added = await page.evaluate(async () => {
    const { commands } = await import("@lumen-timeline/core");
    const { studio } = await import("./app.mjs");
    const start = studio.transport.snapshot().presentedTick + 282240000 / 2;
    studio.editor.dispatch(commands.addMarker({ id: "ahead", start, label: "Ahead" }));
    return start;
  });
  await reach(page, added / hz + 0.2);
  await transport(page, "pause");
  assert.equal(await cue.textContent(), "Ahead");
  const entries = await log.evaluate((r) => {
    r.stop();
    return r.entries;
  });
  assert.deepEqual(
    entries.map((e) => e.id),
    ["marker-narration", "marker-fade", "ahead"],
  );
  assert.ok(entries[0].after >= hz && entries[0].after < 2 * hz);
  assert.ok(entries[1].after >= 19.6 * hz, "Fade is crossed after the seek target");
  await log.dispose();
  // Leave the original project paused at zero for the checks that follow.
  await page.evaluate(async () => {
    const { studio } = await import("./app.mjs");
    studio.editor.history.undo();
    await studio.transport.seek(0);
  });
}

// Video workspace: native element seeks skip markers like transport seeks do.
export async function verifyVideoCrossings(page) {
  const cue = page.locator("#marker-cue");
  await transport(page, "seek", 11 * hz);
  const log = await record(page);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  // Seek the element in the frame that first presents 11.1 s or later, so a loaded machine
  // cannot play past the marker at 12 s between the check and the seek.
  const from = await page.evaluate(async () => {
    const { studio } = await import("./app.mjs");
    for (;;) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const state = studio.transport.snapshot();
      if (state.requestedTick !== null || state.presentedTick < 11.1 * 282240000) continue;
      document.querySelector("video").currentTime = 18.6;
      return state.presentedTick;
    }
  });
  assert.ok(from < 12 * hz, `the native seek left from ${from / hz} s, before the marker at 12 s`);
  await reach(page, 19.3);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const entries = await log.evaluate((r) => {
    r.stop();
    return r.entries;
  });
  await log.dispose();
  assert.deepEqual(
    entries.map((e) => e.id),
    ["marker-return"],
  );
  assert.ok(entries[0].after >= 18.5 * hz, "Return is crossed after the native seek");
  assert.equal(await cue.textContent(), "Return");
}
