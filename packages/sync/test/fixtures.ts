import assert from "node:assert/strict";
import { commands, createEditor } from "@lumen-timeline/core";
import type {
  EditCommand,
  EditResult,
  Editor,
  Project,
  ProjectSnapshot,
} from "@lumen-timeline/core";
import { connectSession, createLink, createSequencer } from "@lumen-timeline/sync";
import type {
  ConfirmationPolicy,
  LinkOptions,
  MemoryLink,
  Review,
  Sequencer,
  Submission,
  SyncClock,
  SyncReport,
  SyncSession,
  SyncTransport,
} from "@lumen-timeline/sync";

export const project = (): Project => ({
  schemaVersion: 1,
  duration: 2000,
  tracks: [{ id: "voice", overlap: "exclusive" }, { id: "mix" }],
  clips: [
    {
      id: "line",
      trackId: "voice",
      kind: "audio",
      start: 100,
      duration: 200,
      contentIn: 10,
      takeIds: ["a"],
      activeTakeId: "a",
    },
    { id: "next", trackId: "voice", kind: "audio", start: 600, duration: 200, contentIn: 0 },
    { id: "bed", trackId: "mix", kind: "audio", start: 0, duration: 1500, contentIn: 0 },
  ],
  takes: [{ id: "a", assetId: "line-a", streamId: "s", sourceAtContentZero: 0 }],
});

/** A seeded generator. Its high bits are well mixed; its low bits repeat quickly. */
export function seeded(seed: number): (n?: number) => number {
  let state = seed;
  return (n?: number) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    const unit = state / 2147483648;
    return n === undefined ? unit : Math.floor(unit * n);
  };
}

/** A clock that moves only when the test advances it, firing timers in order. */
export class ManualClock implements SyncClock {
  time = 0;
  private timers: { at: number; id: number; callback: () => void }[] = [];
  private ids = 0;
  now = (): number => this.time;
  setTimeout = (callback: () => void, ms: number): unknown => {
    const id = ++this.ids;
    this.timers.push({ at: this.time + ms, id, callback });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  };
  advance(ms: number): void {
    const until = this.time + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= until)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.time = due.at;
      due.callback();
    }
    this.time = until;
  }
}

export interface Peer {
  link: MemoryLink;
  session: SyncSession;
  reports: SyncReport[];
  close: () => void;
}

