# Vanilla Canvas timeline

Run `npm ci` and `npm run example:vanilla`, then open the printed local address. The 24-second guide is an original animated contour study. The dialogue is an eSpeak NG synthesis of “The tide returns. Watch the contour lines drift across the inlet.” The checked-in Opus clip includes a one-second lead and padding to eight seconds. The music is synthesized locally. The example plays without a remote media service. The silent reference can be regenerated using `python3 examples/vanilla/media/generate.py` and FFmpeg with libvpx.

Load `@lumen-timeline/timeline/style.css` and call `mountTimeline(element, { editor, transport })`. The view accepts a `TimelineTransport`: an adapter exposing `snapshot()`, `subscribe(listener)` (returning a disposer), `play()`, `pause()` and `seek(projectTick)`. Media transports satisfy it, and so can any player adapter that reports project ticks. Snapshots carry `playing`, `presentedTick` and a nullable `requestedTick`. The host publishes requests immediately and settles only the latest request. The example bridges the existing Web Audio scheduler and its video frame callback.

`view.setViewport({startTick, pixelsPerSecond})` changes one mount. `view.update(options)` applies `snap`, `labels`, `waveforms`, `chrome`, `theme`, `layout`, `readOnly`, `shortcuts`, `formatTime`, `gridSpacing`, `clipStyle`, `renderTrackHeader`, `renderOverlay`, `events`, `edgeMode`, `pixelsPerSecond` and `startTick` without a new mount, as a framework wrapper does on every render. Equal config objects change nothing. A key left out keeps its value. `pixelsPerSecond`, `startTick` and `edgeMode` change the view only when they differ from the values last given, so a host that passes the same values again keeps the user's pan, zoom and edge mode. `editor`, `transport` and `renderer` are fixed for a mount. `view.reveal(clipId)` scrolls a clip's lane into view and pans to its start when that is offscreen, for a host list that selects clips. `view.scrollToTrack(trackId)` scrolls a track row into view, `view.renameTrack(trackId)` opens the inline rename field in its header, and `view.repaint(scope?)` triggers an `"all"` or `"overlay"` redraw when external state read by callbacks changes. Ctrl/Command-wheel zooms at the pointer. Shift-wheel or the scroll slider pans. Use the ruler or its arrow keys to seek. Click a clip, Shift-click to change a group or use the native clip navigator. `editor.session.select(ids)`, `getSelection()` and `subscribeSelection(listener)` share a selection across views. Selection is ephemeral. Undo prunes missing IDs.

The ruler and static clips are cached separately from selection and the moving playhead. Track subrows are assigned from complete track intervals and retained across horizontal pans. Each paint lays out the visible rows once, as rectangles, waveform columns and label crops in stacking order, and the drawing backend draws only that layout. Clip names and captions are rasterized once into a label atlas at the device pixel ratio. Painting and picking use CSS pixels; the backing canvas follows device pixel ratio. `view.hitTest({ x, y })` returns the clip, trim handle or body, track and tick under a point of the clip surface, read from the layout. `view.getDiagnostics()` returns paint and layout counts, the drawing backend, the clips in the current layout and the labels rasterized so far. `view.dispose()` releases that mount's observers, animation frame callbacks, subscriptions, DOM and GPU context. The host owns its editor and transport.

Run `npm test` and `npm run verify:timeline` for geometry, session and real-browser checks. `npm run verify:milestone` runs the milestone 2 acceptance session across both workspaces and a headless replay; pass `firefox` or `webkit` to `node examples/vanilla/verify-milestone.mjs` for the other engines. Install the test browser with `npx playwright install chromium`. CI also runs every trace that takes an engine argument in Firefox on Linux, with a silent PulseAudio output, and in WebKit on macOS, whose media stack is Safari's. `npm run verify:mounts` changes every option of a mounted view and checks that it keeps one view, then mounts and disposes the view twenty times and checks that nothing is left: no subscription to the editor, transport or waveform provider, no resize observer, no animation frame callback and no live WebGL2 context. The ten-second playback trace asserts zero extra layout or static paint operations at a fixed viewport.

## Markers

The ruler draws saved markers as flags with their labels, with a thin line across the clips. Region markers (those carrying a positive `duration`) also render as translucent spans across the ruler and clip surface. With the ruler or the clip surface focused:

- `]` seeks to the next marker and `[` to the previous one;
- `M` adds a marker at the playhead.

The marker navigator lists markers in time order and seeks to the chosen one. **Rename marker** and **Remove marker** act on the navigator's marker, and the history controls undo either.

Drags snap to markers. Ties prefer the playhead, then a marker, then a neighboring clip edge, then the grid. Pass `snap: { markers: false }` to opt out.

