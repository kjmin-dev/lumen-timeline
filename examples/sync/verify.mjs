// One project edited from several tabs of one browser with no backend: edits
// at once, a rejected overlap, a tab going offline and returning under queue
// and under online, a held edit under confirmed, and the leading tab closing.
// Every tab ends on the same document. Usage:
// node examples/sync/verify.mjs [chromium|firefox|webkit]   (build first)
import assert from "node:assert/strict";
import { createEditor } from "@lumen-timeline/core";
import { chromium, firefox, webkit } from "playwright";
import { serve } from "../vanilla/server.mjs";

const hz = 282240000;
const engine = process.argv[2] ?? "chromium";
const server = await serve();
const browser = await { chromium, firefox, webkit }[engine].launch();
const errors = [];
// Tabs of one context share BroadcastChannel and Web Locks, as tabs of one browser do.
const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });

async function open(policy, extra = "") {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url + "/examples/sync/index.html?policy=" + policy + extra);
  await page.waitForFunction(() => window.syncApp?.session.status === "connected", null, {
    timeout: 15000,
  });
  await page.waitForSelector(".lt-edit");
  return page;
}
const run = (page, fn, arg) => page.evaluate(fn, arg);
const documentOf = (page) =>
  run(page, () => {
    const { revision: _revision, ...rest } = window.syncApp.session.editor.getSnapshot();
    return JSON.parse(JSON.stringify(rest));
  });
const dispatch = (page, command) =>
  run(
    page,
    async ([type, args]) => {
      const { commands } = await import("@lumen-timeline/core");
      const result = window.syncApp.session.editor.dispatch(commands[type](args));
      return { ok: result.ok, held: result.held ?? false, code: result.ok ? null : result.code };
    },
    command,
  );
const startOf = async (page, clipId) =>
  (await documentOf(page)).clips.find((clip) => clip.id === clipId)?.start;
const log = (page) => page.locator("#log li").allTextContents();

