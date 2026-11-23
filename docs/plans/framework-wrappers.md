# Four framework wrappers

**Status.** Delivered: the plan in [#51](https://github.com/kjmin-dev/lumen-timeline/pull/51), W1 in [#52](https://github.com/kjmin-dev/lumen-timeline/pull/52), W2 in [#53](https://github.com/kjmin-dev/lumen-timeline/pull/53), W3 in [#54](https://github.com/kjmin-dev/lumen-timeline/pull/54) and W4 in [#55](https://github.com/kjmin-dev/lumen-timeline/pull/55). It started from 8691618, after #50. [Milestone 5](../../ROADMAP.md#milestones) · [Wrapper contract](../design.md#framework-wrapper-contract) · [Wrapper acceptance tests](../../ROADMAP.md#wrapper-acceptance-tests)

**User outcome.** A React, Svelte, SolidJS or Vue application mounts the same timeline as the vanilla example and passes it the editor and transport it already owns. It builds its own panels, such as a take inspector, a selection readout or a clock, from fields it selects from the editor and the transport. A panel updates only when its fields change, so a take inspector does no work during playback. Unmounting releases everything the view made and leaves the host's editor and transport as they were. [Architecture](../core-architecture.md#package-and-runtime-boundaries)

## Starting point

- **Options are fixed at mount.** `mountTimeline(container, options)` returns a `TimelineView` whose only adjustable state is the viewport. Changing the snap settings, the caption words or the waveform provider means a new mount. A framework that passes a new object literal on every render would remount on every render.
- **Three separate subscriptions.** `editor.subscribe(select, listen)` compares one value selected from the snapshot. Selection and history have their own subscriptions. Nothing combines them into the single synchronous value that React's `useSyncExternalStore`, Svelte's `createSubscriber`, a SolidJS signal and a Vue shallow reference each read.
- **WebGL2 keeps its context after disposal.** The WebGL2 backend deletes its buffers, texture and program, but the context lives until garbage collection. Chrome loses the oldest context once 16 are live. A host that remounts the view often would lose contexts it still draws with, and the wrapper checks would count contexts that were never released.
- **No bundler.** The examples load the packages through an import map. React ships CommonJS, and Svelte and SolidJS compile their templates, so their consumers need a build.

## Shared groundwork

These go in the core and timeline packages, so every wrapper is a thin translation of them.

- **`view.update(options)`** applies `snap`, `labels`, `waveforms`, `pixelsPerSecond` and `startTick` to a mounted view. Snap settings and caption words are compared by value, so an equal object costs nothing. A new waveform provider replaces the old one's subscription and repaints. A changed `pixelsPerSecond` or `startTick` moves the viewport. An unchanged one leaves the user's pan and zoom alone, even when the host renders again. `editor`, `transport` and `renderer` stay fixed for a view, and wrappers mount a new view when they change.
- **`watchEditor(editor)`** is the editor's state as one value, `{ snapshot, selection, history }`, whose identity changes only when one of the three does. It subscribes to the editor only while it has listeners, and reading it without listeners returns the current state.
- **`watchSnapshots(source)`** does the same for any `snapshot()` and `subscribe(listener)` source, such as a transport.
- **`watchSelect(source, select, isEqual)`** derives a field from either. Its listeners run only when `isEqual`, `Object.is` by default, finds that the field changed. `shallowEqual` compares plain objects and arrays one level deep.
- **The WebGL2 backend releases its context** with `WEBGL_lose_context` when it is disposed, after removing its own loss handlers.

## Wrappers

Each wrapper is a package that depends on the core and timeline packages and declares its framework as a peer. Its peer range starts at the framework version it was tested with. Each package is TypeScript built by tsrs, with no JSX and no template compiler, so the only build a consumer needs is the one its framework needs anyway.

|                  | `@lumen-timeline/react`                      | `@lumen-timeline/svelte`                       | `@lumen-timeline/solid`                            | `@lumen-timeline/vue`                                |
| ---------------- | -------------------------------------------- | ---------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| Framework peer   | `react` 19                                   | `svelte` 5                                     | `solid-js` 2                                       | `vue` 3.5                                            |
| Mount the view   | `<Timeline …options ref>` component          | `{@attach timeline(() => options)}` attachment | `createTimeline(element, options)` primitive       | `<Timeline …options ref>` component                  |
| The view handle  | `ref` receives the `TimelineView`            | `onview` option                                | Returns an accessor of the `TimelineView`          | The template ref exposes `view`                      |
| Editor fields    | `useEditorSelector(editor, select, isEqual)` | `editorSelector(editor, select, isEqual)`      | `createEditorSelector(editor, select, isEqual)`    | `useEditorSelector(editor, select, isEqual)`         |
| Transport fields | `useTransportSelector(…)`                    | `transportSelector(…)`                         | `createTransportSelector(…)`                       | `useTransportSelector(…)`                            |
| Selected value   | The hook's return value                      | `.current`, read in markup or an effect        | An accessor                                        | A read-only shallow reference                        |
| Panels' handles  | `<TimelineProvider>`, `useTimelineContext()` | `setTimelineContext()`, `getTimelineContext()` | `TimelineContext`, `useTimelineContext()`          | `provideTimeline()`, `useTimelineContext()`          |
| Built on         | `useSyncExternalStore`, a layout effect      | `createSubscriber`, `$effect` in an attachment | A signal, `createEffect` with cleanup, `onSettled` | `shallowRef`, `onMounted`, `watch`, `onScopeDispose` |

The same rules hold in all four:

- **After client mount.** The view mounts once the framework has attached the element: React's layout effect, Svelte's attachment, SolidJS's settled effect and Vue's `onMounted`. None of these runs on the server, so importing or rendering a wrapper on the server creates no view, subscribes to nothing and touches no browser global.
- **The host owns the editor and transport.** A wrapper never creates or disposes either. The transport needs the editor and the host's audio context or media element, so the host makes both. Two views, or a view and a framework panel, can share one editor, transport and history. The context helpers only hand the host's editor and transport down to panels.
- **Changed options are forwarded.** A wrapper passes every render's options to `view.update`, which ignores equal ones. A different `editor`, `transport` or `renderer` disposes the view and mounts another in the same element.
- **Selectors are lazy.** A selector subscribes only while something reads it: React while the component is mounted, Svelte while an effect reads `.current`, SolidJS from settling until disposal, and Vue from mount or, outside a component, until its scope ends. On the server a selector returns the current value without subscribing.
- **Unmount releases everything.** The view's DOM, observers, animation frame callbacks, GPU contexts and every subscription to the editor, the transport and the waveform provider. The editor's document, selection and history are untouched.
- **Svelte ships `.svelte.js`.** The attachment uses `$effect`, so it ships as a `.svelte.js` module, built by tsrs from `.svelte.ts`, and the consumer's Svelte compiles its runes. Svelte libraries ship runes the same way.

## Consumers

`examples/frameworks/` holds five minimal consumers, one vanilla and one per framework, built by Vite 8 in production mode. The packages resolve through their public `exports`, which point at `dist`, so a consumer uses exactly what the packages would publish. A consumer may import only package entry points, never `internal`.

- **One host.** A shared module builds the fixture project, the editor, an audio transport over synthesized buffers and the waveform tiles, using only public exports. Every consumer has the same page layout, viewport and backend.
- **The same panels.** A take inspector shows the selected clip's name and active take, with a button for each candidate that dispatches `select-take`. A clock shows the playhead to a tenth of a second. Both are framework components built on the selectors.
- **A harness.** Each consumer lets the suite mount and unmount the view, change its options and swap the editor through the framework's own state, never by calling the view directly.
- **Server rendering.** Each framework consumer also builds a server entry that renders the same app to a string.

SolidJS 2's JSX compiler was published only under `next` tags on 2026-11-23: vite-plugin-solid 3.0.0-next.27 with babel-preset-solid 2.0.0-rc.2. The SolidJS consumer pins them exactly. The wrapper itself has no JSX and does not depend on them.

## The suite

`npm run verify:wrappers` builds the five consumers and runs each in Chromium at 1,280 × 800 CSS pixels and DPR 2, drawing through WebGL2. An init script counts the editor, selection, history, transport and waveform subscriptions; pending animation frame callbacks; live resize observers; live WebGL2 contexts and WebGPU devices; and audio nodes created.

1. **Lifecycle.** Mount, update every option, unmount and mount again, five times, then swap in another editor and back. After each unmount every count returns to its value before the first mount, no timeline DOM remains, the view made no audio node, and the host's editor still dispatches with its history intact. An option update keeps the same view and root element.
2. **Steady playback.** With a fixed viewport, selection and take, play for ten seconds. The take inspector receives zero updates, the clock updates, and the view uploads no static geometry, the same as vanilla.
3. **Replay.** The same trace in every consumer: seek on the ruler, select and trim a clip with the pointer, split at the playhead from the keyboard, undo, then choose another take with the inspector's button. Project snapshots, the selection, the selected take IDs, the planned audio spans and a grid of hit tests must equal vanilla's.
4. **Isolation.** The vanilla bundle contains no framework and no wrapper. Each wrapper's bundle contains its own framework only.
5. **Server rendering.** Node renders each server entry with no DOM globals. The markup contains the timeline's element and the inspector, and the host's editor and transport have no subscriptions afterwards.

`npm run bench:wrappers` runs the performance comparison on production builds in Google Chrome: a 20-second trace with playback, a pan and zoom, and pointer drags, repeated and interleaved across the five consumers. It records p50 and p95 frame time, input-to-paint drag latency and missed refreshes for each, with vanilla's run-to-run variation alongside. Results go to `docs/measurements/wrappers.json`. CI runs a short pass to keep the page working; its figures come from real hardware.

## Pull requests

| PR  | Scope                                                                                                 | Gate                                                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | `view.update`, `watchEditor`, `watchSnapshots`, `watchSelect`, `shallowEqual`, WebGL2 context release | Unit tests cover identity, laziness, equality and notification order of the watchers, including edits made during delivery. A browser trace shows an update repaints without a new view, equal options cost no paint, and mounting the view twenty times leaves no live context. |
| W2  | Vite consumers for vanilla and React, the React wrapper, `verify:wrappers` with all five checks       | The suite passes for vanilla and React. The React consumer runs under `StrictMode`. Every existing trace passes unchanged.                                                                                                                                                       |
| W3  | The Svelte, SolidJS and Vue wrappers and consumers                                                    | The suite passes for all five consumers, with identical replay results.                                                                                                                                                                                                          |
| W4  | `bench:wrappers`, published measurements, framework guide, milestone 5 status                         | The benchmark runs on all five consumers and its results are published with the hardware and browser. The roadmap marks milestone 5 complete.                                                                                                                                    |

W1 adds API and changes no behavior except the WebGL2 context's release. W2 and W3 add packages and examples only.

## As delivered

- **`view.update` takes what it is given.** A key left out keeps its value and a key given as `undefined` returns to its default, so a vanilla host can change one option and a wrapper can pass every prop. Invalid snap settings throw before anything changes. `npm run verify:mounts` checks the view's side, and twenty mounts in a row, on its own.
- **Every framework runs the lifecycle in development too.** The plan had React's `StrictMode` only. Svelte, SolidJS and Vue each also build a development consumer, where a framework reports misuse it checks only in development, and the suite fails on any console warning or error from any consumer. None prints one.
- **Transports follow their editors.** An audio transport subscribes to its editor, so the lifecycle compares each count with the host's own subscriptions, measured with the view and panels unmounted, rather than with zero.
- **Mutations fail the suite.** A React or SolidJS wrapper that remounts on an option change, a Svelte attachment whose mount effect reads every option, a Vue component that skips disposal and a SolidJS selector that never subscribes each fail it. Without the WebGL2 release, `verify:mounts` finds a live context after the first dispose.
- **Context follows a switched editor.** Vue's `provideTimeline` takes a ref or a getter and `useTimelineContext` returns a computed reference. Svelte and SolidJS hosts pass an object whose properties are getters. The selectors take a function returning the editor, so a panel follows a host that switches editors.
- **The API check follows `.svelte` modules.** Declarations of `attach.svelte.ts` were not reachable by the snapshot's file pattern, which now accepts dots in module names.
- **The benchmark reads a coarse clock.** Without cross-origin isolation Chrome reports time in 0.1 ms steps, so the comparison treats a difference that small as within variation.

## Settled

- **No wrapper-owned editors.** A wrapper that made the editor would also have to make the transport, which needs the host's audio context or media element. The host makes both and passes them down.
- **Options compare by value in the view.** The comparison lives in `view.update`, so the four wrappers and a vanilla host get it alike.
- **The viewport is the user's.** A host's `pixelsPerSecond` and `startTick` are starting values that move the viewport only when the host changes them.
- **Svelte gets an attachment and SolidJS a primitive.** Either can mount the view without a template compiler in the package. React and Vue components need none either.
