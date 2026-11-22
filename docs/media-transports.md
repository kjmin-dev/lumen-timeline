# Media transports

The `@lumen-timeline/media` workspace executes core audio plans on Web Audio and exposes a project-tick interface to the timeline. Importing the package acquires no browser resources.

```js
const transport = createVideoTransport({
  video,
  context,
  output: context.destination,
  editor,
  catalog,
  resolveBuffer,
  onError,
});
const view = mountTimeline(container, { editor, transport });
```

The `catalog` is a [stream catalog](playback-read-api.md): `{ version, streams }`, where `streams[assetId][streamId]` gives the decoded sample rate, asset version and available samples behind each take.

The video driver observes presented frames and handles native seeking, buffering and clock reacquisition. A shared voice scheduler consumes its project-tick/context-time anchor. It owns its planning timer, editor subscription, gain and buffer source nodes, and abortable resolution requests. A clip edit preserves unrelated reservations and the active generation. A clock discontinuity invalidates the generation.

The public video factory accepts seeks in integer project ticks. Use `snapshot()`, `subscribe(listener)`, `play()`, `pause()`, `seek(tick)`, [`audition(request)`](#audition), `setCatalog(catalog)` and `dispose()`. A seek started on the element itself, from native controls or a loop, is reported the same way: its target appears as `requestedTick` at `seeking`, and the landing position at `seeked`. `diagnostics(clipId)` reports the generation, sample rate and an opaque reservation identity and end sample for that clip. The experiment's seconds-based API remains available to its original probes.

The host owns the editor, video element, AudioContext, output and asset cache. Disposing the factory detaches the driver and cancels its work; the host decides when to pause the element or close its context. [Scheduling behavior and probes](incremental-playback.md)

## Audio-only editing

Run `npm run example:vanilla` and follow **Audio workspace**. The route uses the same timeline mount, selection, clip inspector, edit commands and JSON save/reopen controls. It has its own storage key and loads no video. Its playhead clock display identifies the timing source in use.

```js
import { createAudioTransport } from "@lumen-timeline/media";

const transport = createAudioTransport({
  editor,
  context,
  output: context.destination,
  catalog,
  resolveBuffer,
});
const view = mountTimeline(element, { editor, transport });
```

The audio driver supports 1× playback. On play or an active seek, it anchors the project tick to an absolute output sample one nominal 128-frame quantum ahead of the rendering clock. The shared scheduler fills from the target tick, including sources already in progress. It also advances the transport through silence and stops at the exclusive sequence end. A fixed project duration sets the end. With an implicit duration, the ruler and transport both use the last clip end, including after undo and redo.

- **Presentation.** Snapshots include `playing`, `presentedTick`, `requestedTick`, `status` and `precision`. While running, the driver's `output` precision uses the audio output timestamp's context time. A missing or unusable timestamp falls back to rendering time with `estimated` precision. A stationary editing position reports `exact`. A view can unsubscribe or skip an animation frame without changing the audio schedule. [Web Audio output time](https://www.w3.org/TR/2021/REC-webaudio-20210617/#dom-audiocontext-getoutputtimestamp)
- **Play and pause.** Call `play()` on a user gesture. An empty sequence stays paused. Replay from the current end begins at zero. A pause freezes the presented position and cancels this driver's voices. A denied resume rejects its promise so the UI can offer another play action.
- **Seek.** Use safe integer project ticks within the extent. A paused seek returns `arrived` immediately. A playing seek exposes the requested tick and coalesces same-turn requests. The latest request returns `arrived` when the presentation clock reaches its anchor; earlier requests return `superseded`. Seeking directly to the end stops there. Pause or seek during a pending start supersedes that start. A stale completion cannot book a voice.
- **Interruption.** When the context stops running, freeze the playhead, invalidate reservations and retain the latest play intent. Recovery uses a fresh anchor. A user pause while interrupted keeps the transport paused after recovery. If editing shrinks the extent behind playback, clamp to the new end and stop.
- **Ownership.** Pass a host-owned context, editor, output node and asset resolver. Pause and disposal leave other users of the context running. Disposal cancels pending loads and rejects pending transport operations, clears callbacks and releases this driver's reservations. Samples already in the device output pipeline may still drain.

## Audition

`transport.audition({ clipId, takeId, mode })` previews one of a clip's candidates without editing the project. Both transports implement it. Applying the take stays a separate `selectTake` edit, which the host can dispatch during or after the audition.

```js
const result = await transport.audition({ clipId: "line", takeId: "take-b", mode: "isolated" });
if (result === "finished")
  editor.dispatch(commands.selectTake({ clipId: "line", takeId: "take-b" }));
```

- **What plays.** The transport pauses project playback, remembers the playhead and plays the clip's placement as it stands, from its start to its end. `mix` plays the candidate with the rest of the project. `isolated` plays the clip alone, even on a muted track or while another track is soloed, at its track's gain. A `takeId` of `null` plays the mix with the clip silent. Every voice stops at the clip's end, including one that continues past it.
- **Ending.** At the clip's end the promise resolves `finished`, and presentation returns to the remembered position, paused. `cancelAudition()` and `pause()` resolve `cancelled` and return there too. `play()` returns there and plays the project from it. `seek(tick)` cancels the audition for its own target. A newer audition cancels the current one and keeps its return position.
- **Edits.** An edit that removes the clip, moves either of its edges or stops listing the auditioned take cancels the audition. Other edits, such as applying the take, relabeling it or reordering the candidates, leave it playing. The scheduler replans through them as it does during playback.
- **State.** Snapshots carry `audition`: the clip, take, mode, the clip's placement as `range` and the `returnTick`, or `null`. The audio transport reports `starting` and then `playing` while it plays. Entering and leaving each start a [segment](#marker-crossings), so a crossing watcher sees the jump to the clip and the return as seeks. A host that should not react to markers heard during an audition can check `transport.snapshot().audition`.
- **Failures.** An unknown clip rejects with an `EditError` coded `missing-clip`, and a take the clip does not list with `missing-take`. A malformed request rejects with a `TypeError`. An invalid request leaves playback as it was. A denied resume rejects and returns to the position. On the audio transport, an interruption of the context cancels a playing audition. Disposal rejects a pending one.
- **Video.** The video transport pauses the element, seeks it to the clip's start and plays it. The first frame at or past the clip's end, or the element's `ended` event, finishes the audition, and the element seeks back before the promise settles.

`npm test` covers both modes, every way an audition ends, the edits that end it and those that do not, and the video seek sequence. `npm run verify:pcm` renders a mix and an isolated audition at 44.1 and 48 kHz in native offline graphs and compares all 4,096 frames with an oracle in sample indices, including the cut at the clip's end.

## Marker crossings

`watchMarkerCrossings(editor, transport, listener)` from `@lumen-timeline/core` reports the markers that playback crosses. A podcast host can use it for its chapter display, and a dubbing host can use it to highlight the line being heard.

```js
import { watchMarkerCrossings } from "@lumen-timeline/core";

const stop = watchMarkerCrossings(editor, transport, ({ markers, after, through, revision }) => {
  chapter.textContent = markers.at(-1).label ?? "";
});
```

- **Order.** As the presented tick advances, the listener receives the markers with `after < start <= through`, in snapshot order. It reads them from the editor's current revision, so a marker added ahead of the playhead is crossed when playback reaches it, and a removed one is not. A marker reached exactly is crossed once, including one at the sequence end where playback stops.
- **Segments.** Both transports' snapshots carry `segment` and `segmentStart`. Within one segment, `presentedTick` moves only by playback. Every other move starts a new segment: a paused or playing seek, replay from the end, a native seek on the video element and a sequence shortened behind the playhead. Crossings in a new segment count from `segmentStart`, so a seek skips both the markers it jumps over and the marker at its destination. An audio seek is often first observed a little after its target. Markers between the target and that first observation still count as crossed.
- **Other players.** Any adapter whose snapshots report `presentedTick`, `segment` and `segmentStart` satisfies `PresentationSource` and can drive the watcher.
- **Lifetime.** Call the returned function to stop. It returns whether the watch was still active. Stop the watch before disposing its transport. A listener error is reported through `reportError` and does not end the watch.

### Reproduce the audio-only checks

Run `npm test` for clock races, interruption/recovery, source offsets, shared context isolation, gaps, end/replay and extent changes. `npm run verify:pcm` exercises both drivers using native OfflineAudioContext graphs at 44.1 and 48 kHz. The audio-only fixture checks 2,304 samples across adjoining voice windows, silence, overlapping music and dialogue edited while scheduled. The combined fixture covers 6,144 samples.

Run `npm run verify:audio` for the Chromium audio-only route. With Playwright browsers installed, run `node examples/vanilla/verify-audio.mjs firefox` or `node examples/vanilla/verify-audio.mjs webkit` for the other engines. The trace checks ten seconds of playhead progress at a fixed viewport, zero additional static paints or history entries, 100 rapid seeks, pointer/keyboard edits, music continuity and a fresh editor loaded from JSON. It also plays across both markers, seeks past a stretch without one, and checks that the example's **Last marker** display follows. It exercises the normal output timestamp and forces the estimated-clock fallback in a second page.
