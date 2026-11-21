# Saved timeline markers

**Status.** Delivered: PR M in [#19](https://github.com/kjmin-dev/lumen-timeline/pull/19) and PR N in [#20](https://github.com/kjmin-dev/lumen-timeline/pull/20).

**User outcome.** In the vanilla editor, add a marker at the playhead, jump between markers from the keyboard, rename or remove one, undo any of it, then save and reopen with the same markers. An audio-only project plays through silence to a marker after its last clip. The same commands run headlessly. [Design](../design.md#time-and-project-format) · [Milestone 2](../../ROADMAP.md#milestones)

**Starting point.** After #18, every package is strict TypeScript without type assertions. The design reserves point markers and regions for the document: "Stable ID, point or interval, label, color and optional extension data". It also says an audio-only extent can end at a marker and that markers are snap candidates. Neither the document, the read API nor the view knows about markers yet.

## Document model

- **Shape.** `project.markers` is an optional array of point markers: `{ id, start, label?, color?, extensions? }`. Other JSON fields are preserved.
  - `start` is a project tick. A later region can add a `duration` without renaming it.
  - IDs are unique among markers.
  - `0 <= start <= duration` with an explicit sequence duration. A marker may sit at the end.
- **Load validation.** Loading validates every field and rejects a bad one with the new code `invalid-marker`.
- **Canonical form.** The snapshot keeps markers sorted by `start`, then ID, and omits the field when there are none. A loaded `markers: []` is therefore dropped.
- **Extent.** With an implicit duration, `sequenceDuration` ends at the later of the last clip end and the last marker. The audio transport and the ruler already follow `sequenceDuration`.

## PR M — Commands, history and reads in the core

- **Commands.** Four commands work in any transaction alongside clip and entity-data commands.

  | Command                                      | Behavior                                               | Rejections                                                                                 |
  | -------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
  | `addMarker({ id?, start, label?, color? })`  | Generates an ID like a split does when `id` is omitted | `invalid-marker` for a taken or invalid ID or a non-string label or color; `invalid-range` |
  | `moveMarker({ markerId, delta })`            | Moves by `delta`                                       | `missing-marker`, `invalid-delta`, `invalid-range`                                         |
  | `updateMarker({ markerId, label?, color? })` | Changes only the fields given                          | `missing-marker`, `invalid-marker`                                                         |
  | `removeMarker({ markerId })`                 | Removes the marker                                     | `missing-marker`                                                                           |

  A net-zero transaction is `unchanged`. Preview still accepts only clip moves and trims.

- **Commit results.** A commit reports `markerPatches` and `inverseMarkerPatches` as `{ id, before, after }` records, where `undefined` means absent. `changedIds`, `createdIds` and `affected` keep describing clips only. Playback therefore never replans for a marker-only edit.
- **Selective history.** Replay follows the clip rules:
  - an add requires the ID to be free;
  - a removal requires the whole recorded marker to match;
  - an update checks only the fields it changed and keeps others edited in the meantime.

  A failure returns `history-conflict` and leaves both stacks intact.

- **Reads.** A read handle answers, from the canonical order:
  - `markersIn(range)`: half-open, so `start <= marker.start < end`;
  - `nextMarker(tick)`: the first marker after `tick`;
  - `previousMarker(tick)`: the last marker before `tick`.

## PR N — The view and the vanilla example

- **Display.** The ruler draws each marker as a flag with its label, and the overlay layer draws a thin line across the clips. Marker changes repaint only the ruler and the overlay layer. Steady playback still causes no static repaints.
- **Keyboard and controls.**
  - On the ruler or the clip surface, `]` and `[` seek to the next or previous marker, and `M` adds a marker at the playhead.
  - A marker navigator lists markers in order and seeks to the chosen one.
  - Rename and Remove act on the navigator's marker, and the history buttons undo either.
- **Snapping.** Snapping offers marker positions. Ties prefer the playhead, then a marker, then a neighboring clip edge, then the grid. Set `snap: { markers: false }` to opt out.
- **Example.** Both example projects start with markers, and save/reopen keeps them.

## Merge gates

| Gate                 | Evidence                                                                                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model                | Every invalid marker field is rejected with `invalid-marker`, and each case has a `@ts-expect-error` proving the type also rejects it. Markers are sorted canonically, and the field disappears when empty.                  |
| Commands and history | Add, move, update and remove work alone and inside mixed batches. Replay keeps disjoint fields, conflicts on owned ones, and rejects the removal of a modified marker. Undo, redo and reopen restore the same IDs.           |
| Reads and extent     | `markersIn`, `nextMarker` and `previousMarker` match a brute-force oracle over seeded markers. An implicit extent follows the last marker. An audio-only transport plays through silence to it and stops at it.              |
| Unchanged behavior   | The differential fuzz against the pre-marker core stays identical for projects without markers.                                                                                                                              |
| Browser              | Playwright adds a marker with `M`, steps with `]` and `[` to exact ticks, renames, removes, undoes, saves and reopens. It also keeps zero static repaints during ten seconds of playback and never restarts the music voice. |
