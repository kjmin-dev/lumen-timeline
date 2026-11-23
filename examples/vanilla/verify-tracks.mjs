// Track header rename and reorder with a real pointer and keyboard: inline
// rename (double-click, Enter, F2, blur, Escape, blank and IME Enter), drag
// reorder with its drop line and auto-scroll, keyboard focus and Alt+Arrow
// moves, undo, read-only and chrome switches, custom headers with grip and name
// markers, `view.renameTrack` and edits from elsewhere while a header has focus.
// Usage: node examples/vanilla/verify-tracks.mjs [chromium|firefox|webkit]   (build first)
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { serve } from "./server.mjs";

const engine = process.argv[2] ?? "chromium";
const server = await serve();
const browser = await { chromium, firefox, webkit }[engine].launch();
const errors = [];

try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url + "/examples/vanilla/lab.html");
  // Four of the eight rows fit, so a drag to an edge scrolls.
  await page.addStyleTag({ content: ".lt { --lt-scroll-height: 268px; }" });
  await page.evaluate(async () => {
    const { createEditor, TICKS_PER_SECOND: hz } = await import("@lumen-timeline/core");
    const { mountTimeline } = await import("@lumen-timeline/timeline");
    const names = ["Dialogue", "Music", "Effects", "Ambience", "Foley", "Score", "Guide", "Notes"];
    const editor = createEditor({
      project: {
        schemaVersion: 1,
        duration: 20 * hz,
        tracks: names.map((name, i) => ({ id: "t" + i, name })),
        clips: names.map((name, i) => ({
          id: "c" + i,
          name: name + " clip",
          trackId: "t" + i,
          kind: "audio",
          start: i * hz,
          duration: 2 * hz,
          contentIn: 0,
        })),
      },
    });
    let state = { playing: false, presentedTick: 0, requestedTick: null };
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
    const view = mountTimeline(document.querySelector("#lab"), {
      editor,
      transport,
      renderer: "canvas2d",
      pixelsPerSecond: 40,
    });
    window.lab = { editor, view };
  });
  const run = (fn, arg) => page.evaluate(fn, arg);
  const order = () => run(() => window.lab.editor.getSnapshot().tracks.map((t) => t.id));
  const names = () => run(() => window.lab.editor.getSnapshot().tracks.map((t) => t.name));
  const undoDepth = () => run(() => window.lab.editor.history.undoDepth);
  const revision = () => run(() => window.lab.editor.getSnapshot().revision);
  const header = (id) => page.locator(`.lt-label[data-track-id="${id}"]`);
  const input = page.locator(".lt-name-input");
  const focused = () =>
    run(() => {
      const el = document.activeElement;
      return el?.classList.contains("lt-label")
        ? el.dataset.trackId
        : el?.className === "lt-name-input"
          ? "input"
          : (el?.tagName ?? null);
    });
  const frame = () =>
    run(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const scroller = () => run(() => document.querySelector(".lt-scroll").scrollTop);
  const setScroll = async (top) => {
    await run((t) => {
      document.querySelector(".lt-scroll").scrollTop = t;
    }, top);
    await frame();
  };
  const undo = () => page.keyboard.press("ControlOrMeta+z");

  // The headers form a list with one tab stop.
  const semantics = await run(() => {
    const list = document.querySelector(".lt-headers");
    const items = [...list.querySelectorAll(".lt-label")];
    return {
      role: list.getAttribute("role"),
      label: list.getAttribute("aria-label"),
      items: items.map((el) => [
        el.getAttribute("role"),
        el.getAttribute("aria-posinset"),
        el.getAttribute("aria-setsize"),
        el.tabIndex,
      ]),
      text: items.map((el) => el.textContent),
      keys: items[0]?.getAttribute("aria-keyshortcuts"),
      grip: getComputedStyle(items[0].querySelector(".lt-grip")).display,
    };
  });
  assert.equal(semantics.role, "list");
  assert.equal(semantics.label, "Tracks");
  assert.deepEqual(semantics.items.slice(0, 2), [
    ["listitem", "1", "8", 0],
    ["listitem", "2", "8", -1],
  ]);
  assert.equal(semantics.items.filter((item) => item[3] === 0).length, 1);
  // A header's text is its name alone; the grip draws with CSS.
  assert.deepEqual(semantics.text.slice(0, 2), ["Dialogue", "Music"]);
  assert.match(semantics.keys, /Enter F2 Alt\+ArrowUp Alt\+ArrowDown/);
  assert.notEqual(semantics.grip, "none");

  // Double-click opens the field with the name selected; Enter commits one edit.
  let depth = await undoDepth();
  await header("t0").dblclick();
  assert.equal(await input.count(), 1);
  assert.equal(await input.inputValue(), "Dialogue");
  assert.deepEqual(
    await input.evaluate((el) => [
      el.selectionStart,
      el.selectionEnd,
      el.getAttribute("aria-label"),
    ]),
    [0, 8, "Track name"],
  );
  await page.keyboard.type("  Narration ");
  await page.keyboard.press("Enter");
  assert.equal((await names())[0], "Narration");
  assert.equal(await header("t0").textContent(), "Narration");
  assert.equal(await input.count(), 0);
  assert.equal(await focused(), "t0", "focus returns to the header after Enter");
  assert.equal(await undoDepth(), depth + 1);
  // Undo from the header restores the name.
  await undo();
  assert.equal((await names())[0], "Dialogue");
  assert.equal(await header("t0").textContent(), "Dialogue");

  // Escape cancels; a blank or unchanged draft commits nothing.
  let rev = await revision();
  for (const [draft, key] of [
    ["Scrapped", "Escape"],
    ["   ", "Enter"],
    ["Dialogue", "Enter"],
  ]) {
    await header("t0").dblclick();
    await input.fill(draft);
    await page.keyboard.press(key);
    assert.equal(await input.count(), 0, key);
  }
  assert.equal(await revision(), rev, "cancelled, blank and unchanged renames make no edit");
  assert.equal(await header("t0").textContent(), "Dialogue");

  // Enter while an IME composes only confirms the composition.
  await header("t1").dblclick();
  await input.fill("배경음");
  await input.evaluate((el) => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true }));
  });
  assert.equal(await input.count(), 1, "a composing Enter leaves the field open");
  assert.equal((await names())[1], "Music");
  // A click elsewhere commits, as a blur.
  await page.locator(".lt-surface").click({ position: { x: 600, y: 160 } });
  assert.equal(await input.count(), 0);
  assert.equal((await names())[1], "배경음");
  assert.equal(await header("t1").textContent(), "배경음");

  // Enter and F2 on a focused header open the field too.
  await header("t2").focus();
  await page.keyboard.press("Enter");
  assert.equal(await input.inputValue(), "Effects");
  await page.keyboard.press("Escape");
  assert.equal(await focused(), "t2", "focus returns to the header after Escape");
  await page.keyboard.press("F2");
  assert.equal(await input.count(), 1);
  await page.keyboard.press("Escape");
  console.log(engine + ": inline rename commits, cancels, ignores blank names and waits for IME");

  // Arrow keys move focus between headers and scroll rows into view.
  await header("t0").focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await focused(), "t1");
  await page.keyboard.press("End");
  assert.equal(await focused(), "t7");
  assert.ok((await scroller()) > 0, "End scrolled the last track into view");
  await page.keyboard.press("Home");
  assert.equal(await focused(), "t0");
  assert.equal(await scroller(), 0);
  assert.equal(
    await run(() => document.querySelectorAll(".lt-label[tabindex='0']").length),
    1,
    "one tab stop",
  );

  // Alt+Arrow moves the focused track, keeps focus on it and announces it.
  depth = await undoDepth();
  await page.keyboard.press("Alt+ArrowDown");
  assert.deepEqual((await order()).slice(0, 3), ["t1", "t0", "t2"]);
  assert.equal(await focused(), "t0");
  assert.equal(
    (await run(() => document.querySelector(".lt-live").textContent)).trim(),
    "Dialogue moved to position 2 of 8",
  );
  await page.keyboard.press("Alt+ArrowDown");
  await page.keyboard.press("Alt+ArrowUp");
  assert.deepEqual((await order()).slice(0, 3), ["t1", "t0", "t2"]);
  assert.equal(await undoDepth(), depth + 3, "each keyboard move is one edit");
  await page.keyboard.press("Alt+End");
  assert.equal((await order()).at(-1), "t0");
  assert.equal(await focused(), "t0", "focus followed the track off screen");
  assert.equal(await header("t0").getAttribute("aria-posinset"), "8");
  await page.keyboard.press("Alt+Home");
  assert.equal((await order())[0], "t0");
  assert.equal(await scroller(), 0);
  // At the top, a further move changes nothing.
  rev = await revision();
  await page.keyboard.press("Alt+ArrowUp");
  assert.equal(await revision(), rev);
  // Undo walks the moves back.
  for (let i = 0; i < 5; i++) await undo();
  assert.deepEqual(await order(), ["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7"]);
  console.log(engine + ": arrow keys move focus; Alt+Arrow moves tracks one undoable step each");

  // Drag: the grabbed header dims, a ghost follows the pointer and a line marks
  // the gap. Headers stay aligned with their rows until the drop.
  const box = async (id) => {
    const b = await header(id).boundingBox();
    assert.ok(b, id + " is visible");
    return b;
  };
  await setScroll(0);
  const from = await box("t0");
  const target = await box("t2");
  await page.mouse.move(from.x + 50, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 50, from.y + from.height / 2 + 2);
  assert.equal(
    await run(() => document.querySelector(".lt-track-ghost")),
    null,
    "no drag below the threshold",
  );
  // Below the middle of the third row: the gap after it.
  const dropY = target.y + target.height * 0.75;
  await page.mouse.move(from.x + 50, dropY, { steps: 8 });
  const mid = await run(() => {
    const line = document.querySelector(".lt-drop");
    const pin = document.querySelector(".lt-pin").getBoundingClientRect();
    return {
      ghost: Boolean(document.querySelector(".lt-track-ghost")),
      ghostText: document.querySelector(".lt-track-ghost")?.textContent,
      source: document.querySelector(".lt-label-source")?.dataset.trackId,
      line: line && !line.hidden ? line.getBoundingClientRect().top + 1 - pin.top : null,
      dragging: document.querySelector(".lt").classList.contains("lt-track-dragging"),
      headersTop: [...document.querySelectorAll(".lt-label")].map((el) => el.style.top),
    };
  });
  assert.equal(mid.ghost, true);
  assert.equal(mid.ghostText, "Dialogue");
  assert.equal(mid.source, "t0");
  assert.equal(mid.dragging, true);
  const pinTop = await run(() => document.querySelector(".lt-pin").getBoundingClientRect().top);
  assert.ok(
    Math.abs(mid.line - (target.y + target.height - pinTop)) <= 1,
    `drop line at the bottom of the third row: ${mid.line}`,
  );
  assert.equal(await order().then((o) => o[0]), "t0", "nothing moves before the drop");
  depth = await undoDepth();
  await page.mouse.up();
  assert.deepEqual((await order()).slice(0, 3), ["t1", "t2", "t0"]);
  assert.equal(await undoDepth(), depth + 1, "a drop is one edit");
  assert.equal(await focused(), "t0");
  assert.deepEqual(
    await run(() => [
      document.querySelectorAll(".lt-track-ghost, .lt-drop, .lt-label-source").length,
      document.querySelector(".lt").classList.contains("lt-track-dragging"),
    ]),
    [0, false],
  );
  assert.equal(await input.count(), 0, "the drop did not open a rename");
  assert.equal(await header("t0").textContent(), "Dialogue");
  await undo();
  assert.deepEqual((await order()).slice(0, 3), ["t0", "t1", "t2"]);

  // A drop on its own gap, and Escape mid-drag, change nothing.
  rev = await revision();
  const own = await box("t1");
  await page.mouse.move(own.x + 50, own.y + 10);
  await page.mouse.down();
  await page.mouse.move(own.x + 50, own.y + own.height - 10, { steps: 4 });
  assert.equal(await run(() => document.querySelector(".lt-drop").hidden), true);
  await page.mouse.up();
  const second = await box("t2");
  await page.mouse.move(second.x + 50, second.y + 10);
  await page.mouse.down();
  await page.mouse.move(second.x + 50, from.y + 4, { steps: 4 });
  assert.equal(await run(() => document.querySelector(".lt-drop").hidden), false);
  await page.keyboard.press("Escape");
  assert.equal(await run(() => document.querySelector(".lt-track-ghost")), null);
  await page.mouse.up();
  assert.equal(await revision(), rev, "a drop in place and an escaped drag make no edit");

  // Held at the bottom edge, the list scrolls and the track lands last.
  await setScroll(0);
  const first = await box("t0");
  const scrollBox = await page.locator(".lt-scroll").boundingBox();
  await page.mouse.move(first.x + 50, first.y + 10);
  await page.mouse.down();
  await page.mouse.move(first.x + 50, scrollBox.y + scrollBox.height - 3, { steps: 6 });
  await page.waitForFunction(() => {
    const s = document.querySelector(".lt-scroll");
    return s.scrollTop + s.clientHeight >= s.scrollHeight - 1;
  });
  await page.mouse.move(first.x + 50, scrollBox.y + scrollBox.height - 2);
  await page.mouse.up();
  assert.equal((await order()).at(-1), "t0", "auto-scroll reached the end");
  assert.equal(await focused(), "t0");
  await undo();
  console.log(
    engine + ": drag shows a ghost and drop line, drops one edit, cancels and auto-scrolls",
  );

  // Edits from elsewhere: focus stays with its track.
  await setScroll(0);
  await header("t1").focus();
  await run(() => {
    const { editor } = window.lab;
    const ids = editor.getSnapshot().tracks.map((t) => t.id);
    editor.dispatch({ type: "reorder-tracks", trackIds: [ids[1], ids[0], ...ids.slice(2)] });
    editor.dispatch({ type: "update-track", trackId: "t1", name: "Bed" });
  });
  assert.equal(await focused(), "t1");
  assert.equal(await header("t1").textContent(), "Bed");
  assert.equal(await header("t1").getAttribute("aria-posinset"), "1");
  await undo();
  await undo();
  assert.equal(await header("t1").textContent(), "배경음");

  // A focused header and a rename draft survive their row scrolling out of view.
  await header("t0").dblclick();
  await input.fill("Dial");
  await setScroll(10_000);
  assert.equal(await input.count(), 1, "the draft stays open off screen");
  assert.equal(await focused(), "input");
  await page.keyboard.type("og");
  await page.keyboard.press("Enter");
  assert.equal((await names())[0], "Dialog");
  assert.equal(await focused(), "t0", "the offscreen header keeps focus");
  await page.keyboard.press("ArrowDown");
  assert.equal(await focused(), "t1");
  await setScroll(0);
  // Without focus, headers leave with their rows again.
  await page.locator(".lt-surface").click({ position: { x: 600, y: 160 } });
  await setScroll(10_000);
  assert.equal(await header("t0").count(), 0);
  await setScroll(0);

  // view.renameTrack opens the field for a new track, scrolled into view.
  const added = await run(() => {
    const { editor, view } = window.lab;
    editor.dispatch({ type: "add-track", track: { id: "new" } });
    return view.renameTrack("new");
  });
  assert.equal(added, true);
  assert.equal(await input.inputValue(), "new");
  assert.equal(await focused(), "input");
  await page.keyboard.type("Pickups");
  await page.keyboard.press("Enter");
  assert.equal(await header("new").textContent(), "Pickups");
  assert.equal(await run(() => window.lab.view.renameTrack("missing")), false);
  console.log(engine + ": focus and drafts follow outside edits; view.renameTrack opens a field");

  // Read-only and chrome switches turn the gestures off.
  await setScroll(0);
  await run(() => window.lab.view.update({ readOnly: true }));
  rev = await revision();
  await header("t1").dblclick();
  assert.equal(await input.count(), 0);
  await header("t1").focus();
  await page.keyboard.press("Alt+ArrowDown");
  await page.keyboard.press("Enter");
  const ro = await box("t1");
  await page.mouse.move(ro.x + 50, ro.y + 10);
  await page.mouse.down();
  // Past the threshold but clear of the list's edges, where a browser's own
  // selection auto-scroll would start and outlast the gesture.
  await page.mouse.move(ro.x + 50, ro.y + 60, { steps: 4 });
  assert.equal(await run(() => document.querySelector(".lt-track-ghost")), null);
  await page.mouse.up();
  assert.equal(await revision(), rev, "read-only headers make no edit");
  assert.equal(await run(() => document.querySelector(".lt-grip").hidden), true);
  await setScroll(0);
  await header("t1").focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await focused(), "t2", "read-only headers still take arrow-key focus");
  assert.doesNotMatch(await header("t1").getAttribute("aria-keyshortcuts"), /Enter|Alt/);
  await run(() =>
    window.lab.view.update({ readOnly: false, chrome: { trackRename: false, trackReorder: true } }),
  );
  await header("t1").dblclick();
  assert.equal(await input.count(), 0, "chrome.trackRename: false");
  assert.equal(await run(() => document.querySelector(".lt-grip").hidden), false);
  await run(() => window.lab.view.update({ chrome: { trackReorder: false } }));
  await header("t1").focus();
  await page.keyboard.press("Alt+ArrowDown");
  assert.equal(await revision(), rev, "chrome.trackReorder: false");
  // The key falls through to the browser, which may scroll; focus stays put.
  assert.equal(await focused(), "t1");
  await setScroll(0);
  await run(() => window.lab.view.update({ chrome: "minimal" }));
  await header("t1").dblclick();
  assert.equal(await input.count(), 0, "minimal chrome keeps headers static");
  await run(() => window.lab.view.update({ chrome: undefined }));
  console.log(
    engine + ": read-only, chrome.trackRename/trackReorder and minimal turn gestures off",
  );

  // Custom headers rename from their marked name and drag from their grip.
  await run(() => {
    window.lab.view.update({
      renderTrackHeader: (track) => {
        const row = document.createElement("div");
        row.className = "custom";
        row.innerHTML = `<button type="button" class="grip" data-lt-track-grip aria-label="Move">≡</button>
          <span class="name" data-lt-track-name></span><button type="button" class="mute">M</button>`;
        row.querySelector(".name").textContent = track.name ?? track.id;
        return row;
      },
    });
  });
  await setScroll(0);
  const customOrder = await order();
  await header("t1").locator(".name").dblclick();
  assert.equal(await input.count(), 1);
  await input.fill("Strings");
  await page.keyboard.press("Enter");
  assert.equal(await header("t1").locator(".name").textContent(), "Strings");
  assert.equal(await header("t1").locator(".grip").count(), 1, "custom content was restored");
  // A press on a control is the control's.
  rev = await revision();
  await header("t1").locator(".mute").dblclick();
  const mute = await header("t1").locator(".mute").boundingBox();
  await page.mouse.move(mute.x + 4, mute.y + 4);
  await page.mouse.down();
  await page.mouse.move(mute.x + 4, mute.y + 120, { steps: 4 });
  await page.mouse.up();
  assert.equal(await revision(), rev, "custom controls start no rename or drag");
  const grip = await header(customOrder[0]).locator(".grip").boundingBox();
  const third = await box(customOrder[2]);
  await page.mouse.move(grip.x + 4, grip.y + 4);
  await page.mouse.down();
  await page.mouse.move(grip.x + 4, third.y + third.height - 4, { steps: 6 });
  await page.mouse.up();
  assert.deepEqual((await order()).slice(0, 3), [customOrder[1], customOrder[2], customOrder[0]]);
  console.log(engine + ": custom headers rename from data-lt-track-name and drag from the grip");

  await run(() => {
    window.lab.view.dispose();
    window.lab.editor.dispose();
  });
  assert.equal(await run(() => document.querySelectorAll(".lt, .lt-live").length), 0);
  assert.deepEqual(errors, []);
  console.log(engine + ": track header verification passed");
} finally {
  await browser.close();
  await server.close();
}
