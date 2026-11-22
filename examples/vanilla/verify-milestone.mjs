// Milestone 2 acceptance: one recorded session against the roadmap's exit criteria.
// Usage: node examples/vanilla/verify-milestone.mjs [chromium|firefox|webkit]   (build first)
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { commands, createEditor } from "../../packages/core/dist/index.js";
import { serve } from "./server.mjs";

const hz = 282240000;
const engine = process.argv[2] ?? "chromium";
const server = await serve();
const browser = await { chromium, firefox, webkit }[engine].launch();
const errors = [];
const json = (value) => JSON.parse(JSON.stringify(value));
const withoutRevision = (snapshot) => {
  const { revision, ...rest } = snapshot;
  assert.equal(typeof revision, "number");
  return rest;
};

async function open(context, path) {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url + path);
  await page.waitForSelector(".lt-edit");
  // waitForFunction treats a returned promise as truthy, so predicates read
  // the live module namespace synchronously.
  await page.evaluate(async () => {
    window.lumenApp = await import("./app.mjs");
  });
  return page;
}
const app = (page, fn, arg) => page.evaluate(fn, arg);
const snapshot = (page) => app(page, () => window.lumenApp.studio.editor.getSnapshot());

// 1. Edit the video workspace with the pointer and the keyboard, then save and reopen.
async function editSession(context) {
  const page = await open(context, "/");
  const surface = page.getByRole("group", { name: "Timeline clips" });
  const ruler = page.getByRole("slider", { name: "Seek", exact: true });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const initial = await snapshot(page);
  await app(page, () =>
    window.lumenApp.studio.view.setViewport({ startTick: 10 * 282240000, pixelsPerSecond: 100 }),
  );
  async function at(second, row = 0) {
    const { startTick, pixelsPerSecond } = await app(page, () =>
      window.lumenApp.studio.view.getViewport(),
    );
    const r = await surface.boundingBox();
    return { x: r.x + (second - startTick / hz) * pixelsPerSecond, y: r.y + 20 + 46 * row };
  }
  async function drag(from, to) {
    await surface.scrollIntoViewIfNeeded();
    const a = await at(from),
      b = await at(to);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 5 });
    await page.mouse.up();
  }
  const clip = async (id) => (await snapshot(page)).clips.find((c) => c.id === id);
  const placement = async (id) => {
    const c = await clip(id);
    return [c.start / hz, c.duration / hz, c.contentIn / hz];
  };

  // Pointer: move the line two seconds later, then trim its end by half a second.
  // Alt bypasses snapping so each gesture has an exact intent. At 100 px/s every
  // point is a whole pixel, which engines that round pointer positions keep.
  await page.keyboard.down("Alt");
  await drag(13, 15);
  assert.deepEqual(await placement("line"), [14, 4, 1]);
  await drag(18 - 0.02, 17.5 - 0.02);
  await page.keyboard.up("Alt");
  assert.deepEqual(await placement("line"), [14, 3.5, 1]);

  // Keyboard: choose the return cue, nudge it one grid step and trim its start numerically.
  await page.getByLabel("Clip navigator").selectOption("return");
  await surface.focus();
  await page.keyboard.press("ArrowRight");
  assert.deepEqual(await placement("return"), [19.1, 3, 1]);
  await page.getByLabel("Edit operation").selectOption("left");
  const delta = page.getByLabel("Edit delta in seconds");
  await delta.fill("0.5");
  await delta.press("Enter");
  assert.deepEqual(await placement("return"), [19.6, 2.5, 1.5]);

  // Seek with the ruler's keys to 16 s, split the line there and mark the cut.
  await ruler.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("]");
  await page.waitForFunction(() => {
    const s = window.lumenApp.studio.transport.snapshot();
    return s.requestedTick === null && s.presentedTick === 12 * 282240000;
  });
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => {
    const s = window.lumenApp.studio.transport.snapshot();
    return s.requestedTick === null && Math.abs(s.presentedTick - 16 * 282240000) < 282240;
  });
  await page.getByLabel("Clip navigator").selectOption("line");
  await surface.focus();
  await page.keyboard.press("s");
  const afterSplit = await snapshot(page);
  const right = afterSplit.clips.find(
    (c) => c.trackId === "dialogue" && !initial.clips.some((o) => o.id === c.id),
  );
  assert.ok(right, "the split created a right-hand clip");
  const cut = right.start;
  assert.ok(Math.abs(cut - 16 * hz) < hz / 1000);
  assert.deepEqual(await app(page, () => window.lumenApp.studio.editor.session.getSelection()), [
    right.id,
  ]);
  await page.keyboard.press("m");
  const marker = (await snapshot(page)).markers.find(
    (m) => !initial.markers.some((o) => o.id === m.id),
  );
  assert.equal(marker.start, cut);
  await page.getByRole("textbox", { name: "Marker label", exact: true }).fill("Cut");
  await button("Rename marker").click();

  // History from the keyboard: undo the rename, then redo it.
  await surface.focus();
  await page.keyboard.press("Control+z");
  assert.equal((await snapshot(page)).markers.find((m) => m.id === marker.id).label, "Marker 3");
  await page.keyboard.press("Control+Shift+z");
  const edited = await snapshot(page);
  assert.equal(edited.markers.find((m) => m.id === marker.id).label, "Cut");
  // Both halves of the split keep the line's active take.
  assert.deepEqual(Object.fromEntries(edited.clips.map((c) => [c.id, c.activeTakeId])), {
    line: "line",
    [right.id]: "line",
    return: "line",
    bed: "bed",
    reply: "reply",
    stem: "stem",
  });

  // Save, reopen into a fresh editor and recover the same document.
  await button("Save project").click();
  await button("Reopen saved").click();
  await page.waitForFunction(
    () => document.querySelector("#status").textContent === "Saved project reopened.",
  );
  const reopened = await snapshot(page);
  assert.deepEqual(withoutRevision(reopened), withoutRevision(edited));
  assert.deepEqual(
    await app(page, () => ({
      undo: window.lumenApp.studio.editor.history.undoDepth,
      selection: window.lumenApp.studio.editor.session.getSelection(),
    })),
    { undo: 0, selection: [] },
  );
  await page.close();
  console.log(
    engine + ": pointer and keyboard edits, split, markers, history, save and reopen passed",
  );
  return { initial, edited, cut, rightId: right.id, markerId: marker.id };
}

