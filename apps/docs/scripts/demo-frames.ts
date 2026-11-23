// Shortens the path to every live timeline example embedded on a page.
//
// Each example is built as its own page under `/demo/<name>/` and embedded in an iframe so the
// timeline stylesheet stays isolated from Starlight's. After `astro build`, this hook adds
// `modulepreload` hints for every ES module the island imports and writes the built demo page into
// its iframe as `srcdoc`, so the browser starts loading the demo as soon as the page HTML arrives.
// The iframe keeps `src` for `astro dev`, where this hook does not run.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";

export function demoFrames(): AstroIntegration {
  return {
    name: "demo-frames",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        const root = fileURLToPath(dir);
        const demoDir = join(root, "demo");
        const examples = new Map<string, string>();
        for (const name of await readdir(demoDir)) {
          const file = join(demoDir, name, "index.html");
          const html = await preloadModules(await readFile(file, "utf8"), root);
          await writeFile(file, html);
          examples.set(name, html);
        }

        let frames = 0;
        const files = (await readdir(root, { recursive: true })).filter(
          (path) => path.endsWith(".html") && !path.startsWith("demo/"),
        );
        for (const path of files) {
          const file = join(root, path);
          const html = await readFile(file, "utf8");
          if (!html.includes("data-demo=")) continue;
          const framed = html.replace(/<iframe data-demo="([^"]+)"/g, (tag, name: string) => {
            const example = examples.get(name);
            if (!example) {
              throw new Error(`${path} embeds the example "${name}", which has no page`);
            }
            frames++;
            return `${tag} srcdoc="${example.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`;
          });
          // A frame the pattern missed would quietly keep the extra round trip; fail instead.
          if (framed.split("data-demo=").length !== framed.split("srcdoc=").length) {
            throw new Error(`${path} has an example frame that demo-frames.ts did not recognize`);
          }
          await writeFile(file, framed);
        }
        logger.info(`wrote ${examples.size} examples into ${frames} frames`);
      },
    },
  };
}

/** Adds a `modulepreload` link for each module an island loads, and each module they import. */
async function preloadModules(html: string, root: string): Promise<string> {
  const scripts = new Set(captures(html, /<script type="module" src="([^"]+)"/g));
  const modules = new Set<string>();
  const visit = async (url: string) => {
    if (modules.has(url)) return;
    modules.add(url);
    const code = await readFile(join(root, url), "utf8");
    for (const path of captures(code, /(?:from|import)\s*"(\.{1,2}\/[^"]+\.js)"/g)) {
      await visit(new URL(path, `file://${url}`).pathname);
    }
  };
  for (const url of captures(html, / (?:component|renderer|before-hydration)-url="([^"]+)"/g)) {
    await visit(url);
  }
  for (const url of scripts) await visit(url);
  // A module the page already loads with a script tag is found by the browser on its own.
  const links = [...modules]
    .filter((url) => !scripts.has(url))
    .map((url) => `<link rel="modulepreload" href="${url}">`)
    .join("");
  return html.replace("</head>", `${links}</head>`);
}

/** The first group of each match. */
const captures = (text: string, pattern: RegExp): string[] =>
  [...text.matchAll(pattern)].flatMap((match) => match[1] ?? []);
