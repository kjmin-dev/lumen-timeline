# First interactive vanilla timeline

**User outcome.** Open a two-track example, play a guide video, select a dialogue clip, seek on the ruler, move or trim the dialogue and undo the edit while the music keeps playing. Deliver this in two independently reviewable PRs.

At `501e200`, the core can query a pinned revision and commit clip commands. The browser probe preserves unaffected audio reservations. The missing link is a mounted view that translates time into pixels and gestures back into those same commands. [Read API](../playback-read-api.md) · [Incremental playback](../incremental-playback.md) · [Headless editing](../headless-editing.md)

## PR C — Display, select and seek

Add the `@lumen-timeline/timeline` workspace and an `examples/vanilla` fixture with one reference video, a dialogue track and continuous music. The first visible screen needs a play/pause control, time display, ruler, track headers, clip bodies and a playhead. Clips are usable while media or waveform data is unavailable. The waveform provider, GPU backends and framework wrappers have their own roadmap milestones.

Proposed integration:

```js
const view = mountTimeline(container, { editor, transport });
view.setViewport({ startTick, pixelsPerSecond });
view.dispose();
```

| Contract                           | Implementation decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selection                          | Add a headless session selection keyed by clip ID, with read/select operations and a subscription that returns a disposer. The host inspector and multiple mounts can share it. Clicking a clip selects it without seeking. If undo removes a selected split child, prune its ID and keep other selections. Selection writes leave the project revision and both history stacks intact.                                                                                                 |
| Viewport and geometry              | Keep zoom, scroll, measured width and visible rows per mount. Use `editor.read(snapshot).clipsIn(range, { trackIds })` for placements. Both painting and hit testing use CSS pixels relative to the content area and `x = (tick - startTick) / ticksPerSecond × pixelsPerSecond`. Apply DPR when sizing and painting the backing canvas. Give clips on a mixing track stable subrows across horizontal pans. Query visible rows/ranges on pan and reuse unchanged track layout.         |
| Clock                              | Accept a host transport adapter with a state snapshot, a frame subscription and a seek operation in project ticks. In the example, bridge the existing driver to this contract, including its seconds-based seek. The view consumes the driver's observations and draws its overlay. A ruler seek shows the requested tick immediately and settles on the latest presented position. Superseded completions cannot move the cursor backwards. Buffering freezes the presented playhead. |
| Invalidation                       | Cache the ruler and clip layer separately from the playhead and selection overlay. A static viewport needs zero clip-layout rebuilds and zero static repaints during steady playback. Edits invalidate affected old/new track intervals. An ignored take-status update preserves geometry. Resize, zoom and DPR changes rebuild the appropriate geometry/backing surface.                                                                                                               |
| Browser lifetime and accessibility | Mount allocates DOM, listeners and resize/frame subscriptions on the client. Dispose cancels all mount-owned work and preserves the host's editor and player. Provide labeled transport controls, a keyboard-operable seek slider with readable time, and a DOM clip navigator sharing the same selection.                                                                                                                                                                              |

**PR C exit.** In Playwright, select a clip without moving the playhead, then seek without changing selection. At a viewport origin of 12 s and 100 CSS px/s, a click 220 CSS px into the content area requests 14.2 s at both DPR 1 and 2. Test clipped and adjacent placements, overlaps, scrolling and zoom anchored under the pointer. During ten seconds of fixed-viewport playback, assert that the playhead advances while the static paint count, document revision and history depths remain unchanged. Disposing one of two mounts must leave the other operational.

## PR D — Edit with a pointer or keyboard

1. **Use one validator.** Expose a side-effect-free preview path for Move and Trim by sharing the core's existing command staging and final layout checks. Return proposed placements or the same typed rejection as dispatch. A preview produces zero document writes, notifications, audio reservations or history entries.
2. **Define the gesture.** Pointer-down captures the selected IDs, original placements, active handle and revision. Pointer-move converts absolute pointer displacement into an integer tick delta, previews it, and paints a ghost on the overlay. Body drag moves a selection. The left and right handles trim the corresponding edge. Hit testing uses the true clip endpoints so clipping at the viewport boundary cannot create a false trim handle.
3. **Commit once.** Pointer-up submits one recorded command with an expected revision. A background metadata update alone can advance the revision during a drag. If the selected placements still match the captured values, revalidate the intent against the latest revision and destination track. If a selected placement changed or validation fails, cancel and surface the reason. Escape, pointer cancellation and disposal discard the preview. Zero-delta gestures preserve redo.
4. **Use the same commands from accessible controls.** Provide keyboard/numeric move and trim, split at playhead, and Undo/Redo. Scope shortcuts to the editor, respect text inputs and IME composition, and keep the selected row accessible. A split uses the editor's assigned right ID. Buttons subscribe to history changes. Hosts may configure snapping to a project grid, neighboring clip edge or playhead using a CSS-pixel tolerance and a temporary bypass.
5. **Run the example end to end.** Reopen a JSON snapshot and restore clip positions, content offsets and active take IDs. Session selection and undo history start fresh. Reuse the two-track driver to verify that editing the dialogue leaves the music node and its end reservation intact.

**PR D exit.** Start with dialogue at `[12,16)` s and content offset 1 s. Drag it two seconds later, then trim its left edge by one second. The final placement is `[15,18)` with content offset 2 s. At 16.2 s it reads source 3.2 s, or sample 153,600 at 48 kHz. Two undos restore the original placement and two redos recover the final one. Repeat via keyboard. Check zero music restarts, one history entry per completed gesture, no pending preview after cancellation, and rejection of locked-track or exclusive-overlap edits. Include a concurrent ignored metadata update and a conflicting placement edit during drag.

## Delivery order

- Merge C after Node geometry/session tests and Playwright mount, seek, DPR, paint and lifecycle checks pass.
- Build D on C. Run pointer and keyboard traces against the same expected document, assert the background voice identity in the fixture, and retain the 44.1/48 kHz PCM suite and short live-clock probe.
- The next milestone 2 follow-up is an audio-only example using the same mount with an audio-clock adapter. [Roadmap](../../ROADMAP.md#milestones)

The implementation and reproduction commands for both slices are in the [vanilla timeline guide](../vanilla-timeline.md).
