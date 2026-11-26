// The roadmap's edit precision target: 1,000 deterministic trim, split and move operations with
// undo and redo, and no unintended duration change, duplicate boundary sample or ID regenerated
// on redo.
import assert from "node:assert/strict";
import test from "node:test";
import { commands, createEditor, ticksToUnits, TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import type { Clip, EditCommand, StreamCatalog } from "@lumen-timeline/core";
import { commit } from "./support.ts";

/** A seeded generator: the same seed gives the same trace. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A source two hours long at a rate that divides no tick count evenly. Every clip starts well
// inside it, so trims never reach past either end of the source.
const rate = 44100;
const catalog: StreamCatalog = {
  version: 1,
  streams: {
    source: {
      mono: { assetVersion: 1, sampleRate: rate, availableStart: 0, availableEnd: rate * 7200 },
    },
  },
};
const clip = (id: string, trackId: string, start: number, seconds: number, contentIn: number) => ({
  id,
  trackId,
  kind: "audio" as const,
  start,
  duration: seconds * hz,
  contentIn,
  takeIds: ["take"],
  activeTakeId: "take",
});
const end = (c: Clip): number => c.start + c.duration;

for (const seed of [1, 2, 3]) {
  test(`1,000 seeded trims, splits and moves keep durations, boundary samples and IDs (seed ${seed})`, () => {
    const editor = createEditor({
      project: {
        schemaVersion: 2,
        duration: 7200 * hz,
        tracks: [{ id: "one" }, { id: "two" }, { id: "three" }],
        clips: [
          clip("a", "one", 0, 600, 1500 * hz),
          clip("b", "two", 30 * hz, 900, 1200 * hz),
          clip("c", "three", 7 * hz + 13, 300, 3000 * hz + 7),
        ],
        takes: [{ id: "take", assetId: "source", streamId: "mono", sourceAtContentZero: 0 }],
      },
      history: { maxEntries: 1000 },
    });
    const initial = editor.getSnapshot();
    const random = seeded(seed);
    const pick = <T>(items: readonly T[]): T => {
      const item = items[Math.floor(random() * items.length)];
      assert.ok(item !== undefined);
      return item;
    };
    // A tick that falls between samples more often than not.
    const offset = (span: number): number => 1 + Math.floor(random() * (span - 1));
    const created: (readonly string[])[] = [];
    const counts = { split: 0, move: 0, trim: 0, refused: 0 };

    while (created.length < 1000) {
      const before = editor.getSnapshot();
      const target = pick(before.clips);
      const kind = pick(["split", "move", "trim"] as const);
      let command: EditCommand;
      let delta = 0;
      let edge: "left" | "right" = "left";
      let trackId: string | undefined;
      if (kind === "split") {
        if (target.duration < 2) continue;
        command = commands.splitClip({
          clipId: target.id,
          at: target.start + offset(target.duration),
        });
      } else if (kind === "move") {
        delta = Math.round((random() - 0.5) * 20 * hz);
        trackId = random() < 0.3 ? pick(before.tracks).id : undefined;
        command = commands.moveClips({ clipIds: [target.id], delta, trackId });
      } else {
        edge = pick(["left", "right"] as const);
        delta = Math.round((random() - 0.5) * Math.min(target.duration, 10 * hz));
        command = commands.trimClip({ clipId: target.id, edge, delta });
      }
      const result = editor.dispatch(command);
      const after = editor.getSnapshot();
      if (!result.ok || result.unchanged) {
        // A refused edit, or one that moves nothing, changes nothing and is not counted.
        counts.refused++;
        assert.equal(after, before);
        continue;
      }
      counts[kind]++;
      created.push(result.createdIds);
      assert.equal(after.duration, before.duration, "the project's duration changed");
      const others = (c: Clip) => c.id !== target.id && !result.createdIds.includes(c.id);
      assert.deepEqual(after.clips.filter(others), before.clips.filter(others));
      const now = after.clips.find((c) => c.id === target.id);
      assert.ok(now);
      if (kind === "split") {
        // The halves cover the clip exactly and share the sample at the cut.
        assert.equal(result.createdIds.length, 1);
        const right = after.clips.find((c) => c.id === result.createdIds[0]);
        assert.ok(right && !before.clips.some((c) => c.id === right.id));
        assert.equal(now.start, target.start);
        assert.equal(end(now), right.start);
        assert.equal(end(right), end(target));
        assert.equal(right.contentIn, target.contentIn + (right.start - target.start));
        // Both sides of the cut meet on one source sample. A half shorter than a sample plays
        // nothing and is not planned.
        const cut = ticksToUnits(right.contentIn, rate);
        const spans = editor.read().planAudio({ start: now.start, end: end(right) }, catalog).spans;
        const left = spans.find((s) => s.clipId === now.id);
        const next = spans.find((s) => s.clipId === right.id);
        const samples = (c: Clip) =>
          ticksToUnits(c.contentIn + c.duration, rate) - ticksToUnits(c.contentIn, rate);
        if (left) assert.equal(left.window.sourceEnd, cut);
        else assert.equal(samples(now), 0);
        if (next) assert.equal(next.window.sourceStart, cut);
        else assert.equal(samples(right), 0);
      } else if (kind === "move") {
        // A move changes where a clip is, never how long it is or what it plays.
        assert.deepEqual(result.createdIds, []);
        assert.deepEqual(now, {
          ...target,
          start: target.start + delta,
          trackId: trackId ?? target.trackId,
        });
      } else {
        // A trim changes the duration by exactly what it moved the edge, and nothing else.
        assert.deepEqual(result.createdIds, []);
        assert.deepEqual(
          now,
          edge === "left"
            ? {
                ...target,
                start: target.start + delta,
                duration: target.duration - delta,
                contentIn: target.contentIn + delta,
              }
            : { ...target, duration: target.duration + delta },
        );
      }
    }
    assert.ok(
      [counts.split, counts.move, counts.trim].every((n) => n > 250),
      JSON.stringify(counts),
    );

    const final = editor.getSnapshot();
    for (const c of final.clips)
      assert.ok(c.contentIn >= 0 && c.contentIn + c.duration <= 7200 * hz);
    for (let i = 0; i < 1000; i++) commit(editor.history.undo());
    assert.deepEqual(editor.getSnapshot().clips, initial.clips);
    assert.equal(editor.history.canUndo, false);
    // Redo replays every edit with the IDs it first created.
    for (let i = 0; i < 1000; i++)
      assert.deepEqual(commit(editor.history.redo()).createdIds, created[i]);
    assert.deepEqual(editor.getSnapshot().clips, final.clips);
    assert.equal(editor.getSnapshot().revision, 3000);
    editor.dispose();
  });
}
