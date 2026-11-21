import assert from "node:assert/strict";
import test from "node:test";
import { commands, createEditor, watchMarkerCrossings } from "@lumen-timeline/core";
import type {
  Editor,
  Marker,
  MarkerCrossing,
  PresentationSource,
  PresentationState,
} from "@lumen-timeline/core";
import { commit } from "./support.ts";

/** A transport stand-in: `play` advances within a segment, `seek` starts a new one. */
class Presentation implements PresentationSource {
  state: PresentationState;
  readonly listeners = new Set<(state: PresentationState) => void>();
  unsubscribes = 0;
  constructor(tick = 0) {
    this.state = { presentedTick: tick, segment: 0, segmentStart: tick };
  }
  snapshot(): PresentationState {
    return this.state;
  }
  subscribe(listener: (state: PresentationState) => void): () => boolean {
    this.listeners.add(listener);
    return () => {
      this.unsubscribes++;
      return this.listeners.delete(listener);
    };
  }
  play(tick: number): void {
    this.emit({ ...this.state, presentedTick: tick });
  }
  seek(tick: number, presented = tick): void {
    this.emit({ presentedTick: presented, segment: this.state.segment + 1, segmentStart: tick });
  }
  emit(state: PresentationState): void {
    this.state = state;
    // oxlint-disable-next-line unicorn/no-useless-spread -- A listener may unsubscribe during delivery, so iterate a snapshot.
    for (const listener of [...this.listeners]) listener(state);
  }
}

function editor(markers: Marker[], duration = 1000): Editor {
  return createEditor({ project: { schemaVersion: 1, duration, tracks: [], clips: [], markers } });
}
function watch(e: Editor, source: PresentationSource) {
  const crossings: MarkerCrossing[] = [];
  const stop = watchMarkerCrossings(e, source, (crossing) => crossings.push(crossing));
  const ids = () => crossings.flatMap((c) => c.markers.map((m) => m.id));
  return { crossings, stop, ids };
}
const marks = (...starts: number[]): Marker[] => starts.map((start, i) => ({ id: "m" + i, start }));

test("playback reports markers in (previous, current] order, each once", () => {
  const e = editor([...marks(0, 10, 20, 20, 30), { id: "a", start: 20 }]);
  const p = new Presentation();
  const { crossings, ids } = watch(e, p);
  p.play(5);
  assert.equal(crossings.length, 0);
  p.play(20);
  assert.deepEqual(ids(), ["m1", "a", "m2", "m3"]);
  assert.deepEqual(
    { after: crossings[0].after, through: crossings[0].through, revision: crossings[0].revision },
    { after: 5, through: 20, revision: 0 },
  );
  assert.ok(Object.isFrozen(crossings[0]));
  p.play(20);
  p.play(29);
  assert.equal(crossings.length, 1);
  p.play(30);
  assert.deepEqual(crossings.at(-1)?.markers, [{ id: "m4", start: 30 }]);
});

test("a seek skips markers, including one at its destination, and playback resumes from it", () => {
  const e = editor(marks(10, 20, 30, 40));
  const p = new Presentation();
  const { crossings, ids } = watch(e, p);
  p.seek(20);
  p.seek(35);
  assert.equal(crossings.length, 0);
  p.play(40);
  assert.deepEqual(ids(), ["m3"]);
  // Backwards, then forwards across markers already passed in an earlier segment.
  p.seek(5);
  p.play(25);
  assert.deepEqual(ids(), ["m3", "m0", "m1"]);
  assert.deepEqual([crossings[1].after, crossings[1].through], [5, 25]);
});

test("a segment continues from its start, not from the first position reported in it", () => {
  const e = editor(marks(100, 101, 104));
  const p = new Presentation();
  const { crossings, ids } = watch(e, p);
  // An audio seek is first reported a little after its target.
  p.seek(100, 102);
  assert.deepEqual(ids(), ["m1"]);
  assert.deepEqual([crossings[0].after, crossings[0].through], [100, 102]);
  // A video frame slightly before the furthest position does not repeat a crossing.
  p.play(101);
  p.play(103);
  assert.equal(crossings.length, 1);
  p.play(104);
  assert.deepEqual(ids(), ["m1", "m2"]);
});

test("crossings read the current revision, so edits during playback take effect", () => {
  const e = editor(marks(50));
  const p = new Presentation();
  const { crossings, ids } = watch(e, p);
  p.play(10);
  commit(e.dispatch(commands.addMarker({ id: "ahead", start: 30 })));
  commit(e.dispatch(commands.addMarker({ id: "behind", start: 5 })));
  commit(e.dispatch(commands.removeMarker({ markerId: "m0" })));
  p.play(60);
  assert.deepEqual(ids(), ["ahead"]);
  assert.equal(crossings[0].revision, e.getSnapshot().revision);
});

test("listener errors are reported without ending the watch; stopping is idempotent", (t) => {
  const reported: unknown[] = [];
  // Node has no reportError, so install one for the duration of the test.
  assert.equal(Reflect.get(globalThis, "reportError"), undefined);
  Reflect.set(globalThis, "reportError", (error: unknown) => reported.push(error));
  t.after(() => Reflect.deleteProperty(globalThis, "reportError"));
  const e = editor(marks(10, 20));
  const p = new Presentation();
  let calls = 0;
  const stop = watchMarkerCrossings(e, p, () => {
    calls++;
    throw new Error("listener failed");
  });
  p.play(15);
  p.play(25);
  assert.equal(calls, 2);
  assert.deepEqual(
    reported.map((error) => (error instanceof Error ? error.message : error)),
    ["listener failed", "listener failed"],
  );
  assert.equal(stop(), true);
  assert.equal(stop(), false);
  assert.equal(p.listeners.size, 0);
  p.seek(0);
  p.play(30);
  assert.equal(calls, 2);
});

test("seeded traces match a per-segment oracle", () => {
  let seed = 0x2f6b;
  const random = (n: number): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  for (let trial = 0; trial < 300; trial++) {
    const markers = Array.from({ length: random(12) }, (_, i) => ({
      id: "m" + i,
      start: random(200),
    }));
    const e = editor(markers, 200);
    const sorted = e.getSnapshot().markers ?? [];
    const start = random(200);
    const p = new Presentation(start);
    const { crossings, ids } = watch(e, p);
    // Each segment crosses the markers after its start through its furthest tick.
    const segments = [{ start, furthest: start }];
    for (let step = 0; step < 40; step++) {
      const current = p.state.presentedTick;
      const roll = random(10);
      const segment = segments[segments.length - 1];
      if (roll < 2) {
        const target = random(200);
        const shown = Math.min(200, target + random(3));
        p.seek(target, shown);
        segments.push({ start: target, furthest: Math.max(target, shown) });
      } else if (roll < 3) {
        p.play(Math.max(0, current - random(3)));
      } else {
        const next = Math.min(200, current + random(25));
        p.play(next);
        segment.furthest = Math.max(segment.furthest, next);
      }
    }
    const expected = segments.flatMap(({ start: from, furthest }) =>
      sorted.filter((m) => m.start > from && m.start <= furthest).map((m) => m.id),
    );
    assert.deepEqual(ids(), expected, `trial ${trial}`);
    for (const c of crossings) {
      assert.ok(c.markers.length > 0);
      for (const m of c.markers) assert.ok(m.start > c.after && m.start <= c.through);
    }
  }
});
