# Selective undo and redo

Use one transaction for one user intention. For example, preview a drag in session state and submit its final placement on pointer release. Put durable background results through the document API with `history: 'ignore'`. A user's undo can then restore a clip position while a newly generated take stays available. Cursor motion, playback ticks and job-progress animation belong to the host's transient session state. The examples call `@lumen-timeline/core` alone, so they run unchanged under every framework wrapper; a component calls them from its event handlers, as the [Getting started](../apps/docs/src/content/docs/getting-started.mdx#minimal-integration) tabs do.

## Public contract

```js
import { commands, createEditor } from "@lumen-timeline/core";

const editor = createEditor({ project, history: { maxEntries: 200, maxBytes: 16 * 1024 * 1024 } });
const move = commands.moveClips({ clipIds: ["line"], delta: 282240000 });
editor.dispatch(move);
editor.history.undo();

// One field update, one document revision. The user's move is still redoable.
const ignore = { history: "ignore" };
editor.dispatch(
  commands.setEntityData({
    scope: "take",
    id: "take-b",
    key: "status",
    value: "ready",
  }),
  ignore,
);

// All writes succeed together and produce a single notification.
const results = [
  commands.setEntityData({ scope: "take", id: "take-b", key: "assetId", value: "audio-42" }),
  commands.setEntityData({ scope: "asset", id: "audio-42", key: "sampleRate", value: 48000 }),
];
editor.dispatch(results, { ...ignore, expectedRevision: editor.getSnapshot().revision });
editor.history.redo();
```

| Operation                                                          | Document                    | Undo stack                         | Redo stack                         |
| ------------------------------------------------------------------ | --------------------------- | ---------------------------------- | ---------------------------------- |
| `dispatch(command)` or `dispatch(commands, { history: 'record' })` | One new revision            | Append one transaction             | Clear                              |
| `dispatch(commandOrArray, { history: 'ignore' })`                  | One new revision            | Preserve                           | Preserve                           |
| Undo                                                               | One new revision on success | Pop latest entry                   | Push the same entry                |
| Redo                                                               | One new revision on success | Push the same entry                | Pop latest entry                   |
| Rejected, empty or net-zero transaction                            | Keep the current snapshot   | Preserve                           | Preserve                           |
| `history.discard('undo' or 'redo')`, `history.clear()`             | Keep the current snapshot   | Explicitly forget selected history | Explicitly forget selected history |

Policy applies to the entire call. Arrays run synchronously in order against a private draft, so a later command can reference an explicit split child ID from an earlier command. Validate command arguments, locks, source bounds and minimum duration while staging. Check exclusive-track overlaps on the final layout, which permits atomic swaps. Repeated writes to one field collapse to its initial and final values. Check the optional expected revision before staging. An error commits zero writes and publishes zero notifications.

## What history retains

- A history entry contains forward and inverse clip patches by ID, and before/after values for touched data fields. The patches reference immutable clip records and share their nested objects. Undo and redo create fresh document revisions. Saving and reopening restores the current document with empty session history.
- Durable host data lives in `snapshot.entityData[scope][id][key]`. A key is the unit of conflict. Store independently updated values under separate keys. Values are cloned, frozen JSON. `null` is a value. `commands.removeEntityData({ scope, id, key })` removes a field and empty containers are pruned. Scope and entity IDs are host-defined.
- The entity data store is independent of clip existence. If undo removes a split child, its analysis or take-generation result stays addressable by ID. Redo restores the child with its original ID. Use stable IDs and explicitly remove metadata when retiring its underlying entity.
- The defaults are **200 transactions and an estimated 16 MiB across both stacks**. Recording a new edit clears the redo branch and evicts oldest undo entries until both limits fit. A single oversized newest transaction stays undoable in full. A zero limit disables recording. `undoDepth`, `redoDepth` and `estimatedBytes` expose the policy in use. Byte accounting estimates logical payload size, caches immutable object weights and can charge shared values multiple times. Use heap profiling to measure actual retained memory.

## Replay against the current document

1. Find each recorded clip by ID. An ignored split elsewhere changes no ID, so it does not affect the entry.
2. For a retained clip, compare the current values of the fields the edit owned with their expected values, then restore only those fields. Use a value precondition for each touched host-data key. JSON equality is independent of property order and of object identity.
3. Compare placement in content space, where edits own separate values.
   - `origin` is where content time zero sits on the timeline: `start − contentIn`. A move owns it.
   - `in` is the left content edge, `contentIn`. A left trim owns it.
   - `out` is the right content edge, `contentIn + duration`. A right trim and the left half of a split own it.

   Undoing a left trim after an unrelated move therefore restores the edge and leaves the clip where the move put it. Two edits of the same value still conflict.

   A clip with a [rate](headless-editing.md#clip-speed) other than 1, before, after or now, rounds between timeline and content positions, so its placement is one value: start, duration, content offset and rate. An edit that changed it conflicts with any other change to it since.

   A candidate list replays by element. An edit owns the takes it added, removed or moved in `takeIds`, and every other element stays where it is now. Undoing an added take after another take was added meanwhile removes only its own. A removed take that is already gone stays gone, and an owned take goes back after its nearest predecessor in the edit's list that the clip still holds. The active take is one value: two selections conflict. A clip with no candidates replays as an empty list and no active take, and a list that empties drops both fields.

4. Undoing a split also removes the clips it added. Each must equal its recorded clip by value. Redo checks that the required new IDs are available, and places each clip after the one it followed.
5. Recheck sequence, source and track overlap constraints on the merged result.
6. If a field was superseded, a clip is missing or changed, or an exclusive interval would overlap, return `history-conflict` with the target and reason. Both stacks and the document stay intact. The host can resolve the conflict and retry, explicitly discard that entry or clear history when replacing a project. This is value-checked session history. Concurrent multi-user text or sequence merging would need a separate reconciliation layer.

An undo or redo commit lists the records it applied as one `replay` command. `commands.replay(records)` applies records under these same rules in any editor, so undo and redo can travel to another editor or a saved log. [Replay commands](headless-editing.md#generated-ids-and-replay)

The policy follows selective capture by origin in Yjs, replay of history across excluded transactions in ProseMirror, and transaction grouping and bounded history in Qt. Here the mapping uses timeline entity IDs, field preconditions and exact clip boundaries. [Yjs UndoManager](https://docs.yjs.dev/api/undo-manager) · [ProseMirror history implementation](https://github.com/ProseMirror/prosemirror-history/blob/master/src/history.ts) · [Qt undo stack](https://doc.qt.io/qt-6/qundostack.html)

## Rendering and playback consequences

One successful batch publishes one immutable snapshot and change result. `result.history` identifies record, ignore, undo or redo. Clip changes publish patches by clip ID and old/new track intervals. Host-data changes publish `dataPatches` and `inverseDataPatches` with scope, ID, key and before/after values. A missing before or after value represents field absence.

A metadata-only transaction preserves the clip array and track indexes, emits empty geometry intervals and does no clip scan. Document selectors still evaluate once per revision. A clip panel using a stable selector receives no callback when its value is unchanged. A status panel can subscribe directly to its take field. Changes affecting playback through a host plugin can use the data patch keys to invalidate that plugin's derived plan. Placement edits reuse the ID index when array positions are stable. Publishing a new flat clip array still takes work proportional to its length.

Use `editor.history.subscribe(listener)` for toolbar controls. The listener receives undo depth, redo depth and estimated bytes after a stack change, including discard or clear. Ignored writes leave this channel idle. Both channels support unsubscription and emit coherent, ordered notifications under reentrant edits.

The regression suite covers grouped swaps and splits, undo after index shifts, same-field and exclusive-track conflicts, pending redo during a background update, limit eviction and a 1,000-field metadata transaction. The offline browser fixture also moves a separate audio source in an ignored batch, then checks every rendered sample and the retained take status across redo and undo. [Headless editing checks](headless-editing.md#regression-checks)
