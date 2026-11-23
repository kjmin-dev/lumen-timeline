import {
  computed,
  defineComponent,
  getCurrentInstance,
  getCurrentScope,
  h,
  inject,
  onBeforeUnmount,
  onMounted,
  onScopeDispose,
  provide,
  shallowRef,
  toRaw,
  toValue,
  watch,
} from "vue";
import type {
  ComputedRef,
  DefineSetupFnComponent,
  InjectionKey,
  MaybeRefOrGetter,
  ShallowRef,
} from "vue";
import { watchEditor, watchSelect, watchSnapshots } from "@lumen-timeline/core";
import type { Editor, EditorState, SnapshotSource, Watchable } from "@lumen-timeline/core";
import { mountTimeline } from "@lumen-timeline/timeline";
import type {
  TimelineOptions,
  TimelineTransport,
  TimelineUpdate,
  TimelineView,
} from "@lumen-timeline/timeline";

export type TimelineProps = TimelineOptions;

const optionNames = [
  "editor",
  "transport",
  "renderer",
  "pixelsPerSecond",
  "startTick",
  "snap",
  "labels",
  "waveforms",
] as const satisfies readonly (keyof TimelineProps)[];

/**
 * Mounts the timeline view in a `div` once Vue has mounted the component, and
 * disposes it before unmount. A different `editor`, `transport` or `renderer`
 * mounts a new view; every other prop reaches the mounted view through
 * `view.update`, which ignores equal values. The template ref exposes `view`.
 * Nothing is mounted on the server. Props are read raw, so an editor kept in a
 * deep `ref` still reaches the view as the object the host made.
 */
export const Timeline: DefineSetupFnComponent<TimelineProps> = defineComponent(
  (props: TimelineProps, { expose }) => {
    const element = shallowRef<HTMLDivElement | null>(null);
    const view = shallowRef<TimelineView | null>(null);
    const update = (): TimelineUpdate => ({
      pixelsPerSecond: props.pixelsPerSecond,
      startTick: props.startTick,
      snap: toRaw(props.snap),
      labels: toRaw(props.labels),
      waveforms: toRaw(props.waveforms),
    });
    function mount(): void {
      const container = element.value;
      if (!container) return;
      view.value = mountTimeline(container, {
        ...update(),
        editor: toRaw(props.editor),
        transport: toRaw(props.transport),
        renderer: props.renderer,
      });
    }
    function unmount(): void {
      view.value?.dispose();
      view.value = null;
    }
    onMounted(mount);
    onBeforeUnmount(unmount);
    watch([() => props.editor, () => props.transport, () => props.renderer], () => {
      if (!view.value) return;
      unmount();
      mount();
    });
    watch(
      [
        () => props.pixelsPerSecond,
        () => props.startTick,
        () => props.snap,
        () => props.labels,
        () => props.waveforms,
      ],
      () => view.value?.update(update()),
    );
    expose({ view });
    return () => h("div", { ref: element });
  },
  { name: "LumenTimeline", props: [...optionNames] },
);

// Follows a watch from mount, or at once outside a component, until unmount or
// the end of the scope. On the server a component never mounts, so it reads
// the value and subscribes to nothing.
function useSelected<S, T>(
  source: () => Watchable<S>,
  select: (state: S) => T,
  isEqual: (a: T, b: T) => boolean,
): Readonly<ShallowRef<T>> {
  let watched = watchSelect(source(), select, isEqual);
  const value = shallowRef(watched.get());
  let stop: (() => void) | null = null;
  const start = (): void => {
    value.value = watched.get();
    stop = watched.subscribe(() => {
      value.value = watched.get();
    });
  };
  const end = (): void => {
    stop?.();
    stop = null;
  };
  watch(source, (next) => {
    const live = stop !== null;
    end();
    watched = watchSelect(next, select, isEqual);
    value.value = watched.get();
    if (live) start();
  });
  if (getCurrentInstance()) {
    onMounted(start);
    onBeforeUnmount(end);
  } else start();
  if (getCurrentScope()) onScopeDispose(end);
  return value;
}

/**
 * A field of the editor's snapshot, selection and history, as a read-only
 * shallow reference that changes only when `isEqual`, `Object.is` by default,
 * finds the field changed. `editor` may be a ref or a getter; a new editor is
 * followed. Pass `shallowEqual` from the core for a selector that builds an
 * object or array.
 */
export function useEditorSelector<T>(
  editor: MaybeRefOrGetter<Editor>,
  select: (state: EditorState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): Readonly<ShallowRef<T>> {
  const current = computed(() => watchEditor(toRaw(toValue(editor))));
  return useSelected(() => current.value, select, isEqual);
}

/**
 * A field of a transport's snapshot, such as the playhead. The same rules as
 * `useEditorSelector`. A transport notifies on every frame during playback, so
 * select only as fine a field as the panel shows.
 */
export function useTransportSelector<S, T>(
  transport: MaybeRefOrGetter<SnapshotSource<S>>,
  select: (state: S) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): Readonly<ShallowRef<T>> {
  const current = computed(() => watchSnapshots(toRaw(toValue(transport))));
  return useSelected(() => current.value, select, isEqual);
}

/** The host's editor and transport, handed down to panels. */
export interface TimelineContextValue {
  readonly editor: Editor;
  readonly transport: TimelineTransport;
}

const contextKey: InjectionKey<ComputedRef<TimelineContextValue>> = Symbol("lumen-timeline");

/**
 * Hands the host's editor and transport to the components below. A ref or a
 * getter lets a host switch them; panels follow.
 */
export function provideTimeline(value: MaybeRefOrGetter<TimelineContextValue>): void {
  provide(
    contextKey,
    computed(() => toValue(value)),
  );
}

/** The editor and transport of the nearest `provideTimeline`. Throws without one. */
export function useTimelineContext(): ComputedRef<TimelineContextValue> {
  const value = inject(contextKey, null);
  if (!value) throw new Error("useTimelineContext needs provideTimeline in a parent component");
  return value;
}
