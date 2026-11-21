import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";
import { measure } from "./measure.mjs";

const engine = process.argv[2] ?? "chrome";
const engines = { chrome: chromium, chromium, firefox, webkit };
if (!engines[engine]) throw new Error("Choose chrome, chromium, firefox or webkit");
const cwd = fileURLToPath(new URL(".", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "lumen-rust-"));
let browser;
try {
  const rustc = execFileSync("rustc", ["+1.100.0", "--version"], { cwd, encoding: "utf8" }).trim();
  const wasm = join(dir, "kernels.wasm");
  execFileSync(
    "rustc",
    [
      "+1.100.0",
      "--edition=2024",
      "--target",
      "wasm32-unknown-unknown",
      "--crate-type=cdylib",
      "-C",
      "opt-level=3",
      "-C",
      "panic=abort",
      "-C",
      "strip=symbols",
      "-C",
      "link-arg=--export=__heap_base",
      "kernels.rs",
      "-o",
      wasm,
    ],
    { cwd },
  );
  const bytes = [...(await readFile(wasm))];
  const node = await measure(bytes);
  browser = await engines[engine].launch(engine === "chrome" ? { channel: "chrome" } : {});
  const page = await browser.newPage();
  await page.context().route("http://lumen-bench.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({ contentType: "text/html", body: "<title>Lumen benchmark</title>" });
    if (
      ![
        "/experiments/wasm/measure.mjs",
        "/experiments/wasm/worker-bench.mjs",
        "/experiments/wasm/worker.mjs",
        "/experiments/wasm/peaks.mjs",
        "/packages/core/time.mjs",
      ].includes(path)
    )
      return route.abort();
    const body = await readFile(new URL("../.." + path, import.meta.url));
    return route.fulfill({ contentType: "text/javascript", body });
  });
  await page.goto("http://lumen-bench.test/");
  const browserResults = await page.evaluate(async (bytes) => {
    const { measure } = await import("/experiments/wasm/measure.mjs");
    return measure(bytes);
  }, bytes);
  const worker = await page.evaluate(async (bytes) => {
    const { measureWorker } = await import("/experiments/wasm/worker-bench.mjs");
    return measureWorker(bytes);
  }, bytes);
  console.log(
    JSON.stringify(
      {
        rustc,
        nodeVersion: process.version,
        engine,
        browserVersion: browser.version(),
        node,
        browserResults,
        worker,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await rm(dir, { recursive: true, force: true });
}
