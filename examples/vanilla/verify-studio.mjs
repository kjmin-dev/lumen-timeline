// Milestone 3 acceptance: edit a line, generate, audition and apply a take,
// split, regenerate only the right half, undo and reopen, then reproduce a
// stale generation result. Usage: node examples/vanilla/verify-studio.mjs
// [chromium|firefox|webkit]   (build first)
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { serve } from "./server.mjs";

const hz = 282240000;
const engine = process.argv[2] ?? "chromium";
const server = await serve();
const browser = await { chromium, firefox, webkit }[engine].launch();
const errors = [];

const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
page.on("pageerror", (error) => errors.push(error.message));
const app = (fn, arg) => page.evaluate(fn, arg);
const button = (name) => page.getByRole("button", { name, exact: true });
const snapshot = () => app(() => window.lumenApp.studio.editor.getSnapshot());
const clip = async (id) => (await snapshot()).clips.find((c) => c.id === id);
const take = async (id) => (await snapshot()).takes.find((t) => t.id === id);
const status = () => page.locator("#status").textContent();
// A fingerprint of the decoded samples the host supplies for an asset.
const fingerprint = (assetId) =>
  app(async (id) => {
    const buffer = await window.lumenApp.studio.assets.resolveBuffer({ assetId: id });
    const pcm = buffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += Math.abs(pcm[i]) * ((i % 97) + 1);
    return [buffer.sampleRate, buffer.length, Math.round(sum * 1e6)];
  }, assetId);
// What the clip plays over its own range, from the reopened editor and catalog.
const planned = (clipId) =>
  app((id) => {
    const { editor, transport } = window.lumenApp.studio;
    const c = editor.getSnapshot().clips.find((x) => x.id === id);
    const plan = editor
      .read()
      .planAudio({ start: c.start, end: c.start + c.duration }, transport.catalog);
    return {
      issues: plan.issues,
      spans: plan.spans
        .filter((s) => s.clipId === id)
        .map((s) => [s.takeId, s.assetId, s.audible.start, s.audible.end, s.audible.sourceStart]),
    };
  }, clipId);
// Clicks Generate and returns the report of that job, applied or rejected.
async function generate() {
  await app(() => {
    document.querySelector("#status").textContent = "";
  });
  await button("Generate take").click();
}
async function generated() {
  await page.waitForFunction(
    () => /^Generat(ed|ion) \d+/.test(document.querySelector("#status").textContent),
    null,
    { timeout: 15000 },
  );
  return status();
}
// Auditions a take and waits for the panel's report of the result.
async function audition(name) {
  await app(() => {
    document.querySelector("#status").textContent = "";
  });
  await button("Audition " + name).click();
  await page.waitForFunction(() => window.lumenApp.studio.transport.snapshot().audition !== null);
  await page.waitForFunction(
    () => document.querySelector("#status").textContent.startsWith("Audition "),
    null,
    { timeout: 15000 },
  );
}

