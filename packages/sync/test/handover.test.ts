import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { createSequencer } from "@lumen-timeline/sync";
import type { AcceptedMessage } from "@lumen-timeline/sync";
import { documentOf, editorOf, network, randomEdit } from "./fixtures.ts";

test("a successor sequencer resumes from the longest confirmed log and keeps every accepted entry", () => {
  const net = network({ size: 3, seed: 5, chaos: { loss: 0.1, reorder: true } });
  const edit = (steps: number, from: number) => {
    for (let step = from; step < from + steps; step++) {
      const peer = net.peers[net.random(net.peers.length)];
      assert.ok(peer);
      if (peer.session.editor && net.random(2) === 0) randomEdit(editorOf(peer), net.random, step);
      for (const other of net.peers) if (net.random(3) === 0) other.link.flush();
      net.clock.advance(net.random(20));
    }
  };
  edit(300, 0);
  // The leader leaves. Its links close, and whatever was in flight is lost.
  const seen = new Map<number, AcceptedMessage>();
  for (const peer of net.peers) {
    for (const entry of peer.session.state()?.log ?? []) seen.set(entry.revision, entry);
    peer.session.disconnect();
    peer.close();
  }
  const departed = net.sequencer.getSnapshot().revision;
  // Sessions keep editing while no sequencer runs.
  edit(60, 300);
  // The session that confirmed the most starts the next sequencer.
  const leader = net.peers.reduce((best, peer) =>
    (peer.session.revision ?? 0) > (best.session.revision ?? 0) ? peer : best,
  );
  const state = leader.session.state();
  assert.ok(state);
  const successor = createSequencer({ id: "tidal", project: state, retain: 100000 });
  net.setSequencer(successor);
  for (const peer of net.peers) net.relink(peer, { loss: 0.1, reorder: true });
  edit(100, 360);
  net.settle();

  // Every entry any session saw survives with its actor and number, and no
  // revision is issued twice.
  const start = state.project.revision;
  assert.ok(
    seen.size > 30 && start <= departed,
    JSON.stringify({ seen: seen.size, start, departed }),
  );
  const log = successor.state().log;
  for (const [revision, entry] of seen) {
    assert.ok(revision <= start, "a session saw an entry the successor lacks");
    const kept = log.find((candidate) => candidate.revision === revision);
    if (kept) assert.deepEqual([kept.actor, kept.n], [entry.actor, entry.n]);
  }
  // Each transaction still applied once, in its actor's order, across the handover.
  const last = new Map<string, number>();
  for (const entry of log) {
    assert.ok((last.get(entry.actor) ?? 0) < entry.n, "applied twice or out of order");
    last.set(entry.actor, entry.n);
  }
  const final = successor.getSnapshot();
  assert.ok(final.revision > start);
  for (const peer of net.peers)
    assert.deepEqual(documentOf(editorOf(peer).getSnapshot()), documentOf(final));
});

test("the core neither depends on nor imports the sync package", () => {
  const root = new URL("../../core/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
  const sources = readdirSync(new URL("src/", root), { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".ts"));
  assert.ok(sources.length > 10);
  for (const name of sources)
    assert.ok(
      !readFileSync(new URL("src/" + name, root), "utf8").includes("@lumen-timeline/sync"),
      name,
    );
});
