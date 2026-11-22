# Candidate takes per clip

**Status.** PR T in [#24](https://github.com/kjmin-dev/lumen-timeline/pull/24). PRs U, V and W are planned.

**User outcome.** Any host can keep several candidates for one clip slot and choose between them: a dubbing studio's generated lines, an ADR session's recorded takes, a musician's comped passes, a game's variations or a reviewer's vendor versions. A split shares the candidates with both halves, a new candidate on one half stays there, and every choice is one undoable edit that survives save and reopen. A late asynchronous result cannot overwrite newer work. [Design](../design.md#time-and-project-format) · [Milestone 3](../../ROADMAP.md#milestones)

**Starting point.** After #23, a clip stores only `activeTakeId`. The host's `TakeCatalog` maps that ID to a decoded stream and its alignment in samples, and no command changes it. The design's record table already promised "take sets" in the project, with candidate IDs, assets, streams and alignment, and a "Select take" command. The project cannot yet say which candidates a clip has, so neither the candidate list nor a regenerated half survives reopen.

## Naming

The API keeps **take** for one candidate, because recording, music, ADR and editing tools already share the word, and it reads as well for a generated or imported candidate. The interface label belongs to the host: "Version" in a review tool, "Variation" in game audio, "Alternate" in a picture edit. Words the project already uses for other things stay out: _revision_ and _version_ (document revision, text revision, schema version) and _audition_ (the preview action).

There is no separate take-set record. The candidate list is a field of the clip, and takes are shared by ID. This removes copy-on-write sharing rules: a split copies a small array, and adding to one half edits only that array.

## Document model

- **Takes.** `project.takes` holds `{ id, assetId, streamId, sourceAtContentZero, label?, extensions? }`, sorted by ID and omitted when empty. The source position is in project ticks, which divide every common sample rate from 8 to 96 kHz exactly, so the document does not depend on decoded sample rates. Other JSON fields are preserved.
- **Candidates.** `clip.takeIds` lists candidates in display order, and `clip.activeTakeId` is `null` or one of them. The list is omitted when empty.
- **Invariants.**
  - Take IDs are unique.
  - Every listed ID names a take.
  - Every take is listed by at least one clip.
  - An active take is listed.
- **Compatibility.** A clip without `takeIds` keeps the earlier contract, so existing projects and host catalogs play unchanged. Its `activeTakeId` names a host-aligned binding in `catalog.takes`. Registering that take with the same ID moves the clip to the project model.
- **Domain data.** Provenance, job IDs, ratings, language and review state live in take extensions or entity data. The core does not interpret them.

## PR T — Model, commands, expectations and planning in the core

- **Commands.** Seven commands work in any transaction.

  | Command                                                | Behavior                                                                                                   |
  | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
  | `addTake({ clipIds, take \| takeId, activate? })`      | Registers or shares a take and appends it to each clip's list. Applies it only with `activate: true`.      |
  | `selectTake({ clipId, takeId })`                       | Selects a listed take, or `null`.                                                                          |
  | `removeTake({ clipId, takeId })`                       | Removes a candidate. Rejects the active take with `active-take`.                                           |
  | `reorderTakes({ clipId, takeIds })`                    | Reorders the list to a permutation of itself.                                                              |
  | `updateTake({ takeId, label?, sourceAtContentZero? })` | Changes those fields for every clip that lists the take. The asset and stream are fixed.                   |
  | `expectClip({ clipId, fields })`                       | Rejects the transaction with `expectation-failed` unless the staged clip's fields deep-equal these values. |
  | `expectData({ scope, id, key, value })`                | The same check for an entity field.                                                                        |

- **Collection.** A take that no clip lists any more is removed in the same commit and recorded, so undo restores it. The editor keeps a reference count per take, updated from each commit's clip patches.
- **Commit results.** `takePatches` and `inverseTakePatches` follow the marker patch shape. A source-position change adds every listing clip to `changedIds` and `affected`, so the voice scheduler replans them without new transport code.
- **History.** Clip fields keep their field-level replay, so a selection and a reorder are independent. Take records reuse the marker rules through a shared record-patch module. After replay, the editor checks the references again and returns `history-conflict` rather than list a missing take or remove a listed one.
- **Planning.** `TakeCatalog` gains `streams[assetId][streamId]` for project takes; `takes` stays for host-aligned clips, and both are optional. `planAudio(range, catalog, { takeOverrides })` plays another listed take, or silence, in named clips without editing the project. A missing stream reports `unresolved-stream`. `read.takesOf(clipId)` lists a clip's candidates.

## Later PRs

- **PR U — Audition in the transports.** `transport.audition({ clipId, takeId, mode })` pauses project playback, remembers the playhead and plays one candidate, either in the mix or isolated, through `takeOverrides`. Finishing or cancelling restores the position. Applying stays a separate `selectTake`.
- **PR V — Candidates in the view.** The timeline draws a candidate count and the active take's label on each clip that has a list. A `labels` option renames "take" for the host's domain. The vanilla example gains a take panel with audition, apply, reorder and remove.
- **PR W — Generation as a plugin.** A `studio.generation` example records request snapshots in take extensions, commits results with expectations and keeps rejected results in a host job log. The milestone 3 trace edits a line, auditions and applies a take, splits, regenerates only the right half, undoes and reopens. It then checks the left clip's audio and candidates and reproduces a stale result.

## Merge gates for PR T

| Gate          | Evidence                                                                                                                                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model         | Every malformed take and candidate list is rejected with `invalid-take`, with `@ts-expect-error` where the type also rejects it. Takes sort by ID, and empty lists disappear. A snapshot reopens identically.           |
| Commands      | Each command and rejection is covered alone and in batches. Net-zero batches are `unchanged`. A split shares candidates, and a take added to the right half stays out of the left.                                      |
| History       | A seeded walk of 40 × 25 random take commands and splits keeps references exact, reopens identically at every step and returns to the first and last snapshots through full undo and redo. Replay conflicts are tested. |
| Expectations  | A stale text revision or clip field rejects the whole transaction and changes nothing. Expectations read staged values.                                                                                                 |
| Playback      | The planner reproduces the design's worked edit from a project take in ticks. An audio transport switches buffers on select and undo, and replans on a position change but not on a label change.                       |
| Compatibility | Existing projects, catalogs, media tests, PCM fixtures and browser traces pass unchanged. A deliberate fault in each new rule fails a test, except one defensive check that consistent history cannot reach.            |
