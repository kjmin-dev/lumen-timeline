import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { chromium } from "playwright";

const dist = resolve(import.meta.dirname, "../dist");

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".wasm", "application/wasm"],
  [".txt", "text/plain; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"],
  [".pf_fragment", "application/octet-stream"],
  [".pf_index", "application/octet-stream"],
  [".pf_meta", "application/octet-stream"],
  [".pagefind", "application/octet-stream"],
]);

async function walkHtml(dir) {
  const entries = await readdir(dir, { recursive: true });
  return entries.filter((entry) => entry.endsWith(".html"));
}

function startStaticServer(rootDir) {
  return new Promise((resolveServer, rejectServer) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        let path = decodeURIComponent(url.pathname);
        if (path.endsWith("/")) path += "index.html";
        let full = resolve(rootDir, `.${path}`);
        if (!full.startsWith(rootDir)) {
          res.writeHead(403);
          res.end();
          return;
        }
        if (!existsSync(full) && existsSync(`${full}/index.html`)) {
          full = `${full}/index.html`;
        }
        const body = await readFile(full);
        res.writeHead(200, {
          "Content-Type": MIME.get(extname(full)) ?? "application/octet-stream",
        });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
    });
    server.on("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectServer(new Error("Unexpected server address"));
        return;
      }
      resolveServer({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done(undefined))),
      });
    });
  });
}

