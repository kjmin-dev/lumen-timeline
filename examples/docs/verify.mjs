// Builds and runs every framework example in the documentation, as published.
//
// Each page's framework tabs (`<!-- framework-tabs -->` groups in docs/*.md,
// `<Tabs syncKey="framework">` in Getting started) are whole files named by
// their `title`. For each page and framework this writes those files beside
// `host.js` from Getting started and the page's own titled modules, builds
// them with Vite in development mode with the framework's plugin, and opens
// them in Chromium. The first group's file is the page's root component and
// later groups are panels rendered inside it, as the pages describe. A page
// passes when every build and the page print no warning or error, each root
// mounts one timeline, the buttons do what the page says, and unmounting
// leaves no timeline behind.
//
// Usage (build the packages first): node examples/docs/verify.mjs [page,...]
import {
  copyFileSync,
  createReadStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, build } from "vite";
import { chromium } from "playwright";
import { consumers } from "../frameworks/build.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const out = fileURLToPath(new URL("./dist/", import.meta.url));
const FRAMEWORKS = ["Vanilla", "React", "Svelte", "SolidJS", "Vue"];
const PLUGIN = {
  Vanilla: "vanilla",
  React: "react",
  Svelte: "svelte",
  SolidJS: "solid",
  Vue: "vue",
};
const GETTING_STARTED = "apps/docs/src/content/docs/getting-started.mdx";

// --- Reading the pages -------------------------------------------------------

