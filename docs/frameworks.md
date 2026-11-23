# Framework wrappers

Each wrapper mounts the same view as `mountTimeline` and lets a framework's own components read the editor and the transport. The host creates the editor and the transport, as in the [vanilla example](vanilla-timeline.md), and passes them down. A wrapper never creates or disposes either. The [plan](plans/framework-wrappers.md) records the design and its checks.

| Package                 | Framework peer  | Tested with  |
| ----------------------- | --------------- | ------------ |
| `@lumen-timeline/react` | `react` ^19.3.1 | React 19.3.1 |

Every wrapper follows the same rules:

- **After client mount.** The view mounts once the framework has attached its element, and never on the server. Rendering on the server produces the element and the panels, creates no view and subscribes to nothing.
- **Options.** Every render's options reach the mounted view through [`view.update`](vanilla-timeline.md), which ignores equal ones, so an object literal written in the markup costs nothing. A different `editor`, `transport` or `renderer` disposes the view and mounts another. `pixelsPerSecond` and `startTick` are starting values that move the viewport only when the host changes them, so the user's pan and zoom survive a render.
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

## Consumers and checks

`examples/frameworks` holds a vanilla consumer and one per framework. They share a host, `shared/browser.mjs`, with two editor and transport pairs over a 40-second project with candidate takes, synthesized sources played through Web Audio and waveform tiles. Each consumer has the same page: the timeline, a take inspector whose buttons choose the selected clip's candidate, and a clock. `npm run build:consumers` builds them with Vite in production mode into `examples/frameworks/dist`. The packages resolve through their public `exports` to their builds, as an installed copy would.

`npm run verify:wrappers` builds the consumers and runs the [wrapper acceptance tests](../ROADMAP.md#wrapper-acceptance-tests) on each in Chromium at 1,280 × 800 CSS pixels and DPR 2, through WebGL2. An init script counts pending animation frame callbacks, resize observers, live WebGL2 contexts and audio nodes created, and the host counts every subscription to its editors, transports and waveform tiles.

1. **Lifecycle.** Five times: mount the view, change every option, check that the same view and element remain, then unmount and check that every count is back where it started. Then mount with the other editor and transport and back, and with Canvas 2D and back. With the panels unmounted too, only the transports' own subscriptions to their editors remain, and the host's editor still edits with its history. No audio node was made. The React consumer also runs this check as a development build under `StrictMode`.
2. **Steady playback.** With a clip selected, ten seconds of playback give the take inspector no update and the view no geometry upload or layout, while the clock updates about a hundred times.
3. **Replay.** Seek on the ruler, trim a clip's end with the pointer, split at the playhead with `S`, undo with Control-Z, select another clip and choose its third take in the inspector. The snapshot, selection, active takes, playhead, history depths, planned audio spans and 476 hit tests must equal vanilla's.
4. **Isolation.** The vanilla bundle holds no framework and no wrapper, and each wrapper's bundle holds only its own.
5. **Server rendering.** Node renders each framework consumer's server entry with no DOM globals. The markup has the timeline's element and the inspector, no view, and no subscription.

CI runs the suite with `LUMEN_SOFTWARE_GPU=1`, which draws WebGL2 on SwiftShader.
