// Waveforms in the timeline: the example's reference stem drawn where its
// phrases are, at two zoom levels; and, in a mount of its own, a provider whose
// peaks arrive later, the tracks a notification repaints, and the source range
// requested after a move, a trim and a take offset change. Usage:
// node examples/vanilla/verify-waveforms.mjs [chromium|firefox|webkit]   (build first)
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { serve } from "./server.mjs";

const engine = process.argv[2] ?? "chromium";
const server = await serve();
const browser = await { chromium, firefox, webkit }[engine].launch();
const errors = [];

// Counts the pixels of a clip body, below its stripe, that differ from the fill
// color, in the columns within three pixels of `x`, and returns the largest count.
const inkSource = `window.ink = (canvas, x, top, height, fill) => {
  const dpr = canvas.width / canvas.clientWidth;
  const ctx = canvas.getContext("2d");
  let best = 0;
  for (let cx = Math.round(x) - 3; cx <= Math.round(x) + 3; cx++) {
    const data = ctx.getImageData(Math.round(cx * dpr), Math.round(top * dpr), 1, Math.round(height * dpr)).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4)
      if (Math.abs(data[i] - fill[0]) + Math.abs(data[i + 1] - fill[1]) + Math.abs(data[i + 2] - fill[2]) > 24) count++;
    best = Math.max(best, count / dpr);
  }
  return best;
};`;

async function studio() {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.waitForSelector(".lt-edit");
  await page.evaluate(inkSource);
  await page.evaluate(async () => {
    window.lumenApp = await import("./app.mjs");
  });
  // The stem is the fourth row, one lane, below three one-lane rows.
  const stem = (seconds) =>
    page.evaluate((s) => {
      const { startTick, pixelsPerSecond } = window.lumenApp.studio.view.getViewport();
      const x = ((s * 282240000 - startTick) / 282240000) * pixelsPerSecond;
      return window.ink(document.querySelector(".lt-clips"), x, 3 * 46 + 9, 28, [43, 85, 85]);
    }, seconds);
  // The whole sequence: silence between phrases, a waveform inside each.
  const whole = {
    silent: [await stem(10), await stem(17.5)],
    voiced: [await stem(13), await stem(20)],
  };
  assert.ok(
    whole.silent.every((ink) => ink <= 2) && whole.voiced.every((ink) => ink >= 6),
    JSON.stringify(whole),
  );
  // Zoomed in, the same source lines up with the same ticks.
  await page.evaluate(() =>
    window.lumenApp.studio.view.setViewport({ startTick: 9 * 282240000, pixelsPerSecond: 200 }),
  );
  const zoomed = { silent: await stem(10.5), voiced: await stem(12.55) };
  assert.ok(zoomed.silent <= 2 && zoomed.voiced >= 6, JSON.stringify(zoomed));
  // The stem is a reference: locked, so it cannot be dragged out of sync.
  assert.equal(
    (
      await page.evaluate(async () => {
        const { commands } = await import("@lumen-timeline/core");
        return window.lumenApp.studio.editor.dispatch(
          commands.moveClips({ clipIds: ["stem"], delta: 282240000 }),
        );
      })
    ).code,
    "locked-track",
  );
  await page.close();
}

