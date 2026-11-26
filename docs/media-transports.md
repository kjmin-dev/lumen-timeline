# Media transports

The `@lumen-timeline/media` workspace executes core audio plans on Web Audio and exposes a project-tick interface to the timeline. Importing the package acquires no browser resources.

`createVideoTransport` plays the project against a reference video. The video element supplies the clock, so a component makes the transport once the element exists and disposes it when the component goes. It also hands the editor and the transport to the panels inside it through the wrapper's context, as the sections below use. Each tab is a whole file; [`host.js`](../apps/docs/src/content/docs/getting-started.mdx#minimal-integration) holds the editor, the `AudioContext`, the catalog and the buffer resolver.

<!-- framework-tabs -->

**Vanilla**

```js title="player.js"
import { createVideoTransport } from "@lumen-timeline/media";
import { mountTimeline } from "@lumen-timeline/timeline";
import "@lumen-timeline/timeline/style.css";
import { catalog, context, editor, resolveBuffer } from "./host.js";

// The page holds <video src="/media/reference.webm" muted></video> and <div id="timeline"></div>.
export const transport = createVideoTransport({
  video: document.querySelector("video"),
  context,
  output: context.destination,
  editor,
  catalog,
  resolveBuffer,
  onError: (error) => console.warn(error),
});
export const view = mountTimeline(document.querySelector("#timeline"), { editor, transport });

// To tear down: view.dispose(), then transport.dispose().
```

**React**

```jsx title="VideoEditor.jsx"
import { useEffect, useRef, useState } from "react";
import { createVideoTransport } from "@lumen-timeline/media";
import { Timeline, TimelineProvider } from "@lumen-timeline/react";
import "@lumen-timeline/timeline/style.css";
import { catalog, context, editor, resolveBuffer } from "./host.js";

export function VideoEditor({ children }) {
  const video = useRef(null);
  const [transport, setTransport] = useState(null);
  useEffect(() => {
    const created = createVideoTransport({
      video: video.current,
      context,
      output: context.destination,
      editor,
      catalog,
      resolveBuffer,
      onError: (error) => console.warn(error),
    });
    setTransport(created);
    return () => created.dispose();
  }, []);
  return (
    <>
      <video ref={video} src="/media/reference.webm" muted />
      {transport && (
        <TimelineProvider editor={editor} transport={transport}>
          <Timeline editor={editor} transport={transport} />
          {children}
        </TimelineProvider>
      )}
    </>
  );
}
```

**Svelte**

```svelte title="VideoEditor.svelte"
<script>
  import { createVideoTransport } from "@lumen-timeline/media";
  import { setTimelineContext, timeline } from "@lumen-timeline/svelte";
  import "@lumen-timeline/timeline/style.css";
  import { catalog, context, editor, resolveBuffer } from "./host.js";

  const { children } = $props();
  let video = $state();
  let transport = $state.raw(null);
  // Panels inside read the editor and the transport from here.
  setTimelineContext({
    editor,
    get transport() {
      return transport;
    },
  });
  $effect(() => {
    const created = createVideoTransport({
      video,
      context,
      output: context.destination,
      editor,
      catalog,
      resolveBuffer,
      onError: (error) => console.warn(error),
    });
    transport = created;
    return () => created.dispose();
  });
</script>

<video bind:this={video} src="/media/reference.webm" muted></video>
{#if transport}
  <div {@attach timeline(() => ({ editor, transport }))}></div>
  {@render children?.()}
{/if}
```

**SolidJS**

```jsx title="VideoEditor.jsx"
import { createEffect, createSignal, Show } from "solid-js";
import { createVideoTransport } from "@lumen-timeline/media";
import { createTimeline, TimelineContext } from "@lumen-timeline/solid";
import "@lumen-timeline/timeline/style.css";
import { catalog, context, editor, resolveBuffer } from "./host.js";

export function VideoEditor(props) {
  const [video, setVideo] = createSignal();
  const [transport, setTransport] = createSignal();
  const [element, setElement] = createSignal();
  createEffect(video, (node) => {
    if (!node) return;
    const created = createVideoTransport({
      video: node,
      context,
      output: context.destination,
      editor,
      catalog,
      resolveBuffer,
      onError: (error) => console.warn(error),
    });
    setTransport(created);
    return () => created.dispose();
  });
  createTimeline(element, () => ({ editor, transport: transport() }));
  return (
    <>
      <video ref={setVideo} src="/media/reference.webm" muted />
      <Show when={transport()}>
        <TimelineContext value={{ editor, transport: transport() }}>
          <div ref={setElement} />
          {props.children}
        </TimelineContext>
      </Show>
    </>
  );
}
```