Both example projects start with two markers. Save project and Reopen saved keep them. The title row shows the last marker that playback crossed. Seeking past a marker, by any means, does not change it. [Marker crossings](media-transports.md#marker-crossings) `npm run verify:timeline` steps through markers from the keyboard, adds, renames, removes and undoes one, checks that a marker added during playback leaves the music reservation alone, and reopens the saved project. It then plays from 11 s, seeks the video element directly to 18.6 s and checks that only the marker at 19 s is crossed.

## Candidates

Each clip that lists [candidate takes](headless-editing.md#takes) shows a caption after its name: the active take's label, or its ID, and the count, as in `Guide · 3 takes`. A clip with none active reads `No take · 3 takes`. Pass `labels: { take, takes, none }` to use the host's words, such as `{ take: "version" }` for `Guide · 3 versions` and `No version`. `takes` defaults to `take` followed by "s" and `none` to "No " followed by `take`, so a language without that plural passes all three. A clip with a [rate](headless-editing.md#clip-speed) adds its speed as a percentage, as in `Guide · 3 takes · 125%`, or `125%` alone without candidates.

Selecting a take or changing a clip's list repaints the clip as any clip edit does. Relabeling a take repaints only the tracks where it is the active take of some clip. A label or data change that no caption shows repaints nothing.

The example's **Takes** panel lists the selected clip's candidates in order. Each row can **Audition** the take through the [transport](media-transports.md#audition), in the mix or **Isolated**, and the same button stops it. **Apply** selects it, the arrows reorder the list and **Remove** takes it off the list. The active take cannot be removed. Each of these is one undoable edit, and Save project and Reopen saved keep the list. The first line has three candidates: the recording, the same recording a quarter second later and a synthesized guide. The audio workspace calls them versions. The panel keeps a constant height, so selecting a clip never moves the timeline under the pointer.

`npm run verify:takes` checks the caption and repaint rules, an isolated and a cancelled audition with the video returning to its position, apply, reorder, remove, undo and reopen in the video workspace, and a mix audition and the renamed words in the audio workspace. Pass `firefox` or `webkit` to `node examples/vanilla/verify-takes.mjs` for the other engines.

## Waveforms

Pass `waveforms` to `mountTimeline`, or to a [framework wrapper](frameworks.md), to draw a waveform in each clip whose active take or direct `clip.source` has peaks. The view asks the provider for the visible part of the source, one bucket per CSS pixel column, whenever it paints that clip.

A provider is a plain object with no lifecycle, so it lives in a module of its own. This one reads the audio that `decode` in [`host.js`](../apps/docs/src/content/docs/getting-started.mdx#minimal-integration) fetched, on the main thread, which suits short clips. For long sources, [waveform tiles](waveforms.md) build the peaks in a worker.

```js title="peaks.js"
import { TICKS_PER_SECOND } from "@lumen-timeline/core";
import { decode } from "./host.js";

const buffers = new Map(); // assetId → AudioBuffer, once decoded
const listeners = new Set();

export const waveforms = {
  // Source time is content time plus the take's sourceAtContentZero, in ticks.
  peaks({ assetId, start, end, buckets }) {
    const buffer = buffers.get(assetId);
    if (!buffer) {
      if (!buffers.has(assetId)) {
        buffers.set(assetId, null);
        decode(assetId).then((decoded) => {
          buffers.set(assetId, decoded);
          for (const listener of listeners) listener(assetId);
        });
      }
      return null; // Nothing to draw yet.
    }
    const samples = buffer.getChannelData(0);
    const at = (tick) => Math.floor((tick / TICKS_PER_SECOND) * buffer.sampleRate);
    const from = at(start);
    const width = (at(end) - from) / buckets;
    const pairs = new Float32Array(buckets * 2).fill(NaN); // NaN columns are not drawn.
    for (let column = 0; column < buckets; column++) {
      const first = Math.max(0, Math.floor(from + column * width));
      const last = Math.min(samples.length, Math.floor(from + (column + 1) * width));
      let min = Infinity;
      let max = -Infinity;
      for (let i = first; i < last; i++) {
        min = Math.min(min, samples[i]);
        max = Math.max(max, samples[i]);
      }
      if (min <= max) pairs.set([min, max], column * 2);
    }
    return pairs;
  },
  // The view listens while it is mounted, and repaints the clips that play the asset.
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
```

Each tab is a whole file that mounts the view with the provider:

<!-- framework-tabs -->

**Vanilla**

```js title="main.js"
import { mountTimeline } from "@lumen-timeline/timeline";
import "@lumen-timeline/timeline/style.css";
import { editor, transport } from "./host.js";
import { waveforms } from "./peaks.js";

// The page holds <div id="timeline"></div>.
const view = mountTimeline(document.querySelector("#timeline"), { editor, transport, waveforms });
```

**React**

```jsx title="App.jsx"
import { Timeline } from "@lumen-timeline/react";
import "@lumen-timeline/timeline/style.css";
import { editor, transport } from "./host.js";
import { waveforms } from "./peaks.js";

export function App() {
  return <Timeline editor={editor} transport={transport} waveforms={waveforms} />;
}
```

**Svelte**

```svelte title="App.svelte"
<script>
  import { timeline } from "@lumen-timeline/svelte";
  import "@lumen-timeline/timeline/style.css";
  import { editor, transport } from "./host.js";
  import { waveforms } from "./peaks.js";
</script>

<div {@attach timeline(() => ({ editor, transport, waveforms }))}></div>
```

**SolidJS**

```jsx title="App.jsx"
import { createSignal } from "solid-js";
import { createTimeline } from "@lumen-timeline/solid";
import "@lumen-timeline/timeline/style.css";
import { editor, transport } from "./host.js";
import { waveforms } from "./peaks.js";

export function App() {
  const [element, setElement] = createSignal();
  createTimeline(element, () => ({ editor, transport, waveforms }));
  return <div ref={setElement} />;
}
```

**Vue**

```vue title="App.vue"
<script setup>
import { Timeline } from "@lumen-timeline/vue";
import "@lumen-timeline/timeline/style.css";
import { editor, transport } from "./host.js";
import { waveforms } from "./peaks.js";
</script>

<template>
  <Timeline :editor="editor" :transport="transport" :waveforms="waveforms" />
</template>
```

<!-- /framework-tabs -->

Keep the provider outside a component's render, as `peaks.js` does. A wrapper passes its options to the mounted view on every render, and the view compares providers by identity: a new one is subscribed to again and repaints every clip.

- **Peaks.** `peaks` returns `buckets` minimum and maximum pairs between -1 and 1, or `null` to draw nothing for that source yet. A column whose pair is not finite is not drawn. A move keeps the requested range, and a trim or a take's new `sourceAtContentZero` changes it.
- **Level and scale.** The view multiplies each peak by the clip's [gain](headless-editing.md#clip-gain), so a clip turned down draws smaller, and clips peaks past ±1 at full height. An optional `scale(peak)` on the provider then maps the gained peak to the height drawn. `decibelScale(floor)` draws peaks by their level in decibels, from `floor` (−42 by default) to 0 dB, so speech and other quiet material keep their shape; pass `{ peaks, subscribe, scale: decibelScale() }`. The scale changes the picture only, never the sound.
- **Late peaks.** When peaks arrive or change, call the `subscribe` listener with the asset ID. The view repaints only the visible tracks whose drawn clips play that asset. The first notification repaints at once; any more before the next frame repaint together in it. A take that starts playing other media repaints the tracks of the clips that list it. Disposing the view unsubscribes.
- **Scope.** Each paint asks for what is visible. [Waveform tiles](waveforms.md) from the media package answer from tiles built in a worker, and a host can pass any provider of its own.

The video workspace's **Original dialogue** track holds a reference stem under the whole picture: a locked clip that plays the original-language dialogue quietly at a track gain of 0.35. Its waveform shows where each original line falls, for timing the dub against it. The example draws it with `createWaveformTiles` over the decoded stem, so its peaks are built in the media package's worker.

`npm run verify:waveforms` waits for the stem's tiles, then checks that its drawn peaks fall in its phrases and not between them at two zoom levels, and that the stem is locked. In a mount of its own, it checks that pending peaks draw nothing, that a notification repaints once and only the track that plays the asset, the source range after a move, a left trim and a take offset change, and the unsubscription on dispose. Pass `firefox` or `webkit` to `node examples/vanilla/verify-waveforms.mjs` for the other engines.

## Rendering

Pass `renderer` to `mountTimeline` to choose how clips are drawn. Every backend draws the same CPU layout, so geometry, stacking, hit tests and edits are the same on each.

| `renderer`       | Draws through                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `auto` (default) | WebGL2 on a hardware GPU. Canvas 2D where WebGL2 is missing or would run on a software rasterizer such as SwiftShader. |
| `webgl2`         | WebGL2 wherever it exists, a software rasterizer included, else Canvas 2D.                                             |
| `webgpu`         | WebGPU once its device is ready. WebGL2 or Canvas 2D until then, and while a lost device is replaced.                  |
| `canvas2d`       | Canvas 2D only. The view creates no GPU context.                                                                       |

- **GPU frames.** A GPU backend draws every visible quad in one instanced draw. It draws a task's first paint at once, so the clips reach the screen in the same frame as the ruler, the overlay and the playhead that the paint drew, also when a host moves the viewport from an animation frame callback. Further paints of that task draw once more when it ends, the latest layout only. The geometry is uploaded only when the layout changed, and the label atlas only in the rows that changed. With a fixed viewport and project, playback moves the DOM playhead and uploads nothing. Canvas 2D draws at once and repaints only the rows that changed.
- **Device loss.** When a WebGL2 context or a WebGPU device is lost, the view puts a fresh canvas in place and draws on the next backend from its CPU layout at once. When the context is restored, or a new WebGPU device is granted, it switches back. Viewport, selection, a drag in progress and every edit stay as they were, since none of them live on the GPU. A lost WebGPU device is replaced up to three times.
- **Diagnostics.** `getDiagnostics()` reports the `renderer` asked for, the `backend` drawing now, and a `fallback` reason when the two differ, such as `WebGL2 would run on a software rasterizer` or `The WebGPU device was lost`. It also counts `staticUploads`, the geometry uploads since mount, and `deviceLosses`.

The example takes `?renderer=webgpu`, `webgl2` or `canvas2d` in its address.

`npm run verify:renderers` mounts the same fixture on Canvas 2D, WebGL2 and WebGPU at DPR 2: six tracks, 36 clips, captions and waveforms. Hit tests over a grid of 1,357 points agree on all three. Fill and background colors match, and less than 2% of the clip canvas differs from Canvas 2D, at about 0.2% in practice, at clip and waveform edges. The same holds after a pan that brings new labels, which the GPU backends upload into the atlas rows that changed. A paint made in an animation frame callback reaches each GPU canvas inside that callback, and eight more in the same task draw once, when it ends. Steady playback uploads no geometry and repaints nothing. One pointer and keyboard edit trace (select, move, trim, split at the playhead, undo, redo) ends on the same project and selection everywhere. On each GPU backend the trace loses the device during playback, checks that Canvas 2D or WebGL2 draws the same fills while playback continues at the same viewport and selection, and waits for the backend to return. It then loses the device again in the middle of a drag, which commits the same move as on Canvas 2D. Pixels are read back through each backend's own pipeline with an internal `readPixels`, not from screenshots. The trace runs Chromium in its new headless mode, as headless Chromium's older shell loses a WebGPU device on its software adapter. CI runs it with `LUMEN_SOFTWARE_GPU=1`, which forces SwiftShader for both GPU backends. Pass `firefox` or `webkit` to `node examples/vanilla/verify-renderers.mjs` for the other engines. Where the engine lacks a backend, as WebGPU in Playwright's Firefox or WebGL2 in Firefox on a Linux machine without a GPU, the trace checks instead that a view asking for it draws on the next backend and reports why in `fallback`.

### Benchmark

`npm run bench:render` runs the roadmap's [rendering fixture](../ROADMAP.md#engine-acceptance-targets) in Google Chrome on each backend. The fixture in `examples/bench` is two hours long, with 40 tracks, 20,000 clips and 12 rows visible at 1,440 × 900 CSS pixels and DPR 2. A 1080p video plays while it runs, and eight of its tracks play audio through the audio transport. Its waveforms come from 408 tile sources.

The trace lasts 60 seconds: 20 s of panning, 20 s of zooming between 0.6 and 630 px/s, and 20 s of pointer drags at one move a frame. For each frame it records main-thread work from the frame's start until its rendering ends, and it counts missed refreshes. Before the trace, ten seeks to regions never drawn, then the same ten again, time how long the tiles they need take to build and to draw. The run also records memory and the peak worker's round trips, and `--write` saves everything to [`docs/measurements/render.json`](measurements/render.json).

Recorded on an Apple M1 with Chrome 157 (ANGLE Metal), headless, at a load average of 4.6 to 10 from other work on the machine:

| Backend   | Frame work p50 / p95 / p99 | Missed refreshes | Cold seek: built / drawn | Warm seek: built / drawn | JS heap | Tiles    | GPU      |
| --------- | -------------------------- | ---------------- | ------------------------ | ------------------------ | ------- | -------- | -------- |
| WebGL2    | 3.4 / 5.2 / 6.3 ms         | 0.75%            | 10 / 17 ms               | 2 / 17 ms                | 122 MiB | 66.8 MiB | 16.6 MiB |
| WebGPU    | 3.8 / 5.7 / 7.1 ms         | 0.92%            | 12 / 17 ms               | 3 / 17 ms                | 116 MiB | 66.8 MiB | 16.6 MiB |
| Canvas 2D | 4.4 / 6.4 / 8.5 ms         | 0.69%            | 11 / 17 ms               | 4 / 17 ms                | 132 MiB | 66.8 MiB | 0        |

- **Targets.** On every backend, p95 frame work is within the target's 8 ms and missed refreshes within its 1%.
- **Missed refreshes.** Nearly all fell in the drag phase, where each pointer move is a round trip from the test runner. The same machine missed none with playback alone, and under heavier load from other processes, earlier runs missed up to 2.4%.
- **Seeks.** A cold seek built 88 tiles. The view draws in the next frame after its tiles are ready, so drawn time is about one refresh in both cases.
- **GPU memory.** Most of it is the 16 MiB label atlas.

The benchmark shaped two changes. Labels are left out of clips with less than 24 px of room, which kept the atlas from filling on every frame when zoomed out. Zoomed-out columns read each source's summary instead of whole tiles, which kept zooming from evicting and rebuilding thousands of tiles. Together they took zoom-phase p95 frame work from about 22 ms to 4–6 ms.

## Scale

Work in the view follows what is visible, not the size of the project. A paint lays out only the clips of visible rows in the visible range, which the core's per-track interval index returns. A pan or zoom redraws the ruler and the layout, leaves the track headers alone, and measures no layout: the view reads its sizes and scroll position when the mount changes, not in a paint. A vertical scroll moves the header list, changes a header only where a row comes into view or leaves it, and leaves the ruler alone. The clip navigator updates only the options of the clips an edit patched, and a new clip takes its place in project order. Labels stay in the atlas while they fit; when it fills, the view clears it and lays out again, so it only ever holds one paint's labels.

`npm run verify:scale` mounts the roadmap's benchmark shape: two hours, 40 tracks and 20,000 clips at 1440 × 900 CSS pixels and DPR 2, with 12 rows visible. At three zoom levels, down to the whole project, the layout holds exactly the clips a direct count finds. Sixty pans leave the headers and the navigator unchanged, and sixty more in one task make Chromium lay the page out no more than the frames around them do. Three vertical scrolls change two headers, keep them in row order and never draw the ruler. A split and its undo add and remove one navigator option, which stays in project order. One waveform notification repaints at once and a burst of ten repaints twice, and a paint of every row leaves no waveform repaint behind it. Panning across the project rasterizes thousands of distinct labels, more than the atlas holds, and labels still draw. Hit tests find a clip's body and handle, empty track space and the outside. Pass `firefox` or `webkit` to `node examples/vanilla/verify-scale.mjs` for the other engines, and a renderer after the engine, as in `chromium webgl2`, to run the same checks on that backend. CI runs it on the default backend and on WebGL2.

## Script

The video workspace has one track per speaker, Narrator and Keeper, beside the music and the reference stem. The **Lines** list below the timeline, in `examples/vanilla/lines.mjs`, shows every clip that carries a line, in timeline order. Each row gives the speaker, which is the clip's track, the range, the active take, the source text and the translation. A split line shows each part, as in `part 1 of 2`.

- **Select and reveal.** Clicking a row selects its clip, and `view.reveal(clipId)` brings it into view in the timeline. The inspector, take panel and line panel follow the selection. A clip selected in the timeline marks its row and scrolls it into view inside the list. The list has a constant height and never scrolls the page, so a selection made with the pointer moves nothing under it.
- **Line play.** **Play line** seeks to the clip and calls [`play({ until })`](media-transports.md#play-to-a-stop) with the clip's end, so playback stops on the line's last tick. Ordinary playback still begins at the playhead. While playback is inside a line, its row reads **Playing**, whatever has focus.

`npm run verify:lines` checks the rows, select and reveal, a selection from the timeline that leaves the page in place, line play stopping at the line's end, the parts of a split line, a text edit and undo in the video workspace, and line play in the audio workspace. Pass `firefox` or `webkit` to `node examples/vanilla/verify-lines.mjs` for the other engines.

## Lines and generation

The example's `studio.generation` plugin, in `examples/vanilla/generation.mjs`, shows how a host adds a take generator without anything in the core knowing of it.

- **Lines.** A clip names its line in a custom `lineId` field, which a split copies to both halves. The line's source text, translation and text revision live in entity data under `studio.line`. **Save text** writes the translation and advances the revision in one edit.
- **Requests.** **Generate take** snapshots the clip's line, text revision and content range. The simulated host generator derives audio from that request alone, after a configurable latency.
- **Results.** The plugin commits each result as one transaction: `expectData` on the text revision, `expectClip` on the clip's `lineId`, then `addTake` with the request in the take's `studio.generation` extension. A result whose line changed meanwhile is rejected whole with `expectation-failed`, so a late result never overwrites newer work. Applying a generated take stays a separate edit.
- **Job log.** Every job stays in the panel's **Generation jobs** log, applied or rejected, with its asset.
- **Reopen.** A saved project carries each generated take's request, so a reopened project rebuilds the take's audio from it before playback.

`npm run verify:studio` walks milestone 3's exit criteria in the video workspace, and CI runs it. It edits the line, generates and auditions a take and applies it, splits at 14 s and regenerates only the right half. It then undoes the apply and reopens. Afterwards it checks that the left half's candidates, plan and generated samples are unchanged. Last, it edits the text while a slow job runs and checks the rejection, the unchanged line and the job log. Pass `firefox` or `webkit` to `node examples/vanilla/verify-studio.mjs` for the other engines.

## Edit clips

Drag a clip body to move the selection. Drag a visible endpoint to trim it. Shift-click adds or removes a clip from the selection. A clipped edge of the viewport still picks the body when the true trim handle is offscreen. The music and reference stem tracks in the example are locked. The speaker tracks reject overlapping placements.

The dashed overlay previews a candidate move or trim. Release commits one transaction. Escape, pointer cancellation, lost capture and view disposal discard the gesture. A change to a selected placement cancels the drag. Independent metadata writes can advance the revision while the gesture continues. On release the view validates the absolute intent against the latest sequence and track constraints.

An edge drag trims by default. In stretch mode it changes the clip's [speed](headless-editing.md#clip-speed) instead: the dragged edge moves, the other stays, and the clip keeps its content, as one `retimeClip` by duration anchored at the other edge. The **Stretch** switch in the toolbar (`chrome.stretchToggle`) and R on the focused clip surface flip the mode, and `events.onEdgeModeChange` reports the user's choice. `edgeMode: "stretch"` mounts the view in it, the way a dubbing tool that fits lines to picture would. A stretch drag shows a column cursor and stops where the rate would leave 0.25 to 4, or the start would pass zero. A clip with a rate shows it after its name, as `125%`.

Configure snapping with `snap: { gridTicks, tolerancePx, neighbors, playhead, markers }` in the mount options. The nearest target within the CSS-pixel tolerance wins. Ties prefer the playhead, then a marker, then a neighboring boundary, then the grid. Hold Alt to bypass snapping. Set the grid interval or the tolerance to zero to disable the grid or all snapping, respectively.

The clip navigator and numeric edit controls support keyboard operation. Choose Move, Trim start or Trim end; enter a signed delta in seconds and activate Apply. Speed takes a percentage instead, starting from the clip's own, and applies it as one `retimeClip` that keeps the clip's start. With the clip surface focused, Left/Right nudges by one grid interval and S splits at the playhead. Undo uses Ctrl/Command-Z and redo uses Ctrl/Command-Shift-Z or Ctrl-Y. Text entry and IME composition retain their native shortcuts. The split selects the new right-hand clip.

Save project stores the immutable JSON snapshot in local browser storage. Reopen saved loads it into a new editor with the same clip IDs, offsets and active takes, a fresh selection and empty undo/redo stacks. The browser regression repeats the same move and trim via pointer and numeric controls and checks the music node and its end reservation throughout playback.

## Rename and reorder tracks

The built-in track headers are a list with one tab stop. Each header's text is the track's name, or its ID when it has none.

- **Rename.** Double-click a name, or press Enter or F2 on a focused header. The name becomes a text field with the old name selected.
  - **Commit.** Enter, or a click elsewhere, commits one undoable `updateTrack` edit. Focus returns to the header after Enter.
  - **Cancel.** Escape cancels.
  - **No-op drafts.** The draft is trimmed. A blank draft, or the name already shown, makes no edit, so it adds no undo entry.
  - **IME.** Enter during an IME composition only confirms the composed text.
  - **Switching windows.** Leaving the window keeps the draft open.
  - **API.** `view.renameTrack(trackId)` scrolls a track into view and opens its field. Use it to name a track just added with `commands.addTrack`.
- **Reorder by pointer.**
  - **Starting a drag.** Drag a header with the mouse or pen. On touch, drag its grip, which appears at the left edge on hover. A press shorter than 4 px stays a click or double-click.
  - **During the drag.** The header dims, a lifted copy follows the pointer, and a line across headers and clips marks the gap where the track will land. Rows stay aligned with their headers until the drop, so the line is the only thing that moves. The drop line splits each row at its middle, and it hides over the track's own gaps, where a drop changes nothing.
  - **Auto-scroll.** Holding the pointer within 32 px of the list's top or bottom scrolls it, faster nearer the edge.
  - **Ending.** A drop commits one `reorderTracks` edit. Escape, a cancelled pointer or leaving the window discards the drag.
- **Keyboard.** On a focused header:
  - Up and Down arrows move focus between tracks; Home and End go to the first and last.
  - Alt with Up, Down, Home or End moves the focused track one place, or to the top or bottom, as one undoable edit each.
  - Focus follows the moved track and scrolls it into view. A polite live region announces "Music moved to position 2 of 4". Change its text with `labels.trackMoved`, which fills `{name}`, `{position}` and `{count}`.
  - Ctrl/Command-Z undoes from the header.
- **Focus and drafts across scrolls and outside edits.** The view keeps the focused header, and an open rename field, while its row scrolls out of view, so keyboard focus never falls back to the page. When another view or a sync peer reorders the tracks, focus stays with its track. Tab focus scrolls a partly hidden header into view.
- **Turning it off.** `chrome: { trackRename: false }` and `chrome: { trackReorder: false }` turn either gesture off. The `"minimal"` and `false` presets turn both off. `readOnly` turns both off and leaves arrow-key focus. `shortcuts: false` keeps the pointer gestures and drops their keys.
- **Custom headers.** Custom `renderTrackHeader` content opts in with two markers:
  - `data-lt-track-grip` marks the element that starts a drag and takes Alt+Arrow keys.
  - `data-lt-track-name` marks the element a double-click swaps for the rename field. The view restores it and renders the header again with the new name.
  - The custom header's other controls keep their own pointer and keys.
- **Labels.** `labels.trackName` names the rename field for assistive technology, and `labels.reorderTrack` is the grip's tooltip.

`npm run verify:tracks` drives these with a real pointer and keyboard. Pass `firefox` or `webkit` to `node examples/vanilla/verify-tracks.mjs` for the other engines. It checks:

- the list semantics;
- rename by double-click, Enter and F2, with commit, Escape, blank and unchanged drafts, an IME Enter, a blur commit and undo;
- arrow-key focus and Alt+Arrow moves;
- a drag with its threshold, ghost, drop line and one edit;
- a drop in place and an escaped drag, which make no edit;
- auto-scroll to the last place;
- focus and a draft surviving scrolls and outside edits;
- `view.renameTrack` on a new track;
- read-only, the chrome switches and the minimal preset;
- custom headers with both markers.

## Appearance

The view comes in two color schemes. `theme: { scheme: "light" }` or `"dark"`, the default, sets the DOM chrome and the canvases together, and `view.update({ theme })` switches a mounted view. The root element carries the scheme as `data-lt-scheme`. Every other `theme` field overrides one color or font of the scheme.

- **Toolbar.** A round play button, the playhead time with the project's length, the clip and marker navigators, undo and redo (`chrome.history`), **Add marker**, the snapping switch (`chrome.snapToggle`), the edge-drag switch between trimming and stretching (`chrome.stretchToggle`) and the zoom buttons with the zoom as a percentage of the mounted `pixelsPerSecond`. With **Snap** off, drags and trims follow the pointer; `snap` still configures what they snap to when it is on.
- **Panel.** The track headers, the ruler, the lanes and a thin scroll bar share one rounded panel. Each track is a rounded lane. `theme.grid` draws grid lines across the lanes, and is transparent by default.
- **Ruler.** Markers sit in a lane of their own above the time labels, as flags with a stem. A press on a flag chooses that marker and seeks to it.
- **Clips.** A clip is a rounded block in its track's color, with its name and caption above a waveform of bars. Palette entries give `fill`, `stripe` (the accent: the header's dot and the take lanes' outline), `waveform` and `text`. A `track.color` or `clip.color` is an accent: the dark scheme fills the clip with it, and the light scheme tints it. A locked track's clips use `theme.locked`, a neutral grey.
- **Selection.** A selected clip has a ring and a grip on each edge. One selected clip also shows a floating toolbar (`chrome.clipToolbar`) with **Split**, which splits at the playhead as S does, and **Takes** for a clip with at least two candidates.
- **Take lanes** (`chrome.takeLanes`). **Takes**, T on the clip surface, or `view.showTakeLanes(clipId)` shows the clip's candidates as lanes under its track, each with its own waveform. The active one is filled. A click on a lane, or on its name in the header column, makes that candidate active as one undoable `selectTake` edit. With `events.onTakeAudition` set, each name has an audition button that calls it with `{ clipId, takeId }`; the view plays nothing itself. The lanes close when the selection moves to other clips, and `view.showTakeLanes(null)` closes them.
- **Track headers** (`chrome.trackControls`). Beside its name, a header shows a mute and a solo switch, which dispatch `updateTrack`, a lock mark for a locked track, and the track's gain as a meter and in decibels. M and S on a focused header switch them. A custom `renderTrackHeader` replaces all of it.
- **Forms.** The marker form shows while the marker navigator has a marker chosen, and the edit form while clips are selected.
- **Narrow mounts.** Under 1080 px the navigators drop their captions; under 640 px the length, the zoom percentage and the gain meters go; under 460 px the mute and solo switches go too. The root carries the step as `data-lt-size`.

`npm run verify:chrome` drives these with a real pointer and keyboard: the scheme switch, a marker flag, the clip toolbar, take lanes by button, key, list, lane and API, audition, the snap switch, stretch drags of either edge with the switch, R and `edgeMode`, the speed field, mute and solo, read-only and the chrome flags. Pass `firefox` or `webkit` to `node examples/vanilla/verify-chrome.mjs` for the other engines.

## Customization and headless canvas

Hosts can strip down or customize the built-in timeline UI for diverse domains (video review, podcast editing, DAWs, annotation tools or embedded players) without replacing the layout or GPU rendering pipeline:

- **Composable chrome (`chrome`).** Defaults to showing all built-in controls. Pass `chrome: "minimal"` for ruler + track headers + clip surface with no toolbars or forms, `chrome: false` for a bare clip canvas, or an object toggling `toolbar`, `ruler`, `trackHeaders`, `scrollBar`, `markerEditor`, `editToolbar`, `status`, `clipNavigator`, `markerNavigator`, `trackRename`, `trackReorder`, `history`, `snapToggle`, `stretchToggle`, `clipToolbar`, `takeLanes` and `trackControls`. Hiding `clipNavigator` skips DOM `<option>` maintenance.
- **Full localization (`labels`).** `labels` accepts text overrides for every built-in control (`play`, `pause`, `tracks`, `clip`, `selectClip`, `marker`, `selectMarker`, `addMarker`, `markerLabel`, `renameMarker`, `removeMarker`, `scroll`, `zoomIn`, `zoomOut`, `operation`, `move`, `trimStart`, `trimEnd`, `delta`, `apply`, `splitAtPlayhead`, `undo`, `redo`, `trackName`, `reorderTrack`, `trackMoved`, `snap`, `split`, `takeLanes`, `mute`, `solo`, `locked`, `audition`) in addition to candidate take captions (`take`, `takes`, `none`).
- **Theming and layout (`theme`, `layout`, CSS variables).** Choose the built-in palette with `theme.scheme` (see [Appearance](#appearance)), then override canvas and overlay colors, fonts and the track palette via `theme` (`rowEven`, `rowOdd`, `grid`, `selectionStroke`, `handleFill`, `ghostFill`, `ghostStroke`, `marker`, `rulerText`, `rulerMarkerBackground`, `labelColor`, `nameFont`, `captionFont`, `rulerFont`, `markerFont`, `palette`, `locked`), and override DOM chrome colors via `--lt-*` CSS custom properties in `@lumen-timeline/timeline/style.css`. Adjust row density with `layout: { laneHeight, rowInset }`; the defaults, `47` and `10`, give a 44 px clip with its name above its waveform, and a clip under 30 px draws its waveform over its full height.
- **Time formatting and grids (`formatTime`, `gridSpacing`).** Customize ruler labels, time readouts and ARIA labels with `formatTime(tick)` (for SMPTE timecode, bars/beats or frame numbers) and choose grid intervals dynamically with `gridSpacing(pixelsPerSecond)`.
- **Per-clip styling, custom headers and overlays (`clipStyle`, `renderTrackHeader`, `renderOverlay`).** Override any clip's colors, label or caption via `clipStyle(clip, track, trackIndex)` (clips and tracks can also carry static `color` fields in the project). Populate virtualized track header rows with custom DOM controls (such as mute/solo/gain knobs) via `renderTrackHeader(track, context)`. Draw arbitrary 2D graphics—automation curves, comments, loop brackets or spectrogram overlays—above clips via `renderOverlay({ ctx, width, height, scrollTop, view, snapshot, selection, pixelAt, tickAt, boxOf })`, and call `view.repaint("overlay")` or `view.repaint("all")` whenever external host state changes.
- **Read-only mode, shortcuts and events (`readOnly`, `shortcuts`, `events`).** Set `readOnly: true` to disable drag, keyboard and form mutations while preserving selection, seek, zoom and pan. It defaults to `true` for an editor whose `readOnly` names a reason, such as a project in a [later schema](plugins-and-persistence.md#schema-versions). Set `shortcuts: false` to own all keybindings in the host. Subscribe to surface interactions with `events: { onClipClick, onClipDoubleClick, onContextMenu, onTrackClick, onViewportChange, onTakeAudition }`.

`npm run verify:reusability` runs a real-browser Playwright check covering headless chrome presets, dynamic theme/layout/i18n updates, custom `renderTrackHeader` controls (mute/solo/gain), `clipStyle` and `renderOverlay` hooks, `readOnly` enforcement, `events` callbacks, region markers, direct `clip.source` waveforms, and live `addTrack`/`reorderTracks`/`removeTrack`/`addClip`/`removeClip` mutations on both GPU and Canvas 2D backends.
