# Framework wrappers

Each wrapper mounts the same view as `mountTimeline` and lets a framework's own components read the editor and the transport. The host creates the editor and the transport, as in the [vanilla example](vanilla-timeline.md), and passes them down. A wrapper never creates or disposes either. The [plan](plans/framework-wrappers.md) records the design and its checks.

| Package                  | Framework peer    | Tested with                                                                                      |
| ------------------------ | ----------------- | ------------------------------------------------------------------------------------------------ |
| `@lumen-timeline/react`  | `react` ^19.0.0   | React 19.3.1                                                                                     |
| `@lumen-timeline/svelte` | `svelte` ^5.40.0  | Svelte 5.59.1 with vite-plugin-svelte 7.3.1                                                      |
| `@lumen-timeline/solid`  | `solid-js` ^2.0.0 | SolidJS 2.0.3 with vite-plugin-solid 3.0.0-next.27 and babel-preset-solid 2.0.0-rc.2 for its JSX |
| `@lumen-timeline/vue`    | `vue` ^3.5.0      | Vue 3.5.46 with @vitejs/plugin-vue 6.0.11                                                        |

Each package is TypeScript built to plain JavaScript, with no JSX and no template compiler, so a consumer needs only the build its framework needs anyway.

Every wrapper follows the same rules:

- **After client mount.** The view mounts once the framework has attached its element, and never on the server. Rendering on the server produces the element and the panels, creates no view and subscribes to nothing.
- **Options.** Every render's options—including `chrome`, `theme`, `layout`, `labels`, `readOnly`, `shortcuts`, `formatTime`, `gridSpacing`, `clipStyle`, `renderTrackHeader`, `renderOverlay`, `events`, `snap`, `waveforms`, `pixelsPerSecond` and `startTick`—reach the mounted view through [`view.update`](vanilla-timeline.md), which ignores equal ones, so an object literal written in the markup costs nothing. A different `editor`, `transport` or `renderer` disposes the view and mounts another. `pixelsPerSecond` and `startTick` are starting values that move the viewport only when the host changes them, so the user's pan and zoom survive a render.
- **Fields.** A panel selects the fields it shows from the editor's [watched state](headless-editing.md#watching-state), `{ snapshot, selection, history }`, or from the transport's snapshot. It updates only when its field changes, compared with `Object.is` or the comparison it passes, such as `shallowEqual` from the core. During playback a panel that reads only editor fields does nothing.
- **Unmount.** The view's DOM, observers, animation frame callbacks, GPU context and every subscription it or a selector held are released. The editor's document, selection and history are untouched.

## React

```jsx
import { useRef } from "react";
import { TICKS_PER_SECOND as hz, shallowEqual } from "@lumen-timeline/core";
import {
  Timeline,
  TimelineProvider,
  useEditorSelector,
  useTimelineContext,
  useTransportSelector,
} from "@lumen-timeline/react";
import "@lumen-timeline/timeline/style.css";

function TakeInspector() {
  const { editor } = useTimelineContext();
  const clip = useEditorSelector(
    editor,
    ({ snapshot, selection }) => {
      const found = snapshot.clips.find((c) => c.id === selection.at(-1));
      return found ? { id: found.id, name: found.name, take: found.activeTakeId } : null;
    },
    shallowEqual,
  );
  return <aside>{clip ? `${clip.name}: ${clip.take}` : "No clip selected"}</aside>;
}

function Clock() {
  const { transport } = useTimelineContext();
  const tenths = useTransportSelector(transport, (s) => Math.floor(s.presentedTick / (hz / 10)));
  return <output>{(tenths / 10).toFixed(1)} s</output>;
}

export function Workspace({ editor, transport, tiles }) {
  const view = useRef(null);
  return (
    <TimelineProvider editor={editor} transport={transport}>
      <Clock />
      <Timeline
        editor={editor}
        transport={transport}
        waveforms={tiles}
        snap={{ gridTicks: hz / 10 }}
        ref={view}
      />
      <TakeInspector />
    </TimelineProvider>
  );
}
```

- **`<Timeline {...options}>`** renders a `div` and mounts the view in it from a layout effect. It takes every `mountTimeline` option as a prop, with `className` and `style` for the `div`. `ref` receives the `TimelineView`, for `reveal`, `setViewport` or `hitTest`, and `null` once it is disposed.
- **`useEditorSelector(editor, select, isEqual)`** returns a field of the editor's state through `useSyncExternalStore`. The selector may be written inline. A new selection equal to the one on screen keeps that one's identity, so the component renders only when `isEqual` finds a change.
- **`useTransportSelector(transport, select, isEqual)`** does the same for any source with `snapshot()` and `subscribe()`. A transport notifies on every frame during playback, so select no finer a field than the panel shows.
- **`<TimelineProvider editor transport>`** and **`useTimelineContext()`** hand the host's editor and transport to panels below it. `useTimelineContext` throws without a provider.
- Under `StrictMode` in development, React mounts each new component's effects twice. The first view is disposed at once, before anything draws.