**Vue**

```vue title="VideoEditor.vue"
<script setup>
import { onMounted, onUnmounted, shallowRef, useTemplateRef } from "vue";
import { createVideoTransport } from "@lumen-timeline/media";
import { provideTimeline, Timeline } from "@lumen-timeline/vue";
import "@lumen-timeline/timeline/style.css";
import { catalog, context, editor, resolveBuffer } from "./host.js";

const video = useTemplateRef("video");
const transport = shallowRef(null);
// Panels in the slot read the editor and the transport from here.
provideTimeline(() => ({ editor, transport: transport.value }));
onMounted(() => {
  transport.value = createVideoTransport({
    video: video.value,
    context,
    output: context.destination,
    editor,
    catalog,
    resolveBuffer,
    onError: (error) => console.warn(error),
  });
});
onUnmounted(() => transport.value?.dispose());
</script>

<template>
  <video ref="video" src="/media/reference.webm" muted />
  <template v-if="transport">
    <Timeline :editor="editor" :transport="transport" />
    <slot />
  </template>
</template>
```

<!-- /framework-tabs -->

The element is muted because the transport plays the project's audio through Web Audio; the video supplies the picture and the clock.

The `catalog` is a [stream catalog](playback-read-api.md): `{ version, streams }`, where `streams[assetId][streamId]` gives the decoded sample rate, asset version and available samples behind each take. `resolveBuffer` supplies each voice's whole decoded stream. For media of hours, pass a chunk cache as `media` instead: it reads chunks through the host's reader within a byte budget and loads ahead of the playhead. [Long media](long-media.md)

The video driver observes presented frames through `requestVideoFrameCallback` and falls back to `requestAnimationFrame` with `video.currentTime` on environments without it (and to `context.currentTime` when `getOutputTimestamp` is absent), handling native seeking, buffering and clock reacquisition. A shared voice scheduler consumes its project-tick/context-time anchor. It owns its planning timer, editor subscription, gain and buffer source nodes, and abortable resolution requests. A clip edit preserves unrelated reservations and the active generation, and live track mix edits (`mute`, `solo`, `gain`) reconcile active voices immediately. A clock discontinuity invalidates the generation.

