import type { Attachment } from "svelte/attachments";
import type { TimelineOptions, TimelineView } from "@lumen-timeline/timeline";
export interface TimelineAttachmentOptions extends TimelineOptions {
    /** Receives the mounted view, and `null` once it is disposed. */
    readonly onview?: ((view: TimelineView | null) => void) | undefined;
}
/**
 * An attachment that mounts the timeline view in its element and disposes it
 * when the element goes. Pass a function that returns the options, as in
 * `{@attach timeline(() => ({ editor, transport, snap }))}`, so reading them
 * stays inside the attachment: a different `editor`, `transport` or
 * `renderer` mounts a new view, and every other option reaches the mounted view
 * through `view.update`, which ignores equal values. Attachments do not run on
 * the server.
 */
export declare function timeline(options: () => TimelineAttachmentOptions): Attachment<HTMLElement>;