## Svelte

```svelte
<script>
  import { shallowEqual } from "@lumen-timeline/core";
  import { editorSelector, setTimelineContext, timeline } from "@lumen-timeline/svelte";
  import "@lumen-timeline/timeline/style.css";

  const { editor, transport, tiles } = $props();
  let snap = $state({ gridTicks: 28224000 });
  let view = null;
  setTimelineContext({ editor, transport });
  const clip = editorSelector(
    editor,
    ({ snapshot, selection }) => {
      const found = snapshot.clips.find((c) => c.id === selection.at(-1));
      return found ? { name: found.name, take: found.activeTakeId } : null;
    },
    shallowEqual,
  );
</script>

<div {@attach timeline(() => ({ editor, transport, snap, waveforms: tiles, onview: (v) => (view = v) }))}></div>
<aside>{clip.current ? `${clip.current.name}: ${clip.current.take}` : "No clip selected"}</aside>
```

- **`{@attach timeline(() => options)}`** mounts the view in its element and disposes it when the element goes. Pass a function that returns the options, so they are read inside the attachment: a changed `editor`, `transport` or `renderer` mounts a new view, and other options reach the mounted view. `onview` receives the view, and `null` once it is disposed.
- **`editorSelector(editor, select, isEqual)`** returns `{ current }`. Read `current` in markup, a derived value or an effect. An effect that reads it subscribes, and the subscription ends when no effect reads it. `editor` may be a function returning it, which a host that switches editors passes.
- **`transportSelector(transport, select, isEqual)`** does the same for a transport's snapshot.
- **`setTimelineContext({ editor, transport })`** and **`getTimelineContext()`** hand the host's editor and transport down during component setup. A host that switches them passes an object whose properties are getters of its state.
- The attachment uses `$effect`, so the package ships it as `attach.svelte.js` and the application's Svelte compiles its runes, as Svelte libraries do. The package's `svelte` export condition tells Vite so.

## SolidJS

```jsx
import { createSignal } from "solid-js";
import { shallowEqual } from "@lumen-timeline/core";
import { createEditorSelector, createTimeline, TimelineContext } from "@lumen-timeline/solid";
import "@lumen-timeline/timeline/style.css";

export function Workspace(props) {
  const [element, setElement] = createSignal();
  const [snap] = createSignal({ gridTicks: 28224000 });
  const view = createTimeline(element, () => ({
    editor: props.editor,
    transport: props.transport,
    snap: snap(),
  }));
  const clip = createEditorSelector(
    () => props.editor,
    ({ snapshot, selection }) => {
      const found = snapshot.clips.find((c) => c.id === selection.at(-1));
      return found ? { name: found.name, take: found.activeTakeId } : null;
    },
    shallowEqual,
  );
  return (
    <TimelineContext value={{ editor: props.editor, transport: props.transport }}>
      <div ref={setElement} />
      <aside>{clip() ? `${clip().name}: ${clip().take}` : "No clip selected"}</aside>
    </TimelineContext>
  );
}
```

- **`createTimeline(element, options)`** mounts the view in `element` once the render has settled, and disposes it with its owner. Give the element as a signal, with its setter as the `ref`, and the options as an accessor. It returns an accessor of the view, `undefined` until it mounts.
- **`createEditorSelector(editor, select, isEqual)`** returns an accessor of the field. It subscribes from its first effect run until its owner is disposed. `editor` may be an accessor, which a host that switches editors passes.
- **`createTransportSelector(transport, select, isEqual)`** does the same for a transport's snapshot.
- **`<TimelineContext value={{ editor, transport }}>`** and **`useTimelineContext()`** hand the host's editor and transport down. A host that switches them passes an object whose properties are getters of its signals. `useTimelineContext` throws without a provider.
- SolidJS 2's JSX compiler was published only under `next` tags when this was tested. The package has no JSX and does not depend on it; an application compiles its own.

## Vue

```vue
<script setup>
import { computed, useTemplateRef } from "vue";
import { shallowEqual } from "@lumen-timeline/core";
import { provideTimeline, Timeline, useEditorSelector } from "@lumen-timeline/vue";
import "@lumen-timeline/timeline/style.css";

const { editor, transport, tiles } = defineProps(["editor", "transport", "tiles"]);
provideTimeline({ editor, transport });
const timeline = useTemplateRef("timeline");
const clip = useEditorSelector(
  editor,
  ({ snapshot, selection }) => {
    const found = snapshot.clips.find((c) => c.id === selection.at(-1));
    return found ? { name: found.name, take: found.activeTakeId } : null;
  },
  shallowEqual,
);
</script>

<template>
  <Timeline ref="timeline" :editor="editor" :transport="transport" :waveforms="tiles" />
  <aside>{{ clip ? `${clip.name}: ${clip.take}` : "No clip selected" }}</aside>
</template>
```