try {
  await page.goto(server.url);
  await page.waitForSelector(".lt-edit");
  await app(async () => {
    window.lumenApp = await import("./app.mjs");
  });

  // 1. Edit the line's text: one edit that advances its revision.
  await page.getByLabel("Clip navigator").selectOption("line");
  assert.equal(
    await page.locator(".line-source").textContent(),
    "La marée revient. Regarde les courbes dériver sur l'anse.",
  );
  const text = "The tide comes back. See the contours drift over the inlet.";
  await page.getByLabel("Line text").fill(text);
  await button("Save text").click();
  assert.deepEqual((await snapshot()).entityData["studio.line"]["line-1"], {
    source: "La marée revient. Regarde les courbes dériver sur l'anse.",
    text,
    revision: 1,
  });

  // 2. Generate a take for the line. It joins the list without playing.
  await generate();
  assert.equal(await generated(), "Generated 1 added.");
  const first = (await clip("line")).takeIds.at(-1);
  const firstTake = await take(first);
  assert.deepEqual(firstTake.extensions["studio.generation"].request, {
    number: 1,
    clipId: "line",
    lineId: "line-1",
    text,
    revision: 1,
    in: hz,
    out: 5 * hz,
  });
  assert.equal(firstTake.sourceAtContentZero, -hz);
  assert.equal((await clip("line")).activeTakeId, "line");

  // 3. Audition it alone, then apply it.
  await page.evaluate(() => window.lumenApp.studio.transport.seek(3 * 282240000));
  await page.getByLabel("Isolated").check();
  await audition("Generated 1");
  assert.equal(await status(), "Audition finished.");
  assert.equal(
    (await app(() => window.lumenApp.studio.transport.snapshot())).presentedTick,
    3 * hz,
  );
  await button("Apply Generated 1").click();
  assert.equal((await clip("line")).activeTakeId, first);

  // 4. Split the line at 14 s from the keyboard. Both halves share the list.
  await page.evaluate(() => window.lumenApp.studio.transport.seek(14 * 282240000));
  await page.getByRole("group", { name: "Timeline clips" }).focus();
  await page.keyboard.press("s");
  const [right] = await app(() => window.lumenApp.studio.editor.session.getSelection());
  const left = await clip("line");
  assert.equal((await clip(right)).start, 14 * hz);
  assert.equal((await clip(right)).lineId, "line-1");
  assert.deepEqual((await clip(right)).takeIds, left.takeIds);
  const leftAudio = await planned("line");

  // 5. Regenerate only the right half and apply the result there.
  await generate();
  assert.equal(await generated(), "Generated 2 added.");
  const second = (await clip(right)).takeIds.at(-1);
  assert.deepEqual(
    [
      (await take(second)).extensions["studio.generation"].request.in,
      (await take(second)).extensions["studio.generation"].request.out,
    ],
    [3 * hz, 5 * hz],
  );
  await button("Apply Generated 2").click();
  assert.equal((await clip(right)).activeTakeId, second);
  assert.deepEqual(await clip("line"), left, "the left half changed");
  assert.deepEqual(await planned("line"), leftAudio);

  // 6. Undo the apply; the right half's new candidate stays listed.
  await page.getByRole("group", { name: "Timeline clips" }).focus();
  await page.keyboard.press("Control+z");
  assert.equal((await clip(right)).activeTakeId, first);
  assert.deepEqual((await clip(right)).takeIds, [...left.takeIds, second]);

  // 7. Save and reopen: the left half plays the same samples, and both lists survive.
  const before = {
    left: await clip("line"),
    right: await clip(right),
    audio: await fingerprint("generated-1"),
  };
  await button("Save project").click();
  await button("Reopen saved").click();
  await page.waitForFunction(
    () => document.querySelector("#status").textContent === "Saved project reopened.",
  );
  assert.deepEqual(await clip("line"), before.left);
  assert.deepEqual(await clip(right), before.right);
  assert.deepEqual(
    await fingerprint("generated-1"),
    before.audio,
    "the generated asset was not rebuilt",
  );
  const reopened = await planned("line");
  assert.deepEqual(reopened, leftAudio);
  assert.deepEqual(reopened.issues, []);
  assert.deepEqual(
    reopened.spans.map(([takeId, assetId]) => [takeId, assetId]),
    [[first, "generated-1"]],
  );

  // 8. A stale result: the text changes while the right half's take is generated.
  await app(() => {
    window.lumenApp.studio.generation.latency = 1500;
  });
  await page.getByLabel("Clip navigator").selectOption(right);
  const depth = await app(() => window.lumenApp.studio.editor.history.undoDepth);
  await generate();
  await page.getByLabel("Line text").fill("The tide returns.");
  await button("Save text").click();
  assert.equal(await generated(), "Generation 3 rejected: The line changed after the request.");
  // The current line keeps its candidates and its active take; the job log keeps the result.
  assert.deepEqual((await clip(right)).takeIds, before.right.takeIds);
  assert.equal((await clip(right)).activeTakeId, first);
  assert.ok(!(await snapshot()).takes.some((t) => t.assetId === "generated-3"));
  assert.equal(await app(() => window.lumenApp.studio.editor.history.undoDepth), depth + 1);
  const jobs = await app(() =>
    window.lumenApp.studio.generation.jobs().map((j) => [j.number, j.status, j.assetId]),
  );
  assert.deepEqual(jobs[0], [3, "rejected", "generated-3"]);
  assert.match(
    await page.getByRole("list", { name: "Generation jobs" }).textContent(),
    /#3 .* rejected/,
  );
  console.log(
    engine +
      ": edit, generate, audition, apply, split, regenerate, undo, reopen and stale result passed",
  );
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
