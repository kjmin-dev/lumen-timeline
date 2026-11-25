// Milestone 6's exit criteria for the example editors, against the built site:
//
// - both example editors, the dubbing studio and the podcast editor, are built on the
//   packages' public entry points only;
// - the audio-only podcast editor combines overlapping voices, music, chapter markers and a gain
//   inspector, each driven here through the screen itself.
//
// The screen hands its editor and transport to `window.lumenExample`, public package objects, so
// the trace can read what the screen did without reaching into it.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { chromium } from "playwright";
import { startStaticServer } from "./serve.mjs";

const repo = resolve(import.meta.dirname, "../../..");
const dist = resolve(import.meta.dirname, "../dist");
const hz = 282_240_000;

/** Every module specifier a source file imports or re-exports. */
function specifiers(file) {
  const text = readFileSync(file, "utf8");
  const found = [];
  for (const match of text.matchAll(/(?:import|export)\s[^"';]*?from\s*["']([^"']+)["']/g))
    found.push(match[1]);
  for (const match of text.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) found.push(match[1]);
  for (const match of text.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) found.push(match[1]);
  return found;
}

/** The files of an example: its own modules, followed from its entry through relative imports. */
function moduleGraph(entry) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of specifiers(file)) {
      if (!specifier.startsWith(".")) continue;
      visit(resolve(file, "..", specifier));
    }
  };
  visit(entry);
  return [...seen];
}

// The entry points the packages publish: their roots, the timeline's stylesheet and the media
// package's optional stretch engine. `internal` is for the packages' own tests.
const PUBLIC = new Set([
  "@lumen-timeline/core",
  "@lumen-timeline/media",
  "@lumen-timeline/media/signalsmith",
  "@lumen-timeline/timeline",
  "@lumen-timeline/timeline/style.css",
  "@lumen-timeline/react",
  "@lumen-timeline/sync",
]);

