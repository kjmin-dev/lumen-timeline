# Share one project between editors

**Status.** Planned. This document is the proposal; no implementation PR is open.

**User outcome.** A project edits the same with or without a network. When a host connects two or more editors, each sees the others' edits within a moment, keeps their own undo and ends on the same project as the others. A rule the editor enforces alone, such as no overlap on an exclusive track or no edit on a locked one, still holds with several editors. Nothing in this requires a server. [Audit experiments](../../experiments/collab/README.md) · [Replayable edits](replayable-edits.md)

## Scope

This is a minimal capability of an open-source library, not a hosted service.

- **The core stays complete alone.** Editing, undo, playback and saving work with no sync code loaded, as they do now. Sync is a separate package that a host may add.
- **No server is assumed.** The role that orders edits is a plain object over the core. A host can run it in a server, in one of the open pages, in a shared worker or in a test. The package ships no server and no network code.
- **The host owns transport, storage and identity.** The package exchanges JSON messages through a two-function interface and reports what happened. Authentication, permissions beyond document rules, persistence and deployment stay with the host.
- **Losing the connection never blocks editing.** A disconnected editor keeps editing locally and sends its edits when it reconnects.

## Starting point

After #26 the core already has most of what a shared session needs.

- **Deterministic commands.** The headless core runs the same in Node and in a browser. A commit's `commands` name every generated ID, so another editor at the same revision replays them to the same snapshot. A seeded test runs three sessions through 600 edits this way.
- **Scoped guards.** `expectClip` and `expectData` reject a transaction when the values it depended on changed, without the project-wide `expectedRevision`.
- **Records by ID.** Clip, marker, take and data changes are keyed by ID. Replay owns the fields an edit changed, with clip placement in content space, so unrelated edits of one clip do not conflict.
- **Session state apart.** Selection and the transport's position are not in the document.

What is missing is everything between two editors: an order for concurrent edits, a way for an editor to adopt that order, and a form in which undo can travel.

## Approach: one participant orders commands

Each editor applies its own edits at once and sends their commands to a **sequencer**. The sequencer is a headless editor of its own. It applies commands in the order they arrive, rejects the ones that no longer fit, and announces the accepted ones. Every editor replays that sequence and puts its unconfirmed edits back on top.

