// Verifies time-stretched playback with the real Signalsmith Stretch library.
// Usage: node examples/vanilla/verify-stretch.mjs [chromium|firefox|webkit]
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { serve } from "./server.mjs";

const engine = process.argv[2] ?? "chromium";
const server = await serve();
const browser = await { chromium, firefox, webkit }[engine].launch();

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url + "/examples/vanilla/stretch.html");
  const lab = await page.evaluateHandle(() => import("./stretch.mjs"));

  // Renderings: the exact length, the tone's pitch and each burst's position.
  const renderings = await lab.evaluate((m) => m.measureRenderings([0.8, 1.25, 0.5, 2]));
  for (const r of renderings) {
    assert.equal(r.length, r.expectedLength, `rate ${r.rate}: length`);
    assert.equal(r.sampleRate, 48000);
    assert.ok(Math.abs(r.hz - 440) < 440 * 0.005, `rate ${r.rate}: pitch ${r.hz.toFixed(2)} Hz`);
    // The stretcher smears a burst over its analysis window, so its energy
    // lands about a millisecond after the position the rate maps it to.
    const worst = Math.max(...r.offsetsMs.map(Math.abs));
    const mean = r.offsetsMs.reduce((sum, ms) => sum + ms, 0) / r.offsetsMs.length;
    assert.ok(r.offsetsMs.length >= 8, `rate ${r.rate}: bursts measured`);
    assert.ok(worst < 2.5, `rate ${r.rate}: burst ${worst.toFixed(2)} ms from its mapped position`);
    assert.ok(Math.abs(mean) < 1.5, `rate ${r.rate}: bursts ${mean.toFixed(2)} ms late on average`);
    assert.ok(r.cached, `rate ${r.rate}: a repeated request reuses the rendering`);
    console.log(
      `${engine}: rate ${r.rate} keeps ${r.hz.toFixed(2)} Hz, bursts within ${worst.toFixed(2)} ms, ` +
        `rendered 3 s of source in ${r.renderMs.toFixed(0)} ms`,
    );
  }

  // Playback: varispeed raises the pitch with the rate; the stretch engine keeps it.
  await page.getByRole("button", { name: "Start audio" }).click();
  const plain = await lab.evaluate((m) => m.measurePlayback(1.25, false));
  assert.deepEqual(plain.errors, []);
  assert.ok(Math.abs(plain.hz - 550) < 550 * 0.01, `varispeed plays ${plain.hz.toFixed(1)} Hz`);
  const kept = await lab.evaluate((m) => m.measurePlayback(1.25, true));
  assert.deepEqual(kept.errors, []);
  assert.deepEqual(kept.stretches, [Math.round((4 * 48000) / 1.25)]);
  assert.ok(
    Math.abs(kept.hz - 440) < 440 * 0.01,
    `stretched playback plays ${kept.hz.toFixed(1)} Hz`,
  );
  console.log(
    `${engine}: a 440 Hz line at rate 1.25 plays ${plain.hz.toFixed(1)} Hz as varispeed ` +
      `and ${kept.hz.toFixed(1)} Hz stretched`,
  );
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
