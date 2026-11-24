import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { CSSProperties, ReactElement, ReactNode, Ref } from "react";
import { watchEditor, watchSnapshots } from "@lumen-timeline/core";
import type { Editor, EditorState, SnapshotSource, Watchable } from "@lumen-timeline/core";
import { mountTimeline } from "@lumen-timeline/timeline";
import type { TimelineOptions, TimelineTransport, TimelineView } from "@lumen-timeline/timeline";

export interface TimelineProps extends TimelineOptions {
  /** Receives the mounted view, and `null` once it is disposed. */
  readonly ref?: Ref<TimelineView> | undefined;
  /** Applied to the element the view mounts in. */
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
}

/**
 * Mounts the timeline view in a `div` once React has attached it, and disposes
 * it on unmount. A different `editor`, `transport` or `renderer` mounts a new
 * view; every other option reaches the mounted view through `view.update`,
 * which ignores equal values. Nothing is mounted on the server. The host owns
 * the editor and transport.
 */
export function Timeline(props: TimelineProps): ReactElement {
  const { editor, transport, renderer, ref, className, style } = props;
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
    edgeMode,
  } = props;
  const element = useRef<HTMLDivElement>(null);
  const view = useRef<TimelineView | null>(null);
  useLayoutEffect(() => {
    const container = element.current;
    if (!container) return;
    // The options of the render that mounts; later ones go through `update`.
    const mounted = mountTimeline(container, {
      editor,
      transport,
      renderer,
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
      edgeMode,
    });
    view.current = mounted;
    return () => {
      view.current = null;
      mounted.dispose();
    };
    // Only these need a new view.
  }, [editor, transport, renderer]);
  useLayoutEffect(() => {
    view.current?.update({
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
      edgeMode,
    });
  });
  useImperativeHandle<TimelineView | null, TimelineView | null>(ref, () => view.current, [
    editor,
    transport,
    renderer,
  ]);
  return createElement("div", { ref: element, className, style });
}

// Selects from a watch for useSyncExternalStore. The selection is kept while
// the watched state keeps its identity, and a new selection equal to the one
// on screen keeps that one's identity, so an inline selector that builds an
// object renders only when `isEqual` finds a change.
function useSelected<S, T>(
  source: Watchable<S>,
  select: (state: S) => T,
  isEqual: (a: T, b: T) => boolean,
): T {
  const shown = useRef<{ readonly value: T } | null>(null);
  const subscribe = useCallback((listener: () => void) => source.subscribe(listener), [source]);
  const read = useMemo(() => {
    let memo: { readonly state: S; readonly value: T } | null = null;
    return (): T => {
      const state = source.get();
      if (memo && Object.is(memo.state, state)) return memo.value;
      const next = select(state);
      const last = shown.current;
      const value = last && isEqual(last.value, next) ? last.value : next;
      memo = { state, value };
      return value;
    };
  }, [source, select, isEqual]);
  const value = useSyncExternalStore(subscribe, read, read);
  useEffect(() => {
    shown.current = { value };
  }, [value]);
  return value;
}

/**
 * A field of the editor's snapshot, selection and history. The component
 * renders again only when `isEqual`, `Object.is` by default, finds the field
 * changed; pass `shallowEqual` from the core for a selector that builds an
 * object or array. Subscribes while the component is mounted, and not at all on
 * the server.
 */
export function useEditorSelector<T>(
  editor: Editor,
  select: (state: EditorState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const source = useMemo(() => watchEditor(editor), [editor]);
  return useSelected(source, select, isEqual);
}

/**
 * A field of a transport's snapshot, such as the playhead or whether it plays.
 * The same rules as `useEditorSelector`. A transport notifies on every frame
 * during playback, so select only as fine a field as the panel shows.
 */
export function useTransportSelector<S, T>(
  transport: SnapshotSource<S>,
  select: (state: S) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const source = useMemo(() => watchSnapshots(transport), [transport]);
  return useSelected(source, select, isEqual);
}

/** The host's editor and transport, handed down to panels. */
export interface TimelineContextValue {
  readonly editor: Editor;
  readonly transport: TimelineTransport;
}

const TimelineContext = createContext<TimelineContextValue | null>(null);

export interface TimelineProviderProps extends TimelineContextValue {
  readonly children?: ReactNode;
}

/** Hands the host's editor and transport to the panels below it. */
export function TimelineProvider({
  editor,
  transport,
  children,
}: TimelineProviderProps): ReactElement {
  const value = useMemo(() => ({ editor, transport }), [editor, transport]);
  return createElement(TimelineContext.Provider, { value }, children);
}

/** The editor and transport of the nearest `TimelineProvider`. Throws without one. */
export function useTimelineContext(): TimelineContextValue {
  const value = useContext(TimelineContext);
  if (!value) throw new Error("useTimelineContext needs a TimelineProvider above it");
  return value;
}