- **Why a single order.** Some of this editor's rules cannot survive a merge of two valid states: two clips moved to the same place on an exclusive track are each valid alone. Rules of this kind need one participant to decide, or have to be relaxed and repaired after a merge. [Coordination avoidance](https://arxiv.org/abs/1402.2237) gives the general condition; that overlap and lock rules fall under it is this plan's reading. The deciding participant does not have to be a server.
- **Why commands and not field values.** Figma's property-level last-writer-wins, decided by server arrival order, is the closest published design for a design tool, and it merges values. [Figma's multiplayer](https://madebyevan.com/figma/how-figmas-multiplayer-technology-works/) A timeline's edits are mostly relative: a move by a delta, a trim by a delta, a split at a point. Replaying the command against the current state keeps both edits where merging two values would keep one.
- **Prior art for the loop.** Replicache describes the same cycle: optimistic local mutation, authoritative replay, and a rebase of pending mutations on the client. It also requires IDs to be passed into mutators, as `commands` now does. [How Replicache works](https://doc.replicache.dev/concepts/how-it-works)
- **Measured on this core.** `experiments/collab/server-order.mjs` lets three editors each send a locally valid command per round and replays the sequencer's log everywhere. Over 1,200 rounds the sequencer accepted 3,597 of 3,600 commands, no round left an editor different from it, and none left an overlap.

A merge with no deciding participant at all, as in a pure CRDT, is outside this plan. It needs every rule above turned into a repair step.

## Where the sequencer runs

The same sequencer object serves each arrangement. The host picks one.

| Arrangement          | Sequencer runs in                    | Typical transport        | Notes                                                                     |
| -------------------- | ------------------------------------ | ------------------------ | ------------------------------------------------------------------------- |
| Alone                | nowhere                              | none                     | Today's editor. Sync is not loaded.                                       |
| Pages of one browser | a `SharedWorker` or one elected page | `BroadcastChannel`       | No network. A page elected with the Web Locks API hands over when closed. |
| Peers                | one peer, chosen by the host         | WebRTC data channel      | The host decides who leads and what happens when the leader leaves.       |
| Host server          | the host's process                   | WebSocket, HTTP or other | The host wraps the sequencer in its own server and storage.               |

When the sequencer changes, the new one starts from the highest revision any editor reports. Entries never differ between editors, since one sequencer issued them, so the longest confirmed log is complete up to its end. Each entry names its actor and sequence number, so the new sequencer rebuilds the per-actor counts it needs to ignore a resent transaction from the log itself.

## Protocol

Messages are JSON values. A transport is `{ send(message), onMessage(listener) }`.

| Message    | From      | Carries                                              | Meaning                                                                   |
| ---------- | --------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| `hello`    | editor    | project ID, last revision seen, actor when rejoining | Join, or rejoin after a disconnect.                                       |
| `snapshot` | sequencer | actor, project snapshot at revision `r`              | Start from here, under this actor.                                        |
| `submit`   | editor    | actor, sequence number `n`, commands                 | One local transaction.                                                    |
| `accepted` | sequencer | revision `r`, actor, `n`, commands                   | The transaction is entry `r` of the shared history. Sent to every editor. |
| `rejected` | sequencer | actor, `n`, code, target, reason                     | The transaction did not fit. Sent to its author.                          |
| `presence` | any       | actor, selection, playhead, any host fields          | Not ordered, not stored, last value wins.                                 |

- **Actors.** The sequencer issues a session's actor on its first `hello`, so two pages of one user never share one and their generated IDs cannot collide. A rejoin presents the actor again, which lets the sequencer recognise a resent transaction.
- **Exactly once.** The sequencer remembers the last sequence number it processed per actor. A resent `submit` is answered again and not applied twice. This matters because a move by a delta is not idempotent.
- **Order.** `accepted` messages carry consecutive revisions. An editor that sees a gap rejoins with `hello`. The sequencer answers a rejoin with the `accepted` entries after the editor's revision while it still holds them, and with a `snapshot` otherwise.
- **Validation.** The sequencer applies commands with the core, under the same rules as any editor. An optional host callback may reject a transaction for its own reasons, such as who may edit which track. The package defines no users or roles.

## Editor reconciliation

A connected editor keeps two documents: the confirmed one, which only sequencer messages change, and the visible one, which also shows its pending transactions.

1. A local edit applies to the visible document, joins the pending queue with the next sequence number, and is submitted when connected.
2. On `accepted` from another actor, the editor applies the commands to the confirmed document, resets the visible document to it and replays the pending queue without recording it in history a second time. A pending transaction that no longer applies is dropped and reported to the host.
3. On `accepted` for its own transaction, the editor applies it to the confirmed document and removes it from the queue. The visible document already shows it.
4. On `rejected`, the editor removes the transaction, rebuilds the visible document as in step 2 and reports the rejection.

Subscribers of the visible editor see one commit per step, with the usual `changedIds` and `affected`, so the timeline view and the transports need no change. Disconnecting the sync package leaves the visible editor as an ordinary editor.

## What the core still needs

Each item is useful without sync, and none adds a dependency or network code to the core.

- **Replace the document in place.** Step 2 needs `editor.replace(snapshot)`: adopt another snapshot of the same project while keeping subscriptions, pruning the selection, and notifying once. A host also uses it to load a saved revision without rebuilding its views.
  - Local undo history stays. Its entries are records by ID that replay against whatever the document now holds, and conflict where their fields changed.
  - A replayed pending transaction replaces the records of its history entry. Undo then reverses what the edit did after the rebase, not what it did before.
  - The ID counter never moves back across a replacement, so a dropped transaction's IDs are not issued again.
- **Undo that travels.** A commit from undo or redo has no commands. A `replay` command carrying clip, marker, take and data patches would apply them under the existing value-checked replay rules. An undo commit then lists one `replay` command, which another editor or a saved log can apply like any other.
- **Split at a content position.** `splitClip({ at })` names a timeline tick. After a concurrent move the same tick is another point in the clip, or outside it. An `atContent` form names the point in the clip's own content time, which a move does not change.
- **Candidate lists by element.** A clip's `takeIds` is one value, so undoing an added take conflicts after another take was added (audit probe 3). Replay should own the elements an edit added, removed or moved. Local undo benefits as much as sharing does.

## Outside the document

- **Presence.** Selection, playhead and audition state travel as `presence`. Each editor draws the others' from the last message.
- **Text.** Script lines and translations that two people type into at once need a text merge. Entity data replaces whole values. A field declared as text should delegate to a text CRDT. The field `type` in the plugin design is where that declaration belongs, and plugins are not built yet, so this plan leaves text to a later one.
- **Persistence.** The package exposes the sequencer's snapshot and the accepted entries after it. Where and when they are stored is the host's choice.
- **Disconnects.** Editing continues. Pending transactions wait and are submitted after `hello`. The longer an editor stays away, the more of its pending work may no longer apply when it returns; each such transaction is dropped and reported, never applied in part.

## Packages

- **`@lumen-timeline/sync`.** Message types, the editor reconciler, the sequencer and an in-memory transport for tests. It depends on the core only, opens no connection and stores nothing.
- **`examples/sync`.** The vanilla example in several pages of one browser, ordered over `BroadcastChannel` by the page that holds a Web Lock. When that page closes, another takes the lock and the role. It runs from a static file server and needs no backend.

## Pull requests

| PR  | Scope                                                   | Gate                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `replay` command; undo and redo commits carry it        | Three seeded sessions converge through edits, undos and redos by forwarding only `commands`. A replay that conflicts is rejected whole.                                                                                                                                      |
| S2  | `editor.replace(snapshot)`                              | Subscriptions, selection and history behave as specified across a replacement. Views repaint once. No generated ID is issued twice. A foreign project is rejected.                                                                                                           |
| S3  | `@lumen-timeline/sync`: protocol, reconciler, sequencer | Under seeded delay, reordering, duplication and loss with resends, all editors equal the sequencer, each transaction applies once, and no rule is broken. A sequencer handover keeps every accepted entry. The core's tests and examples pass without the package installed. |
| S4  | `examples/sync` and a multi-page browser trace          | Playwright edits one project from two pages at once with no backend, including a rejected overlap, a page going offline and returning, and closing the page that leads. All pages end on the same snapshot.                                                                  |
| S5  | `atContent` split and candidate lists by element        | A split concurrent with a move cuts the same content point. Two takes added at once both remain, and each undo removes its own.                                                                                                                                              |

S1, S2 and S5 change only the core and can merge on their own. The roadmap does not depend on S3 or S4, so they can follow whenever sharing is wanted.

## Settled

- **No server is required.** The core works alone, and the sequencer runs wherever the host puts it (decided on 2026-11-22).
- **Minimal scope.** The package ships protocol, reconciler and sequencer only. A reference server is not a supported package.
- **Authority.** The sequencer enforces document rules. Anything else is an optional host callback.
- **Offline.** Editing never waits for a connection. Merging long offline work without a deciding participant stays out of scope.
