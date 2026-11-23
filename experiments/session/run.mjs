// What following another editor costs on the rendering benchmark's project:
// two hours, 40 tracks, 20,000 clips with a take each, and 2,000 markers.
// First the core alone, where one editor replaces its document by another's
// snapshot; then a shared session, where each message crosses as JSON.
// Usage (build first): node experiments/session/run.mjs [--write]
import { writeFileSync } from "node:fs";
import os from "node:os";
import { commands, createEditor, TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import { connectSession, createSequencer } from "@lumen-timeline/sync";

const tracks = [];
const clips = [];
const takes = [];
for (let t = 0; t < 40; t++) {
  tracks.push({ id: "t" + t, overlap: "exclusive" });
  for (let k = 0; k < 500; k++) {
    const id = `c${t}-${k}`;
    clips.push({
      id,
      trackId: "t" + t,
      kind: "audio",
      start: Math.round(k * 14.4 * hz),
      duration: (10 + (k % 4)) * hz,
      contentIn: 0,
      takeIds: ["k" + id],
      activeTakeId: "k" + id,
    });
    takes.push({
      id: "k" + id,
      assetId: "wave" + (k % 400),
      streamId: "mono",
      sourceAtContentZero: 0,
    });
  }
}
const markers = Array.from({ length: 2000 }, (_, i) => ({ id: "m" + i, start: i * hz }));
const project = () => ({ schemaVersion: 1, duration: 7200 * hz, tracks, clips, takes, markers });

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const results = {};
function record(name, times) {
  results[name] = { p50: quantile(times, 0.5), p95: quantile(times, 0.95) };
  console.log(
    `${name.padEnd(52)} p50 ${results[name].p50.toFixed(3)} ms, p95 ${results[name].p95.toFixed(3)} ms`,
  );
}
// Step `i` moves a clip of track `i % 40` there and back.
const move = (i, slot = 250) =>
  commands.moveClips({
    clipIds: [`c${i % 40}-${slot}`],
    delta: ((Math.floor(i / 40) % 2 === 0 ? 1 : -1) * hz) / 10,
  });
const pass = (result) => {
  if ((!result.ok && !result.held) || result.unchanged) throw new Error(JSON.stringify(result));
};
const watch = (editor) =>
  editor.subscribe(
    (snapshot) => snapshot,
    () => {},
  );

// The core: `confirmed` moves one clip, and each follower shows the result
// and makes the first read a view makes afterwards.
{
  const confirmed = createEditor({ project: project() });
  const handed = createEditor({ project: project() });
  const copied = createEditor({ project: project() });
  watch(handed);
  watch(copied);
  const times = { handed: [], copied: [] };
  for (let i = 0; i < 160; i++) {
    pass(confirmed.dispatch(move(i)));
    const target = confirmed.getSnapshot();
    let start = performance.now();
    pass(handed.replace(target));
    handed.read().takesOf(`c${i % 40}-250`);
    // The first quarter warms the path.
    if (i >= 40) times.handed.push(performance.now() - start);
    // A copy is what storage or a wire delivers. One in four keeps the run short.
    if (i % 4) continue;
    const copy = JSON.parse(JSON.stringify(target));
    start = performance.now();
    pass(copied.replace(copy));
    copied.read().takesOf(`c${i % 40}-250`);
    if (i >= 40) times.copied.push(performance.now() - start);
  }
  record("replace by an editor's snapshot, one clip moved", times.handed);
  record("replace by a JSON copy of that snapshot", times.copied);
}

// A link that passes each message as JSON and times the handlers alone.
function link() {
  const queues = { up: [], down: [] };
  const listeners = { up: new Set(), down: new Set() };
  const end = (send, receive) => ({
    send: (message) => queues[send].push(JSON.stringify(message)),
    onMessage(listener) {
      listeners[receive].add(listener);
      return () => listeners[receive].delete(listener);
    },
  });
  const deliver = (direction) => () => {
    let time = 0;
    for (const json of queues[direction].splice(0)) {
      const message = JSON.parse(json);
      const start = performance.now();
      for (const listener of listeners[direction]) listener(message);
      time += performance.now() - start;
    }
    return time;
  };
  return {
    editor: end("up", "down"),
    sequencer: end("down", "up"),
    up: deliver("up"),
    down: deliver("down"),
  };
}
// The run delivers by hand, so no timer of a session ever fires.
const clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} };

function session(policy) {
  const sequencer = createSequencer({ id: "bench", project: project() });
  const join = () => {
    const wire = link();
    sequencer.connect(wire.sequencer);
    const peer = connectSession({ id: "bench", transport: wire.editor, policy, clock });
    wire.up();
    const joined = wire.down();
    if (!peer.editor) throw new Error("The session did not start");
    watch(peer.editor);
    return { wire, peer, editor: peer.editor, joined };
  };
  const ana = join();
  const ben = join();
  const joined = [ana.joined, ben.joined];
  // A few more join and leave, for the time of joining alone.
  for (let n = 0; n < 5; n++) {
    const late = join();
    joined.push(late.joined);
    late.peer.dispose();
  }
  const times = { own: [], other: [], pending: [] };
  for (let i = 0; i < 240; i++) {
    pass(ana.editor.dispatch(move(i)));
    ana.wire.up();
    const own = ana.wire.down();
    const other = ben.wire.down();
    ben.editor.read().takesOf(`c${i % 40}-250`);
    if (i < 40) continue;
    times.own.push(own);
    times.other.push(other);
  }
  for (let i = 0; i < 240; i++) {
    // Ben has an edit of his own that is not answered when Ana's arrives.
    pass(ben.editor.dispatch(move(i, 300)));
    pass(ana.editor.dispatch(move(i)));
    ana.wire.up();
    ana.wire.down();
    const other = ben.wire.down();
    if (i >= 40) times.pending.push(other);
    ben.wire.up();
    ben.wire.down();
    ana.wire.down();
  }
  const document = ({ revision: _revision, ...rest }) => JSON.stringify(rest);
  if (document(ana.editor.getSnapshot()) !== document(ben.editor.getSnapshot()))
    throw new Error("The sessions disagree");
  if (ana.peer.pending || ben.peer.pending) throw new Error("A transaction is unanswered");
  ana.peer.dispose();
  ben.peer.dispose();
  return { ...times, joined };
}

const queue = session("queue");
record("session: join, from the snapshot message", queue.joined);
record("session: another's move accepted", queue.other);
record("session: another's move, one of its own unanswered", queue.pending);
record("session: its own move accepted", queue.own);
const confirmed = session("confirmed");
record("session, confirmed policy: its own move accepted", confirmed.own);

if (process.argv.includes("--write")) {
  const measured = {
    recorded: new Date().toISOString(),
    machine: {
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model ?? null,
      load: os.loadavg(),
    },
    node: process.version,
    fixture: { tracks: 40, clips: clips.length, takes: takes.length, markers: markers.length },
    milliseconds: results,
  };
  writeFileSync(
    new URL("../../docs/measurements/session.json", import.meta.url),
    JSON.stringify(measured, null, 2) + "\n",
  );
  console.log("Wrote docs/measurements/session.json");
}
