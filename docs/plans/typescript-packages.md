# Media and timeline in TypeScript

**Outcome.** `@lumen-timeline/media` and `@lumen-timeline/timeline` are strict TypeScript built by tsrs, like the core. The vanilla example, the experiments and both browser workflows load the build. Playback and editing behave exactly as before. The following marker work is then written against typed packages. [Core recipe](typescript-core.md) · [Media guide](../media-transports.md) · [Timeline guide](../vanilla-timeline.md)

**Starting point.** At `288a9bc`, the core is TypeScript with conditional exports, a tsrs build, type-aware Oxlint rules, a ban on type and non-null assertions (#16), compiler parity and an API snapshot. Media (five modules, 915 lines) and timeline (three modules, 825 lines) are still JavaScript ES modules. Their 15 tests import the packages by name, except that `experiments/sync/transport.mjs` reaches into two media modules.

## Shared rules

- **Same recipe as the core.** Per package:
  - `git mv` moves `*.mjs` to `src/*.ts` in the same commit that adds types. The pre-commit type check rejects untyped TypeScript, and Git still records each move as a rename;
  - tests stay `.mjs` until the sources are typed, so the existing suite remains an unchanged oracle;
  - a final commit moves the tests to `test/*.test.ts` and type-checks them.
- **Browser libraries.** Package sources compile with `lib: ["es2024", "dom", "dom.iterable"]` and `types: []`. Only the core stays DOM-free.
- **Host types are structural.** Public options take `AudioContextLike`, `AudioNodeLike`, `VideoElementLike` and `AudioBufferLike`. Each lists only the members the transports use. A compile-only test assigns real `AudioContext`, `HTMLVideoElement`, destination and `AudioBuffer` objects to them. Test doubles implement them directly, so tests need no casts. The timeline takes an `HTMLElement` container.
- **No assertions.** As in the core since #16, sources and tests use no `as` (except `as const`), no `!`, no definite assignment and no non-optional `declare` fields. Fields created lazily, such as the video driver's pending seek, stay optional `declare` fields, so object shapes do not change.
- **Unstable entries.** `./internal` exports `VideoTransport`, `presentationTime` and `scheduleWindow` for the seconds-based probes. Timeline exports `./style.css` unchanged.
- **The timeline owns its transport contract.** It declares the transport shape it needs: `snapshot()` with `playing`, `presentedTick` and `requestedTick`, plus `subscribe`, `play`, `pause` and `seek`. Media transports satisfy it structurally, so neither view package imports the other.
- **Display names.** The timeline renders `track.name` and `clip.name`. #16 typed both as optional strings and validates them on load.
- **Gates.** The gates match PR I:
  - tsrs and tsc agree on every project, and emitting projects produce identical files;
  - every reachable declaration file is snapshotted per package;
  - tests pass on the sources and on `dist/`;
  - the PCM, timeline and audio browser workflows pass against `dist/`;
  - emitted JavaScript differs from the original only in reviewed, behavior-neutral lines.

## PR K — Media

- Type the voice scheduler's voice records, video driver state and transport snapshots. Public types:
  - `AudioTransport` and `VideoTransport` handles and the structural host interfaces;
  - `AudioTransportState` (`status`, `precision`) and `VideoTransportState`;
  - `ResolveBuffer` and `TransportDiagnostics`.
- Fields assigned after construction use `declare`, so the emit keeps the original property creation order.
- The PCM experiment and both example pages import media from `dist/`. The seconds-based probe re-exports come from `@lumen-timeline/media/internal`.

## PR L — Timeline

- Type geometry, gestures and the mount: `TimelineView`, `TimelineOptions`, `TimelineTransport`, `SnapOptions` and `Viewport`.
- The DOM lookups in `mountTimeline` use typed `querySelector` helpers. A missing template element throws instead of failing later with `undefined`.
- The example pages and the browser verifications import the timeline from `dist/`.

## Merge gates

| Gate     | Evidence                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Behavior | The unchanged `.mjs` tests pass on sources and `dist/` before conversion. The converted tests pass with the same count afterwards. |
| Browser  | `verify:pcm`, `verify:timeline` and `verify:audio` pass in Chromium against `dist/`.                                               |
| Emit     | Formatted emitted JavaScript differs from the original only in listed lines.                                                       |
| Tooling  | `npm run check` passes in a fresh clone: parity for every project and API snapshots for every package.                             |

Saved timeline markers follow in their own plan. [Marker plan](timeline-markers.md)