describe("milestone 6 example editors", () => {
  it("build the dubbing studio and the podcast editor on public entry points only", () => {
    const examples = resolve(repo, "apps/docs/src/demos/examples");
    const editors = {
      "dubbing studio (vanilla)": resolve(repo, "examples/vanilla/app.mjs"),
      "dubbing studio (docs)": join(examples, "DubbingStudio.tsx"),
      "podcast editor (docs)": join(examples, "PodcastEditor.tsx"),
    };
    for (const [name, entry] of Object.entries(editors)) {
      const files = moduleGraph(entry);
      assert.ok(files.length > 1, name);
      for (const file of files) {
        assert.ok(!file.includes("/packages/"), `${name} reaches into ${file}`);
        for (const specifier of specifiers(file)) {
          if (!specifier.startsWith("@lumen-timeline/")) continue;
          assert.ok(PUBLIC.has(specifier), `${name}: ${file} imports ${specifier}`);
        }
      }
    }
    // Every example screen in the docs, not only the two editors.
    for (const file of readdirSync(examples)) {
      for (const specifier of specifiers(join(examples, file))) {
        if (specifier.startsWith("@lumen-timeline/"))
          assert.ok(PUBLIC.has(specifier), `${file} imports ${specifier}`);
      }
    }
  });

  it("combine overlapping voices, music, chapter markers and a gain inspector in the podcast editor", async () => {
    const server = await startStaticServer(dist);
    const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
      });
      await page.goto(`${server.url}/demo/podcast/`);
      await page.locator('[data-demo-ready="podcast"]').waitFor({ timeout: 20000 });
      const state = () =>
        page.evaluate(() => {
          const { editor } = window.lumenExample;
          const snapshot = editor.getSnapshot();
          return {
            clips: snapshot.clips.map((clip) => ({
              id: clip.id,
              trackId: clip.trackId,
              start: clip.start,
              end: clip.start + clip.duration,
              contentIn: clip.contentIn,
              gain: clip.gain,
            })),
            markers: (snapshot.markers ?? []).map((marker) => ({ ...marker })),
            tracks: snapshot.tracks.map((track) => ({ id: track.id, gain: track.gain })),
            selection: editor.session.getSelection(),
            undoDepth: editor.history.undoDepth,
          };
        });
      const plan = (start, end) =>
        page.evaluate(
          ([from, to]) => {
            const { editor, transport } = window.lumenExample;
            return editor
              .read()
              .planAudio({ start: from, end: to }, transport.catalog)
              .spans.map((span) => ({
                clipId: span.clipId,
                trackId: span.trackId,
                gain: span.gain,
              }));
          },
          [start, end],
        );
      const opened = await state();

      // Overlapping voices: the guest comes in on the host's last word, on a track of its own.
      const host = opened.clips.find((clip) => clip.id === "p5");
      const guest = opened.clips.find((clip) => clip.id === "p6");
      assert.ok(host && guest && host.trackId === "host" && guest.trackId === "guest");
      assert.ok(guest.start < host.end, "the guest talks over the host");
      const overlap = await plan(guest.start, host.end);
      assert.deepEqual(overlap.map((span) => span.clipId).sort(), ["p5", "p6"]);
      // ...and the transport plays both at once.
      await page.evaluate(
        (tick) => window.lumenExample.transport.seek(tick),
        guest.start - Math.round(0.4 * hz),
      );
      await page.locator(".ex-play").click();
      await page.waitForFunction(
        ([from, to]) => {
          const { transport } = window.lumenExample;
          const tick = transport.snapshot().presentedTick;
          return (
            tick > from &&
            tick < to &&
            transport.diagnostics("p5").segments > 0 &&
            transport.diagnostics("p6").segments > 0
          );
        },
        [guest.start, host.end],
        { timeout: 5000 },
      );
      await page.locator(".ex-play").click();
      // Both speakers' words under the playhead are marked in the transcript.
      await page.evaluate((tick) => window.lumenExample.transport.seek(tick), guest.start + hz / 5);
      await page.waitForFunction(() => document.querySelectorAll("[data-now]").length === 2);

      // Music: the theme plays under the host's opening words, at the music track's gain.
      const opening = opened.clips.find((clip) => clip.id === "p1");
      assert.ok(opening);
      const bed = await plan(opening.start, opening.start + hz);
      const music = opened.tracks.find((track) => track.id === "music");
      assert.deepEqual(bed.map((span) => [span.clipId, span.gain]).sort(), [
        ["p1", 1],
        ["theme-in", music?.gain],
      ]);

      // Chapter markers: each heads its paragraph in the transcript and is renamed there.
      assert.equal(opened.markers.length, 3);
      assert.equal(await page.locator('.pod-page h4 input[aria-label="Chapter title"]').count(), 3);
      const title = page.locator('.pod-page h4 input[aria-label="Chapter title"]').nth(2);
      await title.fill("Listening for health");
      await title.press("Enter");
      await page.waitForFunction(() =>
        window.lumenExample.editor
          .getSnapshot()
          .markers?.some((m) => m.label === "Listening for health"),
      );

      // The gain inspector: the speaker's name selects the paragraph, and the level is its gain.
      const level = page.locator("[data-pod-level]");
      assert.equal(await level.locator("input").isDisabled(), true);
      await page.locator("section", { hasText: "Pretty much" }).locator(".pod-speaker").click();
      assert.deepEqual((await state()).selection, ["p6"]);
      assert.equal(await level.locator("[data-pod-db]").textContent(), "0.0 dB");
      // A drag is heard as it moves and is one undo step.
      const before = (await state()).undoDepth;
      const slider = await level.locator("input").boundingBox();
      assert.ok(slider);
      const y = slider.y + slider.height / 2;
      const zero = slider.x + (slider.width * 24) / 36;
      await page.mouse.move(zero, y);
      await page.mouse.down();
      for (let i = 1; i <= 6; i++) await page.mouse.move(zero - i * 6, y);
      await page.mouse.move(slider.x + (slider.width * 18) / 36, y);
      await page.mouse.up();
      const turned = await state();
      const gain = turned.clips.find((clip) => clip.id === "p6")?.gain;
      assert.ok(gain !== undefined && gain < 0.6 && gain > 0.4, `gain ${gain}`);
      assert.equal(turned.undoDepth, before + 1);
      const shown = await level.locator("[data-pod-db]").textContent();
      assert.equal(shown, `−${Math.abs(20 * Math.log10(gain)).toFixed(1)} dB`);
      const heard = await plan(guest.start, guest.end);
      assert.equal(heard.find((span) => span.clipId === "p6")?.gain, gain);
      // The keyboard changes it a half decibel a step.
      await level.locator("input").press("ArrowRight");
      const stepped = (await state()).clips.find((clip) => clip.id === "p6")?.gain;
      assert.ok(stepped !== undefined && Math.abs(20 * Math.log10(stepped / gain) - 0.5) < 1e-9);
      await page.locator('button[aria-label="Undo"]').click();
      await page.locator('button[aria-label="Undo"]').click();
      assert.equal((await state()).clips.find((clip) => clip.id === "p6")?.gain, undefined);
      assert.equal(await level.locator("[data-pod-db]").textContent(), "0.0 dB");

      // A cut where the speakers overlap takes whole words from both: the host's last word and
      // the guest's two over it. The guest's next word then starts where the host's cut did, and
      // everything after moves left by the time taken. The chapter before the cut stays.
      const words = await page.locator("[data-word]").count();
      await page.locator('[data-word="p5:9"]').click();
      const picked = await page.locator("[data-picked]").allTextContents();
      assert.deepEqual(picked, ["listening?", "Pretty", "much."]);
      await page.locator("[data-pod-cut]").click();
      assert.equal(await page.locator("[data-word]").count(), words - 3);
      const cut = await state();
      const hostEnd = cut.clips.find((clip) => clip.id === "p5")?.end;
      const rest = cut.clips.find((clip) => clip.trackId === "guest" && clip.start === hostEnd);
      assert.ok(hostEnd !== undefined && rest, "the guest's next word follows the host's cut");
      // Where that word was before the cut, from the piece's own content position.
      const taken = guest.start + rest.contentIn - rest.start;
      assert.ok(taken > host.end - hostEnd, "the cut took more than the host's word");
      const ending = (clips) => clips.find((clip) => clip.id === "p7")?.start;
      assert.equal(ending(cut.clips), (ending(opened.clips) ?? 0) - taken);
      const chapter = (markers) => markers.find((m) => m.id === "ch-3")?.start;
      assert.equal(chapter(cut.markers), chapter(opened.markers));
      await page.locator('button[aria-label="Undo"]').click();
      assert.equal(await page.locator("[data-word]").count(), words);

      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  });
});
