import type { Accessor, Context } from "solid-js";
import type { Editor, EditorState, SnapshotSource } from "@lumen-timeline/core";
import type { TimelineOptions, TimelineTransport, TimelineView } from "@lumen-timeline/timeline";
/**
 * Mounts the timeline view in `element` once it exists and the render has
 * settled, and disposes it with the owner. Give the element as a signal, such
 * as `const [element, setElement] = createSignal()` with `ref={setElement}`. A
 * different element, `editor`, `transport` or `renderer` mounts a new view;
 * every other option reaches the mounted view through `view.update`, which
 * ignores equal values. Returns the mounted view, `undefined` before it mounts.
 * Effects do not run on the server, so nothing is mounted there.
 */
export declare function createTimeline(element: Accessor<HTMLElement | null | undefined>, options: Accessor<TimelineOptions>): Accessor<TimelineView | undefined>;
/**
 * A field of the editor's snapshot, selection and history, as an accessor
 * that changes only when `isEqual`, `Object.is` by default, finds the field
 * changed. Pass the editor or an accessor of it; a new editor is followed. Pass
 * `shallowEqual` from the core for a selector that builds an object or array.
 */
export declare function createEditorSelector<T>(editor: Editor | Accessor<Editor>, select: (state: EditorState) => T, isEqual?: (a: T, b: T) => boolean): Accessor<T>;
/**
 * A field of a transport's snapshot, such as the playhead. The same rules as
 * `createEditorSelector`. A transport notifies on every frame during playback,
 * so select only as fine a field as the panel shows.
 */
export declare function createTransportSelector<S, T>(transport: SnapshotSource<S> | Accessor<SnapshotSource<S>>, select: (state: S) => T, isEqual?: (a: T, b: T) => boolean): Accessor<T>;
/**
 * The host's editor and transport, handed down to panels. A host that switches
 * them gives an object whose properties are getters of its signals.
 */
export interface TimelineContextValue {
    readonly editor: Editor;
    readonly transport: TimelineTransport;
}
/** Provide with `<TimelineContext value={{ editor, transport }}>`. */
export declare const TimelineContext: Context<TimelineContextValue>;
/** The editor and transport of the nearest `TimelineContext`. Throws without one. */
export declare function useTimelineContext(): TimelineContextValue;
