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
/**
 * The editor's snapshot, selection and history as one value. Its identity
 * changes only when one of the three does, so a commit that also prunes the
 * selection and records history notifies once. It subscribes to the editor
 * only while it has listeners. Stop listening before disposing the editor.
 */
export declare function watchEditor(editor: Editor): Watchable<EditorState>;
/**
 * A snapshot source, such as a transport, as a watch. It reads `snapshot()`, so
 * a source that returns the same object until it notifies keeps the value's
 * identity stable. It subscribes to the source only while it has listeners.
 */
export declare function watchSnapshots<S>(source: SnapshotSource<S>): Watchable<S>;
/**
 * A field derived from another watch. `select` runs when the source's value
 * changes identity, and listeners run only when `isEqual`, `Object.is` by
 * default, finds the field changed. A selector that builds an object or array
 * should pass `shallowEqual` or its own comparison.
 */
export declare function watchSelect<S, T>(source: Watchable<S>, select: (state: S) => T, isEqual?: (a: T, b: T) => boolean): Watchable<T>;
/**
 * Whether two values are the same, or are arrays or plain objects whose
 * elements or own enumerable properties are the same by `Object.is`.
 */
export declare function shallowEqual<T>(a: T, b: T): boolean;
