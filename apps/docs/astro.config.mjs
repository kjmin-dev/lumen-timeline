import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";
import { demoFrames } from "./scripts/demo-frames.ts";

// The public address of the site. `llms.txt`, the sitemap and canonical links are built from it,
// so a deployment sets DOCS_SITE. Without it the links point at the local preview server.
const site = process.env.DOCS_SITE || "http://localhost:4321";

export default defineConfig({
  site,
  trailingSlash: "always",
  // Fetch a page while the pointer rests on its link, so it is often in before the click.
  prefetch: { prefetchAll: true, defaultStrategy: "hover" },
  integrations: [
    starlight({
      title: "Lumen Timeline",
      description:
        "A JavaScript framework for browser-based audio and video editors: headless editing core, sample-accurate Web Audio transports, GPU timeline rendering, waveform workers, optional sync and React, Svelte, SolidJS and Vue wrappers.",
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        ko: { label: "한국어", lang: "ko" },
      },
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/kjmin-dev/lumen-timeline" },
      ],
      editLink: { baseUrl: "https://github.com/kjmin-dev/lumen-timeline/edit/main/apps/docs/" },
      customCss: ["./src/styles/site.css"],
      routeMiddleware: "./src/route-data.ts",
      plugins: [
        starlightLlmsTxt({
          projectName: "Lumen Timeline",
          description:
            "Lumen Timeline is a JavaScript framework for building browser-based audio and video editors. The headless @lumen-timeline/core package owns 282,240,000 Hz project ticks, transactional clip/take/marker editing, selective history and pure audio planning; @lumen-timeline/media drives video and audio-only Web Audio transports and a Rust SIMD waveform tile worker; @lumen-timeline/timeline renders one CPU layout through WebGL2, WebGPU or Canvas 2D; @lumen-timeline/sync provides optional server-free session convergence; and thin wrappers ship for React 19, Svelte 5, SolidJS 2 and Vue 3.",
          // The Korean pages translate the English ones; one language is enough for a model.
          exclude: ["ko/**"],
          customSelectors: {
            all: [".demo", ".pkg-matrix__filter", ".pkg-matrix__count", ".arch-diagram"],
          },
        }),
      ],
      sidebar: [
        {
          label: "Start",
          translations: { ko: "시작하기" },
          items: [{ slug: "getting-started" }, { slug: "examples" }],
        },
        {
          label: "Architecture",
          translations: { ko: "아키텍처" },
          items: [{ autogenerate: { directory: "architecture" } }],
        },
        {
          label: "Guides",
          translations: { ko: "가이드" },
          items: [{ autogenerate: { directory: "guides" } }],
        },
        {
          label: "Frameworks",
          translations: { ko: "프레임워크" },
          items: [{ autogenerate: { directory: "frameworks" } }],
        },
        {
          label: "Packages",
          translations: { ko: "패키지" },
          items: [{ autogenerate: { directory: "packages" } }],
        },
        {
          label: "Benchmarks",
          translations: { ko: "벤치마크" },
          items: [{ autogenerate: { directory: "benchmarks" } }],
        },
        {
          label: "Hosting this site",
          translations: { ko: "사이트 호스팅" },
          items: [{ slug: "hosting" }],
        },
      ],
    }),
    react(),
    demoFrames(),
  ],
  vite: {
    optimizeDeps: {
      // Keep workspace packages un-prebundled so module worker URLs resolve directly.
      exclude: [
        "@lumen-timeline/core",
        "@lumen-timeline/media",
        "@lumen-timeline/timeline",
        "@lumen-timeline/sync",
        "@lumen-timeline/react",
      ],
    },
  },
});
