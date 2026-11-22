import assert from "node:assert/strict";
import test from "node:test";
import { commands } from "@lumen-timeline/core";
import type { ConfirmationPolicy, Review, Submission } from "@lumen-timeline/sync";
import { assertValid, documentOf, editorOf, network, randomEdit } from "./fixtures.ts";

// Seeded editors edit, undo and redo at random while every link delays,
// reorders, duplicates and loses messages. Sessions resend until answered.
function run(
  policy: ConfirmationPolicy,
  seed: number,
  review?: (s: Submission) => Review | undefined,
) {
  const net = network({
    policy,
    seed,
    review,
    // Long enough that no held edit is discarded: every number must be answered.
    deadline: 1e9,
    chaos: { loss: 0.15, duplicate: 0.1, reorder: true },
  });
  const counts = { edits: 0, held: 0, refused: 0 };
  for (let step = 0; step < 700; step++) {
    const peer = net.peers[net.random(net.peers.length)];
    assert.ok(peer);
    if (peer.session.editor && net.random(3) === 0) {
      const result = randomEdit(editorOf(peer), net.random, step);
      if (result.ok && !result.unchanged) counts.edits++;
      else if (!result.ok && result.held) counts.held++;
      else if (!result.ok && result.code === "read-only") counts.refused++;
    }
    // Links deliver at different times, so editors see entries in different interleavings.
    for (const other of net.peers) if (net.random(4) === 0) other.link.flush();
    net.clock.advance(net.random(30));
  }
  net.settle();
  const final = net.sequencer.getSnapshot();
  const state = net.sequencer.state();
  // All editors, visible and confirmed, equal the sequencer.
  for (const peer of net.peers) {
    assert.deepEqual(documentOf(editorOf(peer).getSnapshot()), documentOf(final));
    assert.equal(peer.session.revision, final.revision);
    assert.equal(peer.session.pending, 0);
  }
  // Each transaction applied once, and each actor's in the order it made them.
  const seen = new Map<string, number>();
  for (const entry of state.log) {
    assert.ok((seen.get(entry.actor) ?? 0) < entry.n, "applied twice or out of order");
    seen.set(entry.actor, entry.n);
  }
  assert.deepEqual(
    state.log.map((entry) => entry.revision),
    state.log.map((_entry, i) => i + 1),
  );
  // Every transaction was answered: none went missing.
  assert.ok(net.processed() >= state.log.length);
  // No rule is broken in any document.
  assertValid(final);
  const reports = net.peers.flatMap((peer) => peer.reports.map((report) => report.type));
  return { net, counts, entries: state.log.length, reports };
}

for (const [policy, seed] of [
  ["queue", 7],
  ["online", 8],
  ["confirmed", 9],
] as const) {
  test(`editors converge under loss, duplication and reordering: ${policy}`, () => {
    const { counts, entries, reports } = run(policy, seed);
    assert.ok(entries > 80, "accepted entries: " + entries);
    if (policy === "confirmed") assert.ok(counts.held > 80, JSON.stringify(counts));
    else assert.ok(counts.edits > 80, JSON.stringify(counts));
    // Concurrent edits collided and the sequencer rejected some.
    assert.ok(reports.includes("rejected"), "no transaction collided");
  });
}

test("every editor follows a sequencer that rewrites commands", () => {
  // The sequencer stamps each edit with who made it and renames new markers.
  const review = ({ actor, n, commands: list }: Submission): Review | undefined => {
    if (list.some((command) => command.type === "replay")) return undefined;
    return {
      commands: [
        ...list.map((command) =>
          command.type === "add-marker" ? { ...command, label: "Reviewed" } : command,
        ),
        commands.setEntityData({ scope: "review", id: actor, key: "last", value: n }),
      ],
    };
  };
  const { net } = run("queue", 11, review);
  const final = net.sequencer.getSnapshot();
  assert.ok(Object.keys(final.entityData?.["review"] ?? {}).length >= 2);
  assert.ok((final.markers ?? []).every((marker) => marker.label === "Reviewed"));
  for (const peer of net.peers)
    assert.deepEqual(documentOf(editorOf(peer).getSnapshot()), documentOf(final));
});
