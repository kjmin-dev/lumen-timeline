import test from "node:test";
import assert from "node:assert/strict";
import { createEditor, commands, unitsToTicks, ticksToUnits } from "@lumen-timeline/core";
import type {
  Clip,
  EditResult,
  ReadHandle,
  StreamBinding,
  StreamCatalog,
  Take,
  TickRange,
  Track,
} from "@lumen-timeline/core";
import { visitRange } from "@lumen-timeline/core/internal";

const sec = (value: number): number => unitsToTicks(value, 1);
const clip = (
  id: string,
  trackId: string,
  start: number,
  duration: number,
  take: string | null = "A",
): Clip => ({
  id,
  trackId,
  kind: "audio",
  start,
  duration,
  contentIn: 0,
  ...(take === null ? {} : { takeIds: [take], activeTakeId: take }),
});
/** One take per ID the clips play, each on its own asset, at the given source positions. */
const takesOf = (clips: readonly Clip[], positions: Record<string, number> = {}): Take[] =>
  [...new Set(clips.flatMap((c) => c.takeIds ?? []))].map((id) => ({
    id,
    assetId: id,
    streamId: "mono",
    sourceAtContentZero: positions[id] ?? 0,
  }));
const open = (
  clips: readonly Clip[],
  tracks: readonly Track[] = [{ id: "voice" }],
  positions?: Record<string, number>,
) =>
  createEditor({ project: { schemaVersion: 1, tracks, clips, takes: takesOf(clips, positions) } });
const binding = (rate: number): StreamBinding => ({
  assetVersion: 1,
  sampleRate: rate,
  availableStart: 0,
  availableEnd: rate * 20,
});
const catalogOf = (
  version: string | number,
  streams: Record<string, StreamBinding>,
): StreamCatalog => ({
  version,
  streams: Object.fromEntries(Object.entries(streams).map(([id, mono]) => [id, { mono }])),
});
const range = (start: number, end: number): TickRange => ({ start, end });
function commit(result: EditResult): void {
  assert.equal(result.ok, true, JSON.stringify(result));
}

test("range query matches an independent seeded oracle, in stable document order", () => {
  let seed = 42;
  const rand = (n: number): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n;
  const tracks = [{ id: "z", mute: true }, { id: "a" }, { id: "empty" }];
  const clips = [clip("long", "a", 0, 3000), clip("no-take", "z", 8, 20, null)];
  for (let i = 0; i < 500; i++)
    clips.push(clip(String(i), tracks[rand(2)].id, rand(2000), rand(40) + 1));
  const e = open(clips, tracks);
  const read = e.read();
  const original = e.getSnapshot().clips;
  for (let i = 0; i < 120; i++) {
    const start = rand(2300) - 50;
    const end = start + rand(120);
    const trackIds = i % 3 ? ["a", "z", "a"] : ["a"];
    const expected = tracks.flatMap((t) =>
      original
        .filter(
          (c) =>
            trackIds.includes(t.id) &&
            c.trackId === t.id &&
            start < end &&
            c.start < end &&
            c.start + c.duration > start,
        )
        .sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1)),
    );
    const actual = read.clipsIn(range(start, end), { trackIds });
    assert.deepEqual(
      actual.map((c) => c.id),
      expected.map((c) => c.id),
    );
    assert.ok(actual.every((c, j) => c === expected[j]));
  }
  assert.deepEqual(read.clipsIn(range(100, 100)), []);
  assert.deepEqual(read.clipsIn(range(0, 40), { trackIds: ["empty"] }), []);
  assert.throws(() => read.clipsIn(range(20, 10)), /range/);
  assert.throws(() => read.clipsIn(range(0, Infinity)), /range/);
  assert.throws(() => read.clipsIn(range(0, 10), { trackIds: ["missing"] }), /track/);
});

test("old snapshots and reentrant notifications retain their own layout", () => {
  const e = open([clip("line", "voice", 1, 3)]);
  const pinned = e.read();
  const queried: number[] = [];
  e.subscribe(
    (s) => s.revision,
    (r) => {
      if (r === 1) commit(e.history.undo());
    },
  );
  e.subscribe(
    (s) => s,
    (snapshot) => queried.push(e.read(snapshot).clipsIn(range(1, 4)).length),
  );
  commit(e.dispatch(commands.moveClips({ clipIds: ["line"], delta: 10 })));
  commit(e.history.redo());
  assert.deepEqual(queried, [0, 1, 0]);
  assert.equal(pinned.clipsIn(range(1, 4)).length, 1);
  assert.equal(e.read().clipsIn(range(1, 4)).length, 0);
  assert.throws(() => e.read(open([]).getSnapshot()), /snapshot/);
});

