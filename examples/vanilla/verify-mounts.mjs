// A mounted view takes new options without a new mount, and twenty mounts in a
// row leave nothing behind. Equal options repaint nothing; new caption words
// and a new waveform provider repaint the clips; new snap settings change the
// next keyboard move; a host that passes the same viewport values again keeps
// the user's pan and zoom; invalid settings change nothing. Each dispose
// releases its WebGL2 context, observers, animation frame callbacks and every
// subscription to the editor, the transport and the waveform provider. Usage:
// node examples/vanilla/verify-mounts.mjs [renderer]   (build first)
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { serve } from "./server.mjs";

const renderer = process.argv[2] ?? "webgl2";
const server = await serve();
const software = process.env.LUMEN_SOFTWARE_GPU === "1";
const browser = await chromium.launch({
  channel: "chromium",
  args: software ? ["--use-angle=swiftshader"] : [],
});
const errors = [];

try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 700 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (/too many active webgl contexts/i.test(message.text())) errors.push(message.text());
  });
  // Count what a view can leave behind: pending animation frame callbacks,
  // resize observers and WebGL2 contexts that were never lost.
  await page.addInitScript(() => {
    const live = { frames: new Set(), observers: new Set(), contexts: new Set() };
    window.live = live;
    const request = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      const id = request((time) => {
        live.frames.delete(id);
        callback(time);
      });
      live.frames.add(id);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      live.frames.delete(id);
      cancel(id);
    };
    const Observer = window.ResizeObserver;
    window.ResizeObserver = class extends Observer {
      observe(...args) {
        live.observers.add(this);
        return super.observe(...args);
      }
      disconnect() {
        live.observers.delete(this);
        return super.disconnect();
      }
    };
    const getContext = Reflect.get(HTMLCanvasElement.prototype, "getContext");
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      const context = Reflect.apply(getContext, this, [type, ...rest]);
      if (type === "webgl2" && context && !live.contexts.has(context)) {
        live.contexts.add(context);
        this.addEventListener("webglcontextlost", () => live.contexts.delete(context), {
          once: true,
        });
      }
      return context;
    };
  });
  await page.goto(server.url + "/examples/vanilla/lab.html");
  await page.addStyleTag({ content: ".lt-scroll { height: 240px; }" });
  await page.evaluate(async (backend) => {
    const { commands, createEditor, TICKS_PER_SECOND: hz } = await import("@lumen-timeline/core");
    const { mountTimeline } = await import("@lumen-timeline/timeline");
    const clips = [];
    const takes = [];
    for (let t = 0; t < 3; t++)
      for (let k = 0; k < 8; k++) {
        const id = "c" + t + k;
        clips.push({
          id,
          name: "Line " + t + "." + k,
          trackId: "t" + t,
          kind: "audio",
          start: k * 4 * hz,
          duration: 3 * hz,
          contentIn: 0,
          takeIds: ["k" + id, "j" + id],
          activeTakeId: "k" + id,
        });
        for (const prefix of ["k", "j"])
          takes.push({ id: prefix + id, assetId: "a", streamId: "s", sourceAtContentZero: 0 });
      }
    const editor = createEditor({
      project: {
        schemaVersion: 1,
        duration: 60 * hz,
        tracks: [0, 1, 2].map((t) => ({ id: "t" + t, name: "Track " + t })),
        clips,
        takes,
      },
    });
    // Every subscription a view can hold, counted while active.
    const subscriptions = new Map();
    const counted =
      (name, subscribe) =>
      (...args) => {
        const off = subscribe(...args);
        subscriptions.set(name, (subscriptions.get(name) ?? 0) + 1);
        let on = true;
        return () => {
          if (on) subscriptions.set(name, subscriptions.get(name) - 1);
          on = false;
          return off();
        };
      };
    const session = Object.create(editor.session, {
      subscribeSelection: {
        value: counted("selection", (listen) => editor.session.subscribeSelection(listen)),
      },
    });
    const history = Object.create(editor.history, {
      subscribe: { value: counted("history", (listen) => editor.history.subscribe(listen)) },
    });
    const host = {
      ...editor,
      session,
      history,
      subscribe: counted("document", (select, listen) => editor.subscribe(select, listen)),
    };
    let state = { playing: false, presentedTick: 0, requestedTick: null };
    const transport = {
      snapshot: () => state,
      subscribe: counted("transport", () => () => true),
      play() {},
      pause() {},
      seek(tick) {
        state = { ...state, presentedTick: tick };
      },
    };
    const provider = (name) => {
      const p = {
        asked: 0,
        peaks(request) {
          p.asked++;
          return new Float32Array(request.buckets * 2).fill(0.5);
        },
        subscribe: counted(name, () => () => true),
      };
      return p;
    };
    window.lab = {
      hz,
      commands,
      editor,
      host,
      transport,
      subscriptions,
      provider,
      backend,
      mount: (options = {}) =>
        mountTimeline(document.querySelector("#lab"), {
          editor: host,
          transport,
          renderer: backend,
          pixelsPerSecond: 40,
          ...options,
        }),
      counts: () => ({
        ...Object.fromEntries(subscriptions),
        frames: window.live.frames.size,
        observers: window.live.observers.size,
        contexts: window.live.contexts.size,
        roots: document.querySelectorAll(".lt").length,
      }),
    };
  }, renderer);
  const frames = (n = 2) =>
    page.evaluate(
      (count) =>
        new Promise((resolve) => {
          let left = count;
          const step = () => (--left ? requestAnimationFrame(step) : resolve());
          requestAnimationFrame(step);
        }),
      n,
    );
  const before = await page.evaluate(() => window.lab.counts());

  // --- Options on a mounted view --------------------------------------------
  await page.evaluate(() => {
    const { lab } = window;
    lab.first = lab.provider("waveforms");
    lab.view = lab.mount({ snap: { gridTicks: lab.hz / 10 }, waveforms: lab.first });
    lab.root = document.querySelector(".lt");
  });
  await frames();
  const equal = await page.evaluate(() => {
    const { lab } = window;
    const builds = lab.view.getDiagnostics().layoutBuilds;
    // What a framework passes on each render: new objects with the same values.
    lab.view.update({
      snap: { gridTicks: lab.hz / 10 },
      labels: { take: "take" },
      waveforms: lab.first,
      pixelsPerSecond: 40,
      startTick: undefined,
    });
    return {
      builds: lab.view.getDiagnostics().layoutBuilds - builds,
      sameRoot: document.querySelector(".lt") === lab.root,
    };
  });
  assert.deepEqual(equal, { builds: 0, sameRoot: true }, "equal options repaint nothing");

  const words = await page.evaluate(() => {
    const { lab } = window;
    const before = lab.view.getDiagnostics();
    lab.view.update({ labels: { take: "line" } });
    const after = lab.view.getDiagnostics();
    return {
      builds: after.layoutBuilds - before.layoutBuilds,
      rasterized: after.labelsRasterized - before.labelsRasterized,
    };
  });
  assert.equal(words.builds, 1, "new caption words lay the clips out again");
  assert.ok(words.rasterized > 0, "new caption words draw new labels");

  // A snap grid of a quarter second moves the selected clip by that much.
  const nudged = await page.evaluate(() => {
    const { lab } = window;
    lab.view.update({ snap: { gridTicks: lab.hz / 4 } });
    lab.editor.session.select(["c00"]);
    const surface = document.querySelector(".lt-surface");
    surface.focus();
    surface.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    return lab.editor.getSnapshot().clips.find((c) => c.id === "c00").start / lab.hz;
  });
  assert.equal(nudged, 0.25, "the keyboard moves by the new snap grid");

  const invalid = await page.evaluate(() => {
    const { lab } = window;
    const builds = lab.view.getDiagnostics().layoutBuilds;
    let error = null;
    try {
      lab.view.update({ labels: { take: "cue" }, snap: { gridTicks: -1 } });
    } catch (e) {
      error = e.name;
    }
    return { error, builds: lab.view.getDiagnostics().layoutBuilds - builds };
  });
  assert.deepEqual(invalid, { error: "RangeError", builds: 0 }, "invalid settings change nothing");

  const viewport = await page.evaluate(() => {
    const { lab } = window;
    // The user pans and zooms, then the host renders again with its values.
    lab.view.setViewport({ startTick: 5 * lab.hz, pixelsPerSecond: 80 });
    lab.view.update({ pixelsPerSecond: 40, startTick: undefined });
    const kept = lab.view.getViewport();
    lab.view.update({ pixelsPerSecond: 20 });
    const zoomed = lab.view.getViewport();
    lab.view.update({ startTick: 2 * lab.hz });
    const panned = lab.view.getViewport();
    return {
      kept: [kept.startTick / lab.hz, kept.pixelsPerSecond],
      zoomed: zoomed.pixelsPerSecond,
      panned: panned.startTick / lab.hz,
    };
  });
  assert.deepEqual(viewport, { kept: [5, 80], zoomed: 20, panned: 2 });

  const swapped = await page.evaluate(() => {
    const { lab } = window;
    lab.second = lab.provider("replacement");
    const asked = lab.second.asked;
    const builds = lab.view.getDiagnostics().layoutBuilds;
    lab.view.update({ waveforms: lab.second });
    return {
      builds: lab.view.getDiagnostics().layoutBuilds - builds,
      asked: lab.second.asked - asked,
      old: lab.subscriptions.get("waveforms"),
      replacement: lab.subscriptions.get("replacement"),
      sameRoot: document.querySelector(".lt") === lab.root,
    };
  });
  assert.equal(swapped.builds, 1);
  assert.ok(swapped.asked > 0, "the new provider draws the waveforms");
  assert.equal(swapped.old, 0, "the old provider's subscription ends");
  assert.equal(swapped.replacement, 1);
  assert.ok(swapped.sameRoot);
  await page.evaluate(() => {
    window.lab.view.update({ waveforms: undefined });
    window.lab.view.dispose();
    window.lab.view.update({ labels: { take: "after" } });
  });
  await frames();
  assert.deepEqual(await page.evaluate(() => window.lab.counts()), {
    ...before,
    document: 0,
    selection: 0,
    history: 0,
    transport: 0,
    waveforms: 0,
    replacement: 0,
  });

  // --- Twenty mounts in a row ------------------------------------------------
  const mounts = 20;
  let peak = 0;
  for (let i = 0; i < mounts; i++) {
    await page.evaluate(() => {
      const { lab } = window;
      lab.view = lab.mount({ waveforms: lab.first });
    });
    await frames();
    const mounted = await page.evaluate(() => ({
      ...window.lab.counts(),
      backend: window.lab.view.getDiagnostics().backend,
    }));
    if (renderer === "webgl2") assert.equal(mounted.backend, "webgl2");
    peak = Math.max(peak, mounted.contexts);
    await page.evaluate(() => window.lab.view.dispose());
    await frames();
    const left = await page.evaluate(() => window.lab.counts());
    assert.deepEqual(
      left,
      {
        ...before,
        document: 0,
        selection: 0,
        history: 0,
        transport: 0,
        waveforms: 0,
        replacement: 0,
      },
      `mount ${i + 1} left nothing behind`,
    );
  }
  // The host's editor still edits, with its history.
  const edited = await page.evaluate(() => {
    const { lab } = window;
    const depth = lab.editor.history.undoDepth;
    const result = lab.editor.dispatch(lab.commands.moveClips({ clipIds: ["c10"], delta: lab.hz }));
    return { ok: result.ok, depth, after: lab.editor.history.undoDepth };
  });
  assert.deepEqual(edited, { ok: true, depth: 1, after: 2 });
  assert.deepEqual(errors, []);
  console.log(
    `${renderer}: updates kept one view; ${mounts} mounts left no subscription, observer, ` +
      `frame callback or WebGL2 context (at most ${peak} live while mounted)`,
  );
} finally {
  await browser.close();
  await server.close();
}
