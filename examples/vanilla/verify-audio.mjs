import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { serve } from "./server.mjs";
import { verifyAudioCrossings } from "./verify-crossings.mjs";

const engine = process.argv[2] ?? "chromium";
const server = await serve();
const browser = await { chromium, firefox, webkit }[engine].launch();
const hz = 282240000;

async function trace(fallback) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 880 } });
  const errors = [],
    videos = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().endsWith(".webm")) videos.push(r.url());
  });
  try {
    await page.addInitScript((forceFallback) => {
      HTMLVideoElement.prototype.requestVideoFrameCallback = () => {
        throw new Error("Audio-only route used a video clock");
      };
      if (forceFallback)
        Object.defineProperty(AudioContext.prototype, "getOutputTimestamp", { value: undefined });
    }, fallback);
    await page.goto(server.url + "/examples/vanilla/audio.html");
    assert.equal(await page.locator("video").count(), 0);
    if (!fallback) {
      await verifyAudioCrossings(page);
      console.log(engine + ": audio marker crossings passed");
    }
    const studio = await page.evaluateHandle(async () => (await import("./app.mjs")).studio);
    const button = (name) => page.getByRole("button", { name, exact: true });
    await button("Play").click();
    await page.waitForFunction(
      (s) => s.transport.snapshot().presentedTick > 0.2 * 282240000,
      studio,
    );
    const initial = await studio.evaluate((s) => ({
      tick: s.transport.snapshot().presentedTick,
      precision: s.transport.snapshot().precision,
      counts: s.view.getDiagnostics(),
      revision: s.editor.getSnapshot().revision,
      undo: s.editor.history.undoDepth,
    }));
    assert.ok(["estimated", "output"].includes(initial.precision));
    if (fallback) {
      assert.equal(initial.precision, "estimated");
      assert.equal(await page.locator("#clock-mode").textContent(), "Rendering clock estimate");
      return;
    }
    await page.waitForFunction(
      ({ s, tick }) => s.transport.snapshot().presentedTick >= tick + 10 * 282240000,
      { s: studio, tick: initial.tick },
      { timeout: 20000 },
    );
    const after = await studio.evaluate((s) => ({
      counts: s.view.getDiagnostics(),
      revision: s.editor.getSnapshot().revision,
      undo: s.editor.history.undoDepth,
    }));
    assert.deepEqual(after, {
      counts: initial.counts,
      revision: initial.revision,
      undo: initial.undo,
    });
    const race = await studio.evaluate(async (s) => {
      const outcomes = await Promise.all(
        Array.from({ length: 100 }, (_, i) => s.transport.seek(i === 99 ? 3.25 * 282240000 : i)),
      );
      return { arrived: outcomes.filter((x) => x === "arrived").length, last: outcomes.at(-1) };
    });
    assert.deepEqual(race, { arrived: 1, last: "arrived" });
    await button("Pause").click();
    await studio.evaluate(async (s) => {
      await s.transport.seek(3.25 * 282240000);
      s.view.setViewport({ startTick: 0, pixelsPerSecond: 100 });
    });
    assert.equal(await studio.evaluate((s) => s.transport.snapshot().presentedTick), 3.25 * hz);
    await button("Play").click();
    const bed = await page.waitForFunction((s) => {
      const music = s.transport.diagnostics("bed");
      return music.reservation && s.transport.diagnostics("line").reservation && music;
    }, studio);
    const surface = page.getByRole("group", { name: "Timeline clips" });
    await surface.scrollIntoViewIfNeeded();
    const r = await surface.boundingBox();
    await page.keyboard.down("Alt");
    await page.mouse.move(r.x + 300, r.y + 20);
    await page.mouse.down();
    await page.mouse.move(r.x + 400, r.y + 20, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up("Alt");
    const numbers = () =>
      studio.evaluate((s) => {
        const c = s.editor.getSnapshot().clips.find((c) => c.id === "line");
        return [c.start, c.duration, c.contentIn].map((t) => t / 282240000);
      });
    assert.deepEqual(await numbers(), [3, 4, 1]);
    await page.getByLabel("Edit operation").selectOption("left");
    const delta = page.getByLabel("Edit delta in seconds");
    await delta.fill("0.5");
    await delta.press("Enter");
    assert.deepEqual(await numbers(), [3.5, 3.5, 1.5]);
    await button("Undo").click();
    assert.deepEqual(await numbers(), [3, 4, 1]);
    await button("Redo").click();
    assert.deepEqual(await numbers(), [3.5, 3.5, 1.5]);
    assert.ok(
      await studio.evaluate((s, old) => {
        const current = s.transport.diagnostics("bed");
        return (
          old.reservation === current.reservation &&
          old.endSample === current.endSample &&
          old.generation === current.generation
        );
      }, bed),
    );
    await bed.dispose();
    await button("Pause").click();
    const saved = await studio.evaluate((s) => s.editor.getSnapshot().clips);
    await button("Save project").click();
    await button("Undo").click();
    await button("Reopen saved").click();
    await page.waitForFunction(
      () => document.querySelector("#status").textContent === "Saved project reopened.",
    );
    const reopened = await page.evaluate(async () => {
      const { studio: s } = await import("./app.mjs");
      return {
        clips: s.editor.getSnapshot().clips,
        selection: s.editor.session.getSelection(),
        undo: s.editor.history.undoDepth,
        playing: s.transport.snapshot().playing,
      };
    });
    assert.deepEqual(reopened, { clips: saved, selection: [], undo: 0, playing: false });
    await studio.dispose();
    console.log(
      engine +
        ": audio-only 10s trace, 100 seeks, editing and reopen passed (" +
        initial.precision +
        " clock)",
    );
  } finally {
    await page.close();
    assert.deepEqual(errors, []);
    assert.deepEqual(videos, []);
  }
}
try {
  await trace(false);
  await trace(true);
  console.log(engine + ": forced rendering-clock fallback passed");
} finally {
  await browser.close();
  await server.close();
}