test("queries prune sparse windows without losing long overlaps or dense matches", () => {
  const clips = [
    clip("long", "voice", 0, 50000),
    ...Array.from({ length: 499 }, (_, i) => clip(String(i), "voice", 100 + i * 80, 2)),
  ];
  const found: string[] = [];
  const visits = visitRange(clips, 35001, 35010, (c) => found.push(c.id));
  assert.ok(visits < 50, String(visits));
  assert.deepEqual(found, ["long"]);
  const dense = Array.from({ length: 500 }, (_, i) => clip(String(i), "voice", 0, 40000));
  let emitted = 0;
  visitRange(dense, 35001, 35010, () => emitted++);
  assert.equal(emitted, 500);
});

test("worked plan preserves absolute source samples across split, move and undo", () => {
  for (const rate of [44100, 48000]) {
    const e = open([{ ...clip("line", "voice", sec(12), sec(4)), contentIn: sec(1) }]);
    const first = e.read();
    const catalog = catalogOf("v1", { A: binding(rate) });
    function check(read: ReadHandle, pos: number, id: string): void {
      const q = range(unitsToTicks(pos, 10), unitsToTicks(pos + 1, 10));
      const plan = read.planAudio(q, catalog);
      assert.equal(plan.revision, read.revision);
      assert.equal(plan.catalogVersion, "v1");
      assert.deepEqual(plan.issues, []);
      assert.equal(plan.spans.length, 1);
      const span = plan.spans[0];
      assert.equal(span.clipId, id);
      assert.deepEqual(span.window, {
        ...q,
        sourceStart: (rate * 32) / 10,
        sourceEnd: (rate * 33) / 10,
      });
      assert.ok(span.audible.end > q.end);
    }
    check(first, 142, "line");
    commit(e.dispatch(commands.splitClip({ clipId: "line", at: sec(14), rightId: "right" })));
    check(e.read(), 142, "right");
    commit(e.dispatch(commands.moveClips({ clipIds: ["right"], delta: sec(2) })));
    check(e.read(), 162, "right");
    check(first, 142, "line");
    commit(e.history.undo());
    check(e.read(), 142, "right");
    assert.equal(e.history.undoDepth, 1);
  }
});

test("silent slots, unavailable samples and missing bindings leave other voices audible", () => {
  const rate = 48000;
  const clips = ["good", "bad", "long", "missing", "blank", "silent"].map((id) => ({
    ...clip(id, "voice", sec(12), sec(4), id === "blank" ? null : id),
    contentIn: sec(1),
  }));
  const e = open(clips, undefined, { good: -unitsToTicks(15, 10) });
  const plan = e.read().planAudio(
    range(sec(12), sec(16)),
    catalogOf(0, {
      good: { ...binding(rate), availableEnd: rate * 2 },
      long: binding(rate),
      bad: { ...binding(rate), sampleRate: 0 },
      silent: { ...binding(rate), availableEnd: 0 },
    }),
  );
  assert.deepEqual(
    plan.spans.map((s) => s.clipId),
    ["good", "long"],
  );
  assert.deepEqual(plan.spans[0].audible, {
    start: unitsToTicks(125, 10),
    end: unitsToTicks(145, 10),
    sourceStart: 0,
    sourceEnd: rate * 2,
  });
  assert.deepEqual(
    plan.issues.map((i) => i.code),
    ["invalid-stream", "unresolved-stream"],
  );
  assert.equal(e.getSnapshot().revision, 0);
  assert.equal(e.history.undoDepth, 0);
});

test("mute overrides solo; track gain and each overlapping voice survive planning", () => {
  const tracks = [
    { id: "bed" },
    { id: "voice", solo: true, gain: 0.4 },
    { id: "guide", solo: true, mute: true },
  ];
  const e = open(
    [
      clip("bed", "bed", 0, sec(1)),
      clip("b", "voice", 0, sec(1)),
      clip("a", "voice", 0, sec(1)),
      clip("guide", "guide", 0, sec(1)),
    ],
    tracks,
  );
  const q = range(0, sec(1));
  assert.deepEqual(
    e
      .read()
      .clipsIn(q)
      .map((c) => c.id),
    ["bed", "a", "b", "guide"],
  );
  assert.deepEqual(
    e
      .read()
      .planAudio(q, catalogOf(1, { A: binding(48000) }))
      .spans.map((s) => [s.clipId, s.gain]),
    [
      ["a", 0.4],
      ["b", 0.4],
    ],
  );
});

test("fractional-frame cut produces the same shared native sample on both sides", () => {
  const cut = unitsToTicks(7, 30000, 1001);
  for (const rate of [44100, 48000, 90001]) {
    const e = open([clip("a", "voice", 0, sec(1))]);
    commit(e.dispatch(commands.splitClip({ clipId: "a", at: cut, rightId: "b" })));
    const catalog = catalogOf(1, { A: binding(rate) });
    const [a, b] = e.read().planAudio(range(0, sec(1)), catalog).spans;
    assert.equal(a.window.sourceEnd, b.window.sourceStart);
    assert.equal(b.window.sourceStart, ticksToUnits(cut, rate));
    assert.equal(b.window.sourceEnd, rate);
    assert.deepEqual(e.read().planAudio(range(0, 1), catalog).spans, []);
  }
});
