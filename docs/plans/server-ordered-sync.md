# Edit one project from several places

**Status.** Planned. This document is the proposal; no implementation PR is open.

**User outcome.** Two people open the same project. Each sees the other's edits within a moment, keeps their own undo, and never ends up with a different project from the other. A rule the editor enforces alone, such as no overlap on an exclusive track or no edit on a locked one, still holds with several editors. [Audit experiments](../../experiments/collab/README.md) · [Replayable edits](replayable-edits.md)

**Starting point.** After #26 the core already has most of what a shared session needs.

- **Deterministic commands.** The headless core runs the same in Node and in a browser. A commit's `commands` name every generated ID, so another editor at the same revision replays them to the same snapshot. A seeded test runs three sessions through 600 edits this way.
- **Scoped guards.** `expectClip` and `expectData` reject a transaction when the values it depended on changed, without the project-wide `expectedRevision`.
- **Records by ID.** Clip, marker, take and data changes are keyed by ID. Replay owns the fields an edit changed, with clip placement in content space, so unrelated edits of one clip do not conflict.
- **Session state apart.** Selection and the transport's position are not in the document.

What is missing is everything between two editors: an order for concurrent edits, a way for a client to adopt that order, and a form in which undo can travel.

## Approach: the server orders commands

Each client applies its own edits at once and sends their commands to a server. The server runs the same core, applies commands in the order they arrive, rejects the ones that no longer fit, and broadcasts the accepted ones. A client replays that sequence and puts its unconfirmed edits back on top.

