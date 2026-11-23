import type { CSSProperties, ReactElement, ReactNode, Ref } from "react";
import type { Editor, EditorState, SnapshotSource } from "@lumen-timeline/core";
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
export declare function Timeline(props: TimelineProps): ReactElement;
/**
 * A field of the editor's snapshot, selection and history. The component
 * renders again only when `isEqual`, `Object.is` by default, finds the field
 * changed; pass `shallowEqual` from the core for a selector that builds an
 * object or array. Subscribes while the component is mounted, and not at all on
 * the server.
 */
export declare function useEditorSelector<T>(editor: Editor, select: (state: EditorState) => T, isEqual?: (a: T, b: T) => boolean): T;
/**
 * A field of a transport's snapshot, such as the playhead or whether it plays.
 * The same rules as `useEditorSelector`. A transport notifies on every frame
 * during playback, so select only as fine a field as the panel shows.
 */
export declare function useTransportSelector<S, T>(transport: SnapshotSource<S>, select: (state: S) => T, isEqual?: (a: T, b: T) => boolean): T;
/** The host's editor and transport, handed down to panels. */
export interface TimelineContextValue {
    readonly editor: Editor;
    readonly transport: TimelineTransport;
}
export interface TimelineProviderProps extends TimelineContextValue {
    readonly children?: ReactNode;
}
/** Hands the host's editor and transport to the panels below it. */
export declare function TimelineProvider({ editor, transport, children, }: TimelineProviderProps): ReactElement;
/** The editor and transport of the nearest `TimelineProvider`. Throws without one. */
export declare function useTimelineContext(): TimelineContextValue;
