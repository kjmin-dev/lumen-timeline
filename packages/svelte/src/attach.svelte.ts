import { untrack } from "svelte";
import type { Attachment } from "svelte/attachments";
import { mountTimeline } from "@lumen-timeline/timeline";
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
export function timeline(options: () => TimelineAttachmentOptions): Attachment<HTMLElement> {
  return (element) => {
    let view: TimelineView | null = null;
    // Derived values notify only when they change, so the mount effect runs
    // again for these three alone.
    const editor = $derived(options().editor);
    const transport = $derived(options().transport);
    const renderer = $derived(options().renderer ?? "auto");
    $effect(() => {
      const fixed = { editor, transport, renderer };
      const mounted = untrack(() => mountTimeline(element, { ...options(), ...fixed }));
      view = mounted;
      untrack(() => options().onview?.(mounted));
      return () => {
        view = null;
        mounted.dispose();
        untrack(() => options().onview?.(null));
      };
    });
    $effect(() => {
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
      } = options();
      untrack(() =>
        view?.update({
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
        }),
      );
    });
  };
}