- **Why not merge states without a server.** Some of this editor's rules cannot survive a merge of two valid states: two clips moved to the same place on an exclusive track are each valid alone. Rules of this kind need a point of coordination, or have to be relaxed and repaired after the merge. [Coordination avoidance](https://arxiv.org/abs/1402.2237) gives the general condition; that overlap and lock rules fall under it is this plan's reading.
- **Why commands and not field values.** Figma's property-level last-writer-wins, decided by server arrival order, is the closest published design for a design tool, and it merges values. [Figma's multiplayer](https://madebyevan.com/figma/how-figmas-multiplayer-technology-works/) A timeline's edits are mostly relative: a move by a delta, a trim by a delta, a split at a point. Replaying the command against the current state keeps both edits where merging two values would keep one.
- **Prior art for the loop.** Replicache describes the same cycle: optimistic local mutation, authoritative replay on the server, and a rebase of pending mutations on the client. It also requires IDs to be passed into mutators, as `commands` now does. [How Replicache works](https://doc.replicache.dev/concepts/how-it-works)
- **Measured on this core.** `experiments/collab/server-order.mjs` lets three clients each send a locally valid command per round and replays the server's log everywhere. Over 1,200 rounds the server accepted 3,597 of 3,600 commands, no round left a client different from the server, and none left an overlap.

A merge without a server stays possible later, for offline-first use. It needs every rule above turned into a repair step, and is outside this plan.

## Protocol

Messages are JSON. The transport is the host's choice; the reference uses WebSocket.

| Message    | From   | Carries                                              | Meaning                                                                      |
| ---------- | ------ | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `hello`    | client | project ID, last revision seen, actor when rejoining | Join, or rejoin after a disconnect.                                          |
| `snapshot` | server | actor, project snapshot at revision `r`              | Start from here, under this actor.                                           |
| `submit`   | client | actor, sequence number `n`, commands                 | One local transaction.                                                       |
| `accepted` | server | revision `r`, actor, `n`, commands                   | The transaction is entry `r` of the project's history. Sent to every client. |
| `rejected` | server | actor, `n`, code, target, reason                     | The transaction did not fit. Sent to its author.                             |
| `presence` | both   | actor, selection, playhead, any host fields          | Not ordered, not stored, last value wins.                                    |

- **Actors.** The server issues a session's actor on its first `hello`, so two tabs of one user never share one and their generated IDs cannot collide. A rejoin presents the actor again, which lets the server recognise a resent transaction.
- **Exactly once.** The server remembers the last sequence number it processed per actor. A resent `submit` is answered again and not applied twice. This matters because a move by a delta is not idempotent.
- **Order.** `accepted` messages carry consecutive revisions. A client that sees a gap rejoins with `hello`. The server answers a rejoin with the `accepted` entries after the client's revision while it still holds them, and with a `snapshot` otherwise.
- **Validation.** The server applies commands with the core, under the same rules as any editor. It may add host rules, such as who may edit which track.

## Client reconciliation

A client keeps two documents: the confirmed one, which only server messages change, and the visible one, which also shows its pending transactions.

1. A local edit applies to the visible document, joins the pending queue with the next sequence number, and is submitted.
2. On `accepted` from another actor, the client applies the commands to the confirmed document, resets the visible document to it and replays the pending queue without recording it in history a second time. A pending transaction that no longer applies is dropped and reported to the host.
3. On `accepted` for its own transaction, the client applies it to the confirmed document and removes it from the queue. The visible document already shows it.
4. On `rejected`, the client removes the transaction, rebuilds the visible document as in step 2 and reports the rejection.

Subscribers of the visible editor see one commit per step, with the usual `changedIds` and `affected`, so the timeline view and the transports need no change.

## What the core still needs

- **Replace the document in place.** Step 2 needs `editor.replace(snapshot)`: adopt another snapshot of the same project while keeping subscriptions, pruning the selection, and notifying once. Today that takes a new editor.
  - Local undo history stays. Its entries are records by ID that replay against whatever the document now holds, and conflict where their fields changed.
  - A replayed pending transaction replaces the records of its history entry. Undo then reverses what the edit did after the rebase, not what it did before.
  - The ID counter never moves back across a replacement, so a dropped transaction's IDs are not issued again.
- **Undo that travels.** A commit from undo or redo has no commands. A `replay` command carrying clip, marker, take and data patches would apply them under the existing value-checked replay rules. An undo commit then lists one `replay` command, and the server validates it like any other.
- **Split at a content position.** `splitClip({ at })` names a timeline tick. After a concurrent move the same tick is another point in the clip, or outside it. An `atContent` form names the point in the clip's own content time, which a move does not change.
- **Candidate lists by element.** A clip's `takeIds` is one value, so undoing an added take conflicts after another take was added (audit probe 3). Replay should own the elements an edit added, removed or moved.

## Outside the document

- **Presence.** Selection, playhead and audition state travel as `presence`. Each client draws the others' from the last message.
- **Text.** Script lines and translations that two people type into at once need a text merge. Entity data replaces whole values. A field declared as text should delegate to a text CRDT. The field `type` in the plugin design is where that declaration belongs, and plugins are not built yet, so this plan leaves text to a later one.
- **Persistence.** The server stores a snapshot and the accepted transactions after it. It prunes takes and compacts the log when no client is behind the snapshot.
- **Disconnects.** Pending transactions wait and are submitted after `hello`. S3 sets how far behind a client may fall before it reloads from a snapshot. Editing offline for long is the server-less case above.

## Packages

- **`@lumen-timeline/sync`.** Message types, the client reconciler over any transport, and an in-memory server for tests. It depends on the core only.
- **`examples/sync`.** A Node WebSocket server around the core, and the vanilla example opened in two tabs.

The core gains no dependency and no network code.

## Pull requests

| PR  | Scope                                                          | Gate                                                                                                                                                               |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1  | `replay` command; undo and redo commits carry it               | Three seeded sessions converge through edits, undos and redos by forwarding only `commands`. A replay that conflicts is rejected whole.                            |
| S2  | `editor.replace(snapshot)`                                     | Subscriptions, selection and history behave as specified across a replacement. Views repaint once. No generated ID is issued twice. A foreign project is rejected. |
| S3  | `@lumen-timeline/sync`: protocol, reconciler, in-memory server | Under seeded delay, reordering, duplication and loss with resends, all clients equal the server, each transaction applies once, and no rule is broken.             |
| S4  | `examples/sync` and a two-page browser trace                   | Playwright edits one project from two pages at once, including a rejected overlap, a disconnect and a rejoin. Both pages end on the server's snapshot.             |
| S5  | `atContent` split and candidate lists by element               | A split concurrent with a move cuts the same content point. Two takes added at once both remain, and each undo removes its own.                                    |

## Decisions needed before S3

- **Offline.** Whether editing for hours without a connection is a requirement. If it is, the server-less merge moves from "later" into this plan.
- **Authority.** Whether the server may reject by user, for example a track owner, or only by document rules.
- **Hosting.** Whether the reference server is an example only, or a supported package.
- **Roadmap.** Whether this sits before or after the framework wrappers of milestone 5. Milestone 3 does not depend on it.
