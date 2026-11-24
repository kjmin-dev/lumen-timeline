// The three-hour session in a real browser: 2 stems and 2,400 lines read in
// ten-second chunks through a reader that authenticates with expiring tokens.
// Playback starts and every seek lands with its audio loaded, decoded audio
// stays within the cache budget across seeks over the whole session, chunk
// edges join without a gap, tokens refresh without a failed read, and the
// whole session draws its waveforms from overviews without reading samples.
// Usage: node examples/vanilla/verify-long.mjs [chromium|firefox|webkit] [--record]   (build first)
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import os from "node:os";
import { chromium, firefox, webkit } from "playwright";
import { serve } from "./server.mjs";

const engine = process.argv[2]?.startsWith("--") ? "chromium" : (process.argv[2] ?? "chromium");
const record = process.argv.includes("--record");
const hz = 282240000;
const server = await serve();
const browser = await { chromium, firefox, webkit }[engine].launch(
  engine === "chromium" ? { args: ["--autoplay-policy=no-user-gesture-required"] } : {},
);
const errors = [];

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.message));
  // Tokens last eight seconds, so the run refreshes several.
  await page.goto(server.url + "/examples/vanilla/long.html?ttl=8&budget=192");
  await page.waitForFunction(() => window.lumenLong?.ready === true, null, { timeout: 60000 });
  const long = await page.evaluateHandle(() => window.lumenLong);

  // The timeline's own transport button starts playback, as a user gesture.
  await page.locator("[data-play]").click();
  await page.waitForFunction((l) => l.transport.snapshot().presentedTick > 3 * 282240000, long, {
    timeout: 30000,
  });
  const started = await long.evaluate((l) => l.transport.playback());
  assert.equal(started.lateStarts, 0, "play starts with its audio");

  // Seeks across the session, some to places already visited.
  const targets = [10740, 5400, 300.25, 10740, 7777.7, 1234.5, 9999.9, 5400, 42, 8888.8];
  const seeks = [];
  let peakBytes = 0;
  for (const seconds of targets) {
    const result = await long.evaluate(
      async (l, target) => {
        // Warm when the stem's audio at the target is still in the cache.
        const frame = (target / 282240000) * 48000;
        const warm = l.media
          .loaded("stem", "main", 1)
          .some((span) => span.start <= frame && frame + 48000 <= span.end);
        const began = performance.now();
        const outcome = await l.transport.seek(target);
        const landed = performance.now() - began;
        return { outcome, landed, warm, presented: l.transport.snapshot().presentedTick };
      },
      Math.round(seconds * hz),
    );
    assert.equal(result.outcome, "arrived");
    assert.ok(result.presented >= Math.round(seconds * hz), "presented from the target");
    // Play a second and a half past it, across a chunk edge for most targets.
    await page.waitForFunction(
      ({ l, tick }) => l.transport.snapshot().presentedTick >= tick + 1.5 * 282240000,
      { l: long, tick: Math.round(seconds * hz) },
      { timeout: 30000 },
    );
    const stats = await long.evaluate((l) => l.media.diagnostics());
    peakBytes = Math.max(peakBytes, stats.peakBytes);
    assert.ok(stats.bytes <= stats.budgetBytes, `cache at ${stats.bytes} bytes`);
    seeks.push({ seconds, ms: Math.round(result.landed), warm: result.warm });
  }

  // Ten seconds of continuous playback across chunk edges.
  const from = await long.evaluate((l) => l.transport.snapshot().presentedTick);
  await page.waitForFunction(
    ({ l, tick }) => l.transport.snapshot().presentedTick >= tick + 10 * 282240000,
    { l: long, tick: from },
    { timeout: 30000 },
  );
  const timing = await long.evaluate((l) => l.transport.playback());
  assert.equal(timing.underruns, 0, "no chunk arrived after its segment was due");
  assert.equal(timing.lateStarts, 0, "no voice started late");
  assert.ok(timing.seams > 0, "segments joined at chunk edges");

  // The whole session draws from the overviews and builds no tiles.
  const before = await long.evaluate((l) => l.tiles.diagnostics());
  await page.getByRole("button", { name: "Whole session", exact: true }).click();
  const whole = await long.evaluate(async (l) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await l.tiles.idle();
    return {
      tiles: l.tiles.diagnostics(),
      viewport: l.view.getViewport(),
    };
  });
  assert.ok(whole.viewport.pixelsPerSecond < 0.2);
  assert.deepEqual(whole.tiles.batches, before.batches, "zoomed out, no tile was built");

  const cache = await long.evaluate((l) => l.media.diagnostics());
  const tokens = await long.evaluate((l) => l.auth.refreshes);
  const served = await (await fetch(server.url + "/media/long/stats")).json();
  assert.equal(cache.failures, 0, "every read succeeded, refreshing tokens as needed");
  assert.ok(tokens >= 2, "tokens were refreshed");
  assert.ok(served.unauthorized >= 1, "an expired token was refused and refreshed");
  assert.ok(cache.peakBytes <= cache.budgetBytes);
  // Chromium reports the JavaScript heap; decoded audio lives outside it.
  let heap = null;
  if (engine === "chromium") {
    const client = await page.context().newCDPSession(page);
    await client.send("Performance.enable");
    const { metrics } = await client.send("Performance.getMetrics");
    heap = metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? null;
  }
  await page.close();
  assert.deepEqual(errors, []);

  const cold = seeks.filter((s) => !s.warm).map((s) => s.ms);
  const warm = seeks.filter((s) => s.warm).map((s) => s.ms);
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  };
  const summary = {
    engine,
    browser: browser.version(),
    budgetBytes: cache.budgetBytes,
    peakBytes: cache.peakBytes,
    chunkLoads: cache.loads,
    evictions: cache.evictions,
    abortedReads: cache.aborted,
    tokenRefreshes: tokens,
    refusedReads: served.unauthorized,
    seeks,
    seekToSoundMs: { coldMedian: median(cold), warmMedian: median(warm) },
    timing,
    jsHeapBytes: heap,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (record) {
    writeFileSync(
      new URL("../../docs/measurements/long-media.json", import.meta.url),
      JSON.stringify(
        {
          recorded: new Date().toISOString(),
          machine: {
            platform: `${os.type()} ${os.release()} ${os.arch()}`,
            cpu: os.cpus()[0]?.model ?? null,
            cores: os.cpus().length,
            memory: os.totalmem(),
          },
          ...summary,
        },
        null,
        2,
      ) + "\n",
    );
  }
  console.log(engine + ": three-hour session passed");
} finally {
  await browser.close();
  await server.close();
}
