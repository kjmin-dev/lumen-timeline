# Vanilla Canvas timeline

Run `npm ci` and `npm run example:vanilla`, then open the printed local address. The 24-second guide is an original animated contour study. The dialogue is an eSpeak NG synthesis of “The tide returns. Watch the contour lines drift across the inlet.” The checked-in Opus clip includes a one-second lead and padding to eight seconds. The music is synthesized locally. The example plays without a remote media service. The silent reference can be regenerated using `python3 examples/vanilla/media/generate.py` and FFmpeg with libvpx.

Load `@lumen-timeline/timeline/style.css` and call `mountTimeline(element, { editor, transport })`. The view accepts a `TimelineTransport`: an adapter exposing `snapshot()`, `subscribe(listener)` (returning a disposer), `play()`, `pause()` and `seek(projectTick)`. Media transports satisfy it, and so can any player adapter that reports project ticks. Snapshots carry `playing`, `presentedTick` and a nullable `requestedTick`. The host publishes requests immediately and settles only the latest request. The example bridges the existing Web Audio scheduler and its video frame callback.

`view.setViewport({startTick, pixelsPerSecond})` changes one mount. `view.reveal(clipId)` scrolls a clip's lane into view and pans to its start when that is offscreen, for a host list that selects clips. Ctrl/Command-wheel zooms at the pointer. Shift-wheel or the scroll slider pans. Use the ruler or its arrow keys to seek. Click a clip, Shift-click to change a group or use the native clip navigator. `editor.session.select(ids)`, `getSelection()` and `subscribeSelection(listener)` share a selection across views. Selection is ephemeral. Undo prunes missing IDs.

The ruler and static clips are cached separately from selection and the moving playhead. Track subrows are assigned from complete track intervals and retained across horizontal pans. Each paint lays out the visible rows once, as rectangles, waveform columns and label crops in stacking order, and the drawing backend draws only that layout. Clip names and captions are rasterized once into a label atlas at the device pixel ratio. Painting and picking use CSS pixels; the backing canvas follows device pixel ratio. `view.hitTest({ x, y })` returns the clip, trim handle or body, track and tick under a point of the clip surface, read from the layout. `view.getDiagnostics()` returns paint and layout counts, the drawing backend, the clips in the current layout and the labels rasterized so far. `view.dispose()` releases that mount's observers, subscriptions and DOM. The host owns its editor and transport.

Run `npm test` and `npm run verify:timeline` for geometry, session and real-browser checks. `npm run verify:milestone` runs the milestone 2 acceptance session across both workspaces and a headless replay; pass `firefox` or `webkit` to `node examples/vanilla/verify-milestone.mjs` for the other engines. Install the test browser with `npx playwright install chromium`. The ten-second playback trace asserts zero extra layout or static paint operations at a fixed viewport.

## Markers

The ruler draws saved markers as flags with their labels, with a thin line across the clips. With the ruler or the clip surface focused:

- `]` seeks to the next marker and `[` to the previous one;
- `M` adds a marker at the playhead.

The marker navigator lists markers in time order and seeks to the chosen one. **Rename marker** and **Remove marker** act on the navigator's marker, and the history controls undo either.

Drags snap to markers. Ties prefer the playhead, then a marker, then a neighboring clip edge, then the grid. Pass `snap: { markers: false }` to opt out.

