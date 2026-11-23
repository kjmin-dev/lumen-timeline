import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  packagesMarkdown,
  parseApiExports,
  promoteHeadings,
  rewriteDocLinks,
  splitSections,
} from "../scripts/generate.ts";

describe("generate helpers", () => {
  it("splits markdown into intro and level-2 sections", () => {
    const parsed = splitSections(
      "# Title\n\nIntro line.\n\n## Alpha\n\nBody A\n\n## Beta\n\nBody B",
    );
    assert.equal(parsed.intro, "Intro line.");
    assert.deepEqual(parsed.sections, [
      { title: "Alpha", body: "Body A" },
      { title: "Beta", body: "Body B" },
    ]);
  });

  it("promotes level-3 headings to level-2", () => {
    assert.equal(promoteHeadings("### Sub\n\n#### Deep\n"), "## Sub\n\n### Deep\n");
  });

  it("rewrites mapped docs links, repo artifacts, and ignores code fences", () => {
    const input = [
      "See [Design](design.md#time) and [Roadmap](../ROADMAP.md#milestones).",
      "See [Plan](plans/clip-takes.md) and [Raw](measurements/render.json).",
      "Keep [External](https://example.com/a.md) and [Anchor](#local).",
      "```md",
      "[Ignored](does-not-exist.md)",
      "```",
    ].join("\n");
    const out = rewriteDocLinks(input, "docs/core-architecture.md");
    assert.match(out, /\[Design\]\(\/architecture\/design\/#time\)/);
    assert.match(out, /\[Roadmap\]\(\/architecture\/roadmap\/#milestones\)/);
    assert.match(
      out,
      /\[Plan\]\(https:\/\/github\.com\/kjmin-dev\/lumen-timeline\/blob\/main\/docs\/plans\/clip-takes\.md\)/,
    );
    assert.match(
      out,
      /\[Raw\]\(https:\/\/github\.com\/kjmin-dev\/lumen-timeline\/blob\/main\/docs\/measurements\/render\.json\)/,
    );
    assert.match(out, /\[External\]\(https:\/\/example\.com\/a\.md\)/);
    assert.match(out, /\[Anchor\]\(#local\)/);
    assert.match(out, /\[Ignored\]\(does-not-exist\.md\)/);
  });

  it("throws when a relative link is not mapped", () => {
    assert.throws(
      () => rewriteDocLinks("See [Missing](unknown-file.md).", "docs/design.md"),
      /unmapped relative link/,
    );
  });

  it("extracts value and type exports from api/index.d.ts", () => {
    const sample = [
      'export { createEditor, commands, type Commands } from "./editor.ts";',
      'export type { ClipWindow, SourceWindow } from "./time.ts";',
      "export declare function mountTimeline(): void;",
      "export declare const Timeline: unknown;",
      "export interface TimelineProps {}",
    ].join("\n");
    const parsed = parseApiExports(sample);
    assert.deepEqual(parsed.values, ["createEditor", "commands", "mountTimeline", "Timeline"]);
    assert.deepEqual(parsed.types, ["Commands", "ClipWindow", "SourceWindow", "TimelineProps"]);
  });

  it("formats packages as a Markdown table", () => {
    const md = packagesMarkdown([
      {
        id: "core",
        name: "@lumen-timeline/core",
        category: "engine",
        runtime: "Node & browser",
        peer: "None",
        summary: "Core",
        guide: "/guides/editing/",
        source: "packages/core",
        exports: ["createEditor", "commands"],
        typeExports: [],
      },
    ]);
    assert.match(md, /\| Package \| Runtime \| Peer \| Public exports \|/);
    assert.match(md, /\[`@lumen-timeline\/core`\]\(\/guides\/editing\/\)/);
    assert.match(md, /`createEditor`, `commands`/);
  });
});
