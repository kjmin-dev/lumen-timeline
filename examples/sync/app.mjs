import { TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import { mountTimeline } from "@lumen-timeline/timeline";
import { connectSession, createSequencer } from "@lumen-timeline/sync";

// Every tab of this page shares one project. The tab that holds a Web Lock runs
// the sequencer; all tabs, the leader included, edit through a session.
const params = new URLSearchParams(location.search);
const policy = ["queue", "online", "confirmed"].includes(params.get("policy"))
  ? params.get("policy")
  : "queue";
const deadline = Number(params.get("deadline") ?? 5000);
const id = "shared-tidal";
const page = crypto.randomUUID();
const channel = new BroadcastChannel("lumen-sync:" + id);

const line = (clipId, trackId, start, duration, name) => ({
  id: clipId,
  name,
  trackId,
  kind: "audio",
  start: start * hz,
  duration: duration * hz,
  contentIn: 0,
  contentBounds: { start: 0, end: 30 * hz },
});
export const project = {
  schemaVersion: 1,
  duration: 24 * hz,
  tracks: [
    { id: "narrator", name: "Narrator", overlap: "exclusive" },
    { id: "keeper", name: "Keeper", overlap: "exclusive" },
  ],
  clips: [
    line("line", "narrator", 2, 3, "The tide returns"),
    line("next", "narrator", 12, 3, "And it leaves again"),
    line("reply", "keeper", 7, 2, "Can you hear it?"),
  ],
};

// The example edits and does not play, so its transport only holds a position.
const playhead = { playing: false, presentedTick: 0, requestedTick: null };
const watchers = new Set();
const transport = {
  snapshot: () => playhead,
  subscribe(listener) {
    watchers.add(listener);
    return () => watchers.delete(listener);
  },
  play() {},
  pause() {},
  seek(tick) {
    Object.assign(playhead, { presentedTick: tick });
    for (const listener of watchers) listener({ ...playhead });
  },
};

// --- Connections over the channel ----------------------------------------
// Each message names its sender and recipient. A tab's session sends to
// whichever tab leads; the leader answers the tab by its ID.
let online = true;
// A test hook: drop this tab's outgoing messages without noticing.
let losing = false;
const toSession = new Set();
const remote = {
  send(message) {
    if (online && !losing)
      channel.postMessage({ kind: "message", from: page, to: "leader", message });
  },
  onMessage(listener) {
    toSession.add(listener);
    return () => toSession.delete(listener);
  },
};
// The leader's own session talks to its sequencer inside the tab.
function localLink() {
  const sides = { session: new Set(), sequencer: new Set() };
  const end = (from, to) => ({
    send: (message) =>
      queueMicrotask(() => {
        for (const listener of Array.from(sides[to])) listener(structuredClone(message));
      }),
    onMessage(listener) {
      sides[from].add(listener);
      return () => sides[from].delete(listener);
    },
  });
  return { session: end("session", "sequencer"), sequencer: end("sequencer", "session") };
}

// Channel messages: a sync message between a tab and the leader, a request for
// each tab's confirmed state, a reply to one, and a new leader's announcement.
let leader = null;
channel.onmessage = ({ data }) => {
  if (!online || typeof data !== "object" || data === null) return;
  if (data.kind === "message" && data.to === page)
    for (const listener of Array.from(toSession)) listener(data.message);
  else if (data.kind === "message" && data.to === "leader" && leader)
    leader.receive(data.from, data.message);
  else if (data.kind === "state?" && session.state())
    channel.postMessage({ kind: "state", to: data.from, state: session.state() });
  else if (data.kind === "state" && data.to === page) offers.push(data.state);
  // A new leader: rejoin it at once rather than wait for a retry.
  else if (data.kind === "leader" && !leader) session.reconnect(remote);
};

// --- Leading -------------------------------------------------------------
let offers = [];
async function lead() {
  // Start from the most advanced confirmed state any tab reports.
  offers = [];
  channel.postMessage({ kind: "state?", from: page });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const own = session.state();
  const best = [own, ...offers]
    .filter(Boolean)
    .reduce((a, b) => (!a || b.project.revision > a.project.revision ? b : a), null);
  const sequencer = createSequencer({ id, project: best ?? project });
  const connections = new Map();
  leader = {
    sequencer,
    receive(from, message) {
      let connection = connections.get(from);
      if (!connection) {
        const listeners = new Set();
        const close = sequencer.connect({
          send: (reply) =>
            channel.postMessage({ kind: "message", from: "leader", to: from, message: reply }),
          onMessage(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        });
        connection = { listeners, close };
        connections.set(from, connection);
      }
      for (const listener of Array.from(connection.listeners)) listener(message);
    },
  };
  const link = localLink();
  sequencer.connect(link.sequencer);
  session.reconnect(link.session);
  channel.postMessage({ kind: "leader", from: page });
  show();
}

// --- The session and its view --------------------------------------------
export const session = connectSession({
  id,
  transport: remote,
  policy,
  deadline,
  retry: 500,
  poll: 2000,
});
const log = document.querySelector("#log");
function note(text) {
  const item = document.createElement("li");
  item.textContent = text;
  log.append(item);
  log.scrollTop = log.scrollHeight;
}
const others = new Map();
function show() {
  document.querySelector("#role").textContent = leader ? "leader" : "follower";
  document.querySelector("#policy").textContent = policy;
  document.querySelector("#actor").textContent = session.actor ?? "—";
  document.querySelector("#connection-state").textContent = session.status;
  document.querySelector("#pending").textContent = String(session.pending);
  document.querySelector("#revision").textContent = String(session.revision ?? "—");
  document.querySelector("#others").textContent = others.size
    ? [...others].map(([actor, state]) => actor + ": " + (state.selection?.[0] ?? "—")).join(", ")
    : "none";
  const button = document.querySelector("#connection");
  button.disabled = Boolean(leader) || !session.editor;
  button.textContent = online ? "Go offline" : "Go online";
}
session.subscribe((report) => {
  if (report.type === "presence") others.set(report.actor, report.state);
  else if (report.type === "rejected") note("Rejected (" + report.code + "): " + report.reason);
  else if (report.type === "dropped") note("Dropped (" + report.code + "): " + report.reason);
  else if (report.type === "rolled-back")
    note("Rolled back " + report.transactions.length + " unconfirmed edit(s) after the deadline");
  else if (report.type === "discarded")
    note("Discarded " + report.transactions.length + " held edit(s)");
  else if (report.type === "settled") note("Settled while out of contact");
  else if (report.type === "status") note("Connection " + report.status);
  show();
});

export let view = null;
export const ready = session.ready.then((editor) => {
  view = mountTimeline(document.querySelector("#timeline"), {
    editor,
    transport,
    snap: { gridTicks: hz / 10 },
    pixelsPerSecond: Math.max(20, (document.querySelector("#timeline").clientWidth - 160) / 24),
  });
  editor.session.subscribeSelection((selection) => session.presence({ selection }));
  editor.subscribe(
    (s) => s.revision,
    () => show(),
  );
  show();
  return editor;
});

// --- Going offline and back ----------------------------------------------
export function goOffline() {
  if (leader || !online) return;
  online = false;
  session.disconnect();
  show();
}
export function goOnline() {
  if (online) return;
  online = true;
  session.reconnect(remote);
  show();
}
export function lose(value) {
  losing = value;
}
export const role = () => (leader ? "leader" : "follower");
document.querySelector("#connection").onclick = () => (online ? goOffline() : goOnline());

void navigator.locks.request("lumen-sync:" + id, async () => {
  await lead();
  // Hold the lock, and the role, until this tab closes.
  await new Promise(() => {});
});
show();
window.syncApp = {
  session,
  goOffline,
  goOnline,
  lose,
  role,
  get view() {
    return view;
  },
};
