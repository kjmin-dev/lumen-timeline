# Headless clip editing

The `@lumen-timeline/core` workspace exposes synchronous move, trim and split commands and transaction history. Run `npm ci` at the repository root to link the workspace. The same JavaScript entry point runs in Node or a browser.

```js
import { commands, createEditor, unitsToTicks } from '@lumen-timeline/core'

const seconds = value => unitsToTicks(value, 1)
const editor = createEditor({ project: {
  schemaVersion: 1,
  duration: seconds(30),
  tracks: [{ id: 'voice', overlap: 'exclusive', accepts: ['audio'] }],
  clips: [{
    id: 'line', trackId: 'voice', kind: 'audio',
    start: seconds(12), duration: seconds(4), contentIn: seconds(1),
    takeSetId: 'recordings', activeTakeId: 'take-a',
  }],
} })

const cut = editor.dispatch(commands.splitClip({ clipId: 'line', at: seconds(14) }))
if (cut.ok) {
  const [rightId] = cut.createdIds
  editor.dispatch(commands.trimClip({ clipId: rightId, edge: 'left', delta: seconds(1) }))
  editor.dispatch(commands.moveClips({ clipIds: [rightId], delta: seconds(2) }))
  editor.history.undo()
  editor.history.redo()
}
```

In the example, the right clip initially starts at 14 s and reads the source at 3 s. Trimming one second from its left sets its timeline start to 15 s and its content offset to 4 s. Moving it two seconds later places the same source at 17 s. The left clip retains its ID and active take.

## Project and command contract

- Supply schema version 1, a tracks array and a clips array. Track and clip IDs are nonempty strings unique within their collection. Every clip has a track ID, kind, start tick, positive duration and integer content offset. The editor clones the input and preserves additional JSON fields.
- All positions use 282,240,000 ticks per second. An explicit `timebase` must match that value. Project `duration` sets a fixed exclusive end in ticks. If omitted, edits may extend to the seven-day project limit. Optional `minClipDuration` defaults to one tick. A track accepts all kinds by default. Use `accepts`, `locked` and `overlap: 'exclusive'` to constrain edits. Mixing tracks allow overlapping intervals. Two exclusive-track clips may share an edge.
- A clip with finite source handles can supply `contentBounds: { start, end }` in content ticks. Both ends of its retained content must stay within these handles. A slot without handles can extend into silence. Take IDs and JSON metadata survive edits. Move and trim preserve opaque clip extension data. Splitting a clip with extension-owned fields returns `split-policy-required` until a domain split policy is available.
- Move accepts distinct clip IDs, a signed delta and an optional destination `trackId`. It checks all selected clips in their final positions together. A left trim shifts start and content offset by the delta and subtracts it from duration. A right trim adds the delta to duration. A split takes an absolute timeline tick strictly inside the clip. Supply an optional unique `rightId` when the host owns IDs. Otherwise read the assigned ID from `createdIds`.

## Results and history

Use a command array for an atomic batch. Pass `{ history: 'ignore' }` to apply single or batched writes outside the undo stacks. Defaults, conflict recovery, durable metadata and retention limits are defined in [selective history](selective-history.md).

- `getSnapshot()` returns the immutable project with its revision. Retained snapshots remain valid after edits. Save the project as JSON and pass it to `createEditor` to reopen at the saved revision. History is local to an editor session.
- Pass `{ expectedRevision }` as a second argument to `dispatch`, or as an argument to `history.undo` or `history.redo`, to reject stale writes. A change increments the revision once and returns `ok`, `revision`, `changedIds`, `createdIds`, forward and inverse patches, and `affected.before` and `affected.after` intervals. These intervals include the vacated track on a cross-track move. A zero-delta edit with no placement change returns `unchanged: true` at the current revision.
- Each patch describes an array splice with `index`, `before` and `after` clip lists. All indices in one patch list refer to the same pre-transaction snapshot. A rejected command returns `{ ok: false, revision, code, target, reason }` and preserves both history branches. One undo reverses the complete selection move. Redo restores the exact split ID. A successful recorded edit after undo discards the previous redo branch. An ignored transaction preserves it.
- `subscribe(selector, listener)` captures the current selector result and returns an unsubscribe function. The listener receives `(value, change, snapshot)` on subsequent changes to that value, compared with `Object.is`. Choose a primitive or a retained field reference. Notifications are delivered in revision order, including edits initiated by a listener. `dispose()` releases subscriptions and history.

## Regression checks

Run `npm test` for validation, immutable snapshots, source handles, atomic selection moves, stale revisions and a 1,000-edit undo/redo trace. For the offline browser fixture, run `npx playwright install chromium` followed by `npm run verify:pcm`. It checks every rendered sample at 44.1 and 48 kHz after dispatching all four edits, each undo and each redo. The expected PCM is derived from independently specified source indices and includes silence and a second overlapping track. The real-time Chrome probe also splits and undoes through the editor. [Playback probe instructions](clock-and-wasm.md#reproduce)
