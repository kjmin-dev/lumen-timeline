// Candidates in the view: the timeline caption, the take panel and audition in
// both workspaces. Usage: node examples/vanilla/verify-takes.mjs [chromium|firefox|webkit]
// (build first)
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
const clipOf = (page, id) =>
  app(
    page,
    (clipId) => window.lumenApp.studio.editor.getSnapshot().clips.find((c) => c.id === clipId),
    id,
  );
const rows = (page) =>
  page
    .locator("#take-panel li")
    .evaluateAll((items) =>
      items.map((li) => [
        li.querySelector(".take-name").textContent,
        li.classList.contains("active"),
      ]),
    );
const paints = (page) => app(page, () => window.lumenApp.studio.view.getDiagnostics().staticPaints);
// What the clip canvas shows, from a screenshot, so any drawing backend compares alike.
const pixels = async (page) => (await page.locator(".lt-clips").screenshot()).toString("base64");
const transportState = (page) => app(page, () => window.lumenApp.studio.transport.snapshot());

// Waits for an audition to start and end, and returns the result the panel reported.
async function heard(page, start) {
  await page.waitForFunction(() => window.lumenApp.studio.transport.snapshot().audition !== null);
  const during = await transportState(page);
  // A previous audition's report stays on the page until this one settles.
  await app(page, () => {
    document.querySelector("#status").textContent = "";
  });
  await start?.();
  await page.waitForFunction(
    () => window.lumenApp.studio.transport.snapshot().audition === null,
    null,
    {
      timeout: 15000,
    },
  );
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.startsWith("Audition "),
  );
  return { during, status: await page.locator("#status").textContent() };
}

