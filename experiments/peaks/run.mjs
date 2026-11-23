// The waveform peak kernels in Chrome, Firefox and WebKit. In each browser it
// compares the JS and Rust SIMD tiles bit for bit over PCM with NaN,
// infinities, both zeros and partial groups, then times `kernel.tiles` in the
// page and the package worker's round trip with each kernel. With --baseline
// <rev>, the WebAssembly module committed at <rev> is timed too, alternating
// with the current one. --write records docs/measurements/peaks.json.
// Usage (build first):
//   node experiments/peaks/run.mjs [chromium,firefox,webkit] [--baseline <rev>] [--write]
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";

const root = fileURLToPath(new URL("../../", import.meta.url));
const argument = (name) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const engines = (process.argv[2]?.startsWith("--") ? undefined : process.argv[2])?.split(",") ?? [
  "chromium",
  "firefox",
  "webkit",
];
const baseline = argument("baseline");
const write = process.argv.includes("--write");

const moduleOf = (text) => ({
  base64: /peaksWasm(?:: string)? =\s+"([A-Za-z0-9+/=]+)"/.exec(text)?.[1],
  sha256: /peaksWasmSha256(?:: string)? =\s+"([0-9a-f]+)"/.exec(text)?.[1],
});
const current = moduleOf(readFileSync(join(root, "packages/media/src/peaks-wasm.ts"), "utf8"));

// Each directory is a copy of the media package's dist; the baseline's carries
// the module committed at its revision.
const dir = mkdtempSync(join(os.tmpdir(), "lumen-peaks-"));
const dirs = ["current"];
let before = null;
cpSync(join(root, "packages/media/dist"), join(dir, "current"), { recursive: true });
if (baseline) {
  const text = execFileSync("git", ["show", `${baseline}:packages/media/src/peaks-wasm.ts`], {
    cwd: root,
    encoding: "utf8",
  });
  before = { rev: baseline, ...moduleOf(text) };
  if (!before.base64) throw new Error(`No module at ${baseline}`);
  cpSync(join(root, "packages/media/dist"), join(dir, "baseline"), { recursive: true });
  const file = join(dir, "baseline/peaks-wasm.js");
  const js = readFileSync(file, "utf8").replace(
    /(peaksWasm = )"[A-Za-z0-9+/=]+"/,
    `$1"${before.base64}"`,
  );
  writeFileSync(file, js);
  dirs.push("baseline");
}

const page = `<!doctype html><meta charset="utf-8"><title>Peak kernels</title>
<script type="module" src="/page.mjs"></script>`;
const server = http.createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  try {
    if (path === "/") res.setHeader("Content-Type", "text/html").end(page);
    else if (path === "/page.mjs")
      res
        .setHeader("Content-Type", "text/javascript")
        .end(readFileSync(new URL("page.mjs", import.meta.url)));
    else if (/^\/(current|baseline)\/[a-z-]+\.js$/.test(path))
      res.setHeader("Content-Type", "text/javascript").end(readFileSync(join(dir, path)));
    else res.writeHead(404).end();
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const results = {};
try {
  for (const engine of engines) {
    const type = { chromium, firefox, webkit }[engine];
    if (!type) throw new Error(`Unknown engine ${engine}`);
    // Chromium means the installed Google Chrome, as the rendering benchmark uses.
    const browser = await type.launch(engine === "chromium" ? { channel: "chrome" } : {});
    try {
      const tab = await browser.newPage();
      await tab.goto(url);
      await tab.waitForFunction(() => window.peaks);
      const parity = await tab.evaluate(() => window.peaks.parity());
      const kernels = await tab.evaluate((d) => window.peaks.kernels(d), dirs);
      const worker = await tab.evaluate((d) => window.peaks.trips(d), dirs);
      results[engine] = { version: browser.version(), parity, kernels, worker };
      const row = (sizes) =>
        Object.entries(sizes)
          .map(([size, runs]) => {
            const times = Object.entries(runs).map(([n, t]) => `${n} ${t.p50.toFixed(3)}`);
            return `${size}: ${times.join(" / ")}`;
          })
          .join("; ");
      console.log(`${engine} ${browser.version()}: ${parity.values} values bit-identical`);
      console.log(`  kernel.tiles p50 ms, ${row(kernels)}`);
      console.log(`  worker round trip p50 ms, ${row(worker)}`);
    } finally {
      await browser.close();
    }
  }
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

if (write) {
  const record = {
    recorded: new Date().toISOString(),
    machine: {
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model ?? null,
      load: os.loadavg(),
    },
    module: {
      current: current.sha256,
      baseline: before && { rev: before.rev, sha256: before.sha256 },
    },
    engines: results,
  };
  writeFileSync(
    new URL("../../docs/measurements/peaks.json", import.meta.url),
    JSON.stringify(record, null, 2) + "\n",
  );
  console.log("Wrote docs/measurements/peaks.json");
}
