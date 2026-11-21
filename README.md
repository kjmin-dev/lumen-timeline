# Lumen Timeline

Lumen Timeline is a planned JavaScript framework for building browser-based audio and video editors. Its smallest integration is a timeline mounted beneath an existing player. A dubbing studio can add synchronized audio tracks, alternate takes and a bilingual script inspector. A podcast editor can use the same engine with an audio clock and a chapter list.

The core will own editing commands, time and history. A shared browser view will handle waveforms, pointer input and playhead updates. React, Svelte, SolidJS and Vue will each get a thin wrapper around that view, targeting the latest stable major of the framework.

**Project status** — Headless clip commands, selective history and incremental playback drive video and audio-only workspaces on the same Canvas 2D timeline.

- [Core implementation architecture](docs/core-architecture.md) defines the TypeScript editing engine, sample scheduling and optional Rust waveform worker.
- [Design](docs/design.md) covers the project format, playback clocks, editing semantics, GPU rendering and extension API.
- [Roadmap](ROADMAP.md) lists the implementation milestones, framework version targets and acceptance tests.
- [Clock verification](docs/clock-and-wasm.md) explains how to run the headless regressions, browser playback probes and Rust 1.100 waveform benchmarks.
- [Headless clip editing](docs/headless-editing.md) shows the workspace API for transactional trim, split, move and undo/redo.
- [Timeline reads and audio plans](docs/playback-read-api.md) covers revision-pinned placement queries, catalog bindings and source sample ranges.
- [Incremental playback](docs/incremental-playback.md) covers edit-time voice reconciliation, buffer resolution and continuous-audio regression tests.
- [Vanilla timeline example](docs/vanilla-timeline.md) runs a two-track guide with Canvas 2D selection, zoom and playback.
- [Media transports](docs/media-transports.md) describes the video and audio-only clocks, their shared Web Audio scheduler and both runnable workflows.

## Development

`@lumen-timeline/core` is written in strict TypeScript. [tsrs](https://github.com/oxc-project/tsrs) type-checks it and emits `packages/core/dist`, which browsers and Node load by default. `npm install` builds it. `npm run build` rebuilds it, and `npm test` runs the suite directly against the TypeScript sources on Node 26. [oxfmt](https://oxc.rs/docs/guide/usage/formatter.html) formats the repository with its default configuration. [Oxlint](https://oxc.rs/docs/guide/usage/linter.html) enforces correctness rules, package boundaries and type-aware rules that keep `any` out of the core.

Run `npm run check` before committing. It runs the format check, lint, build, the tests against both the sources and the build, and a parity check: the TypeScript 7.1 compiler must report the same diagnostics as tsrs and emit identical files. `npm run fix` applies safe lint fixes and formatting. `npm install` also sets up a [lefthook](https://lefthook.dev) pre-commit hook that checks staged files, type-checks and runs the unit tests. CI repeats every check. To skip formatting-only commits in local blame, run `git config blame.ignoreRevsFile .git-blame-ignore-revs`. The [TypeScript and quality-gate plan](docs/plans/typescript-core.md) describes the remaining steps.
