import { reportListenerError } from "./host.ts";
import type { Editor, HistoryState, ProjectSnapshot } from "./types.ts";

/**
 * A value that changes over time: read it at any moment, and hear when it
 * changes. This is the shape that React's `useSyncExternalStore`, Svelte's
 * `createSubscriber`, a SolidJS signal and a Vue shallow reference bridge to.
 */
export interface Watchable<T> {
  /**
   * The current value. Reading again returns the same value, by identity,
   * until it changes, whether or not anything is subscribed.
   */
  get(): T;
  /**
   * Calls `listener` after the value changes. The watch subscribes to its
   * source while it has at least one listener. Returns a function that removes
   * this listener; calling it again does nothing.
   */
  subscribe(listener: () => void): () => void;
}

/** The parts of an editor that a host's panels read, as one value. */
export interface EditorState {
  readonly snapshot: ProjectSnapshot;
  /** The selected clip IDs, as `editor.session.getSelection()` returns them. */
  readonly selection: readonly string[];
  readonly history: HistoryState;
}

/** A source of snapshots that notifies when it has a new one, such as a transport. */
export interface SnapshotSource<S> {
  snapshot(): S;
  subscribe(listener: (state: S) => void): () => unknown;
}

// Reads a value, notifies listeners when a read after `start`'s signal differs
// by identity, and holds the source's subscription while it has listeners.
function watchable<T>(read: () => T, start: (changed: () => void) => () => void): Watchable<T> {
  const listeners = new Set<() => void>();
  let stop: (() => void) | null = null;
  let last: { readonly value: T } | null = null;
  function changed(): void {
    const value = read();
    if (last && Object.is(last.value, value)) return;
    last = { value };
    // oxlint-disable-next-line unicorn/no-useless-spread -- Listeners may subscribe or unsubscribe during delivery, so iterate a snapshot.
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener();
      } catch (error) {
        reportListenerError(error);
      }
    }
  }
  return {
    get: read,
    subscribe(listener) {
      // Each subscription is its own entry, so one function can be added twice.
      const entry = (): void => listener();
      listeners.add(entry);
      if (!stop) {
        last = { value: read() };
        stop = start(changed);
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(entry);
        if (listeners.size || !stop) return;
        const end = stop;
        stop = null;
        last = null;
        end();
      };
    },
  };
}

/**
 * The editor's snapshot, selection and history as one value. Its identity
 * changes only when one of the three does, so a commit that also prunes the
 * selection and records history notifies once. It subscribes to the editor
 * only while it has listeners. Stop listening before disposing the editor.
 */
export function watchEditor(editor: Editor): Watchable<EditorState> {
  let state: EditorState | null = null;
  function read(): EditorState {
    const snapshot = editor.getSnapshot();
    const selection = editor.session.getSelection();
    const { undoDepth, redoDepth, estimatedBytes } = editor.history;
    const previous = state;
    const sameHistory =
      previous !== null &&
      previous.history.undoDepth === undoDepth &&
      previous.history.redoDepth === redoDepth &&
      previous.history.estimatedBytes === estimatedBytes;
    if (
      previous !== null &&
      sameHistory &&
      previous.snapshot === snapshot &&
      previous.selection === selection
    )
      return previous;
    const history =
      previous !== null && sameHistory
        ? previous.history
        : Object.freeze({ undoDepth, redoDepth, estimatedBytes });
    state = Object.freeze({ snapshot, selection, history });
    return state;
  }
  return watchable(read, (changed) => {
    const offs = [
      editor.subscribe((snapshot) => snapshot, changed),
      editor.session.subscribeSelection(changed),
      editor.history.subscribe(changed),
    ];
    return () => {
      for (const off of offs) off();
    };
  });
}

/**
 * A snapshot source, such as a transport, as a watch. It reads `snapshot()`, so
 * a source that returns the same object until it notifies keeps the value's
 * identity stable. It subscribes to the source only while it has listeners.
 */
export function watchSnapshots<S>(source: SnapshotSource<S>): Watchable<S> {
  return watchable(
    () => source.snapshot(),
    (changed) => {
      const off = source.subscribe(() => changed());
      return () => {
        off();
      };
    },
  );
}

/**
 * A field derived from another watch. `select` runs when the source's value
 * changes identity, and listeners run only when `isEqual`, `Object.is` by
 * default, finds the field changed. A selector that builds an object or array
 * should pass `shallowEqual` or its own comparison.
 */
export function watchSelect<S, T>(
  source: Watchable<S>,
  select: (state: S) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): Watchable<T> {
  let memo: { readonly input: S; readonly output: T } | null = null;
  function read(): T {
    const input = source.get();
    if (memo && Object.is(memo.input, input)) return memo.output;
    const next = select(input);
    const output = memo && isEqual(memo.output, next) ? memo.output : next;
    memo = { input, output };
    return output;
  }
  return watchable(read, (changed) => source.subscribe(changed));
}

const plain = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Whether two values are the same, or are arrays or plain objects whose
 * elements or own enumerable properties are the same by `Object.is`.
 */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value: unknown, i) => Object.is(value, b[i]));
  }
  if (!plain(a) || !plain(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) => Object.hasOwn(b, key) && Object.is(Reflect.get(a, key), Reflect.get(b, key)),
  );
}
