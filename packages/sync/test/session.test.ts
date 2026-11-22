import assert from "node:assert/strict";
import test from "node:test";
import { commands } from "@lumen-timeline/core";
import { connectSession, createLink, createSequencer } from "@lumen-timeline/sync";
import type { SyncMessage, SyncReport } from "@lumen-timeline/sync";
import { documentOf, editorOf, ManualClock, network, project } from "./fixtures.ts";

const move = (delta: number) => commands.moveClips({ clipIds: ["bed"], delta });
const bedOf = (peer: {
  session: {
    editor: { getSnapshot(): { clips: readonly { id: string; start: number }[] } } | null;
  };
}) => peer.session.editor?.getSnapshot().clips.find((c) => c.id === "bed")?.start;

test("a session starts from the sequencer's snapshot and sends its edits as they happen", async () => {
  const net = network({ size: 2 });
  // The hello arrives, then the snapshot.
  net.pump();
  net.pump();
  const [ana, ben] = net.peers;
  assert.ok(ana && ben);
  const editor = await ana.session.ready;
  assert.equal(editor, ana.session.editor);
  assert.notEqual(ana.session.actor, ben.session.actor);
  assert.equal(ana.session.status, "connected");
  editor.dispatch(move(10));
  assert.equal(ana.session.pending, 1);
  net.settle();
  assert.equal(bedOf(ben), 10);
  // The author's own accepted edit needed no rebuild: one commit for one edit.
  assert.equal(editor.history.undoDepth, 1);
  editor.history.undo();
  net.settle();
  assert.equal(bedOf(ben), 0);
});

test("a session parses its snapshot once, and its two editors share what neither changed", () => {
  const net = network({ size: 2 });
  net.settle();
  const [ana, ben] = net.peers;
  assert.ok(ana && ben);
  const confirmed = () => {
    const state = ben.session.state();
    assert.ok(state && "clips" in state.project);
    return state.project;
  };
  const shared = () =>
    editorOf(ben)
      .getSnapshot()
      .clips.map((clip, index) => clip === confirmed().clips[index]);
  // The visible editor opened the confirmed editor's snapshot, not a second parse of the message.
  assert.deepEqual(shared(), [true, true, true]);
  assert.equal(editorOf(ben).getSnapshot().takes, confirmed().takes);

  // Another's edit replaces one clip in the visible document and leaves the rest shared.
  editorOf(ana).dispatch(move(10));
  net.settle();
  assert.equal(bedOf(ben), 10);
  assert.deepEqual(shared(), [true, true, true]);
  // Its own unanswered edit is the only clip the two documents do not share.
  editorOf(ben).dispatch(commands.moveClips({ clipIds: ["next"], delta: 5 }));
  editorOf(ana).dispatch(move(10));
  for (const peer of [ana, ana, ben]) peer.link.flush();
  assert.equal(bedOf(ben), 20);
  assert.equal(ben.session.pending, 1);
  assert.deepEqual(shared(), [true, false, true]);
  net.settle();
  assert.deepEqual(
    documentOf(editorOf(ben).getSnapshot()),
    documentOf(net.sequencer.getSnapshot()),
  );
});

test("under queue, edits made while disconnected are sent after reconnecting", () => {
  const net = network({ size: 2, policy: "queue" });
  net.settle();
  const [ana, ben] = net.peers;
  assert.ok(ana && ben);
  ana.session.disconnect();
  assert.equal(ana.session.status, "disconnected");
  const result = editorOf(ana).dispatch(move(20));
  assert.ok(result.ok && !result.unchanged);
  editorOf(ben).dispatch(commands.addMarker({ start: 5 }));
  net.relink(ana);
  net.settle();
  assert.equal(bedOf(ben), 20);
  assert.deepEqual(
    documentOf(editorOf(ana).getSnapshot()),
    documentOf(net.sequencer.getSnapshot()),
  );
});

test("under online, a disconnected editor is read-only and rolls back after the deadline", () => {
  const net = network({ size: 2, policy: "online" });
  net.settle();
  const [ana, ben] = net.peers;
  assert.ok(ana && ben);
  // Sent, but the connection drops before it is delivered.
  editorOf(ana).dispatch(move(30));
  ana.session.disconnect();
  const refused = editorOf(ana).dispatch(move(5));
  assert.ok(!refused.ok && !refused.held);
  assert.deepEqual([refused.code, refused.target], ["read-only", "offline"]);
  const undo = editorOf(ana).history.undo();
  assert.equal(undo.ok ? undefined : undo.code, "read-only");
  assert.equal(bedOf(ana), 30);
  net.clock.advance(499);
  assert.equal(bedOf(ana), 30);
  net.clock.advance(1);
  assert.equal(bedOf(ana), 0);
  assert.ok(ana.reports.some((r) => r.type === "rolled-back" && r.transactions.length === 1));
  // Reconnecting allows editing again; the rolled-back edit never applies.
  net.relink(ana);
  net.settle();
  editorOf(ana).dispatch(commands.addMarker({ start: 9 }));
  net.settle();
  assert.equal(bedOf(ben), 0);
  assert.equal(ben.session.editor?.getSnapshot().markers?.length, 1);

  // Reconnecting before the deadline keeps unconfirmed edits, which then apply.
  editorOf(ana).dispatch(move(40));
  ana.session.disconnect();
  net.clock.advance(200);
  net.relink(ana);
  net.settle();
  net.clock.advance(1000);
  assert.equal(bedOf(ben), 40);
  assert.equal(bedOf(ana), 40);
});

