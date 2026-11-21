# Audio-only playback for the vanilla timeline

**User outcome.** Open a two-track audio project, seek into overlapping dialogue and music, move or trim the dialogue, and undo while the music continues. The existing Canvas timeline, inspector and history controls should work without a video element.

At `9bc5fed`, the timeline already consumes a small tick-based transport interface. The vanilla player translates that interface to a video-driven experiment. Voice scheduling, asynchronous buffer handling and seam correction currently live in the same class as video frame observation and native seeking. The next two PRs separate those responsibilities and exercise the second clock. [Timeline input contract](../vanilla-timeline.md) · [Current video bridge](../../examples/vanilla/player.mjs) · [Scheduling implementation](../../experiments/sync/transport.mjs)

## PR E — Share the voice scheduler and preserve video behavior

- Introduce the `@lumen-timeline/media` workspace. Move planning-window consumption, per-voice reconciliation, gain routing, output-sample reservations, seam handling and late-buffer cancellation into one internal scheduler. Reuse `editor.read(snapshot).planAudio(...)` and the existing catalog and resolver contracts.
- Keep clock authority in the driver. It supplies a generation and a project-tick/audio-context-time anchor. The scheduler books nodes on the context sample grid and returns the observations needed by the video driver's phase checks. Video frame callbacks, native seek coalescing, stall handling and video-specific drift recovery stay with the video driver.
- Expose a video transport factory that implements the view's existing `snapshot / subscribe / play / pause / seek(tick)` contract. Move the example off imports from `experiments/`. Preserve the existing probe entry points and their seconds-based seek behavior with a thin adapter where needed. Create resources on attachment and release only driver-owned nodes, subscriptions and timers on disposal.
- Keep this change reviewable as an extraction. Use the same synthetic assets, independent PCM expectations, short live test and injected-delay control already used for the video path.

**Merge gate.** The existing 54 Node tests, 3,840-sample PCM comparison and vanilla pointer/keyboard workflow must still pass. In the two-track trace, dialogue move, undo, redo and an ignored take update must cause zero music restarts or cancelled music end reservations. Run the short live video probe and the 100 ms negative control. Report their measurements alongside CI.

## PR F — Add the audio clock and runnable example

Proposed host code:

```js
const transport = createAudioTransport({ editor, context, output, catalog, resolveBuffer })
const view = mountTimeline(element, { editor, transport })
```

- **Clock and presentation.** Start playback from a sample-aligned pair of project tick and context time. At 1×, map context time `C` to `anchorTick + round((C - anchorContextTime) * ticksPerSecond)`. Schedule from the context's rendering clock. For the playhead, use the context time reported for the audio output and label the rendering-clock fallback as estimated. Animation-frame callbacks publish a current observation while playing; callback count and timer cadence never determine project position. [Web Audio output timestamps](https://www.w3.org/TR/2021/REC-webaudio-20210617/#dom-audiocontext-getoutputtimestamp)
- **Transport commands.** `play()` resumes a suspended context after a user gesture and books voices intersecting the playhead or lookahead. A later pause, seek or disposal must supersede an outstanding start. Pause freezes the presented tick and cancels this driver's voices. A paused seek settles immediately at the target without issuing audio. A playing seek invalidates old reservations, publishes the requested tick and resumes the current generation at the mapped source offsets. Late loads and superseded completions cannot restore an old position.
- **Extent and silence.** Use the explicit project duration when present, otherwise the latest clip end, with zero for an empty sequence. Share this extent rule between the transport and the existing ruler. Recompute after geometry commits, including undo and redo. Silence between clips advances normally. Stop once at the exclusive end; replay from the end starts at zero. If an edit shrinks the extent behind the playhead, stop at the new end. An empty sequence remains stopped at zero.
- **Interruption and ownership.** Freeze the presentation position if the context stops running. Re-anchor on recovery according to the latest play intent. Pausing or disposing one transport must leave a borrowed context and unrelated host audio usable. Output already delivered to a device has a drain interval; verify stale-source cancellation at the graph boundary.
- **Host integration.** Add an audio-only route or example alongside the video studio. Supply two redistributable voice/music sources through public package APIs, with no video DOM or frame callback. Reuse selection, seeking, editing controls and JSON save/reopen. Keep chapter-marker editing and the full podcast-specific inspector as separate follow-ups.

### Acceptance fixture

Use music at `[0,8)` s from source zero and dialogue at `[2,6)` s with a 1 s content offset. At project 3.25 s, dialogue reads source 2.25 s. After moving the dialogue one second later, the same playhead reads 1.25 s. Music continues at source 3.25 s throughout.

| Verification | Pass condition |
| --- | --- |
| Exact source mapping | At 44.1 kHz the dialogue samples before and after the move are 99,225 and 55,125. At 48 kHz they are 108,000 and 60,000. Undo and redo recover those values. The music source index and reservation stay independent of the edit. |
| Fake clock and lifecycle | Cover seek during pending play, pause before resume completes, 100 rapid seek requests, context interruption, gaps, end/replay, duration shrink and disposal with a buffer in flight. Old-generation callbacks produce zero new starts. |
| Actual mix | Compare native OfflineAudioContext output with an independent source-index oracle at both rates. Cover overlaps, exact shared edges and a segment of silence. Count missing, duplicate and unexpected nonzero samples. |
| Visible workflow | In Playwright, assert that no video element exists. Play for ten seconds on a longer fixture with a fixed viewport. The playhead advances with zero additional static paints, document revisions or history entries. Pause, seek, edit by pointer and keyboard, undo, save and reopen. |
| Regression and CI | Run the shared deterministic suite for both clock modes, the Chromium PCM job and both vanilla browser workflows. Repeat the audio-only visible trace locally in Firefox and WebKit. Record output-timestamp availability and any fallback in test results. |

PR F depends on PR E. After both merge, the next remaining milestone 2 interaction is creating and navigating saved timeline markers. [Milestone 2](../../ROADMAP.md#milestones)

The shared driver contracts, host example and verification commands are in the [media guide](../media-transports.md).
