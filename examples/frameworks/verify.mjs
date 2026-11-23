// The wrapper acceptance suite: the same checks on the vanilla consumer and on
// each framework consumer, built for production by build.mjs.
//
// 1. Lifecycle: mount, update every option, unmount, five times; swap the
//    editor and the renderer; nothing is left behind and the host's editor
//    keeps working. The React consumer also runs in development, where
//    StrictMode mounts every effect twice.
// 2. Steady playback: ten seconds with a fixed viewport, selection and take.
//    The take inspector receives no update and the view uploads no geometry.
// 3. Replay: the same pointer, keyboard and inspector trace ends on the same
//    snapshot, selection, takes, audio spans and hit tests as vanilla.
// 4. Isolation: each bundle holds only its own framework and wrapper.
// 5. Server rendering: the server entry renders the page and subscribes to
//    nothing, with no DOM globals.
//
// Usage (build the packages first):
//   node examples/frameworks/verify.mjs [--consumers vanilla,react] [--renderer webgl2] [--no-build]
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { buildConsumers, consumers } from "./build.mjs";
import { createServerHost, hz } from "./shared/fixture.mjs";

const argument = (name, fallback) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const names = argument("consumers", Object.keys(consumers).join(",")).split(",");
const renderer = argument("renderer", "webgl2");
assert.equal(names[0], "vanilla", "vanilla runs first: it is the reference");
if (!process.argv.includes("--no-build")) await buildConsumers(names);

const dist = new URL("./dist/", import.meta.url);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
};
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (!/^\/[\w-]+\/[\w./-]+$/.test(path) || path.includes("..") || !types[extname(path)]) {
    res.writeHead(404).end();
    return;
  }
  try {
    const data = await readFile(new URL("." + path, dist));
    res.writeHead(200, { "Content-Type": types[extname(path)] }).end(data);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;

const software = process.env.LUMEN_SOFTWARE_GPU === "1";
const browser = await chromium.launch({
  channel: "chromium",
  args: [
    "--autoplay-policy=no-user-gesture-required",
    ...(software ? ["--use-angle=swiftshader"] : []),
  ],
});

// Counts what a consumer can leave behind: pending animation frame callbacks,
// resize observers, live WebGL2 contexts and audio nodes created.
function instrument() {
  const live = { frames: new Set(), observers: new Set(), contexts: new Set(), audio: 0 };
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
  const audio = BaseAudioContext.prototype;
  for (const name of Object.getOwnPropertyNames(audio)) {
    if (!/^create(?!Buffer$|PeriodicWave$)/.test(name)) continue;
    const create = Reflect.get(audio, name);
    if (typeof create !== "function") continue;
    audio[name] = function (...args) {
      live.audio++;
      return Reflect.apply(create, this, args);
    };
  }
}

async function open(name, query = "") {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || /webgl contexts/i.test(message.text()))
      errors.push(message.text());
  });
  await page.addInitScript(instrument);
  await page.goto(`${origin}/${name}/index.html?renderer=${renderer}&${query}`);
  await page.waitForFunction(() => window.consumer);
  await settle(page);
  return { page, errors };
}

// Lets the framework apply a state change, the view paint and lost contexts report.
async function settle(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 30))),
      ),
  );
}

async function set(page, patch) {
  await page.evaluate((p) => window.consumer.controls.set(p), patch);
  await settle(page);
}

async function setOptions(page, options) {
  await page.evaluate((o) => {
    const { controls, hz } = window.consumer;
    // Snap grids are given in seconds here and in ticks to the view.
    const snap = o.snap && { ...o.snap, gridTicks: Math.round(o.snap.gridTicks * hz) };
    controls.set({ options: { ...controls.get().options, ...o, ...(snap ? { snap } : {}) } });
  }, options);
  await settle(page);
}

const counts = (page) =>
  page.evaluate(() => {
    const subscriptions = Object.fromEntries(
      Object.entries(window.consumer.subscriptions()).filter(([, n]) => n),
    );
    return {
      subscriptions,
      frames: window.live.frames.size,
      observers: window.live.observers.size,
      contexts: window.live.contexts.size,
      roots: document.querySelectorAll(".lt").length,
    };
  });

const viewState = (page) =>
  page.evaluate(() => {
    const { view } = window.consumer;
    if (!view) return null;
    const d = view.getDiagnostics();
    return {
      backend: d.backend,
      builds: d.layoutBuilds,
      uploads: d.staticUploads,
      paints: d.staticPaints,
      pixelsPerSecond: view.getViewport().pixelsPerSecond,
      views: window.consumer.views.length,
    };
  });

