# Sharing a project between editors

`@lumen-timeline/sync` lets two or more editors work on one project and end on the same document. It is optional: the core edits, undoes, plays and saves without it, and the core never imports it. The package ships a protocol, an editor-side session and a sequencer. It opens no connection and stores nothing, and nothing in it requires a server. [Plan and decisions](plans/shared-sessions.md)

```js
import { connectSession, createSequencer } from "@lumen-timeline/sync";

// Wherever the host chooses to order edits: a server, one page, a worker or a test.
const sequencer = createSequencer({ id: "tidal-study", project });
const close = sequencer.connect(transportToEditor);

// In each editor.
const session = connectSession({ id: "tidal-study", transport, policy: "queue" });
const editor = await session.ready;
mountTimeline(element, { editor, transport: player });
```

A transport is `{ send(message), onMessage(listener) }`, one per connection, and the host carries the JSON messages: over `BroadcastChannel`, a WebSocket, a WebRTC data channel or anything else. `createLink()` makes an in-memory pair for tests, with optional loss, duplication and reordering.

## How edits travel

Each editor applies its own edits at once and sends their commands. The sequencer is a headless editor of its own. It applies transactions in the order they arrive, rejects what no longer fits and announces the rest as consecutive revisions. Every session replays that order.

- **Two documents.** A session keeps the confirmed document, which only the sequencer's messages change, and the visible editor, which also shows the session's pending transactions. When another participant's entry arrives, the session replaces the visible document with the confirmed one, using `editor.replace`, and replays what is pending on top. Each replay takes over its own [history entry](headless-editing.md#replace-the-document), so undo reverses what the edit did after the replay.
- **Views.** Subscribers of the visible editor see the replacement as one commit, then one commit per pending transaction replayed on top of it, with the usual `changedIds` and `affected`. The timeline view and the transports need no change.
- **Own entries.** When the sequencer accepts exactly what a session sent, with nothing pending ahead of it, the visible document already shows it and nothing is replayed.
- **Undo and redo** travel as [`replay` commands](headless-editing.md#generated-ids-and-replay). Like any transaction they are decided by the sequencer.
- **Rejections.** A transaction that no longer fits is rejected and reported, and the author's visible document rolls it out. A pending transaction that does not apply locally after another participant's entry is left out of the visible document until the sequencer answers it. One that was never sent is dropped and reported.

## Confirmation policy

Each session picks one policy for its own edits.

| Policy      | Connected                                                                                 | Disconnected                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `queue`     | An edit applies at once and is confirmed later.                                           | Editing continues. Edits are sent after reconnecting.                                        |
| `online`    | As `queue`.                                                                               | Read-only. Unconfirmed edits roll back as one commit when `deadline` passes.                 |
| `confirmed` | An edit is [held](headless-editing.md#dispatch-gate) until accepted, then enters history. | Read-only. Held edits are discarded. A held edit unanswered for `deadline` is discarded too. |

A dispatch, undo or redo refused while read-only fails with the code `read-only` and the target `offline`. The host tells the session about its connection: `session.disconnect()` when it drops and `session.reconnect(transport)` with a new one.

## Delivery

- **Exactly once, in order.** Each session numbers its transactions. The sequencer applies an actor's transaction `n` only after `n − 1`. A resent transaction is answered again and never applied twice, which matters because a move by a delta is not idempotent.
- **Lost messages.** A session rejoins with `hello` when an answer is overdue (`retry`, 1 s by default), when it sees a gap in revisions, and every `poll` (5 s) while idle, in case the last entry was lost. The sequencer answers with the entries the session lacks and `joined`, or with a `snapshot` when it no longer holds them. Numbers the session will never send again count as processed, so an abandoned transaction cannot apply later.
- **Actors.** The sequencer issues each session's actor on its first `hello`, so the IDs two sessions generate cannot collide. `session.actor` names it.

## Reviewing transactions

`createSequencer({ review })` sees each transaction before it applies. Return `{ reject: reason }` to refuse it for the host's own reasons, such as who may edit a track, or `{ commands }` to apply other commands instead, such as a filled-in generated take. The accepted entry carries what the sequencer applied, and every session, the author included, replays that.

## Handing over the sequencer

`session.state()` and `sequencer.state()` return `{ project, actors, log }`: the confirmed document, each actor's last processed number and the retained entries. When the sequencer leaves, start the next one from the session with the highest `session.revision`, which holds every entry any session saw, and reconnect the sessions to it:

```js
const next = createSequencer({ id, project: best.state() });
```

Sessions resend what is still pending. The actor table keeps an entry that was already applied from applying again.

## Reports

`session.subscribe(listener)` reports `status`, the `pending` count, `rejected` transactions with the sequencer's code and reason, `dropped` ones that were never sent, transactions `settled` while out of contact, `rolled-back` and `discarded` edits, other sessions' `presence` and a `refused` hello for another project. `session.presence(state)` sends selection, playhead or any host field to the other sessions. It is not ordered or stored, and the last value wins.

`session.dispose()` stops syncing and leaves the visible editor as an ordinary editor.

## Checks

`npm test` runs the package's tests:

- **Convergence.** Under each policy, three sessions edit, undo and redo at random over links that lose, duplicate and reorder messages. Every editor ends equal to the sequencer. Every transaction is answered, and each applied once in its actor's order. Every document still opens.
- **Rewriting.** The same holds when the sequencer rewrites what it applies.
- **Policies.** Edits made offline under `queue` are sent later. Under `online`, editing is read-only and rolls back at the deadline, and an earlier reconnect keeps the edits. Under `confirmed`, edits are held, enter history when accepted, and are discarded when disconnected or overdue.
- **Handover.** A successor sequencer keeps every entry any session saw and applies nothing twice.
- **Independence.** The core neither depends on nor imports the package.
