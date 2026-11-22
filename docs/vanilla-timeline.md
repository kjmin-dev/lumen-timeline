# Vanilla Canvas timeline

Run `npm ci` and `npm run example:vanilla`, then open the printed local address. The 24-second guide is an original animated contour study. The dialogue is an eSpeak NG synthesis of “The tide returns. Watch the contour lines drift across the inlet.” The checked-in Opus clip includes a one-second lead and padding to eight seconds. The music is synthesized locally. The example plays without a remote media service. The silent reference can be regenerated using `python3 examples/vanilla/media/generate.py` and FFmpeg with libvpx.

Load `@lumen-timeline/timeline/style.css` and call `mountTimeline(element, { editor, transport })`. The view accepts a `TimelineTransport`: an adapter exposing `snapshot()`, `subscribe(listener)` (returning a disposer), `play()`, `pause()` and `seek(projectTick)`. Media transports satisfy it, and so can any player adapter that reports project ticks. Snapshots carry `playing`, `presentedTick` and a nullable `requestedTick`. The host publishes requests immediately and settles only the latest request. The example bridges the existing Web Audio scheduler and its video frame callback.

`view.setViewport({startTick, pixelsPerSecond})` changes one mount. Ctrl/Command-wheel zooms at the pointer. Shift-wheel or the scroll slider pans. Use the ruler or its arrow keys to seek. Click a clip, Shift-click to change a group or use the native clip navigator. `editor.session.select(ids)`, `getSelection()` and `subscribeSelection(listener)` share a selection across views. Selection is ephemeral. Undo prunes missing IDs.

The ruler and static clips are cached separately from selection and the moving playhead. Track subrows are assigned from complete track intervals and retained across horizontal pans. Painting and picking use CSS pixels; the backing canvas follows device pixel ratio. `view.getDiagnostics()` returns paint and layout counts. `view.dispose()` releases that mount's observers, subscriptions and DOM. The host owns its editor and transport.

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

## Edit clips

Drag a clip body to move the selection. Drag a visible endpoint to trim it. Shift-click adds or removes a clip from the selection. A clipped edge of the viewport still picks the body when the true trim handle is offscreen. The music track in the example is locked. The dialogue track rejects overlapping placements.

The dashed overlay previews a candidate move or trim. Release commits one transaction. Escape, pointer cancellation, lost capture and view disposal discard the gesture. A change to a selected placement cancels the drag. Independent metadata writes can advance the revision while the gesture continues. On release the view validates the absolute intent against the latest sequence and track constraints.

Configure snapping with `snap: { gridTicks, tolerancePx, neighbors, playhead, markers }` in the mount options. The nearest target within the CSS-pixel tolerance wins. Ties prefer the playhead, then a marker, then a neighboring boundary, then the grid. Hold Alt to bypass snapping. Set the grid interval or the tolerance to zero to disable the grid or all snapping, respectively.

The clip navigator and numeric edit controls support keyboard operation. Choose Move, Trim start or Trim end; enter a signed delta in seconds and activate Apply. With the clip surface focused, Left/Right nudges by one grid interval and S splits at the playhead. Undo uses Ctrl/Command-Z and redo uses Ctrl/Command-Shift-Z or Ctrl-Y. Text entry and IME composition retain their native shortcuts. The split selects the new right-hand clip.

Save project stores the immutable JSON snapshot in local browser storage. Reopen saved loads it into a new editor with the same clip IDs, offsets and active takes, a fresh selection and empty undo/redo stacks. The browser regression repeats the same move and trim via pointer and numeric controls and checks the music node and its end reservation throughout playback.
