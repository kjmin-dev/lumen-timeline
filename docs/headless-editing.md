# Headless clip editing

The `@lumen-timeline/core` workspace exposes synchronous move, trim and split commands and transaction history. Run `npm ci` at the repository root to link the workspaces and build the core with tsrs. The same ES module build runs in Node or a browser, and TypeScript hosts get its declarations. The examples on this page call the core alone, so they run unchanged under every framework wrapper: a component calls `editor.dispatch` from its event handlers as the [Getting started](../apps/docs/src/content/docs/getting-started.mdx#minimal-integration) tabs do. [Watching state](#watching-state) shows each framework reading the editor.

```js
import { commands, contentAt, contentEnd, createEditor, unitsToTicks } from "@lumen-timeline/core";

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
- A clip with finite source handles can supply `contentBounds: { start, end }` in content ticks. Both ends of its retained content must stay within these handles. A slot without handles can extend into silence. A clip that plays a single stream without candidate takes can carry a direct `source: { assetId, streamId, sourceAtContentZero? }` field instead of registering a take; when a clip lists `takeIds`, `activeTakeId` takes precedence. Take IDs, optional `color`, and JSON metadata survive edits. Move and trim preserve opaque clip extension data. Splitting a clip with extension-owned fields uses the registered [plugin](#plugins) `onSplit` policy for each namespace, or returns `split-policy-required` when none is registered.
- Move accepts distinct clip IDs, a signed delta and an optional destination `trackId`. It checks all selected clips in their final positions together. A left trim shifts the start by the delta, subtracts it from duration and moves the content offset by the delta at the clip's [rate](#clip-speed). A right trim adds the delta to duration. A split names its cut either as a timeline tick strictly inside the clip, `at`, or as a point strictly between the clip's content edges, `atContent`. A move does not change the content point. Supply an optional unique `rightId` when the host owns IDs. Otherwise read the [generated ID](#generated-ids-and-replay) from `createdIds`.
- `addClip({ clip, after? })`, `removeClip({ clipId })` and `updateClip({ clipId, name?, color?, kind?, contentBounds?, source?, continuityId?, extensions? })` create, delete and update clips on unlocked tracks. In `updateClip`, `undefined` keeps a field and `null` clears an optional field. Adding a clip validates its placement, overlap policy, accepted kinds and bounds with the same rules as move and trim, and omits `id` to generate one.

## Results and history

Use a command array for an atomic batch. Pass `{ history: 'ignore' }` to apply single or batched writes outside the undo stacks. Defaults, conflict recovery, durable metadata and retention limits are defined in [selective history](selective-history.md).

- Loading checks every typed field and rejects a malformed project with an `EditError`. It rejects an invalid track name, mute, solo or gain with `invalid-track`, an invalid clip name, take or continuity ID or extensions map with `invalid-clip`, and a clip rate out of range with `invalid-rate`. A malformed take or candidate list is rejected with `invalid-take`. Content time lies within seven days of zero, like a take's source position, so a source mapping always fits a safe integer. Other JSON fields are kept unchanged.
- `getSnapshot()` returns the immutable project with its revision. Retained snapshots remain valid after edits. Save the project as JSON and pass it to `createEditor` to reopen at the saved revision. History is local to an editor session.
- Pass `{ expectedRevision }` as a second argument to `dispatch`, or as an argument to `history.undo` or `history.redo`, to reject stale writes. A change increments the revision once and returns `ok`, `revision`, `changedIds`, `createdIds`, forward and inverse clip patches, and `affected.before` and `affected.after` intervals. These intervals include the vacated track on a cross-track move. A zero-delta edit with no placement change returns `unchanged: true` at the current revision.
- `clipPatches` and `inverseClipPatches` describe each clip change as `{ id, before, after, follows? }`, where `undefined` means an absent clip. A patch that adds a clip names in `follows` the clip it is placed after in the project's clip array; a split places each new clip after the one it was cut from. `clipFieldChanges(patch)` lists what an update changed, with placement in [content space](selective-history.md#replay-against-the-current-document). A rejected command returns `{ ok: false, revision, code, target, reason }` and preserves both history branches. One undo reverses the complete selection move. Redo restores the exact split ID. A successful recorded edit after undo discards the previous redo branch. An ignored transaction preserves it.
- `subscribe(selector, listener)` captures the current selector result and returns an unsubscribe function. The listener receives `(value, change, snapshot)` on subsequent changes to that value, compared with `Object.is`. Choose a primitive or a retained field reference. Notifications are delivered in revision order, including edits initiated by a listener. `dispose()` releases subscriptions and history.

## Markers

`project.markers` holds point and region markers: `{ id, start, duration?, label?, color?, extensions? }`, with `start` and optional positive `duration` in project ticks. A point marker omits `duration` and may sit at an explicit sequence end. A region marker covers `[start, start + duration)` and stays inside an explicit sequence duration. Snapshots keep markers sorted by start and then ID, and omit the field when there are none. An implicit sequence ends at the latest clip end, point marker, or region marker end. Query overlapping region markers in O(log N + K) with `editor.read().regionsIn(range)`.

```js
editor.dispatch(
  commands.addMarker({ id: "chorus", start: seconds(30), duration: seconds(8), label: "Chorus" }),
);
editor.dispatch(commands.moveMarker({ markerId: "chorus", delta: seconds(2) }));
editor.dispatch(commands.updateMarker({ markerId: "chorus", label: "Chorus 1", duration: null }));
editor.dispatch(commands.removeMarker({ markerId: "chorus" }));
```

- **Combining.** Marker commands combine with clip, track, take and entity-data commands in one transaction.
- **Adding.** Omitting `id` [generates one](#generated-ids-and-replay).
- **Rejections.**
  - `invalid-marker`: a taken or empty ID, a non-positive or non-integer duration, or a non-string label or color.
  - `invalid-range`: a position or region end outside the sequence.
  - `invalid-delta`: a non-integer delta.
  - `missing-marker`: an unknown marker.
- **Commit results.** A commit reports `markerPatches` and `inverseMarkerPatches` as `{ id, before, after }` records, where `undefined` means absent. `changedIds` and `affected` cover clips only.
- **Undo and redo.** Replay keeps marker fields changed since an edit unless the edit owns them. Removing a marker requires the whole recorded marker to match.

## Tracks

Tracks can be created, updated, reordered and removed at runtime in the same transactional model as clips.

```js
editor.dispatch(
  commands.addTrack({ track: { id: "sfx", name: "SFX", overlap: "mix", color: "#4d908e" } }),
);
editor.dispatch(commands.updateTrack({ trackId: "sfx", mute: true, gain: 0.75 }));
editor.dispatch(commands.reorderTracks({ trackIds: ["sfx", "voice"] }));
editor.dispatch(commands.removeTrack({ trackId: "sfx", removeClips: true }));
```

- **Commands.**
  - `addTrack({ track, after? })` inserts a new track (generating an ID when omitted) optionally right after `after`.
  - `updateTrack({ trackId, name?, overlap?, locked?, accepts?, mute?, solo?, gain?, color?, extensions? })` updates track metadata, constraints or live mix fields (`undefined` keeps the field, `null` clears optional fields). Switching `overlap` to `"exclusive"` or tightening `accepts` validates existing clips on that track.
  - `removeTrack({ trackId, removeClips? })` removes an unlocked track. If the track still holds clips, pass `removeClips: true` to delete them atomically in the same transaction; otherwise it rejects with `track-not-empty`.
  - `reorderTracks({ trackIds })` applies a permutation of the project's track IDs.
- **Commit results.** Track edits report `trackPatches` and `inverseTrackPatches`, plus `trackOrder` when order changes. Live mix changes (`mute`, `solo`, `gain`) trigger active media transports to reconcile voices without dropping unrelated reservations.

## Plugins

Pass `plugins` to `createEditor({ project, plugins })` to register domain extension schemas and clip split policies per extension namespace. Build plugins with `definePlugin`:

```js
import { createEditor, definePlugin } from "@lumen-timeline/core";

const subtitles = definePlugin({
  namespace: "app.subtitles",
  version: 1,
  validate({ value }) {
    if (typeof value !== "object" || value === null || typeof value.text !== "string") {
      return "Subtitle extension must carry a text string";
    }
  },
  onSplit({ clip, left, right, value }) {
    return { left: value, right: { ...value, continued: true } };
  },
});

const editor = createEditor({ project, plugins: [subtitles] });
```

- **Validation.** `validate({ target, id, value })` runs when loading a project and on every edit that creates or updates `extensions` on a clip, track, marker or take. Returning a nonempty error string rejects the operation with `invalid-extension`.
- **Splitting.** When splitting a clip with `extensions`, every namespace present must have a registered plugin providing `onSplit`. Unregistered namespaces still reject with `split-policy-required` so missing plugins cannot silently corrupt domain data.

## Takes

A take is one candidate for a clip's slot: `{ id, assetId, streamId, sourceAtContentZero, label?, forkedFrom?, extensions? }`. The source position is in project ticks at the clip's content time zero and lies within seven days of it. `project.takes` holds every take, sorted by ID and omitted when empty. A clip lists its candidates in `takeIds`, in display order, and plays `activeTakeId`. Several clips can list one take; a split copies the list to both halves.

```js
const late = { assetId: "line-12-v3", streamId: "audio-0", sourceAtContentZero: -seconds(3) };
editor.dispatch([
  commands.expectData({ scope: "script", id: "line", key: "revision", value: 7 }),
  commands.addTake({ clipIds: [rightId], take: { id: "take-c", ...late }, activate: true }),
]);
editor.dispatch(commands.reorderTakes({ clipId: rightId, takeIds: ["take-c", "take-a"] }));
// Nudge take-a for the right half only. The left half keeps the original.
editor.dispatch(
  commands.updateTake({
    takeId: "take-a",
    clipIds: [rightId],
    newId: "take-a-right",
    sourceAtContentZero: seconds(1) / 50,
  }),
);
editor.dispatch(commands.removeTake({ clipId: rightId, takeId: "take-a-right" }));
editor.dispatch(commands.pruneTakes());
```

- **One form per state.** A clip with candidates carries both `takeIds` and `activeTakeId`, where `null` means none is active. A clip without candidates carries neither field. Loading accepts an empty list or a missing `activeTakeId` and writes this form.
- **Load rules.** Take IDs are unique, and every listed ID names a take. The active take is listed. A take that no clip lists is valid and stays until it is pruned.
- **Commands.** Take commands combine with every other command in one transaction. Commands that edit a clip's list reject a clip on a locked track with `locked-track`.
  - `addTake({ clipIds, take | takeId, activate? })` registers a new take, or shares an existing one, and appends it to each clip's list. A clip that already lists it keeps its position. It does not change the active take unless `activate` is `true`. Omitting the new take's `id` generates one.
  - `selectTake({ clipId, takeId })` accepts a listed take or `null`.
  - `removeTake({ clipId, takeId })` rejects the active take with `active-take`. Select another one first, in the same transaction if you like. The take stays in the project.
  - `reorderTakes({ clipId, takeIds })` accepts a permutation of the list.
  - `updateTake({ takeId, clipIds?, newId?, label?, sourceAtContentZero? })` changes only the fields given. A take's asset and stream are fixed; add a new take for new media.
  - `pruneTakes({ takeIds? })` removes takes that no clip lists: all of them, or the ones named. Naming a listed take rejects the command with `listed-take`. Call it before saving, and retire entity data keyed by the pruned IDs in the same transaction.
- **Updating some clips.** Without `clipIds`, `updateTake` changes the take for every clip that lists it. With `clipIds`, it changes it for those clips only. If another clip lists the take too, the take is first copied under `newId`, or a generated ID. The copy replaces the take in the named clips, at the same list position and as the active take where it was active, and records its source in `forkedFrom`. When the named clips are the only ones listing the take, it changes in place and `newId` is unused. `read.clipsListing(takeId)` tells which case applies.
- **Expectations.** `expectClip({ clipId, fields })` and `expectData({ scope, id, key, value })` compare deep JSON values at their position in the transaction, where `undefined` means absent. A difference rejects the whole transaction with `expectation-failed`. A missing clip fails the expectation too.
- **Rejections.**
  - `invalid-take`: a taken ID, a malformed take, a source position beyond seven days, a bad permutation, or `newId` without `clipIds`.
  - `missing-take`: an unknown take, or one the clip does not list.
  - `active-take` and `listed-take`: removing the active take, and pruning a listed one.
  - `invalid-expectation`: a malformed expectation.
- **Commit results.** A commit reports `takePatches` and `inverseTakePatches` as `{ id, before, after }` records. `changedIds` and `affected` also include every clip that lists a take whose source position changed, so playback replans those clips. A label change replans nothing.
- **Undo and redo.** Clip fields replay field by field and compare by value, so a selection and a reorder do not conflict. The candidate list replays by element, so two takes added at once both remain and each undo removes its own. [Replay rules](selective-history.md#replay-against-the-current-document) Take fields follow the marker rules. A take's presence follows its listings: replay skips adding a take that already exists, and skips removing one that is gone or that another clip lists by then. Replay returns `history-conflict` rather than list a take that was pruned since.

## Clip speed

A clip's optional `rate` is the content it plays per tick of timeline, from `MIN_CLIP_RATE` (0.25) to `MAX_CLIP_RATE` (4). A clip covers `duration × rate` of content from `contentIn`: at 1.25 four seconds of timeline play five seconds of content, at 0.8 they play 3.2. Content time stays the media's own time, so `contentIn`, `contentBounds`, a take's `sourceAtContentZero` and a split's `atContent` mean the same at every speed. A snapshot omits a rate of 1.

```js
// Fit the right half into three seconds, keeping its end where it is.
editor.dispatch(commands.retimeClip({ clipId: rightId, duration: seconds(3), anchor: "end" }));
// Or set the speed itself; the length follows.
editor.dispatch(commands.retimeClip({ clipId: rightId, rate: 1.1 }));
const right = editor.getSnapshot().clips.find((clip) => clip.id === rightId);
contentAt(right, right.start + seconds(1)); // The content the clip plays one second in.
contentEnd(right); // Its last content position: contentIn + duration × rate.
```

- **Retime.** `retimeClip({ clipId, rate | duration, anchor? })` keeps the content the clip covers and changes how long it takes on the timeline. Give the new `rate`, and the duration follows, or the new timeline `duration`, and the rate follows. `anchor: "start"`, the default, keeps the start and moves the end; `"end"` keeps the end and moves the start. A retime that changes nothing returns `unchanged`. Preview accepts it, as it does moves and trims, so a drag can show the result first.
- **Other edits.** A move keeps the rate. A trim moves the content edge by the delta at the clip's rate, and a split gives both halves the clip's rate, the right one starting at the content the clip played at the cut. A split recorded by `atContent` cuts the same content after another editor retimed the clip, so a shared session's replay lands where the user cut.
- **Rounding.** A timeline tick at a rate other than 1 maps to content to the nearest tick, half away from zero: `contentAt(clip, tick)` gives the exact value the editor and the planner use. Trimming the start of such a clip can therefore move its content end by one tick, 1/5880 of a sample at 48 kHz. At rate 1 every mapping is exact, as before.
- **Validation.** Loading and `addClip` accept a `rate` in range and write a rate of 1 as no field. `invalid-rate` rejects a rate out of range or not a number, a retime with both or neither of `rate` and `duration`, and a duration that would take the rate out of range. `contentBounds` applies to the content end at the clip's rate, so a trim or a retime past a handle returns `source-bounds`.
- **History.** Undo and redo restore a retime exactly. A placement with a rate is replayed as one value: the start, duration, content offset and rate of a retimed clip change together, so undoing a retime after an unrelated move of the same clip returns `history-conflict` instead of merging the two. `clipFieldChanges` reports a rate change under `fields.rate`.

How a transport plays a clip with a rate, as varispeed or time-stretched at its own pitch, is in [media transports](media-transports.md#clip-speed).

## Generated IDs and replay

A split, a new marker, a new take and a take copy each need an ID. Pass one to control it. Otherwise the editor generates `<actor>-<n>`, where `actor` names the editing session and one counter serves all four.

```js
const editor = createEditor({ project, actor: "ana.4f2c" });
const cut = editor.dispatch(commands.splitClip({ clipId: "line", at: seconds(14) }));
// cut.createdIds is ["ana.4f2c-1"], and cut.commands carries the same ID:
// [{ type: "split", clipId: "line", atContent: ..., rightId: "ana.4f2c-1" }]
otherEditor.dispatch(cut.commands);
```

- **Actor.** Give every session that edits a project its own actor, such as a user ID joined with a session token. Two sessions that share one can generate the same ID. Without an actor the editor draws twelve random characters.
- **Counter.** It continues from the largest `n` the project already carries for the actor, across clips, markers and takes, and skips an ID that is taken.
- **Commit commands.** A commit's `commands` are the transaction as dispatched, with every generated ID written in. A split is recorded by `atContent`, so an editor that replays it after a concurrent move cuts the same point of the content. Another editor at the same revision replays them to the same snapshot. They share nested values with the commands you dispatched, so treat both as immutable.
- **Undo and redo travel.** An undo or redo commit lists one `replay` command, `{ type: "replay", clipPatches, dataPatches, markerPatches, takePatches }`, holding the records it applied. Another editor, or a saved log, dispatches it like any command, and it applies under the [replay rules](selective-history.md#replay-against-the-current-document) of undo: each record owns only the fields it changed, and a record whose fields changed since rejects the whole replay with `history-conflict`. A rule its result breaks, such as an exclusive-track overlap, is reported as a conflict too. A replay forms a transaction by itself. It is parsed like a loaded project, so a malformed record from another source is refused with `invalid-replay`. Dispatched with `record`, it is one undoable edit of the editor that applied it. Commands survive JSON, where `undefined` fields are dropped.

## Replace the document

`editor.replace(snapshot)` adopts another snapshot of the same project in place. A sync layer uses it to adopt the order another participant decided, and a host uses it to load a saved revision without rebuilding its views.

```js
const result = editor.replace(savedSnapshot);
// result.history is "replace", and its patches describe the difference.
```

- **Same project.** The snapshot must have the same project `id` (if set), sequence bounds and timebase; track additions, removals, updates and reorders are diffed and adopted cleanly. Another project fails with `foreign-snapshot`, and an invalid one with the loading codes. Nothing changes on failure.
- **One notification.** Subscribers keep their subscriptions and see one commit, `history: "replace"`. Its track, clip, marker, take and data patches describe the difference, so views repaint only what changed. Its `commands` list one `replay` of that difference. An identical document returns `unchanged`.
- **Selection and history.** The selection drops clips the snapshot lacks. History stays. Its entries replay against the new document and conflict where their fields changed.
- **Revisions and IDs.** The revision moves forward: to the snapshot's revision when that is later, to the next one otherwise. The ID counter moves past every ID of the editor's actor in the snapshot and never moves back, so the IDs of a transaction that was dropped are not issued again.
- **An editor's own snapshot.** Pass the object an editor returned from `getSnapshot()`, of this editor earlier or of another one in the same realm, and the editor takes its records as they are. The snapshot was validated when it was made and nothing can change it, so the replacement shares its records and costs the difference, not the project. A JSON copy of the same snapshot is parsed and validated like a loaded project and ends in the same document. `createEditor` opens such a snapshot the same way.

To replay an edit after a replacement, as a sync layer replays its unconfirmed edits, dispatch its commands with `{ rebases: commit }`. The transaction records no entry of its own. The history entry that `commit` recorded, or moved by undo or redo, takes the transaction's records instead, so a later undo reverses what the edit did after the replay. Nothing in history changes when that entry is gone.

## Dispatch gate

`editor.setGate(gate)` installs a function that decides every validated dispatch, undo and redo before it commits. `setGate(null)` removes it.

```js
editor.setGate(({ history, commands, targets, revision }) =>
  online ? "commit" : { readOnly: "offline" },
);
```

- **What it sees.** The gate runs after validation and before any change. It receives the history kind (`record`, `ignore`, `undo` or `redo`), the commands with generated IDs written in (one `replay` for undo and redo), the revision it would commit as, and `targets`: the clip, marker and take IDs and the entity data records it changes. Unchanged and invalid transactions never reach it, and neither does `replace`.
- **Commit.** `"commit"` lets the transaction through.
- **Read-only.** `{ readOnly: reason }` rejects it with the code `read-only` and the reason as its `target`, so a view can say why, as for a viewer, a review lock or a save in progress.
- **Hold.** `"hold"` returns `{ ok: false, held: true, code: "held", commands, targets }` and changes nothing: no revision, history entry or notification. A held split's commands already name its new clip, so dispatching them later makes the same clip. A view can mark the targets pending.
- **Rules.** The gate must answer synchronously with one of these decisions. It cannot dispatch, undo, redo or replace from inside itself. An error it throws reaches the caller and nothing changes.

## Watching state

Framework panels and other hosts read the editor through one value that changes only when it should. In vanilla JavaScript that value comes from `watchEditor` and `watchSelect`; the [framework wrappers](frameworks.md) build their selectors on them. Each tab is a whole file: an inspector that shows the selected clip and its active take, with the editor from [`host.js`](../apps/docs/src/content/docs/getting-started.mdx#minimal-integration).

<!-- framework-tabs -->

**Vanilla**

```js title="inspector.js"
import { shallowEqual, watchEditor, watchSelect } from "@lumen-timeline/core";
import { editor } from "./host.js";

const inspector = watchSelect(
  watchEditor(editor),
  ({ snapshot, selection }) => {
    const clip = snapshot.clips.find((c) => c.id === selection.at(-1));
    return { clipId: clip?.id ?? null, takeId: clip?.activeTakeId ?? null };
  },
  shallowEqual,
);

// The page holds <output id="inspector"></output>.
const output = document.querySelector("#inspector");
const render = ({ clipId, takeId }) => {
  output.textContent = clipId ? `${clipId}: ${takeId}` : "No clip selected";
};
render(inspector.get());
export const stop = inspector.subscribe(() => render(inspector.get()));
```

**React**

```jsx title="Inspector.jsx"
import { shallowEqual } from "@lumen-timeline/core";
import { useEditorSelector } from "@lumen-timeline/react";
import { editor } from "./host.js";

const selected = ({ snapshot, selection }) => {
  const clip = snapshot.clips.find((c) => c.id === selection.at(-1));
  return { clipId: clip?.id ?? null, takeId: clip?.activeTakeId ?? null };
};

export function Inspector() {
  const { clipId, takeId } = useEditorSelector(editor, selected, shallowEqual);
  return <output>{clipId ? `${clipId}: ${takeId}` : "No clip selected"}</output>;
}
```

**Svelte**

```svelte title="Inspector.svelte"
<script>
  import { shallowEqual } from "@lumen-timeline/core";
  import { editorSelector } from "@lumen-timeline/svelte";
  import { editor } from "./host.js";

  const inspector = editorSelector(
    editor,
    ({ snapshot, selection }) => {
      const clip = snapshot.clips.find((c) => c.id === selection.at(-1));
      return { clipId: clip?.id ?? null, takeId: clip?.activeTakeId ?? null };
    },
    shallowEqual,
  );
</script>

<output>
  {inspector.current.clipId
    ? `${inspector.current.clipId}: ${inspector.current.takeId}`
    : "No clip selected"}
</output>
```

**SolidJS**

```jsx title="Inspector.jsx"
import { shallowEqual } from "@lumen-timeline/core";
import { createEditorSelector } from "@lumen-timeline/solid";
import { editor } from "./host.js";

export function Inspector() {
  const inspector = createEditorSelector(
    editor,
    ({ snapshot, selection }) => {
      const clip = snapshot.clips.find((c) => c.id === selection.at(-1));
      return { clipId: clip?.id ?? null, takeId: clip?.activeTakeId ?? null };
    },
    shallowEqual,
  );
  return (
    <output>
      {inspector().clipId ? `${inspector().clipId}: ${inspector().takeId}` : "No clip selected"}
    </output>
  );
}
```

**Vue**

```vue title="Inspector.vue"
<script setup>
import { shallowEqual } from "@lumen-timeline/core";
import { useEditorSelector } from "@lumen-timeline/vue";
import { editor } from "./host.js";

const inspector = useEditorSelector(
  editor,
  ({ snapshot, selection }) => {
    const clip = snapshot.clips.find((c) => c.id === selection.at(-1));
    return { clipId: clip?.id ?? null, takeId: clip?.activeTakeId ?? null };
  },
  shallowEqual,
);
</script>

<template>
  <output>
    {{ inspector.clipId ? `${inspector.clipId}: ${inspector.takeId}` : "No clip selected" }}
  </output>
</template>
```

<!-- /framework-tabs -->

Each wrapper subscribes while the component is mounted and stops when it goes. In vanilla JavaScript, call `stop()` yourself.

- **`watchEditor(editor)`** is `{ snapshot, selection, history }`. Its identity changes only when one of the three does. A commit that also prunes the selection and records history notifies once, with all three current. It subscribes to the editor only while it has listeners, and `get()` without listeners returns the current state. Stop listening before disposing the editor.
- **`watchSnapshots(source)`** does the same for any source with `snapshot()` and `subscribe(listener)`, such as a transport. A source that returns the same object until it notifies, as the media transports do, keeps the value's identity stable.
- **`watchSelect(source, select, isEqual)`** derives a field. `select` runs when the source's value changes, and listeners run only when `isEqual`, `Object.is` by default, finds the field changed. An equal field keeps its previous identity. `shallowEqual` compares arrays and plain objects one level deep.
- **Delivery.** `subscribe(listener)` returns a function that removes that listener; one function subscribed twice is two listeners. Edits made by a listener notify again, with the final state. A listener's error is reported, and the other listeners still run.

## Canonical order

Snapshots order markers by start and then ID, takes by ID, and each track's clips by start and then ID. IDs compare by UTF-16 code unit, as JavaScript's `<` does. An implementation in another language must use the same comparison to produce the same snapshot; UTF-8 byte order differs for characters outside the Basic Multilingual Plane.

## Regression checks

Run `npm test` for validation, immutable snapshots, source handles, atomic selection moves, stale revisions and a 1,000-edit undo/redo trace. For the offline browser fixture, run `npx playwright install chromium` followed by `npm run verify:pcm`. It checks every rendered sample at 44.1 and 48 kHz after dispatching all four edits, each undo and each redo. The expected PCM is derived from independently specified source indices and includes silence and a second overlapping track. The real-time Chrome probe also splits and undoes through the editor. [Playback probe instructions](clock-and-wasm.md#reproduce)

For a transient placement, call `editor.preview(moveOrTrim, { expectedRevision })`. It also accepts an ordered array of Move and Trim commands. The core stages on its private clip draft and checks final track layout with the same validator as dispatch. Success returns the current revision and immutable proposed clip records in `placements`; rejection uses the dispatch error contract. The call emits zero subscriptions and allocates no clip IDs, revisions or history entries. Revalidate with the latest revision at commit time.