// --- 1. Lifecycle -------------------------------------------------------------
async function lifecycle(name) {
  const { page, errors } = await open(name, "mount=0");
  // What the host holds by itself: each transport follows its editor.
  await set(page, { panels: false });
  const host = await counts(page);
  await set(page, { panels: true });
  const before = await counts(page);
  assert.equal(before.roots, 0);
  const only = (prefix, c) =>
    Object.fromEntries(Object.entries(c.subscriptions).filter(([key]) => key.startsWith(prefix)));
  const audio = await page.evaluate(() => window.live.audio);
  const depth = await page.evaluate(() => window.consumer.pairs.a.editor.history.undoDepth);
  // StrictMode in development mounts a new component's effects twice, so the
  // first view is disposed at once; a changed editor or renderer mounts once.
  const fresh = name.endsWith("-dev") ? 2 : 1;
  let views = 0;
  for (let round = 0; round < 5; round++) {
    await set(page, { timeline: true });
    const mounted = await viewState(page);
    assert.ok(mounted, `${name}: the view mounted`);
    assert.equal(mounted.views, (views += fresh), `${name}: one view per mount`);
    if (renderer === "webgl2") assert.equal(mounted.backend, "webgl2");
    const live = await counts(page);
    assert.equal(live.roots, 1);
    assert.equal(live.contexts, renderer === "webgl2" ? 1 : 0);
    assert.equal(live.subscriptions.waveforms, 1);
    await page.evaluate(() => {
      window.root = document.querySelector(".lt");
    });
    // Every option changes; the view stays.
    await setOptions(page, {
      pixelsPerSecond: 60,
      snap: { gridTicks: 0.25 },
      labels: { take: "line" },
      waveforms: false,
    });
    const updated = await viewState(page);
    assert.equal(updated.views, views, `${name}: an option update keeps the view`);
    assert.ok(await page.evaluate(() => document.querySelector(".lt") === window.root));
    assert.equal(updated.pixelsPerSecond, 60);
    assert.ok(updated.builds > mounted.builds, `${name}: new options repaint`);
    assert.equal((await counts(page)).subscriptions.waveforms, undefined);
    await setOptions(page, {
      pixelsPerSecond: 40,
      snap: { gridTicks: 0.1 },
      labels: { take: "take" },
      waveforms: true,
    });
    const restored = await viewState(page);
    assert.equal(restored.views, views);
    assert.equal(restored.pixelsPerSecond, 40);
    assert.equal((await counts(page)).subscriptions.waveforms, 1);
    // Equal options again: nothing to do.
    await setOptions(page, { labels: { take: "take" }, snap: { gridTicks: 0.1 } });
    assert.equal(
      (await viewState(page)).builds,
      restored.builds,
      `${name}: equal options cost nothing`,
    );
    await set(page, { timeline: false });
    assert.deepEqual(await counts(page), before, `${name}: unmount ${round + 1} left nothing`);
    assert.equal(await page.evaluate(() => window.consumer.view), null);
  }
  // Another editor and transport, then back.
  await set(page, { timeline: true });
  assert.equal((await viewState(page)).views, (views += fresh));
  await set(page, { pair: "b" });
  const swapped = await counts(page);
  assert.equal((await viewState(page)).views, ++views, `${name}: another editor mounts a view`);
  assert.deepEqual(only("a.", swapped), only("a.", host), `${name}: the first editor is let go`);
  assert.ok(swapped.subscriptions["b.selection"] > 0);
  await set(page, { pair: "a" });
  assert.deepEqual(only("b.", await counts(page)), only("b.", host));
  assert.equal((await viewState(page)).views, ++views);
  // Another renderer mounts a view on that backend.
  await set(page, { renderer: "canvas2d" });
  const canvas = await viewState(page);
  assert.equal(canvas.backend, "canvas2d");
  assert.equal(canvas.views, ++views);
  assert.equal((await counts(page)).contexts, 0);
  await set(page, { renderer });
  assert.equal((await viewState(page)).views, ++views);
  // Everything off: only the host's own subscriptions remain.
  await set(page, { timeline: false, panels: false });
  assert.deepEqual(await counts(page), host, `${name}: the panels let go`);
  assert.equal(await page.evaluate(() => window.live.audio), audio, `${name}: no audio node made`);
  // The host's editor still edits, with its history.
  const edited = await page.evaluate(() => {
    const { editor } = window.consumer.pairs.a;
    const before = editor.history.undoDepth;
    const clip = editor.getSnapshot().clips.find((c) => c.id === "room-1");
    const result = editor.dispatch({ type: "move", clipIds: [clip.id], delta: window.consumer.hz });
    return { ok: result.ok, before, after: editor.history.undoDepth };
  });
  assert.deepEqual(edited, { ok: true, before: depth, after: depth + 1 });
  assert.deepEqual(errors, [], name);
  await page.close();
  return views;
}

