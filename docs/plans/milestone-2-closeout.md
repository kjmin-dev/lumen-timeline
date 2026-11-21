# Close milestone 2

**Status.** In progress.

**User outcome.** In the audio workspace, play across the narration and fade markers and watch each one announced as playback crosses it. Seeking past a marker announces nothing. A single browser trace then walks every milestone 2 exit criterion end to end, and the roadmap records the milestone as complete. [Design](../design.md#time-and-project-format) · [Milestone 2](../../ROADMAP.md#milestones)

**Starting point.** After #20, markers can be edited, navigated and reopened. The design says "Continuous forward playback emits crossed markers in `(previous, current]` order", but a transport reports only `presentedTick`, `requestedTick` and `playing`. A listener can tell a seek from playback only by guessing:

- a paused audio seek moves `presentedTick` without ever publishing a request;
- a seek made on the video element itself publishes nothing until it lands;
- a playing audio seek is first observed slightly after its target.

Each exit criterion has a check, but the checks are spread across separate traces.

## PR P — Marker crossings

- **Presentation segments.** Both transport snapshots gain `segment` and `segmentStart`.
  - Within a segment, `presentedTick` moves only by playback.
  - Every other move starts a segment at the position presentation continues from: a paused or playing seek, replay from the end, a native video seek, or a sequence shortened behind the playhead.
  - Pause, natural end, interruption and recovery keep the segment.
  - A playing audio seek starts its segment at the target when the output clock reaches the anchor, even if a pause, a newer seek or a closed context comes first.
- **Native video seeks.** `seeking` on the element publishes its target as `requestedTick`, and `seeked` lands it, as a transport seek does. A transport seek takes over an unfinished native seek.
- **Core watcher.** `watchMarkerCrossings(editor, source, listener)` keeps the furthest tick presented in the current segment. It reports `{ markers, after, through, revision }` for markers with `after < start <= through`, read from the editor's current revision.
  - A new segment counts from `segmentStart`.
  - A slightly earlier frame does not repeat a crossing.
  - Listener errors go to `reportError`.
  - `PresentationSource` is structural, so any player adapter that reports the three fields can use the watcher.
- **Example.** Both pages show the last crossed marker in a status output.
- **Test harness.** Playwright's `waitForFunction` treats a returned promise as truthy, so an `async` predicate never waits. The marker trace's waits become synchronous predicates over the live module namespace.

## PR Q — Milestone 2 acceptance

- **One trace.** `npm run verify:milestone` drives one recorded session against the exit criteria:
  - pointer and keyboard edits, a split and marker commands in the video workspace;
  - save and reopen, with the same clips, active takes and markers;
  - the same commands replayed headlessly in Node to the same snapshot;
  - an audio-only project played through silence to a marker at its end.
- **Roadmap.** Milestone 2 is marked complete with a link to the trace. The ROADMAP and README status lines name what milestone 3 starts from.

## Merge gates

| Gate             | Evidence                                                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Watcher          | A seeded trace of plays, frame wiggles and seeks matches a per-segment oracle. Mutating the segment reset, the furthest-tick rule or the interval bounds fails a test.                                                                                 |
| Transports       | Each segment rule above has a unit test, and removing any `segment` change from either transport fails one. The video test drives native seeks, a takeover and frames through a fake element.                                                          |
| Browser          | `verify:audio` crosses Narration and Fade in order, skips nothing on a seek and crosses a marker added during playback. `verify:timeline` seeks the video element directly past three markers and crosses only the next one. Both run against `dist/`. |
| Unchanged checks | Every existing unit and browser check passes. API snapshots change only by the new fields and exports.                                                                                                                                                 |
| Acceptance       | `verify:milestone` passes in CI. Its headless replay produces the browser's saved snapshot.                                                                                                                                                            |