describe("built documentation site", () => {
  it("emits core routes, Korean locales, _headers, llms.txt and plain Markdown copies", async () => {
    const required = [
      "index.html",
      "getting-started/index.html",
      "hosting/index.html",
      "ko/index.html",
      "ko/getting-started/index.html",
      "ko/hosting/index.html",
      "architecture/design/index.html",
      "architecture/core/index.html",
      "architecture/roadmap/index.html",
      "guides/editing/index.html",
      "guides/selective-history/index.html",
      "guides/queries-and-planning/index.html",
      "guides/transports/index.html",
      "guides/incremental-playback/index.html",
      "guides/timeline-view/index.html",
      "guides/waveforms/index.html",
      "guides/long-media/index.html",
      "guides/sync/index.html",
      "frameworks/overview/index.html",
      "frameworks/react/index.html",
      "frameworks/svelte/index.html",
      "frameworks/solid/index.html",
      "frameworks/vue/index.html",
      "frameworks/verification/index.html",
      "packages/index.html",
      "benchmarks/clock-and-wasm/index.html",
      "benchmarks/measurements/index.html",
      "examples/index.html",
      "ko/examples/index.html",
      "demo/studio/index.html",
      "demo/sync/index.html",
      "demo/dubbing/index.html",
      "demo/podcast/index.html",
      "demo/session/index.html",
      "_headers",
      "llms.txt",
      "llms-full.txt",
      "llms-small.txt",
      "index.md",
      "getting-started.md",
      "hosting.md",
      "architecture/core.md",
      "guides/editing.md",
      "guides/timeline-view.md",
      "guides/sync.md",
      "packages.md",
      "benchmarks/measurements.md",
    ];
    for (const rel of required) {
      assert.ok(existsSync(join(dist, rel)), `missing built file: ${rel}`);
    }
    assert.ok(!existsSync(join(dist, "ko.md")), "ko.md should not be emitted");

    const llms = await readFile(join(dist, "llms.txt"), "utf8");
    assert.match(llms, /Lumen Timeline/);
    assert.doesNotMatch(llms, /\/ko\//);

    const coreMd = await readFile(join(dist, "architecture/core.md"), "utf8");
    assert.match(coreMd, /```mermaid/);
    assert.doesNotMatch(coreMd, /<figure class="arch-diagram/);

    const packagesMd = await readFile(join(dist, "packages.md"), "utf8");
    assert.match(packagesMd, /\| Package \| Runtime \| Peer \| Public exports \|/);
    assert.doesNotMatch(packagesMd, /<PackageMatrix/);

    const timelineMd = await readFile(join(dist, "guides/timeline-view.md"), "utf8");
    assert.doesNotMatch(timelineMd, /<Demo /);
    // MDX imports go; the examples' own imports stay.
    assert.doesNotMatch(
      timelineMd,
      /^import .* from "(?:@astrojs\/starlight\/components|.*\.astro)";$/m,
    );
    assert.match(timelineMd, /^import \{ Timeline \} from "@lumen-timeline\/react";$/m);

    // Framework tabs: synced Starlight tabs on the page, labelled code blocks in plain Markdown.
    const tabLabels = ["Vanilla", "React", "Svelte", "SolidJS", "Vue"];
    for (const page of [
      "getting-started",
      "ko/getting-started",
      "guides/editing",
      "guides/timeline-view",
      "guides/waveforms",
      "guides/transports",
      "guides/sync",
    ]) {
      const html = await readFile(join(dist, page, "index.html"), "utf8");
      const group = /<starlight-tabs data-sync-key="framework"[\s\S]*?<\/ul>/.exec(html)?.[0];
      assert.ok(group, `${page}: no framework tabs`);
      const labels = [
        ...group.matchAll(/role="tab"[^>]*>\s*(?:<[^>]+>\s*)*([^<\s][^<]*?)\s*</g),
      ].map((match) => match[1]);
      assert.deepEqual(labels, tabLabels, `${page}: framework tab labels`);
      if (page.startsWith("ko/")) continue;
      const md = await readFile(join(dist, `${page}.md`), "utf8");
      assert.doesNotMatch(md, /<\/?(?:Tabs|TabItem)\b/, `${page}.md: tab markup left`);
      for (const label of tabLabels) assert.match(md, new RegExp(`^\\*\\*${label}\\*\\*$`, "m"));
    }
  });

  it("inlines demo frames with srcdoc and preloads island modules", async () => {
    for (const name of ["studio", "sync", "dubbing", "podcast", "session"]) {
      const demoHtml = await readFile(join(dist, "demo", name, "index.html"), "utf8");
      assert.match(demoHtml, /<link rel="modulepreload" href="\/_astro\//);
    }
    for (const page of [
      "index.html",
      "ko/index.html",
      "guides/timeline-view/index.html",
      "guides/sync/index.html",
    ]) {
      const html = await readFile(join(dist, page), "utf8");
      assert.match(html, /<iframe data-demo="(?:studio|sync)" srcdoc="/);
    }
    for (const page of ["examples/index.html", "ko/examples/index.html"]) {
      const html = await readFile(join(dist, page), "utf8");
      for (const name of ["dubbing", "podcast", "session"]) {
        assert.ok(html.includes(`<iframe data-demo="${name}" srcdoc="`), `${page}: ${name}`);
      }
    }
  });

  it("has zero broken internal links or heading anchors across all built HTML pages", async () => {
    const htmlFiles = await walkHtml(dist);
    assert.ok(htmlFiles.length >= 25, `expected at least 25 HTML files, got ${htmlFiles.length}`);

    const idCache = new Map();
    const idsFor = async (file) => {
      const cached = idCache.get(file);
      if (cached) return cached;
      const html = await readFile(file, "utf8");
      const ids = new Set();
      for (const [, id] of html.matchAll(/\sid="([^"]+)"/g)) ids.add(id);
      idCache.set(file, ids);
      return ids;
    };

    const broken = [];
    for (const rel of htmlFiles) {
      if (rel.startsWith("demo/")) continue;
      const html = await readFile(join(dist, rel), "utf8");
      // Strip srcdoc attributes so we check links of the Starlight page itself.
      const stripped = html.replace(/\ssrcdoc="[^"]*"/g, "");
      for (const [, href] of stripped.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)) {
        if (
          href.startsWith("http://") ||
          href.startsWith("https://") ||
          href.startsWith("mailto:") ||
          href.startsWith("javascript:")
        ) {
          continue;
        }
        const [rawPath, hash] = href.split("#", 2);
        const targetRel = rawPath
          ? rawPath.startsWith("/")
            ? rawPath.slice(1)
            : join(rel, "..", rawPath)
          : rel;
        let targetFile = join(dist, targetRel);
        if (targetRel === "" || targetRel.endsWith("/")) {
          targetFile = join(dist, targetRel, "index.html");
        } else if (!existsSync(targetFile) && existsSync(join(targetFile, "index.html"))) {
          targetFile = join(targetFile, "index.html");
        }
        if (!existsSync(targetFile)) {
          broken.push(`${rel}: broken href "${href}"`);
          continue;
        }
        if (hash && targetFile.endsWith(".html")) {
          const ids = await idsFor(targetFile);
          if (!ids.has(decodeURIComponent(hash))) {
            broken.push(`${rel}: missing anchor "#${hash}" in ${href}`);
          }
        }
      }
    }
    assert.deepEqual(broken, []);
  });

  it("renders interactive studio, sync, example screens, theme sync, and package filter in Chromium with zero errors", async () => {
    const server = await startStaticServer(dist);
    const launchArgs =
      process.env["LUMEN_SOFTWARE_GPU"] === "1"
        ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
        : [];
    const browser = await chromium.launch({ args: launchArgs });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
      });
      page.on("response", (res) => {
        if (res.status() >= 400) errors.push(`HTTP ${res.status()} ${res.url()}`);
      });

      // 1. Landing page + live studio demo inside srcdoc iframe
      await page.goto(`${server.url}/`, { waitUntil: "networkidle" });
      const studioFrame = page.frameLocator('iframe[data-demo="studio"]');
      await studioFrame.locator('[data-demo-ready="studio"]').waitFor({ timeout: 15000 });
      const canvasBox = await studioFrame.locator("canvas.lt-clips").boundingBox();
      assert.ok(canvasBox && canvasBox.width > 200 && canvasBox.height > 60);

      // The view follows the site's color scheme
      const siteTheme = await page.evaluate(() => document.documentElement.dataset.theme);
      assert.equal(
        await studioFrame.locator(".lt").getAttribute("data-lt-scheme"),
        siteTheme === "light" ? "light" : "dark",
      );

      // Switch take in the take lanes under the selected line
      const altTake = studioFrame.locator('.lt-take-pick[data-take-id="nar-1-b"]');
      await altTake.click();
      assert.equal(await altTake.getAttribute("aria-checked"), "true");

      // Split the clip from its toolbar and verify Undo becomes enabled, then undo
      const undoBtn = studioFrame.locator(".lt [data-undo]");
      const undoDisabledBefore = await undoBtn.isDisabled();
      assert.equal(undoDisabledBefore, false, "the take switch is an edit");
      await undoBtn.click();
      await studioFrame.locator(".lt [data-clip-split]").click();
      assert.equal(await undoBtn.isDisabled(), false);
      await undoBtn.click();

      // Verify site light/dark theme propagates into the demo frame
      await page.evaluate(() => {
        document.documentElement.dataset.theme = "light";
      });
      await page.waitForFunction(() => {
        const iframe = document.querySelector('iframe[data-demo="studio"]');
        return (
          iframe?.contentDocument?.documentElement.dataset.theme === "light" &&
          iframe.contentDocument.querySelector(".lt")?.getAttribute("data-lt-scheme") === "light"
        );
      });

      // 2. Korean landing page
      await page.goto(`${server.url}/ko/`, { waitUntil: "networkidle" });
      assert.match(await page.locator("h1").first().textContent(), /Lumen Timeline/);
      await page
        .frameLocator('iframe[data-demo="studio"]')
        .locator('[data-demo-ready="studio"]')
        .waitFor({ timeout: 15000 });

      // 3. Shared sessions live two-editor demo on /guides/sync/
      await page.goto(`${server.url}/guides/sync/`, { waitUntil: "networkidle" });
      const syncFrame = page.frameLocator('iframe[data-demo="sync"]');
      await syncFrame.locator('[data-demo-ready="sync"]').waitFor({ timeout: 15000 });
      const paneA = syncFrame.locator('[data-sync-pane="Editor A"]');
      const paneB = syncFrame.locator('[data-sync-pane="Editor B"]');
      await paneA.locator("[data-nudge-right]").click();
      await syncFrame
        .locator('[data-sync-pane="Editor B"] .demo-badge', { hasText: "rev 1" })
        .waitFor({
          timeout: 5000,
        });

      // Toggle Editor B offline, make local edit, reconnect and verify convergence
      await paneB.locator("[data-toggle-offline]").click();
      await paneB.locator("[data-nudge-right]").click();
      await paneB.locator("[data-toggle-offline]").click();
      await syncFrame
        .locator('[data-sync-pane="Editor A"] .demo-badge', { hasText: "rev 2" })
        .waitFor({
          timeout: 5000,
        });

      // 4. The three example screens on /examples/: an edit in each reaches its panels
      await page.goto(`${server.url}/examples/`, { waitUntil: "networkidle" });
      const dubbing = page.frameLocator('iframe[data-demo="dubbing"]');
      await dubbing.locator('[data-demo-ready="dubbing"]').waitFor({ timeout: 20000 });
      assert.equal(await dubbing.locator("[data-dub-count]").textContent(), "9 lines");
      // A line's play button plays that line alone.
      await dubbing.locator('[data-line="03"] [data-dub-audition]').click({ force: true });
      await dubbing.locator('[data-line="03"][data-auditioning]').waitFor({ timeout: 5000 });
      await dubbing.locator('[data-line="03"] [data-dub-audition]').click({ force: true });
      // Every dub has a project of its own, and the original has nothing to edit.
      for (const [lang, word] of [
        ["es", "marea"],
        ["fr", "marée"],
      ]) {
        await dubbing.locator(`[data-dub-lang="${lang}"]`).click();
        await dubbing.locator(".dub-list", { hasText: word }).waitFor({ timeout: 5000 });
      }
      await dubbing.locator('[data-dub-lang="en"]').click();
      await dubbing.locator(".dub-list", { hasText: "as shot" }).waitFor({ timeout: 5000 });
      assert.equal(await dubbing.locator("[data-dub-edit]").count(), 0);
      await dubbing.locator('[data-dub-lang="ko"]').click();
      assert.equal(await dubbing.locator("[data-dub-count]").textContent(), "9 lines");

      const podcast = page.frameLocator('iframe[data-demo="podcast"]');
      await podcast.locator('[data-demo-ready="podcast"]').waitFor({ timeout: 20000 });
      const words = await podcast.locator("[data-word]").count();
      await podcast.locator("[data-pod-fillers]").click();
      assert.equal(await podcast.locator("[data-filler]").count(), 0);
      assert.equal(await podcast.locator("[data-word]").count(), words - 8);
      await podcast.locator('button[aria-label="Undo"]').click();
      assert.equal(await podcast.locator("[data-word]").count(), words);

      const session = page.frameLocator('iframe[data-demo="session"]');
      await session.locator('[data-demo-ready="session"]').waitFor({ timeout: 20000 });
      assert.equal(await session.locator(".lt-take").count(), 3);
      await session.locator('[data-ses-cycle="chorus"]').click();
      await session.locator("[data-example-time]", { hasText: "9.1.1" }).first().waitFor();

      // 5. Interactive PackageMatrix filter on /packages/
      await page.goto(`${server.url}/packages/`, { waitUntil: "networkidle" });
      await page.locator('.pkg-matrix__filter button[data-show="wrapper"]').click();
      assert.match(await page.locator(".pkg-matrix__count").textContent(), /4 of 8 packages/);

      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  });
});
