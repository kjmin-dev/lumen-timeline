# Headless clip editing

The `@lumen-timeline/core` workspace exposes synchronous move, trim and split commands and transaction history. Run `npm ci` at the repository root to link the workspaces and build the core with tsrs. The same ES module build runs in Node or a browser, and TypeScript hosts get its declarations.

```js
import { commands, createEditor, unitsToTicks } from "@lumen-timeline/core";

const seconds = (value) => unitsToTicks(value, 1);
const editor = createEditor({
  project: {
    schemaVersion: 1,
    duration: seconds(30),
    tracks: [{ id: "voice", overlap: "exclusive", accepts: ["audio"] }],
    clips: [
      {
        id: "line",
        trackId: "voice",
        kind: "audio",
        start: seconds(12),
        duration: seconds(4),
        contentIn: seconds(1),
        takeIds: ["take-a"],
        activeTakeId: "take-a",
      },
    ],
    takes: [{ id: "take-a", assetId: "recording", streamId: "audio-0", sourceAtContentZero: 0 }],
  },
});

const cut = editor.dispatch(commands.splitClip({ clipId: "line", at: seconds(14) }));
if (cut.ok) {
  const [rightId] = cut.createdIds;
  editor.dispatch(commands.trimClip({ clipId: rightId, edge: "left", delta: seconds(1) }));
  editor.dispatch(commands.moveClips({ clipIds: [rightId], delta: seconds(2) }));
  editor.history.undo();
  editor.history.redo();
}
```

In the example, the right clip initially starts at 14 s and reads the source at 3 s. Trimming one second from its left sets its timeline start to 15 s and its content offset to 4 s. Moving it two seconds later places the same source at 17 s. The left clip retains its ID and active take, and both clips list `take-a`.

## Project and command contract

- Supply schema version 1, a tracks array and a clips array. Track and clip IDs are nonempty strings unique within their collection. Every clip has a track ID, kind, start tick, positive duration and integer content offset. The editor clones the input and preserves additional JSON fields.
- All positions use 282,240,000 ticks per second. An explicit `timebase` must match that value. Project `duration` sets a fixed exclusive end in ticks. If omitted, edits may extend to the seven-day project limit. Optional `minClipDuration` defaults to one tick. A track accepts all kinds by default. Use `accepts`, `locked` and `overlap: 'exclusive'` to constrain edits. Mixing tracks allow overlapping intervals. Two exclusive-track clips may share an edge.
- A clip with finite source handles can supply `contentBounds: { start, end }` in content ticks. Both ends of its retained content must stay within these handles. A slot without handles can extend into silence. Take IDs and JSON metadata survive edits. Move and trim preserve opaque clip extension data. Splitting a clip with extension-owned fields returns `split-policy-required` until a domain split policy is available.
- Move accepts distinct clip IDs, a signed delta and an optional destination `trackId`. It checks all selected clips in their final positions together. A left trim shifts start and content offset by the delta and subtracts it from duration. A right trim adds the delta to duration. A split takes an absolute timeline tick strictly inside the clip. Supply an optional unique `rightId` when the host owns IDs. Otherwise read the assigned ID from `createdIds`.

## Results and history

Use a command array for an atomic batch. Pass `{ history: 'ignore' }` to apply single or batched writes outside the undo stacks. Defaults, conflict recovery, durable metadata and retention limits are defined in [selective history](selective-history.md).

- Loading checks every typed field and rejects a malformed project with an `EditError`. It rejects an invalid track name, mute, solo or gain with `invalid-track`, and an invalid clip name, take or continuity ID or extensions map with `invalid-clip`. A malformed take or candidate list is rejected with `invalid-take`. Other JSON fields are kept unchanged.
- `getSnapshot()` returns the immutable project with its revision. Retained snapshots remain valid after edits. Save the project as JSON and pass it to `createEditor` to reopen at the saved revision. History is local to an editor session.
- Pass `{ expectedRevision }` as a second argument to `dispatch`, or as an argument to `history.undo` or `history.redo`, to reject stale writes. A change increments the revision once and returns `ok`, `revision`, `changedIds`, `createdIds`, forward and inverse patches, and `affected.before` and `affected.after` intervals. These intervals include the vacated track on a cross-track move. A zero-delta edit with no placement change returns `unchanged: true` at the current revision.
- Each patch describes an array splice with `index`, `before` and `after` clip lists. All indices in one patch list refer to the same pre-transaction snapshot. A rejected command returns `{ ok: false, revision, code, target, reason }` and preserves both history branches. One undo reverses the complete selection move. Redo restores the exact split ID. A successful recorded edit after undo discards the previous redo branch. An ignored transaction preserves it.
- `subscribe(selector, listener)` captures the current selector result and returns an unsubscribe function. The listener receives `(value, change, snapshot)` on subsequent changes to that value, compared with `Object.is`. Choose a primitive or a retained field reference. Notifications are delivered in revision order, including edits initiated by a listener. `dispose()` releases subscriptions and history.

## Markers

`project.markers` holds point markers: `{ id, start, label?, color?, extensions? }`, with `start` in project ticks. A marker may sit at an explicit sequence end. Snapshots keep markers sorted by start and then ID, and omit the field when there are none. An implicit sequence ends at the later of its last clip end and its last marker.

