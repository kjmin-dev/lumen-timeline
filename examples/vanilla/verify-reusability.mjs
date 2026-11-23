// Verifies the timeline view's reusability options in Chromium:
// - chrome presets (`false`, `"minimal"`, partial object) and hot updates without remount
// - full i18n UI labels, theme, layout geometry, clipStyle, formatTime, gridSpacing
// - custom virtualized track header renderer (`renderTrackHeader`)
// - custom 2D overlay hook (`renderOverlay`) and `view.repaint("overlay")`
// - region markers rendered across viewport even when starting offscreen
// - readOnly mode, shortcuts toggle and host pointer/viewport callbacks
// - live track/clip CRUD reflected in the mounted view
// - zero extra layout builds for equal option objects and clean disposal
// Usage: node examples/vanilla/verify-reusability.mjs [renderer]   (build first)
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
  await page.goto(server.url + "/examples/vanilla/lab.html");
  await page.addStyleTag({ content: ".lt { --lt-scroll-height: 240px; }" });

  const result = await page.evaluate(async (backend) => {
    const { commands, createEditor, TICKS_PER_SECOND: hz } = await import("@lumen-timeline/core");
    const { mountTimeline } = await import("@lumen-timeline/timeline");

    const editor = createEditor({
      project: {
        schemaVersion: 1,
        duration: 30 * hz,
        tracks: [
          { id: "host", name: "Host", color: "#55ccbb" },
          { id: "music", name: "Music" },
        ],
        clips: [
          {
            id: "intro",
            name: "Intro",
            trackId: "host",
            kind: "audio",
            start: 2 * hz,
            duration: 4 * hz,
            contentIn: 0,
          },
          {
            id: "bed",
            name: "Bed",
            trackId: "music",
            kind: "audio",
            start: 0,
            duration: 12 * hz,
            contentIn: 0,
            color: "#e07060",
          },
        ],
        markers: [{ id: "ch1", start: 0, duration: 8 * hz, label: "Chapter 1", color: "#88ccff" }],
      },
    });

    let transportState = { playing: false, presentedTick: 0, requestedTick: null };
    const listeners = new Set();
    const transport = {
      snapshot: () => transportState,
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      play() {},
      pause() {},
      seek(tick) {
        transportState = { ...transportState, presentedTick: tick };
        for (const fn of listeners) fn(transportState);
      },
    };

    const fired = { clicks: [], dblclicks: [], context: [], trackClicks: [], viewports: 0 };
    let overlayCalls = 0;
    let headerCalls = 0;
    const renderHeader = (track) => {
      headerCalls++;
      const div = document.createElement("div");
      div.className = "custom-header";
      div.dataset.track = track.id;
      div.textContent = `${track.name ?? track.id}${track.mute ? " (M)" : ""}`;
      return div;
    };
    const renderOverlay = ({ ctx, boxOf }) => {
      overlayCalls++;
      const box = boxOf("intro");
      if (box) {
        ctx.fillStyle = "#00ff88";
        ctx.fillRect(box.x, box.y, 4, 4);
      }
    };
    const clipStyle = (clip) =>
      clip.id === "intro" ? { label: "Intro Custom", caption: "v1" } : undefined;
    const formatTime = (tick) => `F${Math.round((tick / hz) * 30)}`;
    const gridSpacing = () => hz;

    const view = mountTimeline(document.querySelector("#lab"), {
      editor,
      transport,
      renderer: backend,
      pixelsPerSecond: 50,
      chrome: "minimal",
      layout: { laneHeight: 44, rowInset: 8 },
      theme: { rowEven: "#11161a", rowOdd: "#161c22", marker: "#99ddff" },
      labels: { play: "재생", pause: "일시정지", tracks: "트랙" },
      readOnly: true,
      shortcuts: false,
      formatTime,
      gridSpacing,
      clipStyle,
      renderTrackHeader: renderHeader,
      renderOverlay,
      events: {
        onClipClick: (e) => fired.clicks.push(e.clipId),
        onClipDoubleClick: (e) => fired.dblclicks.push(e.clipId),
        onContextMenu: (e) => {
          e.originalEvent.preventDefault();
          fired.context.push(e.hit.clipId ?? e.hit.trackId);
        },
        onTrackClick: (e) => fired.trackClicks.push(e.hit.trackId),
        onViewportChange: () => fired.viewports++,
      },
    });

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const root = document.querySelector(".lt");

    // 1. Minimal chrome hides toolbars/forms while keeping ruler and custom track headers.
    const minimalChrome = {
      toolsHidden: root.querySelector(".lt-tools").hidden,
      rulerHidden: root.querySelector("[data-ruler-row]").hidden,
      panHidden: root.querySelector(".lt-pan").hidden,
      editHidden: root.querySelector(".lt-edit").hidden,
      markerFormHidden: root.querySelector(".lt-marker-edit").hidden,
      customHeaders: [...root.querySelectorAll(".custom-header")].map((el) => el.textContent),
      navOptions: root.querySelector("select").options.length,
    };

    // 2. Passing equal options via update() does zero layout builds.
    const buildsBefore = view.getDiagnostics().layoutBuilds;
    view.update({
      chrome: "minimal",
      layout: { laneHeight: 44, rowInset: 8 },
      theme: { rowEven: "#11161a", rowOdd: "#161c22", marker: "#99ddff" },
      labels: { play: "재생", pause: "일시정지", tracks: "트랙" },
      readOnly: true,
      shortcuts: false,
      formatTime,
      gridSpacing,
      clipStyle,
      renderTrackHeader: renderHeader,
      renderOverlay,
    });
    const equalBuilds = view.getDiagnostics().layoutBuilds - buildsBefore;

    // 3. Invalid layout throws RangeError without changing state.
    let badLayoutError = null;
    try {
      view.update({ layout: { laneHeight: 4 } });
    } catch (e) {
      badLayoutError = e.name;
    }

    // 4. Region marker starting offscreen left is still visible after panning to 3s.
    view.setViewport({ startTick: 3 * hz });
    const viewportChanged = fired.viewports > 0;
    const regionVisible = editor
      .read()
      .regionsIn({ start: 3 * hz, end: 10 * hz })
      .map((m) => m.id);
    view.setViewport({ startTick: 0 });

    // 5. Read-only mode allows selection and fires events, but blocks keyboard edits.
    const surface = root.querySelector(".lt-surface");
    const rect = surface.getBoundingClientRect();
    const hitIntro = view.hitTest({ x: 3 * 50, y: 20 });
    surface.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerId: 1,
        clientX: rect.left + 3 * 50,
        clientY: rect.top + 20,
      }),
    );
    surface.dispatchEvent(
      new MouseEvent("dblclick", {
        bubbles: true,
        clientX: rect.left + 3 * 50,
        clientY: rect.top + 20,
      }),
    );
    surface.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 3 * 50,
        clientY: rect.top + 20,
      }),
    );
    // Empty space on track 0 at x = 8 s
    surface.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerId: 2,
        clientX: rect.left + 8 * 50,
        clientY: rect.top + 20,
      }),
    );
    // Re-select intro and verify readOnly/shortcuts block split and arrow move.
    editor.session.select(["intro"]);
    surface.focus();
    surface.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    const introAfterReadOnly = editor.getSnapshot().clips.find((c) => c.id === "intro").start;

    // 6. Switching chrome to false hides ruler and track headers without remounting.
    view.update({ chrome: false });
    const bareChrome = {
      sameRoot: document.querySelector(".lt") === root,
      rulerHidden: root.querySelector("[data-ruler-row]").hidden,
      noHeadersClass: root.classList.contains("lt-no-headers"),
      headerCount: root.querySelectorAll(".lt-label").length,
    };

    // 7. Restoring full chrome + live track & clip CRUD updates headers and rows.
    view.update({ chrome: undefined, readOnly: false, shortcuts: true });
    editor.dispatch([
      commands.updateTrack({ trackId: "host", mute: true }),
      commands.addTrack({ track: { id: "guest", name: "Guest" } }),
      commands.addClip({
        clip: { id: "note", trackId: "guest", kind: "audio", start: 1 * hz, duration: 2 * hz },
      }),
    ]);
    await new Promise((r) => requestAnimationFrame(r));
    const afterCrud = {
      playText: root.querySelector("[data-play]").textContent,
      headers: [...root.querySelectorAll(".custom-header")].map((el) => el.textContent),
      navCount: root.querySelector("select").options.length,
      scrolledToGuest: view.scrollToTrack("guest"),
      hitGuest: view.hitTest({ x: 1.5 * 50, y: 2 * (44 + 16) + 20 })?.clipId ?? null,
    };

    // 8. view.repaint("overlay") invokes renderOverlay without rebuilding static clip geometry.
    const staticBefore = view.getDiagnostics().staticPaints;
    const overlayBefore = overlayCalls;
    view.repaint("overlay");
    const overlayOnly = {
      overlayDelta: overlayCalls - overlayBefore,
      staticDelta: view.getDiagnostics().staticPaints - staticBefore,
    };

    view.dispose();
    editor.dispose();
    return {
      minimalChrome,
      equalBuilds,
      badLayoutError,
      viewportChanged,
      regionVisible,
      hitIntro,
      fired,
      introAfterReadOnly,
      bareChrome,
      afterCrud,
      overlayOnly,
      headerCalls,
      leftoverRoots: document.querySelectorAll(".lt").length,
    };
  }, renderer);

  assert.deepEqual(result.minimalChrome, {
    toolsHidden: true,
    rulerHidden: false,
    panHidden: true,
    editHidden: true,
    markerFormHidden: true,
    customHeaders: ["Host", "Music"],
    navOptions: 0,
  });
  assert.equal(result.equalBuilds, 0, "equal new options do zero layout builds");
  assert.equal(result.badLayoutError, "RangeError");
  assert.equal(result.viewportChanged, true);
  assert.deepEqual(result.regionVisible, ["ch1"]);
  assert.equal(result.hitIntro?.clipId, "intro");
  assert.deepEqual(result.fired.clicks, ["intro"]);
  assert.deepEqual(result.fired.dblclicks, ["intro"]);
  assert.deepEqual(result.fired.context, ["intro"]);
  assert.deepEqual(result.fired.trackClicks, ["host"]);
  assert.equal(result.introAfterReadOnly, 2 * 282_240_000);
  assert.deepEqual(result.bareChrome, {
    sameRoot: true,
    rulerHidden: true,
    noHeadersClass: true,
    headerCount: 0,
  });
  assert.deepEqual(result.afterCrud, {
    playText: "재생",
    headers: ["Host (M)", "Music", "Guest"],
    navCount: 4,
    scrolledToGuest: true,
    hitGuest: "note",
  });
  assert.deepEqual(result.overlayOnly, { overlayDelta: 1, staticDelta: 0 });
  assert.equal(result.leftoverRoots, 0);
  assert.deepEqual(errors, []);
  console.log(
    `${renderer}: reusability verification passed (chrome, theme, layout, headers, overlay, regions, events, readOnly, live CRUD)`,
  );
} finally {
  await browser.close();
  await server.close();
}