// 2. Run the same commands headlessly and reach the same document.
function replay({ initial, edited, cut, rightId, markerId }) {
  const editor = createEditor({ project: json(initial) });
  const steps = [
    commands.moveClips({ clipIds: ["line"], delta: 2 * hz }),
    commands.trimClip({ clipId: "line", edge: "right", delta: -hz / 2 }),
    commands.moveClips({ clipIds: ["return"], delta: hz / 10 }),
    commands.trimClip({ clipId: "return", edge: "left", delta: hz / 2 }),
    commands.splitClip({ clipId: "line", at: cut, rightId }),
    commands.addMarker({ id: markerId, start: cut, label: "Marker 3" }),
    commands.updateMarker({ markerId, label: "Cut" }),
  ];
  for (const step of steps) {
    const result = editor.dispatch(step);
    assert.ok(result.ok && !result.unchanged, JSON.stringify(result));
  }
  assert.ok(editor.history.undo().ok);
  assert.ok(editor.history.redo().ok);
  assert.deepEqual(json(editor.getSnapshot()), json(edited));
  const reopened = createEditor({ project: json(edited) });
  assert.deepEqual(withoutRevision(json(reopened.getSnapshot())), withoutRevision(json(edited)));
  editor.dispose();
  reopened.dispose();
  console.log(engine + ": headless replay reached the browser's saved snapshot");
}

// 3. Play an audio-only project through silence to a marker after its last clip.
async function audioOnly(context) {
  const page = await open(context, "/examples/vanilla/audio.html");
  assert.equal(await page.locator("video").count(), 0);
  const end = 26 * hz;
  await app(
    page,
    async (tick) => {
      const { commands: c } = await import("@lumen-timeline/core");
      const { studio } = window.lumenApp;
      const result = studio.editor.dispatch(
        c.addMarker({ id: "outro", start: tick, label: "Outro" }),
      );
      if (!result.ok) throw new Error(result.reason);
      await studio.transport.seek(23.5 * 282240000);
    },
    end,
  );
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForFunction(
    (tick) => {
      const s = window.lumenApp.studio.transport.snapshot();
      return s.status === "ended" && s.presentedTick === tick;
    },
    end,
    { timeout: 20000 },
  );
  assert.equal(await page.locator("#marker-cue").textContent(), "Outro");
  assert.equal(await app(page, () => window.lumenApp.studio.transport.snapshot().playing), false);
  await page.close();
  console.log(engine + ": audio-only playback ran through silence to the closing marker");
}

try {
  const context = await browser.newContext({ viewport: { width: 1120, height: 1000 } });
  const session = await editSession(context);
  replay(session);
  await audioOnly(context);
  await context.close();
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