const FENCE = /^(`{3,})(\w+)(?:\s+title="([^"]+)")?\s*$/;

/** The titled code blocks of a page, each with the framework tab it sits in. */
function blocks(source) {
  const lines = readFileSync(join(repo, source), "utf8").split("\n");
  const found = [];
  let group = -1;
  let label = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "<!-- framework-tabs -->" || line === '<Tabs syncKey="framework">') group++;
    if (line === "<!-- /framework-tabs -->" || line === "</Tabs>") label = null;
    const tab = /^\*\*(.+)\*\*$/.exec(line)?.[1] ?? /^<TabItem label="([^"]+)">$/.exec(line)?.[1];
    if (tab) label = tab;
    const fence = FENCE.exec(lines[i]);
    if (!fence) continue;
    let end = i + 1;
    while (lines[end].trim() !== fence[1]) end++;
    found.push({
      group: label ? group : null,
      label,
      lang: fence[2],
      file: fence[3] ?? null,
      code: lines.slice(i + 1, end).join("\n") + "\n",
      line: i + 1,
    });
    i = end;
  }
  return found;
}

function pages() {
  const sources = [
    GETTING_STARTED,
    ...readdirSync(join(repo, "docs"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => "docs/" + name),
  ];
  const host = blocks(GETTING_STARTED).find((block) => block.file === "host.js" && !block.label);
  if (!host) throw new Error(GETTING_STARTED + ": no host.js block");
  const list = [];
  for (const source of sources) {
    const all = blocks(source);
    const tabs = all.filter((block) => block.label);
    if (!tabs.length) continue;
    for (const tab of tabs)
      if (!tab.file) throw new Error(`${source}:${tab.line}: a ${tab.label} tab has no title`);
    const groups = [...new Set(tabs.map((tab) => tab.group))].map((group) =>
      Object.fromEntries(tabs.filter((tab) => tab.group === group).map((tab) => [tab.label, tab])),
    );
    // Titled blocks outside the tabs are the page's shared modules. A host.js
    // block elsewhere is an excerpt of Getting started's, which is the module.
    const modules = all.filter((block) => !block.label && block.file && block.file !== "host.js");
    list.push({ name: basename(source).replace(/\.mdx?$/, ""), source, groups, modules, host });
  }
  return list;
}

// --- Writing and building ----------------------------------------------------

const PANEL_PROPS = { clipId: "line-1", takeId: "take-b" };
const component = (file) => basename(file).replace(/\.\w+$/, "");

// Elements the vanilla tabs say the page holds, by the selector they use.
const VANILLA_ELEMENTS = {
  video: '<video src="/media/reference.webm" muted></video>',
  "#split": '<button id="split">Split at 4 s</button>',
  "#play-line": '<button id="play-line">Play line</button>',
  "#audition": '<button id="audition">Audition Take 2</button>',
  "#chapter": '<output id="chapter"></output>',
  "#inspector": '<output id="inspector"></output>',
  "#timeline": '<div id="timeline"></div>',
};
const vanillaPage = (code) =>
  Object.entries(VANILLA_ELEMENTS)
    .filter(([selector]) => code.includes(`querySelector("${selector}")`))
    .map(([, markup]) => markup)
    .join("\n");

function entry(framework, files, copies) {
  const [root, ...panels] = files;
  const imports = files.map((file) =>
    framework === "React" || framework === "SolidJS"
      ? `import { ${component(file)} } from "./${file}";`
      : `import ${component(file)} from "./${file}";`,
  );
  const props = Object.entries(PANEL_PROPS)
    .map(([key, value]) => `${key}="${value}"`)
    .join(" ");
  const jsx = `<${component(root)}>${panels.map((file) => `<${component(file)} ${props} />`).join("")}</${component(root)}>`;
  const roots = Array.from({ length: copies }, () => jsx).join("");
  switch (framework) {
    case "Vanilla":
      return { name: "entry.js", code: files.map((file) => `import "./${file}";`).join("\n") };
    case "React":
      return {
        name: "entry.jsx",
        code: `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
${imports.join("\n")}
const root = createRoot(document.querySelector("#app"));
root.render(<StrictMode>${roots}</StrictMode>);
window.unmountExample = () => root.unmount();`,
      };
    case "SolidJS":
      return {
        name: "entry.jsx",
        code: `import { render } from "@solidjs/web";
${imports.join("\n")}
window.unmountExample = render(() => <>${roots}</>, document.querySelector("#app"));`,
      };
    case "Svelte":
      return {
        name: "entry.js",
        extra: {
          "Example.svelte": `<script>\n${imports.map((line) => "  " + line).join("\n")}\n</script>\n\n${roots}\n`,
        },
        code: `import { mount, unmount } from "svelte";
import Example from "./Example.svelte";
const app = mount(Example, { target: document.querySelector("#app") });
window.unmountExample = () => unmount(app);`,
      };
    case "Vue":
      return {
        name: "entry.js",
        code: `import { createApp, h } from "vue";
${imports.join("\n")}
const root = () => h(${component(root)}, null, { default: () => [${panels
          .map((file) => `h(${component(file)}, ${JSON.stringify(PANEL_PROPS)})`)
          .join(", ")}] });
const app = createApp({ render: () => Array.from({ length: ${copies} }, root) });
app.mount("#app");
window.unmountExample = () => app.unmount();`,
      };
  }
}

async function buildExample(page, framework, copies) {
  const dir = join(out, page.name, framework);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // The harness reads the editor of host.js to check what the buttons did.
  writeFileSync(join(dir, "host.js"), page.host.code + "globalThis.exampleEditor = editor;\n");
  for (const module of page.modules) writeFileSync(join(dir, module.file), module.code);
  const files = page.groups.map((group) => {
    const tab = group[framework];
    if (!tab) throw new Error(`${page.source}: a group has no ${framework} tab`);
    writeFileSync(join(dir, tab.file), tab.code);
    return tab.file;
  });
  const main = entry(framework, files, copies);
  writeFileSync(join(dir, main.name), main.code);
  for (const [name, code] of Object.entries(main.extra ?? {})) writeFileSync(join(dir, name), code);
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>${page.name} · ${framework}</title>
<body>${framework === "Vanilla" ? vanillaPage(page.groups.map((group) => group.Vanilla.code).join("")) : '<div id="app"></div>'}
<script type="module" src="./${main.name}"></script></body>`,
  );
  const warnings = [];
  const logger = createLogger("warn");
  logger.warn = (message) => warnings.push(message);
  logger.warnOnce = (message) => warnings.push(message);
  logger.error = (message) => warnings.push(message);
  // Compilers that print their own warnings, such as Svelte's, print to the console.
  const print = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await build({
      root: dir,
      base: "./",
      mode: "development",
      configFile: false,
      logLevel: "warn",
      customLogger: logger,
      plugins: await consumers[PLUGIN[framework]].plugins({ ssr: false }),
      define: { "process.env.NODE_ENV": JSON.stringify("development") },
      // Templates may name the media by absolute URL, as files in an app's public directory.
      publicDir: join(out, "public"),
      build: {
        outDir: join(dir, "dist"),
        emptyOutDir: true,
        minify: false,
        target: "esnext",
        copyPublicDir: false,
      },
      worker: { format: "es" },
    });
  } finally {
    console.warn = print;
  }
  return { dist: join(dir, "dist"), warnings };
}

// --- Serving -----------------------------------------------------------------

const MEDIA = {
  "/media/reference.webm": ["examples/vanilla/media/tidal-study.webm", "video/webm"],
  "/media/voice-a.opus": ["examples/vanilla/media/dialogue.ogg", "audio/ogg"],
  "/media/voice-b.opus": ["examples/vanilla/media/dialogue.ogg", "audio/ogg"],
};
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
};
let root = "";
mkdirSync(join(out, "public/media"), { recursive: true });
for (const [path, [file]] of Object.entries(MEDIA))
  copyFileSync(join(repo, file), join(out, "public", path));
