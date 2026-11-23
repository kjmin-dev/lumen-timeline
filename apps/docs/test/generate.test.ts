import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FRAMEWORK_TABS,
  frameworkTabs,
  packagesMarkdown,
  parseApiExports,
  promoteHeadings,
  rewriteDocLinks,
  splitSections,
} from "../scripts/generate.ts";

const group5 = (labels: readonly string[], close = true): string =>
  [
    "<!-- framework-tabs -->",
    ...labels.flatMap((label) => [`**${label}**`, "```js", `mount("${label}");`, "```"]),
    ...(close ? ["<!-- /framework-tabs -->"] : []),
  ].join("\n");

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

  it("turns a framework example group into synced Starlight tabs", () => {
    const group = (labels: readonly string[], close = true): string =>
      [
        "Before.",
        "",
        "<!-- framework-tabs -->",
        "",
        ...labels.flatMap((label) => [
          `**${label}**`,
          "",
          "````js",
          "```",
          `mount("${label}");`,
          "````",
          "",
        ]),
        ...(close ? ["<!-- /framework-tabs -->"] : []),
        "",
        "After.",
      ].join("\n");
    const out = frameworkTabs(group(FRAMEWORK_TABS), "docs/x.md");
    assert.equal(out.match(/<Tabs syncKey="framework">/g)?.length, 1);
    assert.deepEqual(
      [...out.matchAll(/<TabItem label="([^"]+)">/g)].map((match) => match[1]),
      [...FRAMEWORK_TABS],
    );
    // A shorter fence inside a block does not end it.
    assert.match(
      out,
      /<TabItem label="React">\n\n````js\n```\nmount\("React"\);\n````\n\n<\/TabItem>/,
    );
    assert.match(out, /^Before\.$/m);
    assert.match(out, /<\/Tabs>\n\nAfter\.$/);
    assert.doesNotMatch(out, /framework-tabs|\*\*Vue\*\*/);
    assert.equal(frameworkTabs("No tabs here.\n", "docs/x.md"), "No tabs here.\n");
  });

  it("rejects a framework group that is missing, reorders or never closes a tab", () => {
    assert.throws(
      () => frameworkTabs(group5(["Vanilla", "React", "Svelte", "Vue"]), "docs/x.md"),
      /docs\/x\.md: a framework group needs the tabs Vanilla, React, Svelte, SolidJS, Vue/,
    );
    assert.throws(
      () => frameworkTabs(group5(["React", "Vanilla", "Svelte", "SolidJS", "Vue"]), "docs/x.md"),
      /in order/,
    );
    assert.throws(() => frameworkTabs(group5(FRAMEWORK_TABS, false), "docs/x.md"), /in order/);
    assert.throws(
      () => frameworkTabs("<!-- framework-tabs -->\n\nSome prose.\n", "docs/x.md"),
      /expected a \*\*Label\*\* line/,
    );
    assert.throws(
      () => frameworkTabs("<!-- framework-tabs -->\n\n**Vanilla**\n\nprose\n", "docs/x.md"),
      /not followed by a code block/,
    );
    assert.throws(() => frameworkTabs("<!-- /framework-tabs -->\n", "docs/x.md"), /without/);
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
