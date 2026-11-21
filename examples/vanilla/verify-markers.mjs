import assert from "node:assert/strict";

const hz = 282240000;

// Drives saved markers from the keyboard and toolbar on the video studio page.
export async function verifyMarkers(page) {
  const state = () =>
    page.evaluate(async () => {
      const { studio } = await import("./app.mjs");
      const s = studio.editor.getSnapshot();
      const t = studio.transport.snapshot();
      return {
        markers: (s.markers ?? []).map((m) => [m.id, m.start, m.label ?? null]),
        undo: studio.editor.history.undoDepth,
        nav: document.querySelector("#timeline select[aria-label='Marker navigator']").value,
        tick: t.requestedTick ?? t.presentedTick,
        settled: t.requestedTick === null,
      };
    });
  const settle = (tick) =>
    page.waitForFunction(async (target) => {
      const { studio } = await import("./app.mjs");
      const t = studio.transport.snapshot();
      return t.requestedTick === null && t.presentedTick === target;
    }, tick);
  await page.evaluate(async () => {
    const { studio } = await import("./app.mjs");
    studio.view.setViewport({ startTick: 0, pixelsPerSecond: 40 });
    await studio.transport.seek(0);
  });
  await settle(0);
  const requests = await page.evaluateHandle(async () => {
    const { studio } = await import("./app.mjs");
    const ticks = [];
    const off = studio.transport.subscribe((s) => {
      if (s.requestedTick !== null && s.requestedTick !== ticks.at(-1)) ticks.push(s.requestedTick);
    });
    return { ticks, off };
  });
  const ruler = page.getByRole("slider", { name: "Seek", exact: true });
  await ruler.focus();
  await page.keyboard.press("]");
  await settle(12 * hz);
  await page.keyboard.press("]");
  await settle(19 * hz);
  await page.keyboard.press("]");
  await page.keyboard.press("[");
  await settle(12 * hz);
  assert.equal((await state()).nav, "marker-line");
  assert.deepEqual(
    await requests.evaluate((r) => {
      r.off();
      return r.ticks;
    }),
    [12 * hz, 19 * hz, 12 * hz],
  );
  await requests.dispose();

  await page.evaluate(
    async (tick) => (await import("./app.mjs")).studio.transport.seek(tick),
    15 * hz,
  );
  await settle(15 * hz);
  const base = await state();
  await ruler.focus();
  await page.keyboard.press("m");
  const added = await state();
  const id = added.nav;
  assert.ok(id && !base.markers.some(([existing]) => existing === id));
  assert.deepEqual(
    added.markers.map(([, start, label]) => [start / hz, label]),
    [
      [12, "Tidal line"],
      [15, "Marker 3"],
      [19, "Return"],
    ],
  );
  assert.equal(added.undo, base.undo + 1);

  await page.getByRole("textbox", { name: "Marker label", exact: true }).fill("Bridge");
  await page.getByRole("button", { name: "Rename marker", exact: true }).click();
  assert.deepEqual((await state()).markers[1], [id, 15 * hz, "Bridge"]);
  await page.getByRole("button", { name: "Remove marker", exact: true }).click();
  assert.equal((await state()).markers.length, 2);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  const restored = await state();
  assert.deepEqual(restored.markers[1], [id, 15 * hz, "Bridge"]);
  assert.equal(restored.undo, base.undo + 2);

  // A marker edit during playback leaves the music reservation alone.
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForFunction(async () => {
    const { studio } = await import("./app.mjs");
    window.lumenBed = studio.transport.diagnostics("bed").reservation;
    return window.lumenBed !== undefined;
  });
  await page.getByRole("group", { name: "Timeline clips" }).focus();
  await page.keyboard.press("m");
  const kept = await page.evaluate(async () => {
    const { studio } = await import("./app.mjs");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return studio.transport.diagnostics("bed").reservation === window.lumenBed;
  });
  assert.ok(kept);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const saved = (await state()).markers;
  assert.equal(saved.length, 4);

  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await page.getByRole("button", { name: "Reopen saved", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("#status").textContent === "Saved project reopened.",
  );
  const reopened = await state();
  assert.deepEqual(reopened.markers, saved);
  assert.equal(reopened.undo, 0);
}