/** One sequencer and several sessions, each over its own in-memory link. */
export function network({
  size = 3,
  policy = "queue",
  chaos = {},
  review,
  seed = 1,
  deadline = 500,
}: {
  deadline?: number;
  size?: number;
  policy?: ConfirmationPolicy;
  chaos?: LinkOptions;
  review?: ((submission: Submission) => Review | undefined) | undefined;
  seed?: number;
} = {}) {
  const random = seeded(seed);
  const clock = new ManualClock();
  // Every answer any sequencer sent, to check that no transaction went unanswered.
  const answers: { actor: string; n: number; type: "accepted" | "rejected" }[] = [];
  const recorded = (link: MemoryLink): SyncTransport => ({
    send(message) {
      if (message.type === "accepted" || message.type === "rejected")
        answers.push({ actor: message.actor, n: message.n, type: message.type });
      link.sequencer.send(message);
    },
    onMessage: (listener) => link.sequencer.onMessage(listener),
  });
  let sequencer: Sequencer = createSequencer({
    id: "tidal",
    project: project(),
    review,
    retain: 100000,
  });
  const join = (transport?: MemoryLink): Peer => {
    const link = transport ?? createLink({ random: () => random(), ...chaos });
    const close = sequencer.connect(recorded(link));
    const session = connectSession({
      id: "tidal",
      transport: link.editor,
      policy,
      clock,
      retry: 40,
      poll: 200,
      deadline,
      retain: 100000,
    });
    const reports: SyncReport[] = [];
    session.subscribe((report) => reports.push(report));
    return { link, session, reports, close };
  };
  const peers = Array.from({ length: size }, () => join());
  return {
    random,
    clock,
    peers,
    /**
     * Each actor's processed numbers, which must run from 1 without a gap:
     * every transaction was answered, as accepted or rejected.
     */
    processed() {
      const byActor = new Map<string, Set<number>>();
      for (const { actor, n } of answers) {
        const set = byActor.get(actor) ?? new Set<number>();
        set.add(n);
        byActor.set(actor, set);
      }
      for (const [actor, set] of byActor)
        assert.deepEqual(
          [...set].sort((a, b) => a - b),
          Array.from({ length: set.size }, (_v, i) => i + 1),
          "unanswered transactions of " + actor,
        );
      return answers.length;
    },
    get sequencer() {
      return sequencer;
    },
    /** Replaces the sequencer, as a host does when the leader leaves. */
    setSequencer(next: Sequencer) {
      sequencer = next;
    },
    /** Connects a session's next link to the current sequencer. */
    relink(peer: Peer, options: LinkOptions = {}) {
      peer.close();
      peer.link = createLink({ random: () => random(), ...options });
      peer.close = sequencer.connect(recorded(peer.link));
      peer.session.reconnect(peer.link.editor);
    },
    /** Delivers every link's queue once and lets time pass. */
    pump(ms = 10) {
      for (const peer of peers) peer.link.flush();
      clock.advance(ms);
    },
    /** Delivers reliably until every session is idle and current. */
    settle() {
      for (const peer of peers) peer.link.configure({ loss: 0, duplicate: 0, reorder: false });
      for (let round = 0; round < 2000; round++) {
        for (const peer of peers) peer.link.flush();
        clock.advance(25);
        const revision = sequencer.getSnapshot().revision;
        if (
          peers.every(
            (peer) =>
              peer.link.queued === 0 &&
              peer.session.pending === 0 &&
              peer.session.status === "connected" &&
              peer.session.revision === revision,
          )
        )
          return round;
      }
      assert.fail("The network did not settle");
    },
  };
}

/** The document without its revision, which differs between editors. */
export function documentOf(snapshot: ProjectSnapshot): unknown {
  const { revision: _revision, ...rest } = snapshot;
  return JSON.parse(JSON.stringify(rest));
}

export function editorOf(peer: Peer): Editor {
  const editor = peer.session.editor;
  assert.ok(editor, "The session is not ready");
  return editor;
}

/** A random edit, undo or redo that is valid against this editor's own view. */
export function randomEdit(
  editor: Editor,
  random: (n?: number) => number,
  step: number,
): EditResult {
  const snapshot = editor.getSnapshot();
  const clip = snapshot.clips[random(snapshot.clips.length)];
  assert.ok(clip);
  const listed = clip.takeIds ?? [];
  const choice = random(12);
  if (choice === 0) return editor.history.undo();
  if (choice === 1) return editor.history.redo();
  let command: EditCommand;
  if (choice === 2)
    command = commands.splitClip({ clipId: clip.id, at: clip.start + 1 + random(clip.duration) });
  else if (choice === 3) command = commands.addMarker({ start: random(2000), label: "M" + step });
  else if (choice === 4)
    command = commands.addTake({
      clipIds: [clip.id],
      take: { assetId: "x", streamId: "s", sourceAtContentZero: 0 },
      activate: random(2) === 0,
    });
  else if (choice === 5 && listed.length > 1)
    command = commands.removeTake({ clipId: clip.id, takeId: listed[random(listed.length)] ?? "" });
  else if (choice === 6)
    command = commands.setEntityData({
      scope: "note",
      id: clip.id,
      key: "text",
      value: "n" + step,
    });
  else if (choice === 7)
    command = commands.trimClip({
      clipId: clip.id,
      edge: random(2) ? "left" : "right",
      delta: random(41) - 20,
    });
  else command = commands.moveClips({ clipIds: [clip.id], delta: random(81) - 40 });
  return editor.dispatch(command);
}

/** Every editor of a project can open the document: no rule is broken. */
export function assertValid(snapshot: ProjectSnapshot): void {
  createEditor({ project: snapshot }).dispose();
}
