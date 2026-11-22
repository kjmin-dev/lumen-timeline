# Collaboration experiments

These scripts back the design audit of November 2026 and the plans that followed it. Run `npm run build` first; each script then runs with `node`.

| Script               | Question                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `audit.mjs`          | What does the core do in eleven situations that make undo or merging hard?                            |
| `field-merge.mjs`    | Do two edits made against the same base merge field by field into what both users meant?              |
| `ordered-replay.mjs` | Do three editors converge when one sequencer orders their commands and each replays the accepted log? |

## `audit.mjs`

Each line is one probe. The table records what each showed when the audit ran and what resolved it.

| Probe | At the audit                                                     | Now                                                                                               |
| ----- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1     | Undoing a left trim conflicts after an unrelated move            | Resolved: replay owns placement in content space, where a trim and a move write different values. |
| 2     | A list equal by value but not by identity conflicts              | Resolved: fields compare by value.                                                                |
| 3     | Undoing an added take conflicts after another take was added     | Resolved: a candidate list replays by element.                                                    |
| 4     | Undo kept a field it had to remove, or reported a false conflict | Resolved: replay owns the fields an edit removed.                                                 |
| 5     | "No active take" had two spellings                               | Resolved: a clip carries both candidate fields or neither.                                        |
| 6     | A new take under an old ID inherited its entity data             | Resolved: takes stay until pruned, so the ID is taken. Prune and retire data together.            |
| 7     | Fallback IDs repeat across editors, and default IDs are random   | Resolved: IDs carry a session actor, and a commit's `commands` name every generated ID.           |
| 8     | An unusable source position was accepted and failed at playback  | Resolved: positions and content time stay within seven days.                                      |
| 9     | Undoing an added take failed once another clip listed it         | Resolved: a take's presence follows its listings.                                                 |
| 10    | Canonical order follows UTF-16 code units, not UTF-8 bytes       | Documented in the headless editing guide.                                                         |
| 11    | `expectedRevision` rejects an edit after any unrelated change    | Use `expectClip` and `expectData` to guard only what an edit depends on.                          |

## `field-merge.mjs`

For pairs of edits whose meaning does not depend on their order, the script merges their field writes and compares the result with applying both commands. `clash` counts pairs that wrote the same field, and `merged` counts pairs whose merge matched.

With the stored fields, a left trim writes `start`, `duration` and `contentIn`, so it clashes with a move, a right trim and a split, and no merge is right. In content space a move writes only `origin`, a left trim only `in` and a right trim only `out`: these pairs never clash and always merge correctly. Two edits of the same edge clash in both forms, as they should. History replay now compares placement in content space, and `clipFieldChanges(patch)` reports a clip patch in the same terms.

## `ordered-replay.mjs`

Three editors each send one command per round that is valid against their own view. A sequencer, here just another headless editor, applies the round in an arbitrary order and rejects what no longer fits. Every editor replays the accepted commands. Pass a round count as the first argument; the default is 600.

The run reports how many commands the ordering rejected, how many rounds left an editor different from the sequencer, and how many left an overlap on the exclusive track. Both of the last two must be zero, and the script exits with an error otherwise. Every command names the IDs it creates, which is what makes the replay exact.
