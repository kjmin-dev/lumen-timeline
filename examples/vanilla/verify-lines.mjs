// The placed script in both workspaces: rows in timeline order with speaker,
// range and both languages; a click that selects and reveals a clip in the
// script, timeline and take panel; line play that stops at the line's end; and
// rows that follow splits, text edits and undo. Usage:
// node examples/vanilla/verify-lines.mjs [chromium|firefox|webkit]   (build first)
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { serve } from "./server.mjs";

const hz = 282240000;
const engine = process.argv[2] ?? "chromium";
const server = await serve();
const browser = await { chromium, firefox, webkit }[engine].launch();
const errors = [];

async function open(path) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url + path);
  await page.waitForSelector(".lt-edit", { state: "attached" });
  await page.evaluate(async () => {
    window.lumenApp = await import("./app.mjs");
  });
  return page;
}
const app = (page, fn, arg) => page.evaluate(fn, arg);
const rows = (page) =>
  page.locator("#line-list li").evaluateAll((items) =>
    items.map((li) => ({
      clip: li.dataset.clip,
      meta: li.querySelector(".line-meta").textContent,
      source: li.querySelector("[lang=fr]").textContent,
      text: li.querySelector("[lang=en]").textContent,
      current: li.getAttribute("aria-current") === "true",
    })),
  );
const selection = (page) => app(page, () => window.lumenApp.studio.editor.session.getSelection());
const transportState = (page) => app(page, () => window.lumenApp.studio.transport.snapshot());

// Plays one line from its row and checks that it stops exactly at the line's end.
async function playLine(page, name, end) {
  await page.getByRole("button", { name: "Play " + name, exact: true }).click();
  await page.waitForFunction(() => window.lumenApp.studio.transport.snapshot().until !== null);
  const row = page.locator("#line-list li.playing");
  await row.waitFor({ timeout: 15000 });
  assert.equal(await row.locator(".line-state").textContent(), "Playing");
  await page.waitForFunction(
    (tick) => {
      const s = window.lumenApp.studio.transport.snapshot();
      return !s.playing && s.until === null && s.presentedTick === tick;
    },
    end,
    { timeout: 15000 },
  );
  assert.equal(await page.locator("#line-list li.playing").count(), 0);
  assert.equal(await page.locator("#status").textContent(), "");
}

