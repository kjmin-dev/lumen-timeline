# Vanilla Canvas timeline

Run `npm ci` and `npm run example:vanilla`, then open the printed local address. The 24-second guide is an original animated contour study. The dialogue is an eSpeak NG synthesis of “The tide returns. Watch the contour lines drift across the inlet.” The checked-in Opus clip includes a one-second lead and padding to eight seconds. The music is synthesized locally. The example plays without a remote media service. The silent reference can be regenerated using `python3 examples/vanilla/media/generate.py` and FFmpeg with libvpx.

Load `@lumen-timeline/timeline/style.css` and call `mountTimeline(element, { editor, transport })`. The view accepts an adapter exposing `snapshot()`, `subscribe(listener)` (returning a disposer), `play()`, `pause()` and `seek(projectTick)`. Snapshots carry `playing`, `presentedTick` and a nullable `requestedTick`. The host publishes requests immediately and settles only the latest request. The example bridges the existing Web Audio scheduler and its video frame callback.

`view.setViewport({startTick, pixelsPerSecond})` changes one mount. Ctrl/Command-wheel zooms at the pointer. Shift-wheel or the scroll slider pans. Use the ruler or its arrow keys to seek. Click a clip, Shift-click to change a group or use the native clip navigator. `editor.session.select(ids)`, `getSelection()` and `subscribeSelection(listener)` share a selection across views. Selection is ephemeral. Undo prunes missing IDs.

The ruler and static clips are cached separately from selection and the moving playhead. Track subrows are assigned from complete track intervals and retained across horizontal pans. Painting and picking use CSS pixels; the backing canvas follows device pixel ratio. `view.getDiagnostics()` returns paint and layout counts. `view.dispose()` releases that mount's observers, subscriptions and DOM. The host owns its editor and transport.

Run `npm test` and `npm run verify:timeline` for geometry, session and real-browser checks. Install the test browser with `npx playwright install chromium`. The ten-second playback trace asserts zero extra layout or static paint operations at a fixed viewport.
