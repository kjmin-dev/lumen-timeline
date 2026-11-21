# Lumen Timeline design

Lumen Timeline gives applications a common time axis for media playback, clip editing and time-based metadata. A developer can mount the timeline below an existing player or assemble a complete editing workspace. The first release targets one reference video with multiple audio tracks, and audio-only sequences. The [core implementation architecture](core-architecture.md) fixes module ownership, transaction and scheduling contracts for v1. The example API names and performance budgets remain proposals.

## Reference workflows

The dubbing studio layout draws on the Hudson AI Studio tour. Its script selection and playhead can occupy different positions. A translator should be able to keep typing in one line while playback crosses another.

```text
+-----------------------------------------------------------------------+
| Project / language pair                                  Save  Export |
+------------------------+----------------------------------------------+
| Video preview          | Lines                                        |
|                        | Speaker / time range / line actions          |
|                        | Source text         | Translation / direction |
+------------------------+----------------------------------+-----------+
| Edit tools       Transport       Time display       Zoom  | Clip takes|
+----------------+------------------------------------------+           |
| Track headers  | Ruler and playhead                       | Audition  |
| Reference stem | Continuous waveform                      | Apply     |
| Speaker track  | [Line A]              [Line B]           | Generate  |
+----------------+------------------------------------------+-----------+
```

- On desktop, allocate about one third of the upper area to the video. Make the timeline height adjustable. On a narrow screen, the host can move the script and takes into tabs while keeping the same editor instance.
- A single click selects and reveals a clip in the script, timeline and take panel. An explicit line-play action seeks to the line and stops at its end. Ordinary playback begins at the playhead. The currently playing line can be highlighted independently of keyboard focus.
- Auditioning a take pauses project playback, remembers the playhead and previews one candidate in the clip's slot. Finishing the audition restores the position. Applying the take commits one undoable edit.
- The application owns its project header, language switcher, generation service and export destination. The timeline supplies editable tracks, references, clip selection, time display, transport and commands. Host panels can also use those APIs individually.

The second reference application is a podcast editor. It uses the audio output clock, overlapping host and guest tracks, background music, chapter markers and a gain inspector. Both applications should be buildable from public exports. An existing-player review tool can use an even smaller subset consisting of the player adapter, regions and a status field.

## JavaScript packages and ownership

Core APIs are implemented as pure JavaScript ES modules. Optional type declarations support typed consumers. The headless core runs in Node with a fake clock. Browser resources are acquired by explicitly mounting a view or attaching media.

| Proposed package | Responsibility |
| --- | --- |
| `@lumen-timeline/core` | Project model, time conversions, track queries, commands, history, editor session, transport state and pure playback planning. |
| `@lumen-timeline/media` | HTML media adapters, playback plan execution, Web Audio scheduling and mixing, asset resolution and waveform workers. |
| `@lumen-timeline/timeline` | Shared DOM mount, timeline layout, hit testing, accessibility, interaction tools and rendering backends. |
| `@lumen-timeline/react`, `@lumen-timeline/svelte`, `@lumen-timeline/solid`, `@lumen-timeline/vue` | Framework lifecycle, editor handles, selection subscriptions and panel composition around the same mounted view. |
| Dubbing and podcast examples | App-specific layouts, fields, actions, fixtures and persistence adapters. |

| State | Owner and lifetime |
| --- | --- |
| Project document | Tracks, placements, asset references, active takes, mix settings, saved markers and extension data. A committed edit increments the document revision. |
| Editor session | Selected clip IDs, focused tool, viewport, snapping, panel sizes and drag previews. A host may save per-user preferences separately. |
| Transport | Playback intent, actual state, requested position, presented position, playback rate, loop range and clock generation. |
| Derived data | Visible geometry, active clips, waveform tiles, decoded samples and GPU buffers. Rebuild from the document, session and asset versions. |

### Framework wrapper contract

