import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  untrack,
  useContext,
} from "solid-js";
import type { Accessor, Context } from "solid-js";
import { watchEditor, watchSelect, watchSnapshots } from "@lumen-timeline/core";
import type { Editor, EditorState, SnapshotSource, Watchable } from "@lumen-timeline/core";
import { mountTimeline } from "@lumen-timeline/timeline";
import type { TimelineOptions, TimelineTransport, TimelineView } from "@lumen-timeline/timeline";

interface Fixed {
  readonly element: HTMLElement | null | undefined;
  readonly editor: Editor;
  readonly transport: TimelineTransport;
  readonly renderer: TimelineOptions["renderer"];
}
const sameFixed = (a: Fixed, b: Fixed): boolean =>
  a.element === b.element &&
  a.editor === b.editor &&
  a.transport === b.transport &&
  a.renderer === b.renderer;

/**
 * Mounts the timeline view in `element` once it exists and the render has
 * settled, and disposes it with the owner. Give the element as a signal, such
 * as `const [element, setElement] = createSignal()` with `ref={setElement}`. A
 * different element, `editor`, `transport` or `renderer` mounts a new view;
 * every other option reaches the mounted view through `view.update`, which
 * ignores equal values. Returns the mounted view, `undefined` before it mounts.
 * Effects do not run on the server, so nothing is mounted there.
 */
export function createTimeline(
  element: Accessor<HTMLElement | null | undefined>,
  options: Accessor<TimelineOptions>,
): Accessor<TimelineView | undefined> {
  const [view, setView] = createSignal<TimelineView>();
  const fixed = createMemo(
    (): Fixed => {
      const { editor, transport, renderer } = options();
      return { element: element(), editor, transport, renderer };
    },
    { equals: sameFixed },
  );
  createEffect(fixed, ({ element: container, editor, transport, renderer }) => {
    if (!container) return;
    const mounted = mountTimeline(container, { ...untrack(options), editor, transport, renderer });
    setView(mounted);
    return () => {
      setView(undefined);
      mounted.dispose();
    };
  });
  createEffect(
    () => {
      const {
        pixelsPerSecond,
        startTick,
        snap,
        labels,
        waveforms,
        chrome,
        theme,
        layout,
        readOnly,
        shortcuts,
        formatTime,
        gridSpacing,
        clipStyle,
        renderTrackHeader,
        renderOverlay,
        events,
      } = options();
      return {
        pixelsPerSecond,
        startTick,
        snap,
        labels,
        waveforms,
        chrome,
        theme,
        layout,
        readOnly,
        shortcuts,
        formatTime,
        gridSpacing,
        clipStyle,
        renderTrackHeader,
        renderOverlay,
        events,
      };
    },
    (next) => untrack(view)?.update(next),
  );
  return view;
}

// Follows a watch of whatever `source` returns now, from the first effect run
// until disposal. Effects do not run on the server, so it reads the value there
// and subscribes to nothing.
function selected<K, S, T>(
  source: Accessor<K>,
  watchFor: (key: K) => Watchable<S>,
  select: (state: S) => T,
  isEqual: (a: T, b: T) => boolean,
): Accessor<T> {
  const watched = createMemo(() => watchSelect(watchFor(source()), select, isEqual));
  // Boxed, so a selected function is stored as a value.
  const [box, setBox] = createSignal({ value: untrack(watched).get() });
  createEffect(watched, (watch) => {
    setBox({ value: watch.get() });
    return watch.subscribe(() => setBox({ value: watch.get() }));
  });
  return () => box().value;
}

const resolve = <T extends object>(value: T | Accessor<T>): Accessor<T> =>
  typeof value === "function" ? value : () => value;

/**
 * A field of the editor's snapshot, selection and history, as an accessor
 * that changes only when `isEqual`, `Object.is` by default, finds the field
 * changed. Pass the editor or an accessor of it; a new editor is followed. Pass
 * `shallowEqual` from the core for a selector that builds an object or array.
 */
export function createEditorSelector<T>(
  editor: Editor | Accessor<Editor>,
  select: (state: EditorState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): Accessor<T> {
  return selected(resolve(editor), watchEditor, select, isEqual);
}

/**
 * A field of a transport's snapshot, such as the playhead. The same rules as
 * `createEditorSelector`. A transport notifies on every frame during playback,
 * so select only as fine a field as the panel shows.
 */
export function createTransportSelector<S, T>(
  transport: SnapshotSource<S> | Accessor<SnapshotSource<S>>,
  select: (state: S) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): Accessor<T> {
  return selected(resolve(transport), (t: SnapshotSource<S>) => watchSnapshots(t), select, isEqual);
}

/**
 * The host's editor and transport, handed down to panels. A host that switches
 * them gives an object whose properties are getters of its signals.
 */
export interface TimelineContextValue {
  readonly editor: Editor;
  readonly transport: TimelineTransport;
}

/** Provide with `<TimelineContext value={{ editor, transport }}>`. */
export const TimelineContext: Context<TimelineContextValue> = createContext<TimelineContextValue>();

/** The editor and transport of the nearest `TimelineContext`. Throws without one. */
export function useTimelineContext(): TimelineContextValue {
  return useContext(TimelineContext);
}