The public video factory accepts seeks in integer project ticks. Use `snapshot()`, `subscribe(listener)`, [`play(options)`](#play-to-a-stop), `pause()`, `seek(tick)`, `setPlaybackRate(rate)`, `setLoop(range)`, [`audition(request)`](#audition), `setCatalog(catalog)` and `dispose()`. Both transports accept optional `trackOutput(trackId)` to route each track's voice into a custom Web Audio node (falling back to `output`) and `fadeOutSeconds` to linearly ramp cancelled voices instead of hard-stopping them. A seek started on the element itself, from native controls or a loop, is reported the same way: its target appears as `requestedTick` at `seeking`, and the landing position at `seeked`. A playing element presents frames again from `seeked`, as WebKit, seeking within buffered media, sends no `playing` event after it. Frames that move on also count as playing whatever the element's `readyState` says, as WebKit on GStreamer reports `HAVE_CURRENT_DATA` while it plays on after a seek; a stall that repeats its frame holds presentation until they move on again. `diagnostics(clipId)` reports the generation, sample rate, an opaque reservation identity, the end sample and the booked node count for that clip, and `playback()` reports seams, clock corrections, late starts, underruns, phase resets and the latest phase error across all voices. Given `frameRate`, the video transport seeks to the middle of the target's frame and presents the target tick itself. The experiment's seconds-based API remains available to its original probes.

The host owns the editor, video element, AudioContext, output and asset cache. Disposing the factory detaches the driver and cancels its work; the host decides when to pause the element or close its context. [Scheduling behavior and probes](incremental-playback.md)

## Audio-only editing

Run `npm run example:vanilla` and follow **Audio workspace**. The route uses the same timeline mount, selection, clip inspector, edit commands and JSON save/reopen controls. It has its own storage key and loads no video. Its playhead clock display identifies the timing source in use.

The audio transport needs no element, so [`host.js`](../apps/docs/src/content/docs/getting-started.mdx#minimal-integration) makes one for the whole page, and every tab on this site that imports `transport` uses it. A component that owns one instead makes and disposes it the way `VideoEditor` does above.

```js title="host.js"
// Plays the editor's document through Web Audio. It lives as long as the page.
export const transport = createAudioTransport({ editor, context, catalog, resolveBuffer });
```

`output` defaults to `context.destination`.

The audio driver supports arbitrary positive playback rates via `setPlaybackRate(rate)` (defaulting to `1`) and optional half-open loop ranges via `setLoop({ start, end } | null)`. On play or an active seek, it anchors the project tick to an absolute output sample one nominal 128-frame quantum ahead of the rendering clock. The shared scheduler fills from the target tick, including sources already in progress. It also advances the transport through silence, loops back to `loop.start` when playback reaches `loop.end`, and stops at the exclusive sequence end. A fixed project duration sets the end. With an implicit duration, the ruler and transport both use the last clip end, including after undo and redo.

- **Presentation.** Snapshots include `playing`, `presentedTick`, `requestedTick`, `status`, `precision`, `playbackRate` and `loop`. While running, the driver's `output` precision uses the audio output timestamp's context time. A missing or unusable timestamp falls back to rendering time with `estimated` precision. A stationary editing position reports `exact`. A view can unsubscribe or skip an animation frame without changing the audio schedule. [Web Audio output time](https://www.w3.org/TR/2021/REC-webaudio-20210617/#dom-audiocontext-getoutputtimestamp)
- **Play and pause.** Call `play()` on a user gesture. An empty sequence stays paused. Replay from the current end begins at zero. A pause freezes the presented position and cancels this driver's voices. A denied resume rejects its promise so the UI can offer another play action.
- **Seek.** Use safe integer project ticks within the extent. A paused seek returns `arrived` immediately. A playing seek exposes the requested tick and coalesces same-turn requests. The latest request returns `arrived` when the presentation clock reaches its anchor; earlier requests return `superseded`. Seeking directly to the end stops there. Pause or seek during a pending start supersedes that start. A stale completion cannot book a voice.
- **Interruption.** When the context stops running, freeze the playhead, invalidate reservations and retain the latest play intent. Recovery uses a fresh anchor. A user pause while interrupted keeps the transport paused after recovery. If editing shrinks the extent behind playback, clamp to the new end and stop.
- **Ownership.** Pass a host-owned context, editor, output node and asset resolver. Pause and disposal leave other users of the context running. Disposal cancels pending loads and rejects pending transport operations, clears callbacks and releases this driver's reservations. Samples already in the device output pipeline may still drain.

## Clip speed

A clip with a [rate](headless-editing.md#clip-speed) other than 1 plays `rate` seconds of source per second of timeline. Both transports play it one of two ways:

- **Varispeed**, without a stretch engine. The voice plays its source from the clip's position at `rate` times the transport's speed, so a faster clip also sounds higher, as tape does. It needs nothing beyond the buffer `resolveBuffer` returns.
- **Time-stretched**, with a `stretch` engine. The transport hands the engine the clip's audible source range and the number of frames it lasts on the timeline, and plays the rendering it returns at the timeline's pace. Speed changes and pitch stays.

`@lumen-timeline/media/signalsmith` provides an engine on [Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/), an MIT-licensed C++ stretcher compiled to WebAssembly. Install it beside the media package:

```sh
npm install signalsmith-stretch
```

```js title="host.js"
import { createAudioTransport } from "@lumen-timeline/media";
import { createSignalsmithStretch } from "@lumen-timeline/media/signalsmith";

// One engine per page: it caches renderings for every transport that uses it.
export const stretcher = createSignalsmithStretch();
export const transport = createAudioTransport({
  editor,
  context,
  catalog,
  resolveBuffer,
  stretch: stretcher.stretch,
});
```

- **Rendering.** Each request renders in its own `OfflineAudioContext`, on the audio rendering thread rather than the main thread. It reads 0.1 s of source before the range, so the stretcher's analysis window is full at the clip's first frame, and a quarter second on each side as context. Three seconds of 48 kHz mono source render in 25 to 105 ms in Chromium, Firefox and WebKit. `resolveBuffer` must return a decoded `AudioBuffer` for the engine to read its channels.
- **Cache.** A rendering is kept per source buffer, source range and length, within `cacheBytes` (64 MiB by default), and the least recently used goes first. A seek, a replay or another transport reuses it. `concurrency` (2 by default) limits renderings in flight; one that every requesting voice has given up on before it starts never runs. `cachedBytes()` and `clear()` report and release the cache, and `preset: "cheaper"` trades quality for speed.
- **Loading.** The engine imports `signalsmith-stretch` on its first rendering. Pass `load` to supply the module another way. The library creates its AudioWorklet from a `blob:` URL, so a Content Security Policy must allow `blob:` in `script-src` or `worker-src`.
- **Timing.** A voice waits for its rendering as it waits for a buffer that decodes later, so a clip retimed during playback is silent for the tens of milliseconds its rendering takes. Edits that leave the clip's audible range, rate and take alone keep its voice.
- **Failures.** A rendering that fails, or returns fewer frames than asked, is reported to `onError` with the clip's span, and the clip plays as varispeed.
- **Alignment.** `npm run verify:stretch` stretches a 440 Hz tone and five-millisecond bursts at rates 0.5, 0.8, 1.25 and 2 in all three engines, which give the same samples. The tone stays within 0.2% of its pitch, every burst's energy lands within 2.5 ms of the position the rate maps it to, about 1 ms late on average, and every rendering has exactly the length asked for. Through the audio transport, a 440 Hz line at rate 1.25 plays 550 Hz as varispeed and 440 Hz stretched.

A host with another stretcher, or one on a server, passes its own `stretch(request, signal)`. The request carries the `span`, the decoded source `buffer`, `sourceStart` and `sourceEnd` in source samples, and `length` in frames at the span's sample rate; frame 0 plays at `span.audible.start`. Return an `AudioBuffer` of at least `length` frames at that sample rate, or a promise of one. The signal aborts when the voice is no longer needed.

## Play to a stop

`play({ until })` plays from the playhead and pauses at `until`, for a host action such as playing one line. Both transports implement it.

A panel inside `VideoEditor` can play one line. Each tab is a whole file:

<!-- framework-tabs -->

**Vanilla**

```js title="play-line.js"
import { editor } from "./host.js";
import { transport } from "./player.js";

// The page holds <button id="play-line">Play line</button>.
document.querySelector("#play-line").addEventListener("click", async () => {
  const clip = editor.getSnapshot().clips.find((c) => c.id === "line-1");
  await transport.seek(clip.start);
  await transport.play({ until: clip.start + clip.duration });
});
```

**React**

```jsx title="PlayLine.jsx"
import { useTimelineContext } from "@lumen-timeline/react";

export function PlayLine({ clipId }) {
  const { editor, transport } = useTimelineContext();
  const play = async () => {
    const clip = editor.getSnapshot().clips.find((c) => c.id === clipId);
    await transport.seek(clip.start);
    await transport.play({ until: clip.start + clip.duration });
  };
  return <button onClick={play}>Play line</button>;
}
```

**Svelte**

```svelte title="PlayLine.svelte"
<script>
  import { getTimelineContext } from "@lumen-timeline/svelte";

  const { clipId } = $props();
  const { editor, transport } = getTimelineContext();
  async function play() {
    const clip = editor.getSnapshot().clips.find((c) => c.id === clipId);
    await transport.seek(clip.start);
    await transport.play({ until: clip.start + clip.duration });
  }
</script>

<button onclick={play}>Play line</button>
```

**SolidJS**

```jsx title="PlayLine.jsx"
import { useTimelineContext } from "@lumen-timeline/solid";

export function PlayLine(props) {
  const { editor, transport } = useTimelineContext();
  const play = async () => {
    const clip = editor.getSnapshot().clips.find((c) => c.id === props.clipId);
    await transport.seek(clip.start);
    await transport.play({ until: clip.start + clip.duration });
  };
  return <button onClick={play}>Play line</button>;
}
```

**Vue**

```vue title="PlayLine.vue"
<script setup>
import { useTimelineContext } from "@lumen-timeline/vue";

const { clipId } = defineProps(["clipId"]);
const timeline = useTimelineContext();
async function play() {
  const { editor, transport } = timeline.value;
  const clip = editor.getSnapshot().clips.find((c) => c.id === clipId);
  await transport.seek(clip.start);
  await transport.play({ until: clip.start + clip.duration });
}
</script>

<template>
  <button @click="play">Play line</button>
</template>
```

<!-- /framework-tabs -->

- **Exact end.** Every voice is booked to stop at the output sample of `until`, so nothing after it sounds. The audio transport then presents `until` in the segment it played through. The video element pauses at the first frame at or past the stop and seeks back to it, so a stop between two frames is still presented exactly.
- **While playing.** Calling `play({ until })` again moves the stop, and `play()` clears it. An earlier stop cuts the voices already booked. A later one books them again from the presented position, as a seek there would.
- **What clears it.** Reaching it, `pause()`, `seek(tick)` and `audition(request)` each clear the stop. Snapshots report it as `until`, which is `null` when playback runs to the end. A stop at or past the sequence end ends playback there as usual.
- **Validation.** `until` must be a safe integer after the position playback starts or continues from: the playhead, a pending seek's target, an audition's return position, or zero when replay restarts from the end. Otherwise `play` rejects with a `RangeError` and changes nothing.

## Audition

`transport.audition({ clipId, takeId, mode })` previews one of a clip's candidates without editing the project. Both transports implement it. Applying the take stays a separate `selectTake` edit, which the host can dispatch during or after the audition.

A panel inside `VideoEditor` can audition a candidate alone and apply it if it was heard to the end. Each tab is a whole file:

<!-- framework-tabs -->

**Vanilla**

```js title="audition.js"
import { commands } from "@lumen-timeline/core";
import { editor } from "./host.js";
import { transport } from "./player.js";

// The page holds <button id="audition">Audition Take 2</button>.
document.querySelector("#audition").addEventListener("click", async () => {
  const request = { clipId: "line-1", takeId: "take-b" };
  const result = await transport.audition({ ...request, mode: "isolated" });
  if (result === "finished") editor.dispatch(commands.selectTake(request));
});
```

**React**

```jsx title="Audition.jsx"
import { commands } from "@lumen-timeline/core";
import { useTimelineContext } from "@lumen-timeline/react";

export function Audition({ clipId, takeId }) {
  const { editor, transport } = useTimelineContext();
  const audition = async () => {
    const result = await transport.audition({ clipId, takeId, mode: "isolated" });
    if (result === "finished") editor.dispatch(commands.selectTake({ clipId, takeId }));
  };
  return <button onClick={audition}>Audition {takeId}</button>;
}
```

**Svelte**

```svelte title="Audition.svelte"
<script>
  import { commands } from "@lumen-timeline/core";
  import { getTimelineContext } from "@lumen-timeline/svelte";

  const { clipId, takeId } = $props();
  const { editor, transport } = getTimelineContext();
  async function audition() {
    const result = await transport.audition({ clipId, takeId, mode: "isolated" });
    if (result === "finished") editor.dispatch(commands.selectTake({ clipId, takeId }));
  }
</script>

<button onclick={audition}>Audition {takeId}</button>
```

**SolidJS**

```jsx title="Audition.jsx"
import { commands } from "@lumen-timeline/core";
import { useTimelineContext } from "@lumen-timeline/solid";

export function Audition(props) {
  const { editor, transport } = useTimelineContext();
  const audition = async () => {
    const request = { clipId: props.clipId, takeId: props.takeId };
    const result = await transport.audition({ ...request, mode: "isolated" });
    if (result === "finished") editor.dispatch(commands.selectTake(request));
  };
  return <button onClick={audition}>Audition {props.takeId}</button>;
}
```

**Vue**

```vue title="Audition.vue"
<script setup>
import { commands } from "@lumen-timeline/core";
import { useTimelineContext } from "@lumen-timeline/vue";

const { clipId, takeId } = defineProps(["clipId", "takeId"]);
const timeline = useTimelineContext();
async function audition() {
  const { editor, transport } = timeline.value;
  const result = await transport.audition({ clipId, takeId, mode: "isolated" });
  if (result === "finished") editor.dispatch(commands.selectTake({ clipId, takeId }));
}
</script>

<template>
  <button @click="audition">Audition {{ takeId }}</button>
</template>
```

<!-- /framework-tabs -->

- **What plays.** The transport pauses project playback, remembers the playhead and plays the clip's placement as it stands, from its start to its end. `mix` plays the candidate with the rest of the project. `isolated` plays the clip alone, even on a muted track or while another track is soloed, at its track's gain. A `takeId` of `null` plays the mix with the clip silent. Every voice stops at the clip's end, including one that continues past it.
- **Ending.** At the clip's end the promise resolves `finished`, and presentation returns to the remembered position, paused. `cancelAudition()` and `pause()` resolve `cancelled` and return there too. `play()` returns there and plays the project from it. `seek(tick)` cancels the audition for its own target. A newer audition cancels the current one and keeps its return position.
- **Edits.** An edit that removes the clip, moves either of its edges or stops listing the auditioned take cancels the audition. Other edits, such as applying the take, relabeling it or reordering the candidates, leave it playing. The scheduler replans through them as it does during playback.
- **State.** Snapshots carry `audition`: the clip, take, mode, the clip's placement as `range` and the `returnTick`, or `null`. The audio transport reports `starting` and then `playing` while it plays. Entering and leaving each start a [segment](#marker-crossings), so a crossing watcher sees the jump to the clip and the return as seeks. A host that should not react to markers heard during an audition can check `transport.snapshot().audition`.
- **Failures.** An unknown clip rejects with an `EditError` coded `missing-clip`, and a take the clip does not list with `missing-take`. A malformed request rejects with a `TypeError`. An invalid request leaves playback as it was. A denied resume rejects and returns to the position. On the audio transport, an interruption of the context cancels a playing audition. Disposal rejects a pending one.
- **Video.** The video transport pauses the element, seeks it to the clip's start and plays it. The first frame at or past the clip's end, or the element's `ended` event, finishes the audition, and the element seeks back before the promise settles.

`npm test` covers both modes, every way an audition ends, the edits that end it and those that do not, and the video seek sequence. `npm run verify:pcm` renders a mix and an isolated audition at 44.1 and 48 kHz in native offline graphs and compares all 4,096 frames with an oracle in sample indices, including the cut at the clip's end.

## Marker crossings

`watchMarkerCrossings(editor, transport, listener)` from `@lumen-timeline/core` reports the markers that playback crosses. A podcast host can use it for its chapter display, and a dubbing host can use it to highlight the line being heard.

A panel inside `VideoEditor` can show the last marker that playback crossed as a chapter title. It watches from mount until it goes, and stops before the transport is disposed. Each tab is a whole file:

<!-- framework-tabs -->

**Vanilla**

```js title="chapter.js"
import { watchMarkerCrossings } from "@lumen-timeline/core";
import { editor } from "./host.js";
import { transport } from "./player.js";

// The page holds <output id="chapter"></output>.
const chapter = document.querySelector("#chapter");
export const stop = watchMarkerCrossings(editor, transport, ({ markers }) => {
  chapter.textContent = markers.at(-1).label ?? "";
});
```

**React**

```jsx title="Chapter.jsx"
import { useEffect, useState } from "react";
import { watchMarkerCrossings } from "@lumen-timeline/core";
import { useTimelineContext } from "@lumen-timeline/react";

export function Chapter() {
  const { editor, transport } = useTimelineContext();
  const [chapter, setChapter] = useState("");
  useEffect(() => {
    const stop = watchMarkerCrossings(editor, transport, ({ markers }) =>
      setChapter(markers.at(-1).label ?? ""),
    );
    return () => void stop();
  }, [editor, transport]);
  return <output>{chapter}</output>;
}
```

**Svelte**

```svelte title="Chapter.svelte"
<script>
  import { watchMarkerCrossings } from "@lumen-timeline/core";
  import { getTimelineContext } from "@lumen-timeline/svelte";

  const { editor, transport } = getTimelineContext();
  let chapter = $state("");
  $effect(() => {
    const stop = watchMarkerCrossings(editor, transport, ({ markers }) => {
      chapter = markers.at(-1).label ?? "";
    });
    return () => void stop();
  });
</script>

<output>{chapter}</output>
```

**SolidJS**

```jsx title="Chapter.jsx"
import { createSignal, onCleanup } from "solid-js";
import { watchMarkerCrossings } from "@lumen-timeline/core";
import { useTimelineContext } from "@lumen-timeline/solid";

export function Chapter() {
  const { editor, transport } = useTimelineContext();
  const [chapter, setChapter] = createSignal("");
  const stop = watchMarkerCrossings(editor, transport, ({ markers }) =>
    setChapter(markers.at(-1).label ?? ""),
  );
  onCleanup(() => void stop());
  return <output>{chapter()}</output>;
}
```

**Vue**

```vue title="Chapter.vue"
<script setup>
import { onUnmounted, ref } from "vue";
import { watchMarkerCrossings } from "@lumen-timeline/core";
import { useTimelineContext } from "@lumen-timeline/vue";

const { editor, transport } = useTimelineContext().value;
const chapter = ref("");
const stop = watchMarkerCrossings(editor, transport, ({ markers }) => {
  chapter.value = markers.at(-1).label ?? "";
});
onUnmounted(() => void stop());
</script>

<template>
  <output>{{ chapter }}</output>
</template>
```

<!-- /framework-tabs -->

- **Order.** As the presented tick advances, the listener receives the markers with `after < start <= through`, in snapshot order. It reads them from the editor's current revision, so a marker added ahead of the playhead is crossed when playback reaches it, and a removed one is not. A marker reached exactly is crossed once, including one at the sequence end where playback stops.
- **Segments.** Both transports' snapshots carry `segment` and `segmentStart`. Within one segment, `presentedTick` moves only by playback. Every other move starts a new segment: a paused or playing seek, replay from the end, a native seek on the video element and a sequence shortened behind the playhead. Crossings in a new segment count from `segmentStart`, so a seek skips both the markers it jumps over and the marker at its destination. An audio seek is often first observed a little after its target. Markers between the target and that first observation still count as crossed.
- **Other players.** Any adapter whose snapshots report `presentedTick`, `segment` and `segmentStart` satisfies `PresentationSource` and can drive the watcher.
- **Lifetime.** Call the returned function to stop. It returns whether the watch was still active. Stop the watch before disposing its transport. A listener error is reported through `reportError` and does not end the watch.

### Reproduce the audio-only checks

Run `npm test` for clock races, interruption/recovery, source offsets, shared context isolation, gaps, end/replay and extent changes. `npm run verify:pcm` exercises both drivers using native OfflineAudioContext graphs at 44.1 and 48 kHz. The audio-only fixture checks 2,304 samples across adjoining voice windows, silence, overlapping music and dialogue edited while scheduled. The combined fixture covers 6,144 samples.

Run `npm run verify:audio` for the Chromium audio-only route. With Playwright browsers installed, run `node examples/vanilla/verify-audio.mjs firefox` or `node examples/vanilla/verify-audio.mjs webkit` for the other engines. The trace checks ten seconds of playhead progress at a fixed viewport, zero additional static paints or history entries, 100 rapid seeks, pointer/keyboard edits, music continuity and a fresh editor loaded from JSON. It also plays across both markers, seeks past a stretch without one, and checks that the example's **Last marker** display follows. It exercises the normal output timestamp and forces the estimated-clock fallback in a second page.
