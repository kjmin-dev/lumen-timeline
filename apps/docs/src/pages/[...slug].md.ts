// A plain Markdown copy of every English documentation page, for AI agents and scripts: the page's
// address with `.md` in place of the trailing slash (for example, `/guides/editing.md` and
// `/index.md`).

import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection, type CollectionEntry } from "astro:content";
import { packagesMarkdown, type PackageSummary } from "../../scripts/generate.ts";
import packages from "../generated/packages.json";

const PACKAGE_LIST: readonly PackageSummary[] = packages.map((pkg) => ({
  id: pkg.id,
  name: pkg.name,
  category:
    pkg.category === "engine" || pkg.category === "optional" || pkg.category === "wrapper"
      ? pkg.category
      : "engine",
  runtime: pkg.runtime,
  peer: pkg.peer,
  summary: pkg.summary,
  guide: pkg.guide,
  source: pkg.source,
  exports: pkg.exports,
  typeExports: pkg.typeExports,
}));

const ARCH_MERMAID = [
  "```mermaid",
  "flowchart TB",
  '  App["Host application"] --> Core["@lumen-timeline/core"]',
  '  App --> Media["@lumen-timeline/media"]',
  '  App --> Bindings["React / Svelte / SolidJS / Vue"]',
  '  App --> View["@lumen-timeline/timeline"]',
  "  Bindings --> View",
  "  Bindings --> Core",
  "  Media --> Core",
  "  View --> Core",
  '  Media --> Peaks["Asset worker / peak provider"]',
  '  Peaks -. optional .-> Wasm["Rust 1.100.0 SIMD"]',
  "```",
].join("\n");

export const getStaticPaths: GetStaticPaths = async () => {
  const pages = await getCollection(
    "docs",
    (entry) => entry.id !== "ko" && !entry.id.startsWith("ko/"),
  );
  return pages.map((entry) => ({
    params: { slug: entry.id === "index" ? "index" : entry.id },
    props: { entry },
  }));
};

/** Strips MDX imports, comments and browser-only widgets for plain-Markdown output. */
function toPlainMarkdown(body: string): string {
  return (
    body
      .replace(/^import .* from "(?:@astrojs\/starlight\/components|.*\.astro)";$/gm, "")
      .replace(/^\{\/\*[\s\S]*?\*\/\}$/gm, "")
      .replace(/^<!--[\s\S]*?-->$/gm, "")
      .replace(/^<Demo .*\/>$/gm, "")
      .replace(/^The live (?:timeline|example) above .*$/gm, "")
      .replace(/^<PackageMatrix \/>$/gm, () => packagesMarkdown(PACKAGE_LIST))
      .replace(/<figure class="arch-diagram[\s\S]*?<\/figure>/g, ARCH_MERMAID)
      .replace(/<\/?(?:CardGrid|Card)[^>]*>/g, "")
      // Framework tabs read as labelled code blocks, as in the repository's Markdown.
      .replace(/^<TabItem label="([^"]+)">$/gm, "**$1**")
      .replace(/^<\/?Tabs[^>]*>$|^<\/TabItem>$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

interface RouteProps {
  entry: CollectionEntry<"docs">;
}

function isRouteProps(value: unknown): value is RouteProps {
  return typeof value === "object" && value !== null && "entry" in value;
}

export const GET: APIRoute = ({ props }) => {
  if (!isRouteProps(props)) {
    return new Response("Not found\n", { status: 404 });
  }
  const { data, body } = props.entry;
  const text = toPlainMarkdown(body ?? "");
  const description =
    data.description && !text.startsWith(data.description) ? `> ${data.description}\n\n` : "";
  return new Response(`# ${data.title}\n\n${description}${text}\n`, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
