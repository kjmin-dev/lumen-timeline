# Candidate takes per clip

**Status.** PR T delivered in [#24](https://github.com/kjmin-dev/lumen-timeline/pull/24) and PR U in [#28](https://github.com/kjmin-dev/lumen-timeline/pull/28). PRs V and W are planned.

**User outcome.** Any host can keep several candidates for one clip slot and choose between them: a dubbing studio's generated lines, an ADR session's recorded takes, a musician's comped passes, a game's variations or a reviewer's vendor versions. A split shares the candidates with both halves, a new candidate on one half stays there, and every choice is one undoable edit that survives save and reopen. A late asynchronous result cannot overwrite newer work. [Design](../design.md#time-and-project-format) · [Milestone 3](../../ROADMAP.md#milestones)

**Starting point.** After #23, a clip stores only `activeTakeId`. The host's catalog maps that ID to a decoded stream and its alignment in samples, and no command changes it. The design's record table already promised "take sets" in the project, with candidate IDs, assets, streams and alignment, and a "Select take" command. The project cannot yet say which candidates a clip has, so neither the candidate list nor a regenerated half survives reopen.

## Naming

The API keeps **take** for one candidate, because recording, music, ADR and editing tools already share the word, and it reads as well for a generated or imported candidate. The interface label belongs to the host: "Version" in a review tool, "Variation" in game audio, "Alternate" in a picture edit. Words the project already uses for other things stay out: _revision_ and _version_ (document revision, text revision, schema version) and _audition_ (the preview action).

There is no separate take-set record. The candidate list is a field of the clip, and takes are shared by ID. A split copies a small array, and adding to one half edits only that array.

## Document model

- **Takes.** `project.takes` holds `{ id, assetId, streamId, sourceAtContentZero, label?, forkedFrom?, extensions? }`, sorted by ID and omitted when empty. Other JSON fields are preserved.
  - The source position is in project ticks, which divide every common sample rate from 8 to 96 kHz exactly, so the document does not depend on decoded sample rates.
  - It lies within seven days of content time zero. Content time has the same bound, so a source mapping always fits a safe integer and an edit cannot store a position that planning would reject.
- **Candidates.** `clip.takeIds` lists candidates in display order, and `clip.activeTakeId` names the one that plays.
- **One form per state.** A clip with candidates carries both fields, with `null` for no active take. A clip without candidates carries neither. Two documents that mean the same are the same JSON.
- **Invariants.**
  - Take IDs are unique.
  - Every listed ID names a take.
  - An active take is listed.
- **Retention.** A take that no clip lists stays in the project until `pruneTakes` removes it. Deleting a take as a side effect of unlisting it would freeze a derived fact into history: an undo would then fail whenever another clip had started to use the take. Retention also keeps a concurrent unlisting and selection from racing.
- **One contract.** Every clip plays project takes. The earlier contract, in which `activeTakeId` named a host-aligned catalog binding, is gone, along with the silent switch between the two when a list became empty. To migrate, give each such clip `takeIds: [activeTakeId]`, add a take per ID with the binding's asset, stream and position in ticks, and key the catalog by asset.
- **Domain data.** Provenance, job IDs, ratings, language and review state live in take extensions or entity data. The core does not interpret them.

## PR T — Model, commands, expectations and planning in the core

- **Commands.** Eight commands work in any transaction.

  | Command                                                                  | Behavior                                                                                                   |
  | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
  | `addTake({ clipIds, take \| takeId, activate? })`                        | Registers or shares a take and appends it to each clip's list. Applies it only with `activate: true`.      |
  | `selectTake({ clipId, takeId })`                                         | Selects a listed take, or `null`.                                                                          |
  | `removeTake({ clipId, takeId })`                                         | Removes a candidate. Rejects the active take with `active-take`.                                           |
  | `reorderTakes({ clipId, takeIds })`                                      | Reorders the list to a permutation of itself.                                                              |
  | `updateTake({ takeId, clipIds?, newId?, label?, sourceAtContentZero? })` | Changes those fields. The asset and stream are fixed.                                                      |
  | `pruneTakes({ takeIds? })`                                               | Removes the takes that no clip lists, or the named ones. Rejects a listed take with `listed-take`.         |
  | `expectClip({ clipId, fields })`                                         | Rejects the transaction with `expectation-failed` unless the staged clip's fields deep-equal these values. |
  | `expectData({ scope, id, key, value })`                                  | The same check for an entity field.                                                                        |

- **Updating some clips.** After a split, both halves list the same takes, and an edit to one half must not reach the other. `updateTake` with `clipIds` applies to those clips only.
  - If another clip lists the take, the take is copied first. The copy replaces it in the named clips, at the same list position and as the active take where it was active, and records its source in `forkedFrom`.
  - If the named clips are the only ones listing it, the take changes in place.
  - Whether a take is shared is a fact of the document: the clips that list it, which `read.clipsListing(takeId)` returns. No flag records it.
- **Commit results.** `takePatches` and `inverseTakePatches` follow the marker patch shape. A source-position change adds every listing clip to `changedIds` and `affected`, so the voice scheduler replans them without new transport code.
- **History.**
  - Clip fields keep their field-level replay and compare by value, so a selection and a reorder are independent. Replay also owns the fields an edit removed.
  - Take records reuse the marker rules through a shared record-patch module.
  - A take's presence follows its listings. Replay skips adding a take that already exists, and skips removing one that is gone or that another clip lists by then.
  - After replay, the editor checks the references again and returns `history-conflict` rather than list a pruned take.
- **Planning.** A `StreamCatalog` is `{ version, streams }`, with `streams[assetId][streamId]` giving the asset version, sample rate and available samples.
  - `planAudio(range, catalog, { takeOverrides })` plays another of a clip's candidates, or silence, without editing the project.
  - A missing stream reports `unresolved-stream`, and a malformed one `invalid-stream`.
  - `read.takesOf(clipId)` lists a clip's candidates.
- **Canonical order.** The guides now state that IDs compare by UTF-16 code unit, so an implementation in another language can produce the same snapshot.

## Later PRs

- **PR U — Audition in the transports.** `transport.audition({ clipId, takeId, mode })` pauses project playback, remembers the playhead and plays one candidate, either in the mix or isolated, through `takeOverrides`. Finishing or cancelling restores the position. Applying stays a separate `selectTake`.
  - _Delivered._ Isolation is a plan option, `isolate`, that ignores mute and solo but keeps the track's gain. The scheduler stops every voice at the clip's end, so the mix does not run past it. An edit that removes the clip, moves an edge or unlists the take cancels the audition. [Audition guide](../media-transports.md#audition)
- **PR V — Candidates in the view.** The timeline draws a candidate count and the active take's label on each clip that has a list. A `labels` option renames "take" for the host's domain. The vanilla example gains a take panel with audition, apply, reorder and remove.
- **PR W — Generation as a plugin.** A `studio.generation` example records request snapshots in take extensions, commits results with expectations and keeps rejected results in a host job log. The milestone 3 trace edits a line, auditions and applies a take, splits, regenerates only the right half, undoes and reopens. It then checks the left clip's audio and candidates and reproduces a stale result.

## Merge gates for PR T

| Gate         | Evidence                                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model        | Every malformed take and candidate list is rejected with `invalid-take`, with `@ts-expect-error` where the type also rejects it. Takes sort by ID, each clip state has one JSON form, and a snapshot reopens identically. |
| Commands     | Each command and rejection is covered alone and in batches. Net-zero batches are `unchanged`. A split shares candidates, and a take added to or updated for the right half stays out of the left.                         |
| History      | A seeded walk of 40 × 30 random take commands and splits keeps references exact, reopens identically at every step and returns to the first and last snapshots through full undo and redo. Replay conflicts are tested.   |
| Expectations | A stale text revision or clip field rejects the whole transaction and changes nothing. Expectations read staged values.                                                                                                   |
| Playback     | The planner reproduces the design's worked edit from a project take in ticks. An audio transport switches buffers on select and undo, and replans on a position change but not on a label change.                         |
| Migration    | Every project, catalog, test, PCM fixture, example and browser trace uses project takes and passes. The clock probe applies a fresh take to the right half of a split instead of swapping the catalog.                    |
| Fault checks | A deliberate fault in each new rule fails a test, except two reference checks that the editor's own records cannot reach and that guard the invariants themselves.                                                        |