const server = createServer((request, response) => {
  const asked = decodeURIComponent(new URL(request.url, "http://x").pathname);
  const path = asked === "/" ? "/index.html" : asked;
  const [file, type] = MEDIA[path]
    ? [join(repo, MEDIA[path][0]), MEDIA[path][1]]
    : [join(root, path), TYPES[extname(path)] ?? "application/octet-stream"];
  let size;
  try {
    size = statSync(file).size;
  } catch {
    response.writeHead(404).end();
    return;
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : size - 1;
    response.writeHead(206, {
      "content-type": type,
      "content-range": `bytes ${start}-${end}/${size}`,
      "content-length": end - start + 1,
      "accept-ranges": "bytes",
    });
    createReadStream(file, { start, end }).pipe(response);
  } else {
    response.writeHead(200, {
      "content-type": type,
      "content-length": size,
      "accept-ranges": "bytes",
    });
    createReadStream(file).pipe(response);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;

// --- Running -----------------------------------------------------------------

const software = process.env.LUMEN_SOFTWARE_GPU === "1";
const browser = await chromium.launch({
  args: [
    "--autoplay-policy=no-user-gesture-required",
    ...(software ? ["--use-angle=swiftshader"] : []),
  ],
});

// What each button must do. The checks run in the page and read host.js's editor.
const CHECKS = {
  "Split at 4 s": { expect: () => globalThis.exampleEditor.getSnapshot().clips.length === 2 },
  "Play line": { output: "Breath" },
  "Audition take-b": { expect: picked },
  "Audition Take 2": { expect: picked },
};
function picked() {
  const clip = globalThis.exampleEditor.getSnapshot().clips.find((c) => c.id === "line-1");
  return clip?.activeTakeId === "take-b";
}

async function run(page, framework, dist, timelines) {
  root = dist;
  const tab = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const problems = [];
  const checked = [];
  tab.on("pageerror", (error) => problems.push("page error: " + error.message));
  tab.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      problems.push(`console ${message.type()}: ${message.text()}`);
  });
  await tab.goto(origin + "/");
  try {
    await tab.waitForFunction((n) => document.querySelectorAll(".lt").length === n, timelines, {
      timeout: 15000,
    });
    checked.push(`${timelines} timeline(s)`);
  } catch {
    problems.push(`expected ${timelines} timeline(s), found ${await tab.locator(".lt").count()}`);
  }
  // An inspector follows the selection.
  if (await tab.locator("output", { hasText: "No clip selected" }).count()) {
    await tab.evaluate(() => globalThis.exampleEditor.session.select(["line-1"]));
    try {
      await tab.locator("output", { hasText: "line-1: take-a" }).waitFor({ timeout: 5000 });
      checked.push("inspector");
    } catch {
      problems.push("the inspector did not show the selected clip");
    }
  }
  const buttons = await tab.locator("button:not(.lt button)").allInnerTexts();
  for (const text of buttons.map((name) => name.trim())) {
    const check = CHECKS[text];
    if (!check) {
      problems.push(`no check for the button "${text}"`);
      continue;
    }
    await tab.locator("button:not(.lt button)", { hasText: text }).first().click();
    try {
      if (check.expect) await tab.waitForFunction(check.expect, null, { timeout: 15000 });
      if (check.output)
        await tab.waitForFunction(
          (text) => [...document.querySelectorAll("output")].some((o) => o.textContent === text),
          check.output,
          { timeout: 15000 },
        );
      checked.push(`"${text}"`);
    } catch {
      problems.push(`the button "${text}" did not do what the page says`);
    }
  }
  if (framework !== "Vanilla") {
    await tab.evaluate(() => window.unmountExample());
    await tab.waitForTimeout(300);
    const left = await tab.locator(".lt").count();
    if (left) problems.push(`${left} timeline(s) left after unmount`);
    else checked.push("unmount");
  }
  await tab.close();
  return { problems, checked };
}

const only = process.argv[2]?.split(",");
let failed = 0;
for (const page of pages()) {
  if (only && !only.includes(page.name)) continue;
  for (const framework of FRAMEWORKS) {
    // The shared session page says two components edit one project; vanilla mounts once.
    const copies = page.name === "sync" && framework !== "Vanilla" ? 2 : 1;
    const { dist, warnings } = await buildExample(page, framework, copies);
    // A root that imports the view's stylesheet mounts a timeline; an inspector does not.
    const timelines = page.groups[0][framework].code.includes("@lumen-timeline/timeline/style.css")
      ? copies
      : 0;
    const result = await run(page, framework, dist, timelines);
    const problems = [...warnings.map((warning) => "build: " + warning), ...result.problems];
    console.log(
      `${problems.length ? "✖" : "✔"} ${page.name} · ${framework}: ${result.checked.join(", ")}`,
    );
    for (const problem of problems) console.log("    " + problem);
    if (problems.length) failed++;
  }
}
await browser.close();
server.close();
if (failed) {
  console.error(failed + " example(s) failed");
  process.exit(1);
}
