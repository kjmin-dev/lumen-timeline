import { createContext } from "svelte";
import { createSubscriber } from "svelte/reactivity";
import { watchEditor, watchSelect, watchSnapshots } from "@lumen-timeline/core";
import type { Editor, EditorState, SnapshotSource, Watchable } from "@lumen-timeline/core";
import type { TimelineTransport } from "@lumen-timeline/timeline";

export { timeline } from "./attach.svelte.ts";
export type { TimelineAttachmentOptions } from "./attach.svelte.ts";

/** A selected field. Read `current` in markup, a derived value or an effect. */
export interface Selected<T> {
  readonly current: T;
}

// Reads a watch of whatever `source` returns now. A reading effect subscribes,
// and the subscription ends when no effect reads it any more; elsewhere, as on
// the server, `current` is read without subscribing.
function selected<K, S, T>(
  source: () => K,
  watchFor: (key: K) => Watchable<S>,
  select: (state: S) => T,
  isEqual: (a: T, b: T) => boolean,
): Selected<T> {
  let watched: {
    readonly key: K;
    readonly watch: Watchable<T>;
    readonly subscribe: () => void;
  } | null = null;
  return {
    get current() {
      const key = source();
      if (!watched || watched.key !== key) {
        const watch = watchSelect(watchFor(key), select, isEqual);
        watched = { key, watch, subscribe: createSubscriber((update) => watch.subscribe(update)) };
      }
      watched.subscribe();
      return watched.watch.get();
    },
  };
}

const resolve = <T extends object>(value: T | (() => T)): (() => T) =>
  typeof value === "function" ? value : () => value;

/**
 * A field of the editor's snapshot, selection and history. Effects that read
 * `current` run again only when `isEqual`, `Object.is` by default, finds the
 * field changed. Pass the editor or a function returning it; a new editor is
 * followed. Pass `shallowEqual` from the core for a selector that builds an
 * object or array.
 */
export function editorSelector<T>(
  editor: Editor | (() => Editor),
  select: (state: EditorState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): Selected<T> {
  return selected(resolve(editor), watchEditor, select, isEqual);
}

/**
 * A field of a transport's snapshot, such as the playhead. The same rules as
 * `editorSelector`. A transport notifies on every frame during playback, so
 * select only as fine a field as the panel shows.
 */
export function transportSelector<S, T>(
  transport: SnapshotSource<S> | (() => SnapshotSource<S>),
  select: (state: S) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): Selected<T> {
  return selected(resolve(transport), (t: SnapshotSource<S>) => watchSnapshots(t), select, isEqual);
}

/**
 * The host's editor and transport, handed down to panels. A host that switches
 * them passes an object whose properties are getters of its state.
 */
export interface TimelineContextValue {
  readonly editor: Editor;
  readonly transport: TimelineTransport;
}

const [getContext, setContext] = createContext<TimelineContextValue>();

/** Hands the host's editor and transport to the components below. Call during component setup. */
export function setTimelineContext(value: TimelineContextValue): TimelineContextValue {
  return setContext(value);
}

/** The editor and transport a parent component set. Throws without one. */
export function getTimelineContext(): TimelineContextValue {
  return getContext();
}
