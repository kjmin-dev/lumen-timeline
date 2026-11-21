# Turn timeline edits into a playback plan

**Status.** Delivered: PR A in [#5](https://github.com/kjmin-dev/lumen-timeline/pull/5) and PR B in [#6](https://github.com/kjmin-dev/lumen-timeline/pull/6).

**User outcome.** In a dubbing session, moving a line or undoing its trim should change the dialogue at the playhead while the background music continues from the same sample. The same range query should tell a future timeline view which clips to draw.

**Starting point.** At `6db9f29`, the editor already commits immutable revisions, maintains sorted clip arrays for affected tracks and reports old and new intervals. The browser experiment scans every clip on a scheduler wakeup. Its `replace(clips)` invalidates the clock anchor and stops every scheduled node. The offline experiment also assembles its source windows directly. This leaves the view, playback and export without a shared way to read one revision. [Editor commit path](https://github.com/kjmin-dev/lumen-timeline/blob/6db9f29/packages/core/editor.mjs) · [Experimental scheduler](../../experiments/sync/transport.mjs) · [Existing time conversion](https://github.com/kjmin-dev/lumen-timeline/blob/6db9f29/packages/core/time.mjs)

## PR A — A headless read API

Ship a revision-bound read handle, a track interval query and a pure audio planner in `@lumen-timeline/core`. The following is the proposed API.

```js
const read = editor.read();
const range = { start: unitsToTicks(142, 10), end: unitsToTicks(143, 10) };
const clips = read.clipsIn(range, { trackIds: ["dialogue", "music"] });
const { revision, catalogVersion, spans, issues } = read.planAudio(range, catalog);
```

- **Snapshot identity.** Capture the document and its track-index roots together at commit. Holding a read handle across edit, undo or redo must reproduce its original results. Calls on a pinned handle perform synchronous reads and create no history entries or notifications. Queued subscribers must be able to obtain a handle for the exact snapshot delivered to them, including during reentrant dispatch. Support `editor.read(snapshot)` for snapshots emitted by that editor and reject foreign snapshots. Use weak snapshot keys so retaining the current editor does not keep every historical index alive.
- **Placement query.** Use half-open project ticks and the predicate `clip.start < end && clip.end > start`. An empty interval returns an empty result. Reject reversed ranges and unsafe tick inputs. Return stable clip references in document track order, then placement start and clip ID. Muted tracks and clips awaiting a take remain visible.
- **Index.** Reuse the per-track arrays already replaced by the editor. Lazily build a start-ordered interval index augmented with each subtree's largest end tick. Prune subtrees ending before the query and entries starting at or beyond its end. Cache by immutable track-array identity. An ignored metadata write shares all geometry indexes. A cross-track move changes the source and destination indexes. A long clip starting before the viewport must still be found.
- **Media input.** The host supplies an immutable, synchronous take catalog with a version. A binding maps a take ID to asset ID and content version, stream ID, sample rate, signed source sample index at content time zero and available sample interval. The catalog adapts host or persisted media records to this shape. The project clip owns its active take and placement. The planner can therefore read existing schema-v1 projects and run in Node with ordinary JSON fixtures. Media fetching and decoded buffers belong to the driver.
- **Plan output.** Each span identifies its track, clip, active take, asset version and stream. Return both the complete audible placement and its intersection with the query, with corresponding half-open source sample ranges. Convert both absolute sample boundaries through the same rounding rule. Normalize catalog sample indices to project ticks at the boundary of the existing `sourceWindow` helper, then convert its absolute source edges back to sample indices and clamp to availability. Omit intervals that contain zero source samples. A silent tail yields no span there. A clip with no selected take remains silent. An unresolved selected take yields a keyed issue so other clips can still play. Apply track mute, solo and gain when planning audio. Default gain is 1, and mute takes precedence over solo. Preserve independent spans for overlapping voices.
- **Lookahead.** A short planning window discovers voices to start or resume. Its right edge is independent of the clip's audible end. The driver can schedule through the available source chunk and keep the node across wakeups. This avoids cutting a continuous clip into a new source every 100 ms.

**Worked fixture.** A four-second line starts at 12 s, with content offset 1 s. Its take starts at source zero. At 48 kHz, querying project `[14.2, 14.3)` must yield source `[153600, 158400)`. A split at 14 s leaves those sample indices unchanged. If the right half moves two seconds later, the same source window appears at `[16.2, 16.3)`. A music clip spanning the entire sequence appears in both queries with its own source mapping.

## PR B — Apply plan changes to the running player

Use PR A from the existing browser probe before exposing a production media package. The driver queries the scheduler lookahead and reconciles the voices already running or reserved. A local document edit preserves the clock generation.

| Input                                      | Driver behavior                                                                                                                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Move, trim, split, undo or redo            | Inspect changed IDs and both old and new intervals at the current playhead and lookahead. Stop obsolete reservations. Start a clip now covering the playhead at its mapped source sample. |
| Background update with `history: 'ignore'` | A metadata-only update with no audio binding change leaves the nodes and clock anchor intact. A batch also changing placement follows its reported geometry.                              |
| A selected take's asset or stream changes  | Compare binding versions and replan dependent voices. A late buffer may attach only if its voice still has the same requested binding, source mapping and transport generation.           |
| Seek, loop wrap or recovery from a stall   | Invalidate the transport generation, cancel stale work and rebuild from the new anchor using the tested shared-sample boundary rules.                                                     |

Compare each running voice's clip, take, asset version, source-to-project mapping, audible end and route. Query-window endpoints and global document revisions must not cause voice replacement by themselves. A preserved voice keeps its node and end reservation. Remove a cached seam when its producing reservation changes. Keep seam records scoped to the continuity chain and generation so an unrelated overlapping track cannot supply the shared output sample.

## Merge gates

| Gate                         | Evidence required                                                                                                                                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR A: correct query          | Compare with a brute-force oracle over seeded placements and random ranges. Cover exact edges, empty tracks, equal starts, a long enclosing clip and overlapping clips. Query old and new handles after an edit and after a reentrant commit.                                      |
| PR A: correct plan           | Verify the worked fixture at 44.1 and 48 kHz, short takes, negative origins, missing bindings, mute/solo and overlapping tracks. Exactly partition adjacent source windows at a fractional-frame cut. Planning must leave project revisions and history depths unchanged.          |
| PR A: bounded query work     | Use the roadmap's 40-track, 20,000-clip fixture. Record visited entries, matches and query p95 for sparse and dense windows. A sparse query on one named track must skip the other 39 and prune irrelevant intervals within the requested track.                                   |
| PR B: uninterrupted playback | In a two-track fake-driver test, record node identities and start/stop calls through dialogue move, undo, redo and background job completion. Require zero music restarts and zero cancelled music reservations. Exercise delayed source resolution and stale-result cancellation. |
| PR B: actual audio           | Render the edited mix at 44.1 and 48 kHz against independent sample expectations. Run the short live sync probe and its injected-delay control. Preserve the existing seek, real-stall and shared-boundary regressions.                                                            |
| Handoff to the view          | Use `clipsIn` for the first vanilla Canvas 2D viewport. The first visible workflow is select a clip, seek, trim or move it, then undo while the playhead follows the same driver.                                                                                                  |

PR A can merge after the headless query and plan gates pass. PR B closes the two-track playback outcome. The Canvas 2D view follows those contracts. [Milestone 2](../../ROADMAP.md#milestones) · [Core architecture](../core-architecture.md) · [Selective history](../selective-history.md)