async function provider() {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.waitForSelector(".lt-edit");
  await page.evaluate(inkSource);
  const steps = await page.evaluate(async () => {
    const { createEditor, commands, TICKS_PER_SECOND: hz } = await import("@lumen-timeline/core");
    const { mountTimeline } = await import("@lumen-timeline/timeline");
    const ready = new Set();
    const requests = [];
    let listener;
    let subscriptions = 0;
    const waveforms = {
      peaks(request) {
        requests.push(request);
        if (!ready.has(request.assetId)) return null;
        return Float32Array.from({ length: 2 * request.buckets }, (_, i) => (i % 2 ? 0.8 : -0.8));
      },
      subscribe(fn) {
        listener = fn;
        subscriptions++;
        return () => {
          subscriptions--;
        };
      },
    };
    const clip = (id, trackId, takeId) => ({
      id,
      trackId,
      kind: "audio",
      start: hz,
      duration: 4 * hz,
      contentIn: 0,
      takeIds: [takeId],
      activeTakeId: takeId,
    });
    const editor = createEditor({
      project: {
        schemaVersion: 1,
        duration: 10 * hz,
        tracks: [{ id: "a" }, { id: "b" }],
        clips: [clip("one", "a", "k1"), clip("two", "b", "k2")],
        takes: [
          { id: "k1", assetId: "x", streamId: "mono", sourceAtContentZero: 0 },
          { id: "k2", assetId: "y", streamId: "mono", sourceAtContentZero: 0 },
        ],
      },
    });
    const transport = {
      snapshot: () => ({ playing: false, presentedTick: 0, requestedTick: null }),
      subscribe: () => () => {},
      play() {},
      pause() {},
      seek() {},
    };
    const host = document.createElement("div");
    document.body.prepend(host);
    const view = mountTimeline(host, { editor, transport, pixelsPerSecond: 50, waveforms });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const canvas = host.querySelector(".lt-clips");
    const look = (seconds) => ({
      a: window.ink(canvas, seconds * 50, 9, 28, [43, 85, 85]),
      b: window.ink(canvas, seconds * 50, 46 + 9, 28, [96, 67, 50]),
    });
    const lastX = () => {
      const r = requests.filter((q) => q.assetId === "x").at(-1);
      return [r.start / hz, r.end / hz, r.buckets];
    };
    const paints = () => view.getDiagnostics().staticPaints;
    const out = {};
    out.pending = {
      look: look(3),
      assets: [...new Set(requests.map((r) => r.assetId))].sort((p, q) => p.localeCompare(q)),
    };
    let before = paints();
    ready.add("x");
    listener("x");
    out.ready = { paints: paints() - before, look: look(3), request: lastX() };
    before = paints();
    listener("z");
    out.unused = paints() - before;
    editor.dispatch(commands.moveClips({ clipIds: ["one"], delta: hz }));
    out.moved = lastX();
    editor.dispatch(commands.trimClip({ clipId: "one", edge: "left", delta: hz / 2 }));
    out.trimmed = lastX();
    before = paints();
    editor.dispatch(commands.updateTake({ takeId: "k1", sourceAtContentZero: hz / 4 }));
    out.offset = { paints: paints() - before, request: lastX() };
    before = paints();
    editor.dispatch(commands.setEntityData({ scope: "take", id: "k1", key: "note", value: "x" }));
    out.data = paints() - before;
    view.dispose();
    out.subscriptions = subscriptions;
    editor.dispose();
    host.remove();
    return out;
  });
  // Pending peaks draw nothing; both assets were asked for.
  assert.deepEqual(steps.pending, { look: { a: 0, b: 0 }, assets: ["x", "y"] });
  // A notification repaints once, and only the track that plays the asset draws it.
  assert.equal(steps.ready.paints, 1);
  assert.ok(steps.ready.look.a >= 15 && steps.ready.look.b === 0, JSON.stringify(steps.ready.look));
  assert.deepEqual(steps.ready.request, [0, 4, 200]);
  assert.equal(steps.unused, 0, "an asset no clip plays repainted");
  // A move keeps the source; a left trim starts it later; a take offset shifts it.
  assert.deepEqual(steps.moved, [0, 4, 200]);
  assert.deepEqual(steps.trimmed, [0.5, 4, 175]);
  assert.deepEqual(steps.offset, { paints: 1, request: [0.75, 4.25, 175] });
  assert.equal(steps.data, 0);
  assert.equal(steps.subscriptions, 0, "dispose left the provider subscribed");
  await page.close();
}

try {
  await studio();
  console.log(
    engine + ": the reference stem draws its phrases at two zoom levels and stays locked",
  );
  await provider();
  console.log(engine + ": late peaks, targeted repaints and source ranges after edits passed");
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