async function videoWorkspace() {
  const page = await open("/");
  const button = (name) => page.getByRole("button", { name, exact: true });
  // 1. Every placed line in timeline order: speaker, range, take and both languages.
  assert.equal(await page.locator("#line-list .line-count").textContent(), "3 lines");
  assert.deepEqual(await rows(page), [
    {
      clip: "reply",
      meta: "Keeper · 5.0–8.0 s · Read",
      source: "Tu entends le courant ?",
      text: "Can you hear the current?",
      current: false,
    },
    {
      clip: "line",
      meta: "Narrator · 12.0–16.0 s · Dialogue",
      source: "La marée revient. Regarde les courbes dériver sur l'anse.",
      text: "The tide returns. Watch the contour lines drift across the inlet.",
      current: false,
    },
    {
      clip: "return",
      meta: "Narrator · 19.0–22.0 s · Dialogue",
      source: "Et elle repart.",
      text: "And it leaves again.",
      current: false,
    },
  ]);

  // 2. A click selects the clip and reveals it in the timeline and the panels.
  await app(page, () =>
    window.lumenApp.studio.view.setViewport({ startTick: 0, pixelsPerSecond: 100 }),
  );
  await button("Select Narrator, 19.0–22.0 s").click();
  assert.deepEqual(await selection(page), ["return"]);
  // The clip's start is on screen; the pan stops at the sequence end.
  const shown = await app(page, () => {
    const { startTick, pixelsPerSecond } = window.lumenApp.studio.view.getViewport();
    const width = document.querySelector(".lt-surface").clientWidth;
    return [startTick, startTick + (width / pixelsPerSecond) * 282240000];
  });
  assert.ok(shown[0] > 0 && shown[0] <= 19 * hz && 19 * hz < shown[1], String(shown));
  assert.equal(await page.locator("#clip-name").textContent(), "Return cue");
  assert.equal(await page.locator("#take-panel .take-name").first().textContent(), "Dialogue");
  assert.equal(await page.getByLabel("Clip navigator").inputValue(), "return");
  assert.deepEqual(
    (await rows(page)).map((r) => r.current),
    [false, false, true],
  );

  // 3. A selection made in the timeline marks the row without scrolling the page.
  const scrollY = await app(page, () => window.scrollY);
  await page.getByLabel("Clip navigator").selectOption("reply");
  assert.deepEqual(
    (await rows(page)).map((r) => r.current),
    [true, false, false],
  );
  assert.equal(await app(page, () => window.scrollY), scrollY);
  assert.equal(await page.locator("#take").textContent(), "Read");

  // 4. Line play seeks to the line, highlights it and stops at its end.
  await playLine(page, "Keeper, 5.0–8.0 s", 8 * hz);
  const stopped = await transportState(page);
  assert.equal(stopped.presentedTick, 8 * hz);
  assert.ok(
    Math.abs((await page.evaluate(() => document.querySelector("video").currentTime)) - 8) < 0.05,
  );
  // Ordinary playback starts at the playhead and plays past the line.
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForFunction(
    () => window.lumenApp.studio.transport.snapshot().presentedTick > 8.3 * 282240000,
    null,
    { timeout: 15000 },
  );
  assert.equal((await transportState(page)).until, null);
  await app(page, () => window.lumenApp.studio.transport.pause());

  // 5. A split shows both parts of the line; a text edit updates both; undo restores one row.
  await button("Select Narrator, 12.0–16.0 s").click();
  await page.evaluate(() => window.lumenApp.studio.transport.seek(14 * 282240000));
  await page.getByRole("group", { name: "Timeline clips" }).focus();
  await page.keyboard.press("s");
  const [right] = await selection(page);
  assert.deepEqual(
    (await rows(page)).map((r) => [r.clip, r.meta]),
    [
      ["reply", "Keeper · 5.0–8.0 s · Read"],
      ["line", "Narrator · 12.0–14.0 s · part 1 of 2 · Dialogue"],
      [right, "Narrator · 14.0–16.0 s · part 2 of 2 · Dialogue"],
      ["return", "Narrator · 19.0–22.0 s · Dialogue"],
    ],
  );
  // The list keeps its height and scrolls the selected part into view inside itself.
  const box = await page.locator("#line-list ol").boundingBox();
  await page.getByLabel("Clip navigator").selectOption("return");
  assert.ok(
    (await page.locator("#line-list ol").evaluate((ol) => ol.scrollTop)) > 0,
    "the last row was not revealed",
  );
  assert.deepEqual(await page.locator("#line-list ol").boundingBox(), box);
  await page.getByLabel("Clip navigator").selectOption(right);
  await page.getByLabel("Line text").fill("The tide comes back.");
  await button("Save text").click();
  assert.deepEqual(
    (await rows(page)).filter((r) => r.source.startsWith("La marée")).map((r) => r.text),
    ["The tide comes back.", "The tide comes back."],
  );
  await page.getByRole("group", { name: "Timeline clips" }).focus();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  assert.deepEqual(
    (await rows(page)).map((r) => r.meta),
    [
      "Keeper · 5.0–8.0 s · Read",
      "Narrator · 12.0–16.0 s · Dialogue",
      "Narrator · 19.0–22.0 s · Dialogue",
    ],
  );
  assert.equal(
    (await rows(page))[1].text,
    "The tide returns. Watch the contour lines drift across the inlet.",
  );
  await page.close();
}

async function audioWorkspace() {
  const page = await open("/examples/vanilla/audio.html");
  assert.deepEqual(
    (await rows(page)).map((r) => [r.clip, r.meta]),
    [["line", "Narrator · 2.0–6.0 s · Dialogue"]],
  );
  // The audio clock stops on the line's last tick, not at a frame after it.
  await playLine(page, "Narrator, 2.0–6.0 s", 6 * hz);
  assert.equal((await transportState(page)).status, "paused");
  assert.deepEqual(await selection(page), ["line"]);
  await page.close();
}

try {
  await videoWorkspace();
  console.log(engine + ": script rows, select and reveal, line play, split, edit and undo passed");
  await audioWorkspace();
  console.log(engine + ": audio workspace line play stopped at the line's end");
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
