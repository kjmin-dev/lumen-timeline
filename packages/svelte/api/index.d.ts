import type { Editor, EditorState, SnapshotSource } from "@lumen-timeline/core";
import type { TimelineTransport } from "@lumen-timeline/timeline";
export { timeline } from "./attach.svelte.ts";
export type { TimelineAttachmentOptions } from "./attach.svelte.ts";
/** A selected field. Read `current` in markup, a derived value or an effect. */
export interface Selected<T> {
    readonly current: T;
}
/**
 * A field of the editor's snapshot, selection and history. Effects that read
 * `current` run again only when `isEqual`, `Object.is` by default, finds the
 * field changed. Pass the editor or a function returning it; a new editor is
 * followed. Pass `shallowEqual` from the core for a selector that builds an
 * object or array.
 */
export declare function editorSelector<T>(editor: Editor | (() => Editor), select: (state: EditorState) => T, isEqual?: (a: T, b: T) => boolean): Selected<T>;
/**
 * A field of a transport's snapshot, such as the playhead. The same rules as
 * `editorSelector`. A transport notifies on every frame during playback, so
 * select only as fine a field as the panel shows.
 */
export declare function transportSelector<S, T>(transport: SnapshotSource<S> | (() => SnapshotSource<S>), select: (state: S) => T, isEqual?: (a: T, b: T) => boolean): Selected<T>;
/**
 * The host's editor and transport, handed down to panels. A host that switches
 * them passes an object whose properties are getters of its state.
 */
export interface TimelineContextValue {
    readonly editor: Editor;
    readonly transport: TimelineTransport;
}
/** Hands the host's editor and transport to the components below. Call during component setup. */
export declare function setTimelineContext(value: TimelineContextValue): TimelineContextValue;
/** The editor and transport a parent component set. Throws without one. */
export declare function getTimelineContext(): TimelineContextValue;