Every wrapper mounts the same imperative view into an element after client mount. It forwards changed options, exposes the editor to the host, and disposes its view and subscriptions on unmount. When the host supplies the editor, the host owns its lifetime. A timeline and minimap can therefore share one transport and undo history.

The view subscribes directly to the transport for frame updates and owns pointer previews and drawing. A framework inspector subscribes to specific fields such as selected clip ID and active take ID. A frame tick makes no project edit. Waveform buffers and the full clip collection stay in the engine. React can use a cached external-store snapshot, Svelte a component subscription with teardown, SolidJS a signal for each selected value and Vue a shallow reference. The roadmap tracks the target versions and the comparison against vanilla. [React external stores](https://react.dev/reference/react/useSyncExternalStore) · [Svelte lifecycle](https://svelte.dev/docs/svelte/lifecycle-hooks) · [SolidJS signals](https://docs.solidjs.com/tutorial/signals/) · [Vue external state](https://vuejs.org/guide/extras/reactivity-in-depth.html#integration-with-external-state-systems) · [Wrapper acceptance tests](../ROADMAP.md#wrapper-acceptance-tests)

## Time and project format

- Store project positions as integer ticks at 282,240,000 ticks per second. A 48 kHz sample spans 5,880 ticks, a 44.1 kHz sample spans 6,400 and a 30000/1001 fps frame spans 9,417,408. A seven-day limit fits within JavaScript's safe integer range and round-trips through JSON. Use exact rational intermediates where multiplication could exceed that range.
- Keep source coordinates in their native units. Audio carries sample indices and sample rate. Video carries presentation timestamps (PTS) and a time base. Round absolute boundaries once when converting to a source unit and use the same converted boundary on both sides of a split.
- Display milliseconds, frame counts or SMPTE timecode. Store the display frame rate as a fraction and distinguish drop-frame and non-drop-frame formatting for 29.97 and 59.94 fps. On a variable-frame-rate source, the ruler can follow the display rate while the adapter reports actual source PTS.
- Clips and regions use half-open intervals `[start, end)` with positive duration. A reference-video sequence ends at the video duration. An audio-only sequence can derive its extent from the last clip, marker or region. A point marker may sit at the end.
- The ruler is computed from the viewport, the playhead belongs to the transport, and user markers and regions belong to the document. Continuous forward playback emits crossed markers in `(previous, current]` order. A seek recomputes active regions at the destination.

| Record | Contents |
| --- | --- |
| Project and sequence | Schema version, ID, time base, display rate, track order, optional reference video, assets, take sets, markers and extension entities. One sequence per project in the first release. |
| Track | ID, kind, accepted clip kinds, overlap policy, lock, name, gain, mute and solo. |
| Clip | ID, track ID, kind, start, duration, content offset (`contentIn`), optional take set and active take, extension data. |
| Take set and take | Candidate IDs, asset and stream IDs, source position at content time zero and available source range. Multiple clips can share candidates. |
| Asset | Stable ID, content version, host locator, streams, duration and original time units. Resolve signed URLs, blobs and decoded buffers at runtime. |
| Marker and region | Stable ID, point or interval, label, color and optional extension data. |
| Extension | `extensions[namespace] = { version, data }` on the entity that owns the field. A text or review cue can exist without a take. |

For a unit-speed clip, first compute `contentTime = contentIn + (projectTime - start)`. Then convert content time into source units and add the active take's `sourceAtContentZero`. Only the intersection with the take's available samples plays. Short takes leave silence, long takes end at the clip boundary, and a negative source origin can delay the first audible sample. [OpenTimelineIO time ranges](https://opentimelineio.readthedocs.io/en/latest/tutorials/time-ranges.html)

## Editing commands

| Command | Result |
| --- | --- |
| Move | Change start and optionally track. Preserve content offset and duration. Validate destination kind, locks, overlap and sequence bounds for the whole selection before committing. |
| Trim left by Δ | Add Δ to start and content offset. Subtract Δ from duration. The end and the mapping of the retained audio stay fixed. |
| Trim right by Δ | Add Δ to duration. Respect the minimum edit unit. Plain media can extend to its available source handles. Dialogue slots may extend into silence within sequence bounds. |
| Split | Keep the left ID, allocate a right ID and add the left duration to the right content offset. Both sides initially reference the same take set and active take. Reject a cut at either endpoint. |
| Select take | Change the clip's active take and invalidate its waveform and audio plan. Resizing the slot to a take is a separate command. |
| Set properties or mix | Commit metadata, name, gain, mute or solo. When any track is soloed, only unmuted solo tracks are audible. |
| Add, remove or reorder | Use stable IDs. Removing a track and its clips is one transaction. Shared assets have an independent lifetime. |

**Worked edit.** A line occupies `[12, 16)` seconds with `contentIn = 1`. Take B has source origin −1.5 s and available audio `[0, 2)`. It is audible over `[12.5, 14.5)`. Splitting at 14 s gives the right clip a content offset of 3 s and half a second of audible B. Moving that clip to 20 s plays the same audio over `[20, 20.5)`.

- A mixing track sums overlaps and assigns visual subrows. An exclusive track rejects overlaps with a reason. Adjacent half-open intervals are valid. Ordinary move and trim keep neighboring clips in place.
- Snap candidates include markers, playhead, adjacent boundaries and the frame or sample grid. Use a CSS-pixel tolerance and resolve ties by candidate priority and stable ID. A slightly wider release distance prevents jitter. Provide a temporary bypass and exact numeric inputs.
- A drag captures the base revision and previews the same command a keyboard or inspector would issue. On release, revalidate and commit one transaction. Escape and pointer cancellation discard the preview.
- Each successful command returns a revision, changed IDs, patches, inverse patches and affected time ranges. Include generated IDs and plugin edits in history so redo restores the same objects. A rejected command reports its code, target and reason. Seeking and selecting affect the session or transport.

## Playback and synchronization

| Mode | Clock and behavior |
| --- | --- |
| Reference video with dubbing | The video element supplies the clock. Observe displayed frames and schedule dubbed audio against corresponding Web Audio output times. |
| Audio-only mix | Anchor project time to the audio output clock and schedule overlapping sources at absolute audio times. |
| External player | Consume position, monotonic observation time, rate, playback state and precision. Enable controls and mixing according to the adapter's capabilities and measured sync accuracy. |

For video, pair `mediaTime` with `expectedDisplayTime` from the frame callback. Use `AudioContext.getOutputTimestamp()` to map the display time to the audio clock. Interpolate the playhead between observations with `requestAnimationFrame`. Where the observations are unavailable, sample the media element's current time and report estimated precision. Route guide audio or separated stems explicitly so a source is heard once. Cross-origin media can have different playback, analysis and mixing capabilities. [Video frame callbacks](https://wicg.github.io/video-rvfc/) · [Web Audio output timestamps](https://www.w3.org/TR/2021/REC-webaudio-20210617/#dom-audiocontext-getoutputtimestamp) · [Media element audio and cross-origin resources](https://www.w3.org/TR/2021/REC-webaudio-20210617/#MediaElementAudioSourceNode-security)

Start by scheduling a 100 ms lookahead every 25 ms, then tune from measurements. Adjacent spans share an absolute output sample and use bounded phase correction at the far edge. The timer fills the schedule and the audio node controls sample onset. Include clips already in progress and start them at their mapped source offset. Route source through clip gain, track gain and master output. At a new playback rate, update both the time conversion and source consumption rate. Ordinary resampling changes pitch. [Transport and audio scheduling](core-architecture.md#transport-and-audio-scheduling)

| Event | Required behavior |
| --- | --- |
| Play or pause | Track intent separately from actual playback. Resume the audio context on user interaction and surface a rejected play request. |
| Scrub or seek | Move the requested playhead immediately. Keep one native seek in flight and only the newest waiting target. A native completion event has no request ID. Confirm arrival and presented time where available, handle cancellation or timeout, then resume the latest schedule. |
| Stall, background interruption or rate change | Stop stale nodes, invalidate pending work and re-anchor to the current clock on recovery. Apply small drift corrections to future scheduling. Account for samples already submitted to the output device. |
| Loop or range end | Stop or seek to the loop start at the half-open boundary. Reschedule spanning clips at their source offsets. |
| Edit during playback | Rebuild the affected interval, stop removed or replaced sources with a short gain ramp and keep unaffected audio running. |
| Missing media | Preserve clip identity and placement. Wait for a required reference, explain unavailable audition sources and relink assets by ID. |

A player adapter exposes `snapshot()`, `subscribe()` and `dispose()`, plus supported controls such as `play()`, `pause()` and `seek()`. A native player action updates transport state directly. A user command invokes the adapter once. Native seek completion provides the initial preview contract. Frame-addressable decoding would also require demuxing, a PTS/keyframe index and decoding up to the requested frame. [HTML media seeking](https://html.spec.whatwg.org/multipage/media.html#seeking) · [WebCodecs](https://www.w3.org/TR/webcodecs/)

## Timeline rendering and assets

The engine uses a shared CPU layout for rendering and hit testing. Like Lumen Charts, it can select a renderer for dense geometry and feed the view from a worker. Timeline layout uses continuous project time and overlapping intervals. [Lumen Charts rendering guide](https://github.com/kjmin-dev/lumen-charts/blob/c261b75e2c719a3d43b04cb8aa2e9050d1974bf5/docs/guide/heatmap-scatter.md#choosing-a-renderer)

- Query each visible track with `start < viewEnd && end > viewStart`. This includes a long clip that spans the entire viewport. Use cumulative row heights for vertical virtualization. All backends consume the same clip rectangles, handles, marker hit regions and stacking order.
- Map time using `x = (tick - viewStart) * pixelsPerTick`. Subtract the viewport origin before converting to GPU floats. Keep the time under the pointer fixed during zoom. Manual scrolling disengages playhead following until the user asks to return.
- Batch visible clip bodies and waveform strips. Start with WebGL2 and fall back to Canvas 2D. A WebGPU preference can switch at a frame boundary after initialization. On device loss or resource exhaustion, rebuild from the same scene using WebGL2 or Canvas 2D. Report requested backend, effective backend and fallback reason.
- Cache ruler and label layers. Update the playhead, time display and active highlights separately. In steady playback through a fixed viewport, static clip geometry needs zero reuploads. Track headers, forms, menus and the searchable clip navigator use DOM elements.
- Build per-channel min/max waveform pyramids keyed by asset ID, version, channel, bucket size and tile. Split, trim and move change the source window. Switching a take changes the bound asset. Local workers and remote precomputed tiles use the same provider interface. [BBC waveform data format](https://github.com/bbc/audiowaveform/blob/master/doc/DataFormat.md)
- One hour of stereo 48 kHz Float32 PCM takes about 1.29 GiB. Stream the reference video, cache nearby short takes and use indexed, independently decodable audio chunks for long stems. Budget PCM, waveform tiles and GPU buffers separately. Cancel stale work, check asset versions and release owned resources on disposal. When a worker is unavailable, process small batches on the main thread.
- Provide a labeled seek slider, keyboard clip navigation, numeric move and trim controls, and an explicit split action. Keep the focused script row mounted during list virtualization. Suppress global editing shortcuts during text entry and IME composition. [W3C slider pattern](https://www.w3.org/WAI/ARIA/apg/patterns/slider/)

## Proposed public API

A vanilla application supplies its media element, assets and project. The same editor handle can be passed to a framework wrapper.

```js
import { commands, createEditor, time } from '@lumen-timeline/core'
import { createBrowserMedia, fromVideoElement } from '@lumen-timeline/media'
import { mountTimeline } from '@lumen-timeline/timeline'

const media = createBrowserMedia({
  reference: fromVideoElement(videoElement),
  assets: projectAssets,
})
const editor = createEditor({ project, media })
const view = mountTimeline(timelineElement, { editor, renderer: 'webgpu' })

editor.session.select(['clip-12'])
await editor.transport.seek(time.seconds(12))
editor.dispatch(commands.splitClip({ clipId: 'clip-12', at: time.seconds(14) }))
editor.dispatch(commands.selectTake({ clipId: 'clip-12', takeId: 'take-b' }))
editor.history.undo()

view.dispose()
editor.dispose()
```

A host can subscribe to stable field snapshots with `editor.subscribe(selector, listener)`. The timeline renderer uses the separate read-only `transport.onFrame(listener)` channel. Disposing the editor detaches its listeners and nodes. The host retains ownership of the supplied video element.

## Domain extensions and persistence

Applications register versioned document fields, validation, migration and split behavior. An inspector receives read-only selections and a command dispatcher. Tools can register scoped shortcuts, preview commands, decorations and hit regions. Asset lookup, recording, translation, speech generation and file delivery run through host adapters.

For example, a dubbing team can make both halves of a split line require review. Registering the rule in the document plugin makes it apply equally to a keyboard split and a pointer split.

```js
const review = definePlugin({
  namespace: 'studio.review',
  version: 1,
  clipFields: {
    status: {
      type: 'enum',
      values: ['pending', 'approved'],
      default: 'pending',
      onSplit: () => ({ left: 'pending', right: 'pending' }),
    },
  },
})
const editor = createEditor({ project, media, plugins: [review] })
```

- The dubbing host opens a document per work and target language. Documents can share the reference video and original line IDs. Translations, candidate takes and active choices belong to the target-language document. Restore the playhead using the common video time.
- A script row and timeline block select the same clip ID. A split gives the right side a new line ID. Split text using word timings where available. For unaligned text, keep the original on the left, create an empty right draft and flag the line for review. Undo restores the script and audio placement together.
- A generation request captures clip ID, line ID, language, text revision, content offset, clip revision and settings. Add a valid result once per job ID. Keep results for superseded text or deleted targets in the host's job history. Adding a candidate and applying it are separate actions.
- When a newly recorded candidate belongs to one half of a split, copy the shared set's candidate references into a new set for that clip. Reuse the old assets. Align a recording starting at source sample zero with `sourceAtContentZero = -contentIn` in source units. In the worked edit, the right take starts at its first sample with a −3 s origin. Undo restores the previous set reference.
- Save immutable project snapshots with an expected revision. Coalesce subsequent edits while a save is in flight and surface conflicts to the host. Migrate a copy, validate it and replace the original atomically. Preserve unknown extension payloads. Disable operations requiring an absent extension's semantics and open newer unsupported core schemas read-only.
- Project JSON retains all takes and editing data. A render plan freezes one revision's active streams, source intervals, placements, gains, mute and solo decisions for browser mixing or a host exporter. Later interchange adapters should report fields or alternate takes a target format cannot represent.

## Release boundary

The first release covers synchronized reference-video and audio-only editing, accessible multitrack interaction, take-aware commands, plugin metadata, project persistence, GPU fallback and the four framework wrappers. Multi-video compositing, transitions, speed ramps, pitch-preserving time stretch, a frame-addressable decoder, finished-video encoding and collaborative editing remain possible extensions.

The planned repository will include redistributable synthetic fixtures, vanilla and framework consumers and reproducible browser benchmarks. Public packages will use semantic versioning, with an independently versioned project schema and migration fixtures. MIT is the proposed license for the first software distribution. Milestone exit criteria and numerical quality targets are in the [roadmap](../ROADMAP.md).
