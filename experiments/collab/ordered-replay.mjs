// Three editors edit the same synced state at once. A sequencer, here another
// headless editor, applies their commands in an arbitrary order, and every
// editor replays the accepted log. Do they converge with the invariants intact?
import { commands, createEditor, TICKS_PER_SECOND as hz } from "@lumen-timeline/core";

let seed = 5;
// The high bits of this generator are well mixed; its low bits repeat quickly.
const rnd = (n) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return Math.floor((seed / 2147483648) * n);
};
const pick = (xs) => xs[rnd(xs.length)];
const project = () => ({
  schemaVersion: 1,
  duration: 120 * hz,
  tracks: [{ id: "voice", overlap: "exclusive" }],
  clips: [0, 1, 2, 3].map((i) => ({
    id: "c" + i,
    trackId: "voice",
    kind: "audio",
    start: (10 + 20 * i) * hz,
    duration: 8 * hz,
    contentIn: 2 * hz,
    takeIds: ["a", "b"],
    activeTakeId: "a",
  })),
  takes: ["a", "b"].map((id) => ({ id, assetId: id, streamId: "s", sourceAtContentZero: 0 })),
});
let ids = 0;
// Every command names the IDs it creates, so a replay creates the same ones.
const intent = (snapshot, actor) => {
  const clip = pick(snapshot.clips);
  const d = (rnd(9) - 4) * hz || hz;
  const listed = clip.takeIds ?? [];
  switch (rnd(8)) {
    case 0:
      return commands.moveClips({ clipIds: [clip.id], delta: d * 3 });
    case 1:
      return commands.trimClip({ clipId: clip.id, edge: "left", delta: d / 4 });
    case 2:
      return commands.trimClip({ clipId: clip.id, edge: "right", delta: d / 4 });
    case 3:
      return commands.splitClip({
        clipId: clip.id,
        at: clip.start + 1 + rnd(clip.duration - 1),
        rightId: actor + "-" + ++ids,
      });
    case 4:
      return commands.selectTake({ clipId: clip.id, takeId: pick(listed) ?? null });
    case 5:
      return commands.addTake({
        clipIds: [clip.id],
        take: {
          id: actor + "-" + ++ids,
          assetId: "gen",
          streamId: "s",
          sourceAtContentZero: -clip.contentIn,
        },
      });
    case 6:
      return listed.length
        ? commands.updateTake({
            takeId: pick(listed),
            clipIds: [clip.id],
            newId: actor + "-" + ++ids,
            label: "edit " + ids,
          })
        : commands.pruneTakes();
    default:
      return listed.length
        ? commands.removeTake({ clipId: clip.id, takeId: pick(listed) })
        : commands.addMarker({ id: actor + "-" + ++ids, start: rnd(120) * hz });
  }
};
const sequencer = createEditor({ project: project() });
const editors = ["A", "B", "C"].map((actor) => ({
  actor,
  editor: createEditor({ project: project() }),
}));
const rejected = {};
const rounds = Number(process.argv[2] ?? 600);
let sent = 0;
let accepted = 0;
let diverged = 0;
let overlaps = 0;
let sameClip = 0;
for (let round = 0; round < rounds; round++) {
  // Each editor sends only a command that is valid against its own view.
  const batch = editors.map((c) => {
    for (;;) {
      const command = intent(c.editor.getSnapshot(), c.actor);
      if (createEditor({ project: c.editor.getSnapshot() }).dispatch(command).ok) return command;
    }
  });
  const targets = batch.map((c) => c.clipId ?? c.clipIds?.[0]);
  if (new Set(targets).size < targets.length) sameClip++;
  batch.sort(() => rnd(3) - 1);
  const log = [];
  for (const command of batch) {
    sent++;
    const result = sequencer.dispatch(command, { history: "ignore" });
    if (result.ok) {
      accepted++;
      log.push(command);
    } else rejected[result.code] = (rejected[result.code] ?? 0) + 1;
  }
  for (const c of editors)
    for (const command of log) c.editor.dispatch(command, { history: "ignore" });
  const truth = JSON.stringify(sequencer.getSnapshot());
  if (editors.some((c) => JSON.stringify(c.editor.getSnapshot()) !== truth)) diverged++;
  const lane = [...sequencer.getSnapshot().clips].sort((a, b) => a.start - b.start);
  if (lane.some((c, i) => i > 0 && lane[i - 1].start + lane[i - 1].duration > c.start)) overlaps++;
}
console.log({
  rounds,
  sent,
  accepted,
  rejectedAfterOrdering: rejected,
  roundsTouchingOneClipTwice: sameClip,
  divergedRounds: diverged,
  roundsWithOverlap: overlaps,
});
if (diverged || overlaps) process.exitCode = 1;
