// The view at the roadmap's scale: two hours, 40 tracks and 20,000 clips at
// 1440 × 900 CSS pixels and DPR 2, 12 rows visible. The layout holds exactly the
// clips of visible rows in the visible range, at any zoom. A pan leaves the
// headers and the clip navigator alone and measures no layout, a vertical
// scroll moves the headers and leaves the ruler alone, an edit touches only
// its own options, a waveform notification repaints once and then once a
// frame, labels keep drawing after the label atlas fills, and hit tests read
// the layout. Usage:
// node examples/vanilla/verify-scale.mjs [chromium|firefox|webkit] [renderer]   (build first)
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { pixels } from "./pixels.mjs";
import { serve } from "./server.mjs";

const engine = process.argv[2] ?? "chromium";
const renderer = process.argv[3];
const server = await serve();
// Chromium runs in its new headless mode, where a WebGPU canvas survives being shown.
const browser = await { chromium, firefox, webkit }[engine].launch(
  engine === "chromium" ? { channel: "chromium", args: ["--enable-unsafe-webgpu"] } : {},
);
const errors = [];

try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url + "/examples/vanilla/lab.html");
  await page.addStyleTag({ content: ".lt-scroll { height: 552px; }" });
  await page.evaluate(async (backend) => {
    const { createEditor, TICKS_PER_SECOND: hz } = await import("@lumen-timeline/core");
    const { mountTimeline } = await import("@lumen-timeline/timeline");
    const slot = 14.4 * hz;
    const tracks = Array.from({ length: 40 }, (_, i) => ({
      id: "t" + i,
      name: "Track " + (i + 1),
      overlap: "exclusive",
    }));
    const clips = [];
    const takes = [];
    for (let t = 0; t < 40; t++)
      for (let k = 0; k < 500; k++) {
        const id = `c${t}-${k}`;
        clips.push({
          id,
          name: `Scene ${t + 1}.${k + 1} — the tide returns`,
          trackId: "t" + t,
          kind: "audio",
          start: k * slot,
          duration: (10 + (k % 4)) * hz,
          contentIn: 0,
          takeIds: ["k" + id],
          activeTakeId: "k" + id,
        });
        takes.push({
          id: "k" + id,
          assetId: "a" + (k % 8),
          streamId: "mono",
          sourceAtContentZero: 0,
        });
      }
    const editor = createEditor({
      project: { schemaVersion: 1, duration: 7200 * hz, tracks, clips, takes },
    });
    const listeners = new Set();
    const waveforms = {
      peaks: ({ buckets }) => {
        const out = new Float32Array(2 * buckets);
        for (let i = 0; i < buckets; i++) {
          out[2 * i] = -0.5 - 0.4 * Math.sin(i / 3);
          out[2 * i + 1] = 0.5 + 0.4 * Math.sin(i / 5);
        }
        return out;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const transport = {
      snapshot: () => ({ playing: false, presentedTick: 0, requestedTick: null }),
      subscribe: () => () => {},
      play() {},
      pause() {},
      seek() {},
    };
    const view = mountTimeline(document.querySelector("#lab"), {
      editor,
      transport,
      waveforms,
      pixelsPerSecond: 20,
      ...(backend ? { renderer: backend } : {}),
    });
    window.scale = { editor, view, notify: (id) => listeners.forEach((l) => l(id)) };
  }, renderer);
  const run = (fn, arg) => page.evaluate(fn, arg);
  // WebGPU starts once its device is ready.
  if (renderer)
    await page.waitForFunction((r) => window.scale.view.getDiagnostics().backend === r, renderer, {
      timeout: 15000,
    });
  // The clips a layout must hold: visible tracks, read from the headers, and
  // clips that reach at least part of a pixel inside the range.
  const expected = () =>
    run(() => {
      const { editor, view } = window.scale;
      const { startTick, pixelsPerSecond } = view.getViewport();
      const width = document.querySelector(".lt-surface").clientWidth;
      const end = startTick + Math.round((width * 282240000) / pixelsPerSecond);
      const names = new Set([...document.querySelectorAll(".lt-label")].map((l) => l.textContent));
      const tracks = new Set(
        editor
          .getSnapshot()
          .tracks.filter((t) => names.has(t.name))
          .map((t) => t.id),
      );
      const px = (tick) => ((tick - startTick) / 282240000) * pixelsPerSecond;
      return editor
        .getSnapshot()
        .clips.filter(
          (c) =>
            tracks.has(c.trackId) &&
            c.start < end + 1 &&
            c.start + c.duration > startTick &&
            Math.min(width, px(c.start + c.duration)) > Math.max(0, px(c.start)),
        ).length;
    });
  const diagnostics = () => run(() => window.scale.view.getDiagnostics());

  // Layout follows the view at three zoom levels.
  const zooms = [];
  for (const [start, pps] of [
    [3600, 20],
    [0, 1280 / 7200],
    [1800, 600],
  ]) {
    await run(
      ([s, p]) => window.scale.view.setViewport({ startTick: s * 282240000, pixelsPerSecond: p }),
      [start, pps],
    );
    const laid = (await diagnostics()).visibleClips;
    assert.equal(laid, await expected(), `zoom ${pps}`);
    zooms.push(laid);
  }
  // Asked for nothing, the view draws through WebGL2 on a hardware GPU and Canvas 2D otherwise.
  const drawn = await diagnostics();
  if (renderer) assert.equal(drawn.backend, renderer);
  else
    assert.ok(
      drawn.backend === "webgl2" || (drawn.backend === "canvas2d" && drawn.fallback),
      JSON.stringify(drawn),
    );
  assert.ok(
    zooms[1] >= 12 * 499 && zooms[1] < 20000,
    "zoomed out to the whole project: " + zooms[1],
  );
  console.log(
    engine + ": the layout held exactly the visible clips at three zooms: " + zooms.join(", "),
  );

  // Pans leave the headers and the navigator alone.
  const pans = await run(async () => {
    const { view } = window.scale;
    view.setViewport({ startTick: 100 * 282240000, pixelsPerSecond: 40 });
    const records = [];
    const watch = new MutationObserver((list) => records.push(...list));
    for (const selector of [".lt-headers", "select[aria-label='Clip navigator']"])
      watch.observe(document.querySelector(selector), {
        childList: true,
        subtree: true,
        characterData: true,
      });
    const times = [];
    for (let i = 0; i < 60; i++) {
      const t0 = performance.now();
      view.setViewport({ startTick: (100 + i * 7) * 282240000 });
      times.push(performance.now() - t0);
    }
    await Promise.resolve();
    watch.disconnect();
    times.sort((a, b) => a - b);
    return { records: records.length, median: times[30], p95: times[57] };
  });
  assert.equal(pans.records, 0, "a pan changed the headers or the navigator");
  console.log(
    `${engine}: 60 pans left headers and navigator untouched (median ${pans.median.toFixed(2)} ms, p95 ${pans.p95.toFixed(2)} ms)`,
  );

  // A pan measures no layout: before, each one made the browser lay the page
  // out again in the middle of its script.
  if (engine === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const layouts = async () =>
      (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "LayoutCount")
        .value;
    const settle = () =>
      run(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await settle();
    const before = await layouts();
    await run(() => {
      for (let i = 0; i < 60; i++)
        window.scale.view.setViewport({ startTick: (100 + i * 7) * 282240000 });
    });
    await settle();
    const laidOut = (await layouts()) - before;
    // The frames around the pans may lay out what they changed, once each.
    assert.ok(laidOut <= 3, `60 pans laid the page out ${laidOut} times`);
    console.log(
      `${engine}: 60 pans in one task measured no layout (${laidOut} in the frames around them)`,
    );
  }

  // A vertical scroll moves the header list. A header changes only where a row
  // comes into view or leaves it, and the ruler is not drawn again.
  const scrolled = await run(async () => {
    const scroller = document.querySelector(".lt-scroll");
    const list = document.querySelector(".lt-headers");
    const frame = () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const home = scroller.scrollTop;
    scroller.scrollTop = 0;
    await frame();
    const records = [];
    const watch = new MutationObserver((changes) => records.push(...changes));
    watch.observe(list, { childList: true });
    // The ruler's own context, which the view draws its time labels through.
    const ruler = document.querySelector(".lt-ruler").getContext("2d");
    let ruled = 0;
    ruler.fillText = (...args) => {
      ruled++;
      CanvasRenderingContext2D.prototype.fillText.apply(ruler, args);
    };
    const paints = () => window.scale.view.getDiagnostics().staticPaints;
    const before = paints();
    const steps = [];
    // Row 13 comes into view; nothing changes; row 1 leaves as row 14 comes in.
    for (const top of [20, 30, 76]) {
      scroller.scrollTop = top;
      await frame();
      await Promise.resolve();
      steps.push([
        records.reduce((n, r) => n + r.addedNodes.length, 0),
        records.reduce((n, r) => n + r.removedNodes.length, 0),
      ]);
    }
    watch.disconnect();
    const scrolls = { ruled, paints: paints() - before };
    // A paint at the same viewport does draw the ruler, so the count above is not blind.
    window.scale.view.setViewport({});
    const control = ruled;
    delete ruler.fillText;
    const pin = document.querySelector(".lt-pin").getBoundingClientRect();
    const out = {
      steps,
      ...scrolls,
      control,
      names: [...list.children].map((label) => label.textContent),
      tops: [...list.children].map((label) => label.getBoundingClientRect().top - pin.top),
    };
    scroller.scrollTop = home;
    await frame();
    return out;
  });
  assert.deepEqual(
    [scrolled.steps, scrolled.ruled, scrolled.paints],
    [
      [
        [1, 0],
        [1, 0],
        [2, 1],
      ],
      0,
      3,
    ],
    JSON.stringify(scrolled),
  );
  assert.ok(scrolled.control > 0, "the ruler drew no label when the viewport was set");
  assert.deepEqual(
    scrolled.names,
    Array.from({ length: 13 }, (_, i) => "Track " + (i + 2)),
  );
  assert.deepEqual(
    scrolled.tops,
    Array.from({ length: 13 }, (_, i) => (i + 1) * 46 - 76),
  );
  console.log(
    engine + ": three scrolls changed two headers, in row order, and left the ruler alone",
  );

  // A split adds one option, in project order, and its undo removes it.
  const edit = await run(async () => {
    const { editor, view } = window.scale;
    const { commands } = await import("@lumen-timeline/core");
    const select = document.querySelector("select[aria-label='Clip navigator']");
    const records = [];
    const watch = new MutationObserver((list) => records.push(...list));
    watch.observe(select, { childList: true, subtree: true, characterData: true });
    const clip = editor.getSnapshot().clips.find((c) => c.id === "c3-20");
    const before = view.getDiagnostics();
    const t0 = performance.now();
    const result = editor.dispatch(
      commands.splitClip({ clipId: clip.id, at: clip.start + 282240000 * 5 }),
    );
    const splitMs = performance.now() - t0;
    await Promise.resolve();
    const added = records.reduce((n, r) => n + r.addedNodes.length, 0);
    const removed = records.reduce((n, r) => n + r.removedNodes.length, 0);
    const order = [...select.options].slice(1).map((o) => o.value);
    const same =
      order.join() ===
      editor
        .getSnapshot()
        .clips.map((c) => c.id)
        .join();
    records.length = 0;
    editor.history.undo();
    await Promise.resolve();
    const undone = {
      added: records.reduce((n, r) => n + r.addedNodes.length, 0),
      removed: records.reduce((n, r) => n + r.removedNodes.length, 0),
    };
    watch.disconnect();
    return {
      ok: result.ok,
      added,
      removed,
      same,
      undone,
      paints: view.getDiagnostics().staticPaints - before.staticPaints,
      splitMs,
      options: select.options.length,
    };
  });
  assert.deepEqual(
    [edit.ok, edit.added, edit.removed, edit.same, edit.undone],
    [true, 1, 0, true, { added: 0, removed: 1 }],
  );
  assert.equal(edit.options, 20001);
  console.log(
    `${engine}: a split and its undo touched one navigator option (split ${edit.splitMs.toFixed(2)} ms)`,
  );

  // A move changes no option, so the navigator's value is left alone: the
  // browser finds a value by walking all 20,001 options.
  const chosen = await run(async () => {
    const { editor } = window.scale;
    const { commands } = await import("@lumen-timeline/core");
    const select = document.querySelector("select[aria-label='Clip navigator']");
    const value = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    let sets = 0;
    Object.defineProperty(select, "value", {
      configurable: true,
      get: () => value.get.call(select),
      set(next) {
        sets++;
        value.set.call(select, next);
      },
    });
    const counts = [];
    editor.session.select(["c3-21"]);
    counts.push(sets);
    editor.dispatch(commands.moveClips({ clipIds: ["c3-21"], delta: 282240000 }));
    editor.history.undo();
    counts.push(sets);
    const clip = editor.getSnapshot().clips.find((c) => c.id === "c3-21");
    editor.dispatch(commands.splitClip({ clipId: clip.id, at: clip.start + 282240000 }));
    counts.push(sets);
    editor.history.undo();
    counts.push(sets);
    const shown = select.value;
    delete select.value;
    editor.session.select([]);
    return { counts, shown };
  });
  // Once for the selection, never for the move or its undo, once each for the split and its undo.
  assert.deepEqual(chosen, { counts: [1, 1, 2, 3], shown: "c3-21" });
  console.log(engine + ": a move left the navigator's value alone, and a split set it once");

  // One notification repaints at once; a burst repaints once more, a frame later.
  const notes = await run(async () => {
    const { view, notify } = window.scale;
    const paints = () => view.getDiagnostics().staticPaints;
    const frame = () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await frame();
    let before = paints();
    notify("a3");
    const first = paints() - before;
    await frame();
    before = paints();
    for (let i = 0; i < 10; i++) notify("a" + (i % 8));
    const burstNow = paints() - before;
    await frame();
    await frame();
    const burst = paints() - before;
    before = paints();
    notify("missing");
    await frame();
    return { first, burstNow, burst, unused: paints() - before };
  });
  assert.deepEqual(notes, { first: 1, burstNow: 1, burst: 2, unused: 0 });
  console.log(engine + ": a notification repainted at once, and a burst of ten painted twice");

  // A paint of every row shows the peaks that arrived, so no repaint follows it.
  const settled = await run(async () => {
    const { view, notify } = window.scale;
    const paints = () => view.getDiagnostics().staticPaints;
    const frame = () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await frame();
    const before = paints();
    // The first paints at once, the second waits for the next frame.
    notify("a3");
    notify("a4");
    view.setViewport({});
    const now = paints() - before;
    await frame();
    await frame();
    return { now, later: paints() - before };
  });
  assert.deepEqual(settled, { now: 2, later: 2 });
  console.log(engine + ": a paint of every row left no waveform repaint behind");

  // Labels keep drawing after the atlas fills: pan across many distinct names.
  const cycled = await run(async () => {
    const { view } = window.scale;
    view.setViewport({ startTick: 0, pixelsPerSecond: 40 });
    for (let s = 0; s < 7000; s += 32) view.setViewport({ startTick: s * 282240000 });
    return view.getDiagnostics().labelsRasterized;
  });
  assert.ok(cycled > 600, "only " + cycled + " labels were rasterized");
  // The clip at the left edge of the first row shows its name in light text.
  const box = await run(() => {
    const { view, editor } = window.scale;
    const { startTick, pixelsPerSecond } = view.getViewport();
    const surface = document.querySelector(".lt-surface").getBoundingClientRect();
    const scroll = document.querySelector(".lt-scroll").scrollTop;
    const row = Math.ceil(scroll / 46);
    const clip = editor
      .getSnapshot()
      .clips.find(
        (c) =>
          c.trackId === "t" + row && c.start >= startTick && c.start - startTick < 400 * 282240000,
      );
    const x = ((clip.start - startTick) / 282240000) * pixelsPerSecond;
    return { x: surface.left + x + 9, y: surface.top + row * 46 - scroll + 6 + 8, id: clip.id };
  });
  const text = await pixels(page, { x: box.x, y: box.y, width: 60, height: 14 });
  const light = text.data.reduce(
    (n, v, i) => (i % 4 === 0 && v > 200 && text.data[i + 1] > 200 ? n + 1 : n),
    0,
  );
  assert.ok(light > 20, `the label of ${box.id} drew ${light} light pixels`);
  console.log(engine + `: ${cycled} labels rasterized across the project, and labels still draw`);

  // Hit tests read the layout.
  const hits = await run(() => {
    const { view, editor } = window.scale;
    view.setViewport({ startTick: 0, pixelsPerSecond: 40 });
    const scroll = document.querySelector(".lt-scroll").scrollTop;
    const row = Math.ceil(scroll / 46);
    const y = row * 46 - scroll + 6 + 15;
    const clip = editor.getSnapshot().clips.find((c) => c.id === `c${row}-1`);
    const x = (clip.start / 282240000) * 40;
    return {
      body: view.hitTest({ x: x + 100, y }),
      left: view.hitTest({ x: x + 2, y }),
      gap: view.hitTest({ x: x + (clip.duration / 282240000) * 40 + 20, y }),
      outside: view.hitTest({ x: -1, y }),
      id: clip.id,
      track: clip.trackId,
    };
  });
  assert.deepEqual(
    [
      hits.body.clipId,
      hits.body.edge,
      hits.body.trackId,
      hits.left.edge,
      hits.gap.clipId,
      hits.gap.trackId,
      hits.outside,
    ],
    [hits.id, "move", hits.track, "left", null, hits.track, null],
  );
  console.log(engine + ": hit tests found the clip, its handle, empty track space and the outside");
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
