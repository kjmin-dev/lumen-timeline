// Verifies the external-player guide with the page it describes, `external.html`: a timeline that
// follows a player owning its own media element, and one that follows an embedded player through
// the adapter in `embed-transport.mjs`.
// Usage: node examples/vanilla/verify-external.mjs [chromium|firefox|webkit]
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { serve } from "./server.mjs";

const hz = 282_240_000;
const engine = process.argv[2] ?? "chromium";
const server = await serve();
const browser = await { chromium, firefox, webkit }[engine].launch(
  engine === "chromium" ? { args: ["--autoplay-policy=no-user-gesture-required"] } : {},
);

try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.goto(server.url + "/examples/vanilla/external.html");
  await page.waitForFunction(() => window.lumenExternal?.ready);
  await page.waitForFunction(() => document.querySelector("#element video").readyState >= 2);
  const ext = (fn, arg) => page.evaluate(fn, arg);

  /** Clicks a timeline's ruler at `seconds`. */
  async function rulerAt(section, which, seconds) {
    const ruler = page.locator(`#${section} .lt-ruler`);
    const box = await ruler.boundingBox();
    const { startTick, pixelsPerSecond } = await ext(
      (name) => window.lumenExternal[name].view.getViewport(),
      which,
    );
    await ruler.click({
      position: { x: (seconds - startTick / hz) * pixelsPerSecond, y: box.height / 2 },
    });
  }

  // ------------------------------------------- 1. a player that owns its element

  const element = page.locator("#element .player");
  // The player's own play button: the transport follows the element.
  await element.locator("[data-player-play]").click();
  await page.waitForFunction(() => {
    const { transport } = window.lumenExternal.element;
    const state = transport.snapshot();
    return state.playing && state.presentedTick > 2.5 * 282240000;
  });
  // The project's own audio plays against the element's clock.
  const booked = await ext(() => {
    const { transport, video } = window.lumenExternal.element;
    return {
      segments: transport.diagnostics("narration").segments,
      drift: Math.abs(transport.snapshot().presentedTick / 282240000 - video.currentTime),
    };
  });
  assert.ok(booked.segments > 0, "the narration clip is booked while the video plays");
  assert.ok(booked.drift < 0.1, `the transport follows the element (${booked.drift.toFixed(3)} s)`);

  // The player's own scrub bar moves the element; the transport presents where it went.
  await element.locator("[data-player-scrub]").evaluate((input) => {
    input.value = "10";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const state = window.lumenExternal.element.transport.snapshot();
    return (
      state.requestedTick === null &&
      state.presentedTick >= 10 * 282240000 &&
      state.presentedTick < 11 * 282240000
    );
  });

  // The timeline's ruler seeks the element.
  await rulerAt("element", "element", 4);
  await page.waitForFunction(() => {
    const { transport, video } = window.lumenExternal.element;
    const state = transport.snapshot();
    return (
      state.requestedTick === null &&
      Math.abs(video.currentTime - 4) < 0.6 &&
      state.presentedTick >= 4 * 282240000 - 282240000 / 10
    );
  });

  // The player's own pause leaves the transport on the frame the element last presented, which is
  // what the picture shows. WebKit's currentTime can lag that frame by up to two frames on a
  // loaded machine, so the element's time only bounds it.
  await ext(() => {
    const { video } = window.lumenExternal.element;
    const shown = (_, frame) => {
      window.lastShown = frame.mediaTime;
      video.requestVideoFrameCallback(shown);
    };
    video.requestVideoFrameCallback(shown);
  });
  await page.waitForFunction(
    () => window.lumenExternal.element.transport.snapshot().presentedTick > 4.6 * 282240000,
  );
  await element.locator("[data-player-play]").click();
  await page.waitForFunction(() => !window.lumenExternal.element.transport.snapshot().playing);
  const [presented, shown, time] = await ext(async () => {
    const { transport, video } = window.lumenExternal.element;
    // Any frame the pause itself presents arrives within a frame or two.
    for (let i = 0; i < 3; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
    return [transport.snapshot().presentedTick, window.lastShown, video.currentTime];
  });
  const frame = (presented / hz) * 10;
  assert.ok(Math.abs(frame - Math.round(frame)) < 1e-6, `${presented} is a frame's start`);
  assert.equal(
    presented,
    Math.round(shown * hz),
    `paused at ${presented / hz} s, shown ${shown} s`,
  );
  assert.ok(
    Math.abs(presented / hz - time) <= 0.25,
    `paused at ${presented / hz} s, the element at ${time} s`,
  );
  console.log(
    `${engine}: a timeline followed the player's own play, scrub and pause, and seeked it`,
  );

  // ----------------------------------------------- 2. an embed through the adapter

  // Record every report the adapter makes while the embed plays for a second and a half.
  await ext(() => {
    const { transport, player } = window.lumenExternal.embed;
    const log = (window.embedLog = { states: [], reports: new Set(), worst: 0, since: 0 });
    transport.subscribe((state) => {
      const now = performance.now();
      log.states.push({ ...state, at: now });
      log.reports.add(player.getCurrentTime());
      if (state.playing && log.since && now - log.since > 300) {
        const error = Math.abs(state.presentedTick / 282240000 - player.truePosition());
        log.worst = Math.max(log.worst, error);
      }
      if (state.playing && !log.since) log.since = now;
    });
  });
  await page.locator("#embed [data-player-play]").click();
  await page.waitForFunction(() => window.lumenExternal.embed.transport.snapshot().playing);
  await page.waitForTimeout(1500);
  const played = await ext(() => {
    const { states, reports, worst } = window.embedLog;
    const playing = states.filter((state) => state.playing);
    const ticks = playing.map((state) => state.presentedTick);
    return {
      frames: playing.length,
      distinct: new Set(ticks).size,
      reports: reports.size,
      backwards: ticks.some((tick, i) => i > 0 && tick < ticks[i - 1]),
      worst,
    };
  });
  assert.ok(played.frames >= 30, `the adapter reports every frame (${played.frames})`);
  assert.ok(
    played.distinct > played.reports * 3,
    `${played.distinct} positions from ${played.reports} reports`,
  );
  assert.equal(played.backwards, false, "the playhead never steps back while playing");
  assert.ok(played.worst < 0.05, `within ${played.worst.toFixed(3)} s of the player`);

  // The ruler seeks the embed. The seek is done once the player reports the target, and the
  // tick asked for is the one presented.
  await rulerAt("embed", "embed", 7.5);
  await page.waitForFunction(() => {
    const state = window.lumenExternal.embed.transport.snapshot();
    return state.requestedTick === null && state.presentedTick >= 7.4 * 282240000;
  });
  const sought = await ext(() => {
    const { states } = window.embedLog;
    const asked = states.findLast((state) => state.requestedTick !== null)?.requestedTick;
    const landed = states.find(
      (state, i) => i > 0 && states[i - 1].requestedTick === asked && state.requestedTick === null,
    );
    return { asked, landed: landed?.presentedTick };
  });
  assert.ok(Math.abs(sought.asked / hz - 7.5) < 0.05, `asked for ${sought.asked / hz} s`);
  assert.equal(sought.landed, sought.asked);

  // The embed's own pause: the adapter stops exactly where the player did.
  await page.locator("#embed [data-player-play]").click();
  await page.waitForFunction(() => !window.lumenExternal.embed.transport.snapshot().playing);
  const halted = await ext(() => {
    const { transport, player } = window.lumenExternal.embed;
    return [transport.snapshot().presentedTick, Math.round(player.truePosition() * 282240000)];
  });
  assert.equal(halted[0], halted[1]);

  // A seek while paused stays where it landed.
  await rulerAt("embed", "embed", 3.1);
  await page.waitForFunction(
    () => window.lumenExternal.embed.transport.snapshot().requestedTick === null,
  );
  await page.waitForTimeout(400);
  const held = await ext(() => {
    const { states } = window.embedLog;
    return [
      states.findLast((state) => state.requestedTick !== null)?.requestedTick,
      window.lumenExternal.embed.transport.snapshot().presentedTick,
    ];
  });
  assert.equal(held[1], held[0]);
  console.log(
    `${engine}: an embed reporting ${played.reports} positions drew ${played.distinct} playhead positions, ` +
      `within ${(played.worst * 1000).toFixed(0)} ms of it, and its seeks presented the tick asked for`,
  );

  await ext(() => window.lumenExternal.dispose());
  assert.equal(await page.locator(".lt").count(), 0);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