test("under confirmed, an edit is held until accepted and enters history then", () => {
  const net = network({ size: 2, policy: "confirmed" });
  net.settle();
  const [ana, ben] = net.peers;
  assert.ok(ana && ben);
  const editor = editorOf(ana);
  const held = editor.dispatch(move(15));
  assert.ok(!held.ok && held.held);
  assert.deepEqual(held.targets.clipIds, ["bed"]);
  assert.equal(bedOf(ana), 0);
  assert.equal(ana.session.pending, 1);
  net.settle();
  assert.deepEqual([bedOf(ana), bedOf(ben)], [15, 15]);
  assert.equal(editor.history.undoDepth, 1);
  // Undo is held too, and moves the entry when accepted.
  const undo = editor.history.undo();
  assert.ok(!undo.ok && undo.held);
  net.settle();
  assert.deepEqual([bedOf(ana), bedOf(ben)], [0, 0]);
  assert.deepEqual([editor.history.undoDepth, editor.history.redoDepth], [0, 1]);
  // Disconnected, it is read-only, and held edits are discarded and reported.
  editor.dispatch(move(25));
  ana.session.disconnect();
  assert.equal(ana.session.pending, 0);
  assert.ok(ana.reports.some((r) => r.type === "discarded" && r.transactions.length === 1));
  const refused = editor.dispatch(move(5));
  assert.equal(refused.ok ? undefined : refused.code, "read-only");
  // A held edit that the sequencer does not answer in time is discarded too.
  net.relink(ana);
  net.settle();
  editor.dispatch(commands.addMarker({ start: 1 }));
  ana.link.configure({ loss: 1 });
  net.clock.advance(600);
  assert.ok(ana.reports.filter((r) => r.type === "discarded").length === 2);
  assert.equal(ana.session.pending, 0);
});

test("under confirmed, an accepted undo that the editor's own history answers differently is put right at once", () => {
  const net = network({ size: 2, policy: "confirmed" });
  net.settle();
  const [ana, ben] = net.peers;
  assert.ok(ana && ben);
  const editor = editorOf(ana);
  const nextOf = () => editor.getSnapshot().clips.find((clip) => clip.id === "next")?.start;
  editor.dispatch(move(10));
  net.settle();
  // Both are held. The undo names the bed's move, the only entry there is yet.
  editor.dispatch(commands.moveClips({ clipIds: ["next"], delta: 7 }));
  editor.history.undo();
  assert.equal(ana.session.pending, 2);
  // To the sequencer and back to Ana alone: nothing of Ben's helps her document along.
  ana.link.flush();
  ana.link.flush();
  assert.equal(ana.session.pending, 0);
  // Her history undid its newest entry, the second move, where the sequencer
  // undid the first. The visible document follows the sequencer.
  assert.deepEqual([bedOf(ana), nextOf()], [0, 607]);
  assert.deepEqual(documentOf(editor.getSnapshot()), documentOf(net.sequencer.getSnapshot()));
  net.settle();
  assert.deepEqual([bedOf(ben), bedOf(ana), nextOf()], [0, 0, 607]);
});

test("a transaction that no longer fits is dropped or rejected and leaves the author's document", () => {
  const net = network({ size: 2 });
  net.settle();
  const [ana, ben] = net.peers;
  assert.ok(ana && ben);
  // Both move a clip onto the same free place of the exclusive track. Ana's
  // arrives first. Ben learns of it before or after his own is refused.
  editorOf(ana).dispatch(commands.moveClips({ clipIds: ["line"], delta: 300 }));
  editorOf(ben).dispatch(commands.moveClips({ clipIds: ["next"], delta: -100 }));
  ana.link.flush();
  net.settle();
  const report = ben.reports.find((r) => r.type === "dropped" || r.type === "rejected");
  assert.ok(report && (report.type === "dropped" || report.type === "rejected"));
  assert.equal(report.code, "overlap");
  assert.deepEqual(report.commands, [commands.moveClips({ clipIds: ["next"], delta: -100 })]);
  assert.deepEqual(
    documentOf(editorOf(ben).getSnapshot()),
    documentOf(net.sequencer.getSnapshot()),
  );
});

