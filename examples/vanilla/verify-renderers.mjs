// The same fixtures on Canvas 2D, WebGL2 and WebGPU: identical hit tests over a
// grid, matching pixels inside clips, and the same project after one pointer and
// keyboard edit trace. Steady playback uploads no geometry. A GPU device lost
// during playback and during a drag leaves the view drawing on the next
// backend, at the same viewport and selection, with every edit kept, and the
// view returns to its backend when the device comes back. Usage:
// node examples/vanilla/verify-renderers.mjs [chromium|webkit]   (build first)
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { serve } from "./server.mjs";

const engine = process.argv[2] ?? "chromium";
const backends = (process.argv[3] ?? "canvas2d,webgl2,webgpu").split(",");
const server = await serve();
// Chromium runs in its new headless mode: the old headless shell loses a WebGPU
// device on SwiftShader as soon as its canvas is shown. LUMEN_SOFTWARE_GPU=1 forces
// SwiftShader for WebGL2 and WebGPU, as on a CI machine without a GPU.
const software = process.env.LUMEN_SOFTWARE_GPU === "1";
const browser = await { chromium, firefox, webkit }[engine].launch(
  engine === "chromium"
    ? {
        channel: "chromium",
        args: [
          "--enable-unsafe-webgpu",
          ...(software ? ["--use-angle=swiftshader", "--use-webgpu-adapter=swiftshader"] : []),
        ],
      }
    : {},
);
const errors = [];
const hz = 282240000;
const pps = 40;

async function mount(renderer) {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 800 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (error) => errors.push(error.message));
  // Keep each WebGPU device, so the trace can lose it.
  await page.addInitScript(() => {
    window.devices = [];
    const adapter = globalThis.GPUAdapter?.prototype;
    if (!adapter) return;
    const request = Reflect.get(adapter, "requestDevice");
    adapter.requestDevice = async function (...args) {
      const device = await request.apply(this, args);
      window.devices.push(device);
      return device;
    };
  });
  await page.goto(server.url + "/examples/vanilla/lab.html");
  await page.addStyleTag({ content: ".lt-scroll { height: 300px; }" });
  await page.evaluate(async (renderer) => {
    const { createEditor, TICKS_PER_SECOND: hz } = await import("@lumen-timeline/core");
    const { mountTimeline } = await import("@lumen-timeline/timeline");
    const names = ["Dialogue", "Keeper", "Music", "Room tone", "Effects", "Guide"];
    const clips = [];
    const takes = [];
    names.forEach((name, t) => {
      // Six clips in view at first, and six more past it for a pan.
      for (let k = 0; k < 12; k++) {
        const id = String.fromCharCode(97 + t) + k;
        // Even clips play a take with a waveform and a caption; odd clips are plain.
        const take = k % 2 === 0 ? { takeIds: ["k" + id], activeTakeId: "k" + id } : {};
        clips.push({
          id,
          name: name + " " + (k + 1),
          trackId: "t" + t,
          kind: "audio",
          start: Math.round((0.5 + 4 * k) * hz),
          duration: 3 * hz,
          contentIn: 0,
          ...take,
        });
        if (k % 2 === 0)
          takes.push({
            id: "k" + id,
            assetId: "a" + t,
            streamId: "mono",
            sourceAtContentZero: 0,
            label: "Take",
          });
      }
    });
    const editor = createEditor({
      project: {
        schemaVersion: 1,
        duration: 60 * hz,
        tracks: names.map((name, t) => ({ id: "t" + t, name, overlap: "exclusive" })),
        clips,
        takes,
      },
    });
    const waveforms = {
      peaks: ({ start, buckets, end }) => {
        const out = new Float32Array(2 * buckets);
        for (let i = 0; i < buckets; i++) {
          const s = (start + ((end - start) * i) / buckets) / hz;
          out[2 * i] = -0.3 - 0.5 * Math.abs(Math.sin(s * 3));
          out[2 * i + 1] = 0.3 + 0.5 * Math.abs(Math.sin(s * 2));
        }
        return out;
      },
    };
    // A transport that advances with animation frames while playing.
    const state = { playing: false, presentedTick: 0, requestedTick: null };
    const listeners = new Set();
    const emit = () => listeners.forEach((l) => l({ ...state }));
    let last = 0;
    const advance = (t) => {
      if (!state.playing) return;
      state.presentedTick += Math.round(((t - last) / 1000) * hz);
      last = t;
      emit();
      requestAnimationFrame(advance);
    };
    const transport = {
      snapshot: () => ({ ...state }),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      play() {
        state.playing = true;
        last = performance.now();
        requestAnimationFrame(advance);
        emit();
      },
      pause() {
        state.playing = false;
        emit();
      },
      seek(tick) {
        state.presentedTick = tick;
        emit();
      },
    };
    const view = mountTimeline(document.querySelector("#lab"), {
      editor,
      transport,
      waveforms,
      pixelsPerSecond: 40,
      snap: { gridTicks: hz / 10 },
      renderer,
    });
    window.fixture = { editor, view, transport };
  }, renderer);
  await page.waitForFunction((r) => window.fixture.view.getDiagnostics().backend === r, renderer, {
    timeout: 15000,
  });
  return page;
}

