---
title: Getting started
description: Clone the Lumen Timeline workspace, build the TypeScript packages, run the browser examples and mount your first timeline.
---

Lumen Timeline is currently developed in a workspace repository while milestone 6 validates the first npm release. All eight packages are written in strict TypeScript, compiled by [tsrs](https://github.com/oxc-project/tsrs) into ES modules with declarations, and tested directly against both source and build outputs.

## Clone and build

Requires Node 26 (see `.node-version`).

```sh
git clone https://github.com/kjmin-dev/lumen-timeline && cd lumen-timeline
npm ci
npm run check
```

`npm ci` links the workspaces and runs `tsrs -b` to emit each package's `dist/`. `npm run check` runs formatting (`oxfmt`), type-aware linting (`oxlint`), compilation, unit tests against both source and build, `tsrs`/`tsc` parity, public API snapshot verification and Markdown link checks.

## Run the interactive examples

```sh
npm run example:vanilla
```

Open the printed local address to explore three runnable workspaces with zero remote dependencies:

- **Video dubbing workspace** (`/examples/vanilla/index.html`) — reference video, speaker tracks, bilingual line list with line play, candidate take auditioning, waveforms and a simulated take generator.
- **Audio-only workspace** (`/examples/vanilla/audio.html`) — audio output clock, overlapping tracks, saved markers and marker-crossing announcements.
- **Shared sessions** (`/examples/sync/index.html`) — open in multiple tabs to watch `@lumen-timeline/sync` converge edits over `BroadcastChannel` with automatic Web Lock leader handover.

## Minimal integration

Mount the timeline in vanilla JavaScript, or wrap the same `editor` and `transport` in [React](/frameworks/react/), [Svelte](/frameworks/svelte/), [SolidJS](/frameworks/solid/) or [Vue](/frameworks/vue/):

```js
import { commands, createEditor, unitsToTicks } from "@lumen-timeline/core";
import { createAudioTransport } from "@lumen-timeline/media";
import { mountTimeline } from "@lumen-timeline/timeline";
import "@lumen-timeline/timeline/style.css";

const sec = (n) => unitsToTicks(n, 1);
const editor = createEditor({
  project: {
    schemaVersion: 1,
    duration: sec(30),
    tracks: [{ id: "voice", name: "Voice", overlap: "exclusive" }],
    clips: [
      {
        id: "line-1",
        name: "Opening line",
        trackId: "voice",
        kind: "audio",
        start: sec(2),
        duration: sec(4),
        contentIn: 0,
        takeIds: ["take-a"],
        activeTakeId: "take-a",
      },
    ],
    takes: [
      {
        id: "take-a",
        label: "Take 1",
        assetId: "voice-a",
        streamId: "mono",
        sourceAtContentZero: 0,
      },
    ],
  },
});

const context = new AudioContext({ sampleRate: 48000 });
const transport = createAudioTransport({ editor, context, catalog, resolveBuffer });
const view = mountTimeline(document.querySelector("#timeline"), { editor, transport });

// Dispatch transactional edits from pointer gestures, keyboard or host panels.
editor.dispatch(commands.splitClip({ clipId: "line-1", at: sec(4) }));
editor.history.undo();
```

## Where to go next

- [Core architecture](/architecture/core/) explains package boundaries, the transaction commit protocol and playback scheduling.
- [Headless clip editing](/guides/editing/) covers move, trim, split, markers, candidate takes, generated IDs and dispatch gates.
- [Timeline view & rendering](/guides/timeline-view/) details WebGL2, WebGPU and Canvas 2D rendering, device-loss recovery and waveforms.
- [Framework wrappers](/frameworks/overview/) shows how React 19, Svelte 5, SolidJS 2 and Vue 3 share one mounted view.
- [All packages](/packages/) lists every package, runtime boundary and locked API export.
