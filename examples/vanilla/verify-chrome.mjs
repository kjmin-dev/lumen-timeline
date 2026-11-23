// The view's built-in chrome with a real pointer and keyboard: the color
// scheme, the toolbar's history and snapping switches, the selected clip's
// toolbar, take lanes with their list and audition buttons, the track headers'
// mute and solo switches, marker flags in the ruler, and the forms that show
// only while they have something to edit.
// Usage: node examples/vanilla/verify-chrome.mjs [chromium|firefox|webkit]   (build first)
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { serve } from "./server.mjs";

const engine = process.argv[2] ?? "chromium";
const server = await serve();
const browser = await { chromium, firefox, webkit }[engine].launch();
const errors = [];

try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url + "/examples/vanilla/lab.html");
  await page.addStyleTag({ content: ".lt { --lt-scroll-height: 300px; }" });
  await page.evaluate(async () => {
    const { createEditor, TICKS_PER_SECOND: hz } = await import("@lumen-timeline/core");
    const { mountTimeline } = await import("@lumen-timeline/timeline");
    const take = (id, label) => ({
      id,
      label,
      assetId: id,
      streamId: "mono",
      sourceAtContentZero: 0,
    });
    const editor = createEditor({
      project: {
        schemaVersion: 1,
        duration: 20 * hz,
        tracks: [
          { id: "voice", name: "Voice" },
          { id: "bed", name: "Bed", locked: true, gain: 0.5 },
        ],
        clips: [
          {
            id: "line",
            name: "Line",
            trackId: "voice",
            kind: "audio",
            start: 2 * hz,
            duration: 4 * hz,
            contentIn: 0,
            takeIds: ["a", "b", "c"],
            activeTakeId: "a",
          },
          {
            id: "plain",
            name: "Plain",
            trackId: "voice",
            kind: "audio",
            start: 10 * hz,
            duration: 2 * hz,
            contentIn: 0,
          },
          {
            id: "music",
            name: "Music",
            trackId: "bed",
            kind: "audio",
            start: 0,
            duration: 18 * hz,
            contentIn: 0,
          },
        ],
        takes: [take("a", "First"), take("b", "Second"), take("c", "Third")],
        markers: [{ id: "m", start: 8 * hz, label: "Turn" }],
      },
    });
    let state = { playing: false, presentedTick: 3 * hz, requestedTick: null };
    const listeners = new Set();
    const transport = {
      snapshot: () => state,
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      play() {},
      pause() {},
      seek(tick) {
        state = { ...state, presentedTick: tick };
        for (const fn of listeners) fn(state);
      },
    };
    const auditions = [];
    const events = { onTakeAudition: (event) => auditions.push(event) };
    const view = mountTimeline(document.querySelector("#lab"), {
      editor,
      transport,
      renderer: "canvas2d",
      pixelsPerSecond: 40,
      snap: { gridTicks: hz },
      events,
    });
    window.lab = { editor, view, transport, auditions, events, hz };
  });
  const run = (fn, arg) => page.evaluate(fn, arg);
  const frame = () =>
    run(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const clip = (id) =>
    run((id) => {
      const { editor, hz } = window.lab;
      const c = editor.getSnapshot().clips.find((item) => item.id === id);
      return c && { start: c.start / hz, take: c.activeTakeId ?? null, track: c.trackId };
    }, id);
  const track = (id) =>
    run((id) => window.lab.editor.getSnapshot().tracks.find((t) => t.id === id), id);
  const rowHeights = () =>
    run(() => [...document.querySelectorAll(".lt-label")].map((el) => el.offsetHeight));
  const surface = page.locator(".lt-surface");
  const at = async (seconds, y) => {
    const box = await surface.boundingBox();
    return { x: box.x + seconds * 40, y: box.y + y };
  };
  const button = (name) => page.getByRole("button", { name, exact: true });

  // The scheme is an attribute of the root, and follows `theme.scheme`.
  const root = page.locator(".lt");
  assert.equal(await root.getAttribute("data-lt-scheme"), "dark");
  const darkPanel = await run(
    () => getComputedStyle(document.querySelector(".lt-panel")).backgroundColor,
  );
  await run(() => window.lab.view.update({ theme: { scheme: "light" } }));
  assert.equal(await root.getAttribute("data-lt-scheme"), "light");
  const lightPanel = await run(
    () => getComputedStyle(document.querySelector(".lt-panel")).backgroundColor,
  );
  assert.notEqual(darkPanel, lightPanel);
  await run(() => window.lab.view.update({ theme: {} }));
  assert.equal(await root.getAttribute("data-lt-scheme"), "dark");
  console.log(engine + ": theme.scheme switches the chrome between dark and light");

  // The forms show only while they have something to edit.
  const hidden = () =>
    run(() =>
      [".lt-edit", ".lt-marker-edit", ".lt-clip-tools"].map(
        (s) => document.querySelector(s).hidden,
      ),
    );
  assert.deepEqual(await hidden(), [true, true, true]);
  assert.equal(await page.locator(".lt-duration").textContent(), "/ 00:20.000");
  assert.equal(await page.locator(".lt-zoom-value").textContent(), "100%");
  await button("Zoom in").click();
  assert.notEqual(await page.locator(".lt-zoom-value").textContent(), "100%");
  await run(() => window.lab.view.setViewport({ pixelsPerSecond: 40 }));

  // A press on a marker's flag chooses that marker and goes to it.
  const ruler = await page.locator(".lt-ruler").boundingBox();
  await page.mouse.click(ruler.x + 8 * 40 + 8, ruler.y + 10);
  assert.equal(await run(() => window.lab.transport.snapshot().presentedTick / window.lab.hz), 8);
  assert.equal(await page.getByLabel("Marker navigator").inputValue(), "m");
  assert.deepEqual(await hidden(), [true, false, true]);
  await run(() => window.lab.transport.seek(3 * window.lab.hz));
  console.log(engine + ": a marker flag seeks and opens the marker form");

  // A selected clip shows its toolbar and the edit form.
  await page.mouse.click(...Object.values(await at(3, 30)));
  await frame();
  assert.deepEqual(await hidden(), [false, false, false]);
  const tools = page.locator(".lt-clip-tools");
  assert.equal(await tools.getAttribute("role"), "toolbar");
  const takesButton = tools.getByRole("button", { name: /^Takes/ });
  assert.equal((await takesButton.textContent()).replace(/\s+/g, " ").trim(), "Takes 1/3");
  assert.equal(await takesButton.getAttribute("aria-pressed"), "false");

  // The switch opens the candidates as lanes under the track, with a list beside them.
  const closed = await rowHeights();
  assert.deepEqual(closed, [67, 67]);
  await takesButton.click();
  await frame();
  assert.equal(await takesButton.getAttribute("aria-pressed"), "true");
  assert.deepEqual(await rowHeights(), [67 + 3 * 26 + 2, 67]);
  const picks = page.locator(".lt-take-pick");
  assert.deepEqual(await picks.allTextContents(), ["First", "Second", "Third"]);
  assert.deepEqual(
    await picks.evaluateAll((els) => els.map((el) => el.getAttribute("aria-checked"))),
    ["true", "false", "false"],
  );
  assert.equal(await page.getByRole("radiogroup").getAttribute("aria-label"), "Takes: Line");
  // The headers still read as the track names alone.
  assert.deepEqual(
    await page.locator(".lt-label").evaluateAll((els) => els.map((el) => el.textContent)),
    ["Voice", "Bed"],
  );

  // The list and a lane each pick a candidate, as one undoable edit.
  await picks.nth(1).click();
  assert.equal((await clip("line")).take, "b");
  assert.equal((await takesButton.textContent()).replace(/\s+/g, " ").trim(), "Takes 2/3");
  await page.mouse.click(...Object.values(await at(3, 67 - 5 + 2 + 2 * 26 + 11)));
  await frame();
  assert.equal((await clip("line")).take, "c");
  assert.deepEqual(
    await picks.evaluateAll((els) => els.map((el) => el.getAttribute("aria-checked"))),
    ["false", "false", "true"],
  );
  assert.deepEqual(
    await run(() => window.lab.editor.session.getSelection()),
    ["line"],
    "a press on a lane keeps the selection",
  );
  await button("Undo").click();
  assert.equal((await clip("line")).take, "b");

  // Audition asks the host and plays nothing itself.
  await page.getByRole("button", { name: "Audition Third" }).click();
  assert.deepEqual(await run(() => window.lab.auditions), [{ clipId: "line", takeId: "c" }]);
  await run(() => window.lab.view.update({ events: {} }));
  assert.equal(await page.locator(".lt-take-audition").count(), 0);
  await run(() => window.lab.view.update({ events: window.lab.events }));
  assert.equal(await page.locator(".lt-take-audition").count(), 3);

  // T closes and opens the lanes, and another selection closes them.
  await surface.focus();
  await page.keyboard.press("t");
  await frame();
  assert.deepEqual(await rowHeights(), [67, 67]);
  assert.equal(await page.locator(".lt-takes").count(), 0);
  await page.keyboard.press("t");
  await frame();
  assert.deepEqual(await rowHeights(), [67 + 80, 67]);
  await page.mouse.click(...Object.values(await at(11, 30)));
  await frame();
  assert.deepEqual(await rowHeights(), [67, 67]);
  assert.deepEqual(await run(() => window.lab.editor.session.getSelection()), ["plain"]);
  // A clip without candidates has no switch, and the view refuses to open lanes for it.
  assert.equal(await tools.getByRole("button", { name: /^Takes/ }).count(), 0);
  assert.equal(await run(() => window.lab.view.showTakeLanes("plain")), false);
  assert.equal(await run(() => window.lab.view.showTakeLanes("line")), true);
  await frame();
  assert.deepEqual(await rowHeights(), [67 + 80, 67]);
  assert.equal(await run(() => window.lab.view.showTakeLanes(null)), true);
  await frame();
  console.log(engine + ": take lanes open, pick by list and by lane, audition, and close");

  // The clip toolbar splits at the playhead.
  await run(() => window.lab.editor.session.select(["line"]));
  await frame();
  const before = await run(() => window.lab.editor.getSnapshot().clips.length);
  await tools.getByRole("button", { name: "Split", exact: true }).click();
  assert.equal(await run(() => window.lab.editor.getSnapshot().clips.length), before + 1);
  await button("Undo").click();
  assert.equal(await run(() => window.lab.editor.getSnapshot().clips.length), before);
  await button("Redo").click();
  await button("Undo").click();

  // Snapping pulls a drag to the grid until the switch turns it off.
  const snap = button("Snap");
  assert.equal(await snap.getAttribute("aria-pressed"), "true");
  const dragBy = async (pixels) => {
    const from = await at(3, 30);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + pixels, from.y, { steps: 4 });
    await page.mouse.up();
    await frame();
  };
  await run(() => window.lab.editor.session.select(["line"]));
  await dragBy(38);
  assert.equal((await clip("line")).start, 3, "38 px snapped to the next second");
  await button("Undo").click();
  await snap.click();
  assert.equal(await snap.getAttribute("aria-pressed"), "false");
  await dragBy(38);
  assert.ok(Math.abs((await clip("line")).start - (2 + 38 / 40)) < 1e-6);
  await button("Undo").click();
  await snap.click();
  console.log(engine + ": the clip toolbar splits, and the snap switch frees a drag");

  // Mute and solo are switches in the header, also on M and S.
  const mute = page.getByRole("button", { name: "Mute Voice" });
  const solo = page.getByRole("button", { name: "Solo Voice" });
  await mute.click();
  assert.equal((await track("voice")).mute, true);
  assert.equal(await mute.getAttribute("aria-pressed"), "true");
  await page.locator('.lt-label[data-track-id="voice"]').focus();
  await page.keyboard.press("m");
  assert.equal((await track("voice")).mute, false);
  await page.keyboard.press("s");
  assert.equal((await track("voice")).solo, true);
  assert.equal(await solo.getAttribute("aria-pressed"), "true");
  await page.keyboard.press("ControlOrMeta+z");
  assert.equal((await track("voice")).solo ?? false, false);
  // A locked track says so, and shows its gain.
  assert.equal(await page.getByRole("img", { name: "Locked" }).count(), 1);
  assert.deepEqual(
    await page.locator(".lt-gain").evaluateAll((els) => els.map((el) => el.dataset.gain)),
    ["0.0 dB", "−6.0 dB"],
  );

  // Read-only keeps the switches and takes visible and inert; the chrome flags remove them.
  await run(() => {
    window.lab.editor.session.select(["line"]);
    window.lab.view.showTakeLanes("line");
    window.lab.view.update({ readOnly: true });
  });
  await frame();
  assert.equal(await mute.isDisabled(), true);
  assert.equal(await picks.first().isDisabled(), true);
  assert.equal(await tools.isHidden(), true);
  await page.mouse.click(...Object.values(await at(3, 67 - 5 + 2 + 11)));
  assert.equal((await clip("line")).take, "b");
  await run(() =>
    window.lab.view.update({
      readOnly: false,
      chrome: {
        history: false,
        snapToggle: false,
        clipToolbar: false,
        takeLanes: false,
        trackControls: false,
      },
    }),
  );
  await frame();
  assert.deepEqual(await rowHeights(), [67, 67]);
  assert.deepEqual(
    await run(() => [
      document.querySelector(".lt-history").hidden,
      document.querySelector("[data-snap]").hidden,
      document.querySelector(".lt-clip-tools").hidden,
      document.querySelectorAll(".lt-track-controls, .lt-gain, .lt-lock, .lt-takes").length,
      window.lab.view.showTakeLanes("line"),
    ]),
    [true, true, true, 0, false],
  );
  await run(() => window.lab.view.update({ chrome: "minimal" }));
  assert.equal(await run(() => document.querySelectorAll(".lt-track-controls").length), 0);
  console.log(
    engine + ": mute and solo switch tracks; read-only and chrome flags turn the controls off",
  );

  assert.deepEqual(errors, []);
  console.log(engine + ": chrome verification passed");
} finally {
  await browser.close();
  await server.close();
}
