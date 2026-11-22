# Edits that replay elsewhere

**Status.** Delivered: PR X in [#25](https://github.com/kjmin-dev/lumen-timeline/pull/25) and PR Y in [#26](https://github.com/kjmin-dev/lumen-timeline/pull/26).

**User outcome.** An edit made in one editor replays in another and produces the same project, with the same IDs. Undo stops reporting a conflict when a move and a trim touched the same clip, because the two no longer write the same field. Both are groundwork for editing a project from several places at once. [Sharing plan](shared-sessions.md) · [Audit experiments](../../experiments/collab/README.md)

**Starting point.** After #24, the audit left three probes open.

- **IDs.** A command that creates a clip, a marker or a take lets the editor pick the ID. The ID is random, so the same command gives another editor a different project. Without `crypto.randomUUID` the editor counts `clip-1`, `clip-2` per session, and two sessions collide.
- **Coupled placement.** A clip stores `start`, `duration` and `contentIn`. A left trim writes all three, so it shares `start` with a move and `duration` with a right trim and a split. Undo compares the fields an edit owned, and reports a conflict between edits that do not depend on each other. Merged field by field, such pairs never give what both users meant.
- **Positional records.** A commit describes clip changes as splices at array indices. An index means something only against one snapshot, so each replay first has to find the clips again.

## PR X — Session IDs and replayable commits

- **Actor.** `createEditor({ project, actor })` names the session. Generated IDs are `<actor>-<n>`, with one counter for clips, markers and takes.
  - The counter continues from the largest `n` the project already carries for that actor, and skips an ID that is taken.
  - Without an actor the editor draws twelve random characters, from `crypto.randomUUID` or, where that is missing, from `Math.random`. The per-session `clip-1` fallback is gone.
  - Two sessions must not share an actor. A host joins its user ID with a session token.
- **Commit commands.** A commit carries `commands`: the transaction as dispatched, with every ID the editor generated written into the command. That covers a split's `rightId`, a new marker's or take's `id`, and the `newId` of a take copy.
  - Another editor at the same revision replays them to the same snapshot, whatever its own actor.
  - The list is empty for undo and redo, which replay recorded changes. PR Y gives those a form that can travel.
- **Staging.** The editor fills in IDs before staging a command, so the marker and take drafts no longer generate any.

## PR Y — Clip records by ID, replayed in content space

- **Records.** A commit reports `clipPatches` and `inverseClipPatches` as `{ id, before, after, follows? }`, the shape markers and takes already use. `undefined` means an absent clip. The index-based `patches` and `inversePatches` are removed.
  - `follows` names the clip a created clip is placed after in the project's clip array. A split places each new clip after the one it was cut from, as today. Without it the clip goes to the end.
- **Content space.** Replay compares and restores a clip's placement as three independent values: `origin = start − contentIn`, `in = contentIn` and `out = contentIn + duration`.

  | Edit        | Stored fields it writes          | Content-space fields it writes |
  | ----------- | -------------------------------- | ------------------------------ |
  | Move        | `start`                          | `origin`                       |
  | Left trim   | `start`, `duration`, `contentIn` | `in`                           |
  | Right trim  | `duration`                       | `out`                          |
  | Split, left | `duration`                       | `out`                          |

  The project format keeps `start`, `duration` and `contentIn`. The two forms convert exactly, so only the unit of ownership changes.

- **Replay rules.**
  - An update owns the content-space fields it changed and keeps the others as they are now. Undoing a left trim after an unrelated move restores `in` and leaves the clip where the move put it.
  - A removal needs the whole recorded clip, by value.
  - An addition needs a free ID.
  - The merged clip is validated again, and an exclusive-track overlap is still a conflict.
  - Adjacency in the clip array no longer matters.
- **Public helper.** `clipFieldChanges(patch)` lists the fields a clip patch changed, with placement in content space, for hosts that merge or display changes by field.
- **Consumers.** The timeline view reads `clipPatches` to decide what to redraw. Media reads `changedIds` and `affected`, which keep their meaning.

## Merge gates

| Gate             | Evidence                                                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IDs (X)          | Generated IDs follow `<actor>-<n>` across clips, markers, takes and take copies. A reopened project continues each actor's counter. Sessions without an actor differ, with and without `crypto.randomUUID`. |
| Replay (X)       | Three seeded sessions take turns at 600 random edits and forward only each commit's `commands`. Every snapshot stays identical after every edit.                                                            |
| Records (Y)      | Every edit and its undo and redo produce the same snapshots as before the change, in the existing suites and the 1,000-edit rewind. Patches carry no index.                                                 |
| Ownership (Y)    | Move with left trim, left trim with right trim, and left trim with split replay without conflict in both orders, and match the snapshot of applying both. Two edits of one edge still conflict.             |
| Unchanged (X, Y) | `npm run check` and the browser traces pass. A deliberate fault in each new rule fails a test.                                                                                                              |
