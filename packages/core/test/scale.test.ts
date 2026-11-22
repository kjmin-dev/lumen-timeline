import assert from "node:assert/strict";
import test from "node:test";
import { commands, createEditor, TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import type { EditCommand, Editor, Project } from "@lumen-timeline/core";
import { commit } from "./support.ts";

// A project of `tracks` tracks with 400 clips each, one take per clip, and markers.
function project(tracks: number): Project {
  const clips = [];
  const takes = [];
  for (let t = 0; t < tracks; t++)
    for (let k = 0; k < 400; k++) {
      const id = `c${t}-${k}`;
      clips.push({
        id,
        trackId: "t" + t,
        kind: "audio",
        start: k * 15 * hz,
        duration: 10 * hz,
        contentIn: 0,
        takeIds: ["k" + id],
        activeTakeId: "k" + id,
      });
      takes.push({
        id: "k" + id,
        assetId: "a" + (k % 7),
        streamId: "mono",
        sourceAtContentZero: 0,
      });
    }
  return {
    schemaVersion: 1,
    duration: 7000 * hz,
    tracks: Array.from({ length: tracks }, (_, t) => ({ id: "t" + t, overlap: "exclusive" })),
    clips,
    takes,
    markers: Array.from({ length: tracks * 10 }, (_, i) => ({ id: "m" + i, start: i * hz })),
  };
}

// Edits that add or remove no record. Each returns the command of step `i`.
const edits: Record<string, (e: Editor, i: number) => EditCommand> = {
  "a clip move": (_, i) =>
    commands.moveClips({ clipIds: ["c0-" + (i % 300)], delta: (i % 2 ? -1 : 1) * hz }),
  "a field of entity data": (_, i) =>
    commands.setEntityData({ scope: "notes", id: "c0-" + (i % 50), key: "text", value: i }),
  "a take choice": (e, i) =>
    commands.selectTake({
      clipId: "c0-" + (i % 300),
      takeId: e.getSnapshot().clips[i % 300]?.activeTakeId ? null : "kc0-" + (i % 300),
    }),
  "a take label": (_, i) => commands.updateTake({ takeId: "kc0-" + (i % 300), label: "L" + i }),
};

// The median time of one commit, least over a few rounds, in milliseconds.
function cost(tracks: number, edit: (e: Editor, i: number) => EditCommand): number {
  const e = createEditor({ project: project(tracks) });
  let best = Infinity;
  let step = 0;
  for (let round = 0; round < 7; round++) {
    const times: number[] = [];
    for (let n = 0; n < 60; n++, step++) {
      const start = performance.now();
      commit(e.dispatch(edit(e, step)));
      e.read().takesOf("c0-" + (step % 300));
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    best = Math.min(best, times[30] ?? Infinity);
  }
  return best;
}

// The median of some times, in milliseconds.
const median = (times: number[]): number =>
  times.toSorted((a, b) => a - b)[Math.floor(times.length / 2)] ?? Infinity;

// An editor that follows another takes the records of the snapshot it is
// handed. A copy of that snapshot is parsed, validated and frozen again, clip
// by clip: at this size some hundred times the work, of which a tenth
// leaves room for the machine's noise.
test("replacing by another editor's snapshot does not parse it", () => {
  const confirmed = createEditor({ project: project(32) });
  const handed = createEditor({ project: confirmed.getSnapshot() });
  const copied = createEditor({ project: confirmed.getSnapshot() });
  const times = { handed: [0], copied: [0] };
  for (let i = 0; i < 12; i++) {
    const delta = (i % 2 ? -1 : 1) * hz;
    commit(confirmed.dispatch(commands.moveClips({ clipIds: ["c0-" + (i % 300)], delta })));
    const target = confirmed.getSnapshot();
    const copy: Project = JSON.parse(JSON.stringify(target));
    let start = performance.now();
    commit(handed.replace(target));
    handed.read().takesOf("c0-" + (i % 300));
    times.handed[i] = performance.now() - start;
    start = performance.now();
    commit(copied.replace(copy));
    copied.read().takesOf("c0-" + (i % 300));
    times.copied[i] = performance.now() - start;
  }
  assert.deepEqual(handed.getSnapshot(), copied.getSnapshot());
  const [snapshot, copy] = [median(times.handed), median(times.copied)];
  assert.ok(
    snapshot * 10 < copy,
    `${snapshot.toFixed(3)} ms for the snapshot against ${copy.toFixed(3)} ms for a copy of it`,
  );
});

// Such an edit copies the list it changes as a block, microseconds at this
// size, and looks up only the records it names. A map or a scan of every clip,
// take or marker per commit would make the large project cost near sixteen
// times the small one; a quarter of that leaves room for the machine's noise.
test("a commit and the read after it cost the same in a project sixteen times larger", () => {
  for (const [name, edit] of Object.entries(edits)) {
    const small = cost(2, edit);
    const large = cost(32, edit);
    assert.ok(
      large < 4 * small + 0.03,
      `${name}: ${large.toFixed(3)} ms at 12,800 clips against ${small.toFixed(3)} ms at 800`,
    );
  }
});