const run = (page, fn, arg) => page.evaluate(fn, arg);
const diagnostics = (page) => run(page, () => window.fixture.view.getDiagnostics());
const frames = (page, n = 3) =>
  run(
    page,
    (n) =>
      new Promise((resolve) => {
        const step = (left) => (left ? requestAnimationFrame(() => step(left - 1)) : resolve());
        step(n);
      }),
    n,
  );
async function surface(page) {
  return page.locator(".lt-surface").boundingBox();
}
// A point on the surface at a time and a row, in page coordinates.
async function at(page, seconds, row, dy = 15) {
  const box = await surface(page);
  return { x: box.x + seconds * pps, y: box.y + 46 * row + 6 + dy };
}
async function drag(page, from, to, { lose } = {}) {
  await page.keyboard.down("Alt");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 3 });
  const ghost = (await diagnostics(page)).previewClipCount;
  if (lose) await lose();
  await page.mouse.move(to.x, to.y, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  return ghost;
}
const documentOf = (page) =>
  run(page, () => {
    const { revision: _r, ...rest } = window.fixture.editor.getSnapshot();
    return JSON.stringify(rest);
  });

// Loses the GPU device under the view: WebGL2 through WEBGL_lose_context, WebGPU by destroying it.
async function loseDevice(page, backend) {
  if (backend === "webgl2")
    return run(page, () => {
      const gl = document.querySelector(".lt-clips").getContext("webgl2");
      window.lose = gl.getExtension("WEBGL_lose_context");
      window.lose.loseContext();
    });
  return run(page, () => window.devices.at(-1).destroy());
}
async function restoreDevice(page, backend) {
  if (backend === "webgl2") await run(page, () => window.lose.restoreContext());
  await page.waitForFunction((b) => window.fixture.view.getDiagnostics().backend === b, backend, {
    timeout: 15000,
  });
}
const fallbackOf = { webgl2: "canvas2d", webgpu: "webgl2" };

// Reads the clip canvas in device pixels through the backend's own pipeline.
// Screenshots are avoided: in headless Chromium they lose the WebGPU device of
// the software adapter.
const canvasPixels = (page, rect) =>
  run(
    page,
    async (rect) => {
      const { readPixels } = await import("@lumen-timeline/timeline/internal");
      const { width, height, data } = await readPixels(window.fixture.view, rect);
      return { width, height, data: Array.from(data) };
    },
    rect,
  );
// The color of a plain clip's fill, clear of its label and below any waveform.
async function fillAt(page, seconds, row) {
  const region = await canvasPixels(page, {
    x: seconds * pps,
    y: 46 * row + 6 + 27,
    width: 1,
    height: 1,
  });
  return region.data.slice(0, 3);
}