- **`<Timeline v-bind="options">`** renders a `div` and mounts the view in it on mount. `class` and `style` fall through to the `div`. The template ref exposes `view`, the `TimelineView` or `null`. Props are read raw, so an editor kept in a deep `ref` still reaches the view as the object the host made.
- **`useEditorSelector(editor, select, isEqual)`** returns a read-only shallow reference. In a component it subscribes from mount until unmount; elsewhere, from the call until its effect scope ends. `editor` may be a ref or a getter, and a new editor is followed.
- **`useTransportSelector(transport, select, isEqual)`** does the same for a transport's snapshot.
- **`provideTimeline(value)`** and **`useTimelineContext()`** hand the host's editor and transport down. `value` may be a ref or a getter, and `useTimelineContext` returns a computed reference. It throws without a provider.

## Consumers and checks

`examples/frameworks` holds a vanilla consumer and one per framework. They share a host, `shared/browser.mjs`, with two editor and transport pairs over a 40-second project with candidate takes, synthesized sources played through Web Audio and waveform tiles. Each consumer has the same page: the timeline, a take inspector whose buttons choose the selected clip's candidate, and a clock. `npm run build:consumers` builds them with Vite in production mode into `examples/frameworks/dist`. The packages resolve through their public `exports` to their builds, as an installed copy would.

`npm run verify:wrappers` builds the consumers and runs the [wrapper acceptance tests](../ROADMAP.md#wrapper-acceptance-tests) on each in Chromium at 1,280 × 800 CSS pixels and DPR 2, through WebGL2. An init script counts pending animation frame callbacks, resize observers, live WebGL2 contexts and audio nodes created, and the host counts every subscription to its editors, transports and waveform tiles.

1. **Lifecycle.** Five times: mount the view, change every option, check that the same view and element remain, then unmount and check that every count is back where it started. Then mount with the other editor and transport and back, and with Canvas 2D and back. With the panels unmounted too, only the transports' own subscriptions to their editors remain, and the host's editor still edits with its history. No audio node was made. Each framework consumer also runs this check as a development build, React's under `StrictMode`, where frameworks report misuse they check only in development. No consumer may print a warning.
2. **Steady playback.** With a clip selected, ten seconds of playback give the take inspector no update and the view no geometry upload or layout, while the clock updates about a hundred times.
3. **Replay.** Seek on the ruler, trim a clip's end with the pointer, split at the playhead with `S`, undo with Control-Z, select another clip and choose its third take in the inspector. The snapshot, selection, active takes, playhead, history depths, planned audio spans and 476 hit tests must equal vanilla's.
4. **Isolation.** The vanilla bundle holds no framework and no wrapper, and each wrapper's bundle holds only its own.
5. **Server rendering.** Node renders each framework consumer's server entry with no DOM globals. The markup has the timeline's element and the inspector, no view, and no subscription.

CI runs the suite with `LUMEN_SOFTWARE_GPU=1`, which draws WebGL2 on SwiftShader.

## Benchmark

`npm run bench:wrappers` compares the production builds with vanilla in Google Chrome at 1,280 × 800 CSS pixels and DPR 2, through WebGL2. Each run opens every consumer once, in an order that rotates from run to run. Each consumer gets the same 20-second trace with playback: eight seconds of panning and zooming the view, then pointer drags that select a clip, preview its move and commit it. It records main-thread work per frame until the frame's tasks end, missed refreshes, and the time from each pointer move to the end of the frame that shows it. `--write` records the medians over the runs and every run in `docs/measurements/wrappers.json`. A wrapper is within variation when its median is no further above vanilla's than vanilla's own runs spread, or than Chrome's 0.1 ms clock can tell apart.

Five runs on an Apple M2 Pro in Chrome 157, medians with the spread across runs:

| Consumer | Frame work p50 | Frame work p95 | Pointer to frame end p95 | Missed refreshes |
| -------- | -------------- | -------------- | ------------------------ | ---------------- |
| Vanilla  | 0.6 ms         | 1.3 ± 0.7 ms   | 16.8 ± 0.9 ms            | 0.00 ± 0.08%     |
| React    | 0.7 ms         | 1.7 ± 1.2 ms   | 17.2 ± 0.4 ms            | 0.00%            |
| Svelte   | 0.6 ms         | 1.3 ± 0.7 ms   | 17.1 ± 0.7 ms            | 0.00 ± 0.08%     |
| SolidJS  | 0.6 ms         | 1.3 ± 1.2 ms   | 17.1 ± 0.3 ms            | 0.00%            |
| Vue      | 0.6 ms         | 1.2 ± 0.9 ms   | 17.0 ± 0.4 ms            | 0.00%            |

Every wrapper is within vanilla's variation. A pointer move reaches the screen in the next frame, about 16.7 ms later at 60 Hz, in all five consumers. React's p95 frame work is the highest, at 0.4 ms above vanilla's median, which is inside vanilla's 0.7 ms spread. CI runs one short pass on Canvas 2D to keep the page working; its figures come from real hardware.