Both example projects start with two markers. Save project and Reopen saved keep them. The title row shows the last marker that playback crossed. Seeking past a marker, by any means, does not change it. [Marker crossings](media-transports.md#marker-crossings) `npm run verify:timeline` steps through markers from the keyboard, adds, renames, removes and undoes one, checks that a marker added during playback leaves the music reservation alone, and reopens the saved project. It then plays from 11 s, seeks the video element directly to 18.6 s and checks that only the marker at 19 s is crossed.

## Candidates

Each clip that lists [candidate takes](headless-editing.md#takes) shows a caption after its name: the active take's label, or its ID, and the count, as in `Guide · 3 takes`. A clip with none active reads `No take · 3 takes`. Pass `labels: { take, takes, none }` to use the host's words, such as `{ take: "version" }` for `Guide · 3 versions` and `No version`. `takes` defaults to `take` followed by "s" and `none` to "No " followed by `take`, so a language without that plural passes all three.

Selecting a take or changing a clip's list repaints the clip as any clip edit does. Relabeling a take repaints only the tracks where it is the active take of some clip. A label or data change that no caption shows repaints nothing.

The example's **Takes** panel lists the selected clip's candidates in order. Each row can **Audition** the take through the [transport](media-transports.md#audition), in the mix or **Isolated**, and the same button stops it. **Apply** selects it, the arrows reorder the list and **Remove** takes it off the list. The active take cannot be removed. Each of these is one undoable edit, and Save project and Reopen saved keep the list. The first line has three candidates: the recording, the same recording a quarter second later and a synthesized guide. The audio workspace calls them versions. The panel keeps a constant height, so selecting a clip never moves the timeline under the pointer.

`npm run verify:takes` checks the caption and repaint rules, an isolated and a cancelled audition with the video returning to its position, apply, reorder, remove, undo and reopen in the video workspace, and a mix audition and the renamed words in the audio workspace. Pass `firefox` or `webkit` to `node examples/vanilla/verify-takes.mjs` for the other engines.

## Waveforms

Pass `waveforms` to `mountTimeline` to draw a waveform in each clip whose active take has peaks. The view asks the provider for the visible part of the take's source, one bucket per CSS pixel column, whenever it paints that clip:

```js
const view = mountTimeline(element, {
  editor,
  transport,
  waveforms: {
    // Source time is content time plus the take's sourceAtContentZero, in ticks.
    peaks: ({ assetId, streamId, start, end, buckets }) => minMaxPairs ?? null,
    subscribe: (listener) => cache.onReady(listener),
  },
});
```

- **Peaks.** `peaks` returns `buckets` minimum and maximum pairs between -1 and 1, or `null` to draw nothing for that source yet. A column whose pair is not finite is not drawn. A move keeps the requested range, and a trim or a take's new `sourceAtContentZero` changes it.
- **Late peaks.** When peaks arrive or change, call the `subscribe` listener with the asset ID. The view repaints only the visible tracks whose drawn clips play that asset. The first notification repaints at once; any more before the next frame repaint together in it. A take that starts playing other media repaints the tracks of the clips that list it. Disposing the view unsubscribes.
- **Scope.** Each paint asks for what is visible. [Waveform tiles](waveforms.md) from the media package answer from tiles built in a worker, and a host can pass any provider of its own.

The video workspace's **Original dialogue** track holds a reference stem under the whole picture: a locked clip that plays the original-language dialogue quietly at a track gain of 0.35. Its waveform shows where each original line falls, for timing the dub against it. The example draws it with `createWaveformTiles` over the decoded stem, so its peaks are built in the media package's worker.

`npm run verify:waveforms` waits for the stem's tiles, then checks that its drawn peaks fall in its phrases and not between them at two zoom levels, and that the stem is locked. In a mount of its own, it checks that pending peaks draw nothing, that a notification repaints once and only the track that plays the asset, the source range after a move, a left trim and a take offset change, and the unsubscription on dispose. Pass `firefox` or `webkit` to `node examples/vanilla/verify-waveforms.mjs` for the other engines.

## Scale

Work in the view follows what is visible, not the size of the project. A paint lays out only the clips of visible rows in the visible range, which the core's per-track interval index returns. A pan or zoom redraws the ruler and the layout and leaves the track headers alone. The clip navigator updates only the options of the clips an edit patched, and a new clip takes its place in project order. Labels stay in the atlas while they fit; when it fills, the view clears it and lays out again, so it only ever holds one paint's labels.

`npm run verify:scale` mounts the roadmap's benchmark shape: two hours, 40 tracks and 20,000 clips at 1440 × 900 CSS pixels and DPR 2, with 12 rows visible. At three zoom levels, down to the whole project, the layout holds exactly the clips a direct count finds. Sixty pans leave the headers and the navigator unchanged. A split and its undo add and remove one navigator option, which stays in project order. One waveform notification repaints at once and a burst of ten repaints twice. Panning across the project rasterizes thousands of distinct labels, more than the atlas holds, and labels still draw. Hit tests find a clip's body and handle, empty track space and the outside. Pass `firefox` or `webkit` to `node examples/vanilla/verify-scale.mjs` for the other engines.

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

Configure snapping with `snap: { gridTicks, tolerancePx, neighbors, playhead, markers }` in the mount options. The nearest target within the CSS-pixel tolerance wins. Ties prefer the playhead, then a marker, then a neighboring boundary, then the grid. Hold Alt to bypass snapping. Set the grid interval or the tolerance to zero to disable the grid or all snapping, respectively.

The clip navigator and numeric edit controls support keyboard operation. Choose Move, Trim start or Trim end; enter a signed delta in seconds and activate Apply. With the clip surface focused, Left/Right nudges by one grid interval and S splits at the playhead. Undo uses Ctrl/Command-Z and redo uses Ctrl/Command-Shift-Z or Ctrl-Y. Text entry and IME composition retain their native shortcuts. The split selects the new right-hand clip.

Save project stores the immutable JSON snapshot in local browser storage. Reopen saved loads it into a new editor with the same clip IDs, offsets and active takes, a fresh selection and empty undo/redo stacks. The browser regression repeats the same move and trim via pointer and numeric controls and checks the music node and its end reservation throughout playback.