const results = {};
try {
  for (const backend of backends) {
    const page = await mount(backend);
    const result = {};
    // Hit tests over a grid of the surface read the layout.
    result.hits = await run(page, () => {
      const out = [];
      for (let y = 2; y < 290; y += 13)
        for (let x = 1; x < 1000; x += 17) {
          const hit = window.fixture.view.hitTest({ x, y });
          out.push(hit && [hit.clipId, hit.edge, hit.trackId, hit.tick]);
        }
      return out;
    });
    const first = await diagnostics(page);
    result.layout = first.visibleClips;
    result.request = [first.renderer, first.fallback];
    await frames(page);
    result.fills = [
      await fillAt(page, 6.9, 1),
      await fillAt(page, 14.9, 0),
      await fillAt(page, 22.9, 2),
    ];
    result.background = await fillAt(page, 4.25, 3);
    result.image = await canvasPixels(page, { x: 0, y: 0, width: 1000, height: 280 });
    // A pan brings new labels, which GPU backends upload into the atlas's changed rows only.
    await run(page, () => window.fixture.view.setViewport({ startTick: 26 * 282240000 }));
    result.panned = await canvasPixels(page, { x: 0, y: 0, width: 1000, height: 280 });
    result.pannedLayout = (await diagnostics(page)).visibleClips;
    await run(page, () => window.fixture.view.setViewport({ startTick: 0 }));

    // Steady playback: the playhead moves, and nothing is laid out or uploaded.
    const before = await diagnostics(page);
    await run(page, () => window.fixture.transport.play());
    await frames(page, 30);
    const during = await diagnostics(page);
    const moved = await run(page, () => window.fixture.transport.snapshot().presentedTick);
    await run(page, () => window.fixture.transport.pause());
    result.steady = {
      uploads: during.staticUploads - before.staticUploads,
      paints: during.staticPaints - before.staticPaints,
      moved: moved > 0,
    };

    // One edit trace through pointer and keyboard.
    await page.mouse.click((await at(page, 6, 1)).x, (await at(page, 6, 1)).y);
    await drag(page, await at(page, 6, 1), await at(page, 6.5, 1));
    await drag(page, await at(page, 8, 1, 15), await at(page, 7.5, 1, 15));
    await run(page, () => window.fixture.transport.seek(6 * 282240000));
    await page.locator(".lt-surface").focus();
    await page.keyboard.press("s");
    await page.keyboard.press("ControlOrMeta+z");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    result.edited = await documentOf(page);
    result.selection = await run(page, () => window.fixture.editor.session.getSelection());

    if (backend !== "canvas2d") {
      // Lose the device during playback: the view keeps drawing on the next backend.
      const view = await run(page, () => window.fixture.view.getViewport());
      await run(page, () => window.fixture.transport.play());
      await loseDevice(page, backend);
      // The reason as the view switches: a new WebGPU device may arrive soon after.
      const switched = await page.waitForFunction(
        (b) => {
          const d = window.fixture.view.getDiagnostics();
          return d.backend === b && d.fallback;
        },
        fallbackOf[backend],
        { timeout: 15000 },
      );
      const reason = await switched.jsonValue();
      await frames(page);
      const playing = await run(page, () => window.fixture.transport.snapshot().presentedTick);
      await frames(page, 10);
      result.lostPlayback = {
        fill: await fillAt(page, 14.9, 0),
        advancing:
          (await run(page, () => window.fixture.transport.snapshot().presentedTick)) > playing,
        view:
          JSON.stringify(await run(page, () => window.fixture.view.getViewport())) ===
          JSON.stringify(view),
        selection: JSON.stringify(
          await run(page, () => window.fixture.editor.session.getSelection()),
        ),
        fallback: reason,
      };
      await run(page, () => window.fixture.transport.pause());
      await restoreDevice(page, backend);
      await frames(page);
      result.restored = {
        fill: await fillAt(page, 14.9, 0),
        losses: (await diagnostics(page)).deviceLosses,
        fallback: (await diagnostics(page)).fallback,
      };

      // Lose it again in the middle of a drag: the gesture commits as usual.
      const ghost = await drag(page, await at(page, 18, 2), await at(page, 18.5, 2), {
        lose: async () => {
          await loseDevice(page, backend);
          await page.waitForFunction(
            (b) => window.fixture.view.getDiagnostics().backend === b,
            fallbackOf[backend],
            { timeout: 15000 },
          );
        },
      });
      result.lostDrag = { ghost, document: await documentOf(page) };
      await restoreDevice(page, backend);
      await frames(page);
      result.afterDrag = {
        fill: await fillAt(page, 14.9, 0),
        losses: (await diagnostics(page)).deviceLosses,
      };
    } else {
      await drag(page, await at(page, 18, 2), await at(page, 18.5, 2));
      result.lostDrag = { ghost: 1, document: await documentOf(page) };
    }
    results[backend] = result;
    await page.close();
  }

  const reference = results[backends[0]];
  for (const backend of backends) {
    const r = results[backend];
    assert.ok(r.layout > 30 && r.layout === reference.layout, backend + ": layout " + r.layout);
    assert.ok(r.pannedLayout > 30 && r.pannedLayout === reference.pannedLayout);
    const offPanned = differing(r.panned, reference.panned);
    assert.ok(offPanned < 0.02, `${backend}: ${(offPanned * 100).toFixed(2)}% differ after a pan`);
    assert.deepEqual(r.request, [backend, null], backend + ": the requested backend draws");
    assert.deepEqual(r.hits, reference.hits, backend + ": hit tests differ");
    for (const fill of r.fills)
      assert.ok(
        close(fill, [96, 67, 50]) || close(fill, [43, 85, 85]) || close(fill, [70, 67, 96]),
        backend + " fill " + fill,
      );
    assert.deepEqual(
      r.fills,
      reference.fills.map((c) => c),
      backend + ": fills differ",
    );
    assert.ok(
      close(r.background, [25, 30, 34]) || close(r.background, [27, 32, 37]),
      backend + " background " + r.background,
    );
    const off = differing(r.image, reference.image);
    assert.ok(
      off < 0.02,
      `${backend}: ${(off * 100).toFixed(2)}% of pixels differ from ${backends[0]}`,
    );
    assert.deepEqual(
      r.steady,
      { uploads: 0, paints: 0, moved: true },
      backend + " steady playback",
    );
    assert.equal(r.edited, reference.edited, backend + ": the edit trace ended elsewhere");
    assert.deepEqual(r.selection, reference.selection);
    assert.equal(r.lostDrag.ghost, 1, backend + ": the drag showed no preview");
    assert.equal(
      r.lostDrag.document,
      reference.lostDrag.document,
      backend + ": the drag across a loss",
    );
    if (backend !== "canvas2d") {
      assert.deepEqual(r.lostPlayback.fill, r.fills[1], backend + ": nothing drawn while lost");
      assert.deepEqual(
        [r.lostPlayback.advancing, r.lostPlayback.view, r.lostPlayback.selection],
        [true, true, JSON.stringify(reference.selection)],
      );
      assert.match(r.lostPlayback.fallback ?? "", / was lost$/);
      assert.deepEqual(r.restored, { fill: r.fills[1], losses: 1, fallback: null });
      assert.deepEqual(r.afterDrag, { fill: r.fills[1], losses: 2 });
    }
    console.log(
      `${engine} ${backend}: ${r.hits.length} hits, fills, ${(differing(r.image, reference.image) * 100).toFixed(2)}% pixel difference, steady playback and the edit trace matched` +
        (backend === "canvas2d" ? "" : "; recovered from losses during playback and a drag"),
    );
  }
  const moved = JSON.parse(reference.lostDrag.document).clips.find((c) => c.id === "c4");
  assert.notDeepEqual(
    reference.panned.data,
    reference.image.data,
    "the pan showed the same pixels",
  );
  assert.equal(moved.start, Math.round(17 * hz), "the drag moved c4 by half a second");
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}

function close(a, b, tolerance = 3) {
  return a.every((v, i) => Math.abs(v - b[i]) <= tolerance);
}
// The share of pixels whose channels differ by more than 48 in total.
function differing(a, b) {
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4)
    if (
      Math.abs(a.data[i] - b.data[i]) +
        Math.abs(a.data[i + 1] - b.data[i + 1]) +
        Math.abs(a.data[i + 2] - b.data[i + 2]) >
      48
    )
      count++;
  return count / (a.data.length / 4);
}