async function videoWorkspace() {
  const page = await open("/");
  const button = (name) => page.getByRole("button", { name, exact: true });
  await app(page, () =>
    window.lumenApp.studio.view.setViewport({ startTick: 10 * 282240000, pixelsPerSecond: 100 }),
  );
  await page.getByLabel("Clip navigator").selectOption("line");
  assert.deepEqual(await rows(page), [
    ["Dialogue", true],
    ["Dialogue, late", false],
    ["Guide", false],
  ]);
  assert.equal(await page.locator("#take").textContent(), "Dialogue");
  assert.ok(await button("Apply Dialogue").isDisabled());
  assert.ok(await button("Remove Dialogue").isDisabled());
  assert.ok(await button("Move Dialogue up").isDisabled());

  // The caption repaints for a relabeled active take, and for nothing else.
  const before = { paints: await paints(page), pixels: await pixels(page) };
  await app(page, async () => {
    const { commands } = await import("@lumen-timeline/core");
    const { editor } = window.lumenApp.studio;
    editor.dispatch(commands.updateTake({ takeId: "guide", label: "Guide tone" }));
    editor.dispatch(commands.setEntityData({ scope: "clip", id: "line", key: "note", value: "x" }));
  });
  assert.equal(await paints(page), before.paints, "an inactive label or data change repainted");
  assert.equal(await pixels(page), before.pixels);
  await app(page, async () => {
    const { commands } = await import("@lumen-timeline/core");
    window.lumenApp.studio.editor.dispatch(
      commands.updateTake({ takeId: "line", label: "Recorded" }),
    );
  });
  assert.equal(await paints(page), before.paints + 1);
  assert.notEqual(await pixels(page), before.pixels, "the caption did not change");
  assert.equal(await page.locator("#take").textContent(), "Recorded");
  assert.deepEqual(
    (await rows(page)).map(([name]) => name),
    ["Recorded", "Dialogue, late", "Guide tone"],
  );

  // An isolated audition plays the guide over the line and returns to 2 s.
  await page.evaluate(() => window.lumenApp.studio.transport.seek(2 * 282240000));
  const revision = (await app(page, () => window.lumenApp.studio.editor.getSnapshot())).revision;
  await page.getByLabel("Isolated").check();
  await button("Audition Guide tone").click();
  const guide = await heard(page, async () => {
    assert.equal(
      await page.locator(".takes-audition").textContent(),
      "Auditioning Guide tone, isolated",
    );
    assert.equal(await page.getByRole("button", { name: "Stop Guide tone" }).count(), 1);
  });
  assert.deepEqual(guide.during.audition, {
    clipId: "line",
    takeId: "guide",
    mode: "isolated",
    range: { start: 12 * hz, end: 16 * hz },
    returnTick: 2 * hz,
  });
  assert.equal(guide.status, "Audition finished.");
  const back = await transportState(page);
  assert.equal(back.presentedTick, 2 * hz);
  assert.equal(back.playing, false);
  assert.ok(
    Math.abs((await page.evaluate(() => document.querySelector("video").currentTime)) - 2) < 0.05,
  );
  assert.equal(
    (await app(page, () => window.lumenApp.studio.editor.getSnapshot())).revision,
    revision,
  );

  // Stop ends a mix audition early.
  await page.getByLabel("Isolated").uncheck();
  await button("Audition Dialogue, late").click();
  const late = await heard(page, () => button("Stop audition").click());
  assert.equal(late.during.audition.mode, "mix");
  assert.equal(late.status, "Audition cancelled.");
  assert.equal((await transportState(page)).presentedTick, 2 * hz);

  // Apply, reorder and remove are one undoable edit each.
  const depth = () => app(page, () => window.lumenApp.studio.editor.history.undoDepth);
  const start = await depth();
  await button("Apply Guide tone").click();
  assert.equal((await clipOf(page, "line")).activeTakeId, "guide");
  assert.equal(await page.locator("#take").textContent(), "Guide tone");
  await button("Move Guide tone up").click();
  await button("Remove Recorded").click();
  assert.deepEqual((await clipOf(page, "line")).takeIds, ["guide", "line-late"]);
  assert.deepEqual(await rows(page), [
    ["Guide tone", true],
    ["Dialogue, late", false],
  ]);
  assert.equal(await depth(), start + 3);
  await page.getByRole("group", { name: "Timeline clips" }).focus();
  await page.keyboard.press("Control+z");
  assert.deepEqual((await clipOf(page, "line")).takeIds, ["line", "guide", "line-late"]);
  // The removed take stayed in the project, so undo lists it again.
  assert.deepEqual(await rows(page), [
    ["Recorded", false],
    ["Guide tone", true],
    ["Dialogue, late", false],
  ]);

  // Save and reopen keep the list, the active take and the labels.
  const saved = await clipOf(page, "line");
  await button("Save project").click();
  await button("Reopen saved").click();
  await page.waitForFunction(
    () => document.querySelector("#status").textContent === "Saved project reopened.",
  );
  await page.getByLabel("Clip navigator").selectOption("line");
  assert.deepEqual(await clipOf(page, "line"), saved);
  assert.deepEqual(await rows(page), [
    ["Recorded", false],
    ["Guide tone", true],
    ["Dialogue, late", false],
  ]);
  await page.close();
}

async function audioWorkspace() {
  const page = await open("/examples/vanilla/audio.html");
  const button = (name) => page.getByRole("button", { name, exact: true });
  await page.getByLabel("Clip navigator").selectOption("line");
  // This workspace calls candidates versions.
  assert.equal(await page.locator("#take-panel .takes-title").textContent(), "Versions");
  assert.equal(await page.getByRole("list", { name: "Versions of the selected clip" }).count(), 1);
  assert.equal(await page.locator("#take").textContent(), "Dialogue");
  await page.evaluate(() => window.lumenApp.studio.transport.seek(9 * 282240000));
  await button("Audition Guide").click();
  const guide = await heard(page);
  assert.equal(guide.during.audition.mode, "mix");
  assert.equal(guide.status, "Audition finished.");
  const back = await transportState(page);
  assert.equal(back.presentedTick, 9 * hz);
  assert.equal(back.status, "paused");
  await button("Apply Guide").click();
  assert.equal(await page.locator("#take").textContent(), "Guide");
  // With no version active, the inspector and caption use the workspace's word.
  await app(page, async () => {
    const { commands } = await import("@lumen-timeline/core");
    window.lumenApp.studio.editor.dispatch(commands.selectTake({ clipId: "line", takeId: null }));
  });
  assert.equal(await page.locator("#take").textContent(), "No version");
  await page.close();
}

try {
  await videoWorkspace();
  console.log(
    engine + ": video workspace caption, take panel, audition, history and reopen passed",
  );
  await audioWorkspace();
  console.log(engine + ": audio workspace versions and audition passed");
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