```js
editor.dispatch(commands.addMarker({ id: "chorus", start: seconds(30), label: "Chorus" }));
editor.dispatch(commands.moveMarker({ markerId: "chorus", delta: seconds(2) }));
editor.dispatch(commands.updateMarker({ markerId: "chorus", label: "Chorus 1" }));
editor.dispatch(commands.removeMarker({ markerId: "chorus" }));
```

- **Combining.** Marker commands combine with clip and entity-data commands in one transaction.
- **Adding.** Omitting `id` generates one.
- **Rejections.**
  - `invalid-marker`: a taken or empty ID, or a non-string label or color.
  - `invalid-range`: a position outside the sequence.
  - `invalid-delta`: a non-integer delta.
  - `missing-marker`: an unknown marker.
- **Commit results.** A commit reports `markerPatches` and `inverseMarkerPatches` as `{ id, before, after }` records, where `undefined` means absent. `changedIds` and `affected` cover clips only.
- **Undo and redo.** Replay keeps marker fields changed since an edit unless the edit owns them. Removing a marker requires the whole recorded marker to match.

## Takes

A take is one candidate for a clip's slot: `{ id, assetId, streamId, sourceAtContentZero, label?, extensions? }`, with the source position in project ticks at the clip's content time zero. `project.takes` holds every take, sorted by ID and omitted when empty. A clip lists its candidates in `takeIds`, in display order, and plays `activeTakeId`, which is `null` or one of them. Several clips can list one take; a split copies the list to both halves.

```js
const late = { assetId: "line-12-v3", streamId: "audio-0", sourceAtContentZero: -seconds(3) };
editor.dispatch([
  commands.expectData({ scope: "script", id: "line", key: "revision", value: 7 }),
  commands.addTake({ clipIds: [rightId], take: { id: "take-c", ...late }, activate: true }),
]);
editor.dispatch(commands.reorderTakes({ clipId: rightId, takeIds: ["take-c", "take-a"] }));
editor.dispatch(commands.updateTake({ takeId: "take-c", label: "Approved" }));
editor.dispatch(commands.selectTake({ clipId: rightId, takeId: "take-a" }));
editor.dispatch(commands.removeTake({ clipId: rightId, takeId: "take-c" }));
```

- **Load rules.** Take IDs are unique. Every listed ID names a take, and every take is listed by at least one clip. An empty list is omitted. A clip without `takeIds` keeps the earlier contract: its `activeTakeId` names a binding in the host's catalog.
- **Commands.** Take commands combine with every other command in one transaction.
  - `addTake({ clipIds, take | takeId, activate? })` registers a new take, or shares an existing one, and appends it to each clip's list. A clip that already lists it keeps its position. It does not change the active take unless `activate` is `true`. Omitting the new take's `id` generates one.
  - `selectTake({ clipId, takeId })` accepts a listed take or `null`.
  - `removeTake({ clipId, takeId })` rejects the active take with `active-take`. Select another one first, in the same transaction if you like.
  - `reorderTakes({ clipId, takeIds })` accepts a permutation of the list.
  - `updateTake({ takeId, label?, sourceAtContentZero? })` changes only the fields given. A take's asset and stream are fixed; add a new take for new media.
  - Clip commands reject a clip on a locked track with `locked-track`.
- **Collection.** A take that no clip lists any more leaves the project in the same commit, and undo restores it. Add and remove in one transaction is `unchanged`.
- **Expectations.** `expectClip({ clipId, fields })` and `expectData({ scope, id, key, value })` compare deep JSON values at their position in the transaction, where `undefined` means absent. A difference rejects the whole transaction with `expectation-failed`. A missing clip fails the expectation too.
- **Rejections.** `invalid-take` for a taken ID, a malformed take, a bad permutation or an active take missing from a new list; `missing-take` for an unknown or unlisted take; `active-take`; `invalid-expectation` for a malformed expectation.
- **Commit results.** A commit reports `takePatches` and `inverseTakePatches` as `{ id, before, after }` records. `changedIds` and `affected` also include every clip that lists a take whose source position changed, so playback replans those clips. A label change replans nothing.
- **Undo and redo.** Clip fields replay field by field, so a selection and a reorder do not conflict. Take fields follow the marker rules. Replay also returns `history-conflict` rather than list a missing take or remove a listed one.

## Regression checks

Run `npm test` for validation, immutable snapshots, source handles, atomic selection moves, stale revisions and a 1,000-edit undo/redo trace. For the offline browser fixture, run `npx playwright install chromium` followed by `npm run verify:pcm`. It checks every rendered sample at 44.1 and 48 kHz after dispatching all four edits, each undo and each redo. The expected PCM is derived from independently specified source indices and includes silence and a second overlapping track. The real-time Chrome probe also splits and undoes through the editor. [Playback probe instructions](clock-and-wasm.md#reproduce)

For a transient placement, call `editor.preview(moveOrTrim, { expectedRevision })`. It also accepts an ordered array of Move and Trim commands. The core stages on its private clip draft and checks final track layout with the same validator as dispatch. Success returns the current revision and immutable proposed clip records in `placements`; rejection uses the dispatch error contract. The call emits zero subscriptions and allocates no clip IDs, revisions or history entries. Revalidate with the latest revision at commit time.