// Waits until every tab is connected, idle and at the same confirmed revision,
// then checks that they hold the same document, one that opens without error.
async function same(pages) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const states = await Promise.all(
      pages.map((page) =>
        run(page, () => ({
          status: window.syncApp.session.status,
          pending: window.syncApp.session.pending,
          revision: window.syncApp.session.revision,
        })),
      ),
    );
    if (
      states.every(
        (s) => s.status === "connected" && s.pending === 0 && s.revision === states[0].revision,
      )
    ) {
      const documents = await Promise.all(pages.map(documentOf));
      for (const document of documents.slice(1)) assert.deepEqual(document, documents[0]);
      createEditor({ project: documents[0] }).dispose();
      return documents[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("The tabs did not converge");
}

try {
  // Two tabs: the first leads, and both edit at once.
  const a = await open("queue");
  const b = await open("queue");
  assert.deepEqual(
    await Promise.all([a, b].map((page) => run(page, () => window.syncApp.role()))),
    ["leader", "follower"],
  );
  const paints = await run(b, () => window.syncApp.view.getDiagnostics().staticPaints);
  await Promise.all([
    dispatch(a, ["moveClips", { clipIds: ["line"], delta: hz }]),
    dispatch(b, ["addMarker", { start: 4 * hz, label: "From B" }]),
  ]);
  let document = await same([a, b]);
  assert.equal(document.clips.find((c) => c.id === "line").start, 3 * hz);
  assert.deepEqual(
    document.markers.map((m) => m.label),
    ["From B"],
  );
  assert.ok(
    (await run(b, () => window.syncApp.view.getDiagnostics().staticPaints)) > paints,
    "the follower's view did not repaint",
  );
  console.log(engine + ": two tabs edited at once and converged");

  // A rejected overlap: both move a clip onto the same free place of the
  // narrator track. The leader's arrives first; the other is refused.
  await Promise.all([
    dispatch(a, ["moveClips", { clipIds: ["line"], delta: 6 * hz }]),
    dispatch(b, ["moveClips", { clipIds: ["next"], delta: -3 * hz }]),
  ]);
  document = await same([a, b]);
  assert.equal(document.clips.find((c) => c.id === "line").start, 9 * hz);
  assert.equal(document.clips.find((c) => c.id === "next").start, 12 * hz);
  assert.ok(
    (await log(b)).some((text) => /^(Rejected|Dropped) \(overlap\)/.test(text)),
    (await log(b)).join("\n"),
  );
  console.log(engine + ": a concurrent overlap was rejected and rolled out");

  // Queue: a tab offline keeps editing and sends its edits when it returns.
  await run(b, () => window.syncApp.goOffline());
  assert.equal(await statusOf(b), "disconnected");
  assert.deepEqual(await dispatch(b, ["addMarker", { start: 6 * hz, label: "Offline" }]), {
    ok: true,
    held: false,
    code: null,
  });
  await dispatch(a, ["moveClips", { clipIds: ["reply"], delta: hz }]);
  assert.equal(await run(b, () => window.syncApp.session.pending), 1);
  await run(b, () => window.syncApp.goOnline());
  document = await same([a, b]);
  assert.deepEqual(
    document.markers.map((m) => m.label),
    ["From B", "Offline"],
  );
  assert.equal(document.clips.find((c) => c.id === "reply").start, 8 * hz);
  console.log(engine + ": an offline tab under queue kept editing and caught up");

  // Online: an unconfirmed edit rolls back after the deadline; offline edits are refused.
  const c = await open("online", "&deadline=800");
  await same([a, b, c]);
  await run(c, () => window.syncApp.lose(true));
  assert.equal((await dispatch(c, ["moveClips", { clipIds: ["next"], delta: 2 * hz }])).ok, true);
  await run(c, () => window.syncApp.goOffline());
  assert.equal(await startOf(c, "next"), 14 * hz);
  assert.deepEqual(await dispatch(c, ["addMarker", { start: hz }]), {
    ok: false,
    held: false,
    code: "read-only",
  });
  await c.waitForFunction(
    () =>
      window.syncApp.session.editor.getSnapshot().clips.find((x) => x.id === "next").start ===
      12 * 282240000,
    null,
    { timeout: 5000 },
  );
  assert.ok((await log(c)).some((text) => text.startsWith("Rolled back 1")));
  await run(c, () => {
    window.syncApp.lose(false);
    window.syncApp.goOnline();
  });
  document = await same([a, b, c]);
  assert.equal(document.clips.find((x) => x.id === "next").start, 12 * hz);
  console.log(engine + ": an offline tab under online was read-only and rolled back");

  // Confirmed: an edit is held until the leader accepts it, then enters history.
  const d = await open("confirmed");
  await same([a, b, c, d]);
  const held = await run(d, async () => {
    const { commands } = await import("@lumen-timeline/core");
    const { editor } = window.syncApp.session;
    const before = editor.getSnapshot().markers.length;
    const result = editor.dispatch(commands.addMarker({ start: 20 * 282240000, label: "Held" }));
    return { held: result.held, before, after: editor.getSnapshot().markers.length };
  });
  assert.deepEqual(held, { held: true, before: 2, after: 2 });
  document = await same([a, b, c, d]);
  assert.deepEqual(
    document.markers.map((m) => m.label),
    ["From B", "Offline", "Held"],
  );
  assert.equal(await run(d, () => window.syncApp.session.editor.history.undoDepth), 1);
  console.log(engine + ": a held edit under confirmed applied once accepted");

  // The leading tab closes. Another takes the lock, resumes the order, and
  // the remaining tabs keep editing.
  await a.close();
  await Promise.any(
    [b, c, d].map((page) =>
      page.waitForFunction(() => window.syncApp.role() === "leader", null, { timeout: 15000 }),
    ),
  );
  const roles = await Promise.all([b, c, d].map((page) => run(page, () => window.syncApp.role())));
  assert.equal(roles.filter((role) => role === "leader").length, 1);
  await dispatch(b, ["moveClips", { clipIds: ["reply"], delta: hz }]);
  await dispatch(d, ["addMarker", { start: 22 * hz, label: "After" }]);
  document = await same([b, c, d]);
  assert.equal(document.clips.find((x) => x.id === "reply").start, 9 * hz);
  assert.deepEqual(
    document.markers.map((m) => m.label),
    ["From B", "Offline", "Held", "After"],
  );
  console.log(engine + ": the leader closed, another tab led, and every tab converged");
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}

async function statusOf(page) {
  return run(page, () => window.syncApp.session.status);
}