// --- 2. Steady playback ---------------------------------------------------------
async function playback(name) {
  const { page, errors } = await open(name);
  await page.evaluate(() => window.consumer.pairs.a.editor.session.select(["voice-a-1"]));
  await settle(page);
  const start = await page.evaluate(() => ({ ...window.consumer.counts }));
  const before = await viewState(page);
  await page.evaluate(async () => {
    await window.consumer.context.resume();
    await window.consumer.pairs.a.transport.play();
  });
  await page.waitForTimeout(10000);
  const presented = await page.evaluate(() => {
    const { transport } = window.consumer.pairs.a;
    const tick = transport.snapshot().presentedTick;
    transport.pause();
    return tick / window.consumer.hz;
  });
  await settle(page);
  const end = await page.evaluate(() => ({ ...window.consumer.counts }));
  const after = await viewState(page);
  assert.ok(presented > 9, `${name}: playback ran (${presented.toFixed(2)} s)`);
  assert.equal(end.inspector - start.inspector, 0, `${name}: the take inspector stayed still`);
  assert.ok(end.clock - start.clock >= 80, `${name}: the clock followed playback`);
  assert.equal(after.uploads - before.uploads, 0, `${name}: no geometry uploads`);
  assert.equal(after.builds - before.builds, 0, `${name}: no layout during playback`);
  assert.deepEqual(errors, [], name);
  await page.close();
  return { clock: end.clock - start.clock, seconds: presented };
}

// --- 3. Replay ------------------------------------------------------------------
async function replay(name) {
  const { page, errors } = await open(name);
  const box = (selector) =>
    page.evaluate((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    }, selector);
  const ruler = await box(".lt-ruler");
  const surface = await box(".lt-surface");
  const pps = 40;
  // Seek to 6 s on the ruler.
  await page.mouse.click(ruler.x + 6 * pps, ruler.y + ruler.height / 2);
  await page.waitForFunction((hz) => {
    const s = window.consumer.pairs.a.transport.snapshot();
    return s.requestedTick === null && Math.abs(s.presentedTick - 6 * hz) < hz / 10;
  }, hz);
  // Trim the end of Ines 2 (5 s to 8.5 s, first row) half a second earlier.
  const y = 6 + 17;
  const edge = await page.evaluate(({ x, y }) => window.consumer.view.hitTest({ x, y }), {
    x: 8.5 * pps - 2,
    y,
  });
  assert.deepEqual([edge.clipId, edge.edge], ["voice-a-1", "right"], name);
  await page.mouse.move(surface.x + 8.5 * pps - 2, surface.y + y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++)
    await page.mouse.move(surface.x + 8.5 * pps - 2 - 2 * step, surface.y + y);
  await page.mouse.up();
  await settle(page);
  // Split at the playhead from the keyboard, then undo the split.
  await page.keyboard.press("s");
  await settle(page);
  const split = await page.evaluate(
    () => window.consumer.pairs.a.editor.getSnapshot().clips.length,
  );
  await page.keyboard.press("Control+z");
  await settle(page);
  // Select Mara 3 (10.5 s to 14 s, second row) and choose its third take.
  await page.mouse.click(surface.x + 12 * pps, surface.y + 46 + y);
  await settle(page);
  await page.click('.inspector [data-take="voice-b-2-take-2"]');
  await settle(page);
  const result = await page.evaluate(() => {
    const { editor, transport } = window.consumer.pairs.a;
    const { view, hz, catalog } = window.consumer;
    const snapshot = editor.getSnapshot();
    const selection = editor.session.getSelection();
    const hits = [];
    for (let x = 2; x < 960; x += 29)
      for (let y = 2; y < 240; y += 17) hits.push(view.hitTest({ x, y }));
    return {
      snapshot: JSON.parse(JSON.stringify(snapshot)),
      selection,
      takes: selection.map((id) => snapshot.clips.find((c) => c.id === id)?.activeTakeId),
      playhead: transport.snapshot().presentedTick,
      spans: JSON.parse(
        JSON.stringify(editor.read().planAudio({ start: 0, end: 40 * hz }, catalog).spans),
      ),
      history: [editor.history.undoDepth, editor.history.redoDepth],
      inspector: document.querySelector(".inspector p").textContent,
      hits,
    };
  });
  result.splitClips = split;
  // The trace did what it says, in every consumer.
  const clip = (id) => result.snapshot.clips.find((c) => c.id === id);
  assert.equal(split, 17, `${name}: the split made a clip`);
  assert.equal(result.snapshot.clips.length, 16, `${name}: undo removed it`);
  assert.equal(clip("voice-a-1").duration, 3 * hz, `${name}: the trim took half a second`);
  assert.equal(clip("voice-b-2").activeTakeId, "voice-b-2-take-2", `${name}: the take changed`);
  assert.deepEqual(result.selection, ["voice-b-2"]);
  assert.deepEqual(result.history, [2, 0]);
  assert.equal(result.playhead, 6 * hz);
  assert.equal(result.inspector, "Active: Take 3");
  assert.deepEqual(errors, [], name);
  await page.close();
  return result;
}

