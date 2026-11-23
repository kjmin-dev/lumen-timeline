import type { ComputedRef, DefineSetupFnComponent, MaybeRefOrGetter, ShallowRef } from "vue";
import type { Editor, EditorState, SnapshotSource } from "@lumen-timeline/core";
import type { TimelineOptions, TimelineTransport } from "@lumen-timeline/timeline";
export type TimelineProps = TimelineOptions;
/**
 * Mounts the timeline view in a `div` once Vue has mounted the component, and
 * disposes it before unmount. A different `editor`, `transport` or `renderer`
 * mounts a new view; every other prop reaches the mounted view through
 * `view.update`, which ignores equal values. The template ref exposes `view`.
 * Nothing is mounted on the server. Props are read raw, so an editor kept in a
 * deep `ref` still reaches the view as the object the host made.
 */
export declare const Timeline: DefineSetupFnComponent<TimelineProps>;
/**
 * A field of the editor's snapshot, selection and history, as a read-only
 * shallow reference that changes only when `isEqual`, `Object.is` by default,
 * finds the field changed. `editor` may be a ref or a getter; a new editor is
 * followed. Pass `shallowEqual` from the core for a selector that builds an
 * object or array.
 */
export declare function useEditorSelector<T>(editor: MaybeRefOrGetter<Editor>, select: (state: EditorState) => T, isEqual?: (a: T, b: T) => boolean): Readonly<ShallowRef<T>>;
/**
 * A field of a transport's snapshot, such as the playhead. The same rules as
 * `useEditorSelector`. A transport notifies on every frame during playback, so
 * select only as fine a field as the panel shows.
 */
export declare function useTransportSelector<S, T>(transport: MaybeRefOrGetter<SnapshotSource<S>>, select: (state: S) => T, isEqual?: (a: T, b: T) => boolean): Readonly<ShallowRef<T>>;
/** The host's editor and transport, handed down to panels. */
export interface TimelineContextValue {
    readonly editor: Editor;
    readonly transport: TimelineTransport;
}
/**
 * Hands the host's editor and transport to the components below. A ref or a
 * getter lets a host switch them; panels follow.
 */
export declare function provideTimeline(value: MaybeRefOrGetter<TimelineContextValue>): void;
/** The editor and transport of the nearest `provideTimeline`. Throws without one. */
export declare function useTimelineContext(): ComputedRef<TimelineContextValue>;