test("a transaction the host's review refuses is reported and rolled back", () => {
  const net = network({
    size: 2,
    review: ({ commands: list }) =>
      list.some((c) => c.type === "add-marker" && c.label === "Secret")
        ? { reject: "Markers are reviewed" }
        : undefined,
  });
  net.settle();
  const [ana, ben] = net.peers;
  assert.ok(ana && ben);
  editorOf(ana).dispatch(commands.addMarker({ start: 5, label: "Secret" }));
  editorOf(ana).dispatch(move(10));
  assert.equal(ana.session.editor?.getSnapshot().markers?.length, 1);
  net.settle();
  assert.deepEqual(
    ana.reports
      .filter((r) => r.type === "rejected")
      .map((r) => (r.type === "rejected" ? [r.code, r.reason] : [])),
    [["refused", "Markers are reviewed"]],
  );
  // The refused marker is gone everywhere; the edit after it still applied.
  assert.equal(ana.session.editor?.getSnapshot().markers, undefined);
  assert.deepEqual([bedOf(ana), bedOf(ben)], [10, 10]);
});

test("presence reaches the other sessions, and a hello for another project is refused", () => {
  const net = network({ size: 2 });
  net.settle();
  const [ana, ben] = net.peers;
  assert.ok(ana && ben);
  ana.session.presence({ selection: ["line"], playhead: 120 });
  net.settle();
  assert.deepEqual(
    ben.reports.filter((r) => r.type === "presence"),
    [{ type: "presence", actor: ana.session.actor, state: { selection: ["line"], playhead: 120 } }],
  );
  assert.ok(!ana.reports.some((r) => r.type === "presence"));
  const link = createLink();
  net.sequencer.connect(link.sequencer);
  const stranger = connectSession({
    id: "another",
    transport: link.editor,
    clock: new ManualClock(),
  });
  const reports: SyncReport[] = [];
  stranger.subscribe((r) => reports.push(r));
  link.flush();
  link.flush();
  assert.deepEqual(reports, [{ type: "refused", reason: "This sequencer orders another project" }]);
  stranger.dispose();
});

test("the sequencer applies each transaction once and in each actor's order", () => {
  const sequencer = createSequencer({ id: "tidal", project: project() });
  const link = createLink();
  sequencer.connect(link.sequencer);
  const received: SyncMessage[] = [];
  link.editor.onMessage((m) => received.push(m));
  link.editor.send({ type: "hello", project: "tidal", revision: null, n: 0 });
  link.flush();
  link.flush();
  const snapshot = received[0];
  assert.equal(snapshot?.type, "snapshot");
  const actor = snapshot?.type === "snapshot" ? snapshot.actor : "";
  const submit = (n: number, delta: number) =>
    link.editor.send({ type: "submit", actor, n, commands: [move(delta)] });
  // Number 2 before number 1 waits; 1 then applies; a resent 1 is answered again.
  submit(2, 5);
  submit(1, 10);
  submit(1, 10);
  submit(2, 5);
  link.flush();
  link.flush();
  const accepted = received.filter((m) => m.type === "accepted");
  assert.deepEqual(
    accepted.map((m) => (m.type === "accepted" ? [m.revision, m.n] : [])),
    [
      [1, 1],
      [1, 1],
      [2, 2],
    ],
  );
  assert.equal(sequencer.getSnapshot().clips.find((c) => c.id === "bed")?.start, 15);
  // A transaction that changes nothing, or that the host's review refuses, is rejected.
  submit(3, 0);
  link.flush();
  link.flush();
  assert.deepEqual(
    received.filter((m) => m.type === "rejected").map((m) => (m.type === "rejected" ? m.code : "")),
    ["unchanged"],
  );
  const strict = createSequencer({
    id: "tidal",
    project: project(),
    review: () => ({ reject: "Viewers cannot edit" }),
  });
  const other = createLink();
  strict.connect(other.sequencer);
  const answers: SyncMessage[] = [];
  other.editor.onMessage((m) => answers.push(m));
  other.editor.send({ type: "hello", project: "tidal", revision: null, actor: "viewer", n: 0 });
  other.editor.send({ type: "submit", actor: "viewer", n: 1, commands: [move(1)] });
  other.flush();
  other.flush();
  assert.deepEqual(
    answers.filter((m) => m.type === "rejected"),
    [
      {
        type: "rejected",
        actor: "viewer",
        n: 1,
        code: "refused",
        target: null,
        reason: "Viewers cannot edit",
      },
    ],
  );
});

test("disposing a session leaves its editor as an ordinary editor", () => {
  const net = network({ size: 1, policy: "online" });
  net.settle();
  const [ana] = net.peers;
  assert.ok(ana);
  const editor = editorOf(ana);
  ana.session.disconnect();
  assert.equal(editor.dispatch(move(5)).ok, false);
  ana.session.dispose();
  const result = editor.dispatch(move(5));
  assert.ok(result.ok && !result.unchanged);
  assert.equal(ana.session.pending, 0);
});