// --- 4. Isolation -----------------------------------------------------------------
const frameworks = {
  react: /^node_modules\/(react|react-dom|scheduler)\//,
  svelte: /^node_modules\/svelte\//,
  solid: /^node_modules\/(solid-js|@solidjs)\//,
  vue: /^node_modules\/(vue|@vue)\//,
};
async function isolation(name) {
  const modules = JSON.parse(await readFile(new URL(name + "/modules.json", dist), "utf8"));
  for (const [framework, pattern] of Object.entries(frameworks)) {
    const own = framework === name;
    const library = modules.some((m) => pattern.test(m));
    const wrapper = modules.some((m) => m.startsWith(`packages/${framework}/`));
    assert.equal(library, own, `${name}: ${framework} ${own ? "missing" : "bundled"}`);
    assert.equal(
      wrapper,
      own,
      `${name}: @lumen-timeline/${framework} ${own ? "missing" : "bundled"}`,
    );
  }
  assert.ok(!modules.some((m) => /\/src\/[\w-]+\.ts$/.test(m)), `${name}: package sources bundled`);
  return modules.length;
}

// --- 5. Server rendering ----------------------------------------------------------
async function serverRender(name) {
  if (!consumers[name].server) return null;
  assert.equal(typeof globalThis.window, "undefined");
  assert.equal(typeof globalThis.document, "undefined");
  const entry = consumers[name].server.replace(/\.\w+$/, ".js");
  const { render } = await import(
    pathToFileURL(fileURLToPath(new URL(`${name}-server/${entry}`, dist)))
  );
  const host = createServerHost();
  const html = await render(host);
  assert.match(html, /class="timeline"/, `${name}: the view's element`);
  assert.match(html, /Ines 1/, `${name}: the inspector's clip`);
  assert.match(html, /Take 3/, `${name}: the inspector's takes`);
  assert.doesNotMatch(html, /class="lt"/, `${name}: no view on the server`);
  assert.deepEqual(
    Object.entries(host.subscriptions()).filter(([, n]) => n),
    [],
    `${name}: nothing subscribed on the server`,
  );
  return html.length;
}

try {
  const reference = {};
  for (const name of names) {
    const lifecycles = [await lifecycle(name)];
    if (consumers[name].development) lifecycles.push(await lifecycle(name + "-dev"));
    const steady = await playback(name);
    const trace = await replay(name);
    if (name === "vanilla") Object.assign(reference, trace);
    else
      for (const key of Object.keys(reference))
        assert.deepEqual(trace[key], reference[key], `${name}: replay ${key} differs from vanilla`);
    const modules = await isolation(name);
    const rendered = await serverRender(name);
    console.log(
      `${name}: lifecycle (${lifecycles.map((v) => v + " views").join(", ")}), ` +
        `playback ${steady.seconds.toFixed(1)} s with 0 inspector updates and ${steady.clock} clock updates, ` +
        `replay matched vanilla (${trace.hits.length} hits, ${trace.spans.length} spans), ` +
        `${modules} modules isolated` +
        (rendered === null ? "" : `, server render ${rendered} bytes with no subscription`),
    );
  }
} finally {
  await browser.close();
  server.close();
  server.closeAllConnections();
}
