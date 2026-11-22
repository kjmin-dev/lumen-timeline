import assert from "node:assert/strict";
import test from "node:test";
import { clipFieldChanges, commands, createEditor } from "@lumen-timeline/core";
import type { Clip, EditCommand, Editor, Project } from "@lumen-timeline/core";
import { applyClips } from "@lumen-timeline/core/internal";
import { codeOf, commit, pass } from "./support.ts";

const clip = (id: string, start: number, trackId = "voice"): Clip => ({
  id,
  trackId,
  kind: "audio",
  start,
  duration: 100,
  contentIn: 50,
});
const project = (): Project => ({
  schemaVersion: 1,
  duration: 10000,
  tracks: [{ id: "voice", overlap: "exclusive" }, { id: "mix" }],
  clips: [clip("a", 1000), clip("b", 3000), clip("m", 0, "mix")],
});
const ignore = { history: "ignore" } as const;
const move = (id: string, delta: number, trackId?: string): EditCommand =>
  commands.moveClips({ clipIds: [id], delta, trackId });
const trim = (id: string, edge: "left" | "right", delta: number): EditCommand =>
  commands.trimClip({ clipId: id, edge, delta });
const split = (id: string, at: number, rightId: string): EditCommand =>
  commands.splitClip({ clipId: id, at, rightId });
const placement = (e: Editor, id: string): number[] => {
  const c = e.getSnapshot().clips.find((x) => x.id === id);
  assert.ok(c, id);
  return [c.start, c.duration, c.contentIn];
};
const ids = (e: Editor): string[] => e.getSnapshot().clips.map((c) => c.id);

test("a commit records each clip change by ID, and a new clip names the one it follows", () => {
  const e = createEditor({ project: project() });
  const first = e.getSnapshot().clips;
  const moved = commit(e.dispatch(move("b", 10)));
  assert.deepEqual(moved.clipPatches, [
    { id: "b", before: first[1], after: { ...first[1], start: 3010 } },
  ]);
  assert.equal(moved.clipPatches[0]?.before, first[1]);
  const cut = commit(e.dispatch([split("a", 1040, "a2"), split("a2", 1070, "a3")]));
  assert.deepEqual(
    cut.clipPatches.map((p) => [p.id, p.before?.duration, p.after?.duration, p.follows]),
    [
      ["a", 100, 40, undefined],
      ["a2", undefined, 30, "a"],
      ["a3", undefined, 30, "a2"],
    ],
  );
  assert.deepEqual(ids(e), ["a", "a2", "a3", "b", "m"]);
  const undo = commit(e.history.undo());
  assert.equal(undo.clipPatches, cut.inverseClipPatches);
  assert.deepEqual(
    undo.clipPatches.map((p) => [p.id, p.after?.duration, p.follows]),
    [
      ["a", 100, undefined],
      ["a2", undefined, "a"],
      ["a3", undefined, "a2"],
    ],
  );
  assert.deepEqual(ids(e), ["a", "b", "m"]);
  // Redo puts the new clips back after the clip they were cut from.
  pass(e.dispatch(split("m", 50, "m2"), ignore));
  pass(e.history.redo());
  assert.deepEqual(ids(e), ["a", "a2", "a3", "b", "m", "m2"]);
});

test("a clip patch reports its changes by field, with placement in content space", () => {
  const e = createEditor({ project: project() });
  const changes = (command: EditCommand | EditCommand[]) =>
    commit(e.dispatch(command)).clipPatches.map((p) => clipFieldChanges(p));
  assert.deepEqual(changes(move("a", 7)), [
    { placement: { origin: { before: 950, after: 957 } }, fields: {} },
  ]);
  assert.deepEqual(changes(trim("a", "left", 5)), [
    { placement: { in: { before: 50, after: 55 } }, fields: {} },
  ]);
  assert.deepEqual(changes(trim("a", "right", -5)), [
    { placement: { out: { before: 150, after: 145 } }, fields: {} },
  ]);
  assert.deepEqual(changes(move("b", 0, "mix")), [
    { placement: {}, fields: { trackId: { before: "voice", after: "mix" } } },
  ]);
  // The left half of a split changes only its right edge. An added clip changes no field.
  assert.deepEqual(changes(split("a", 1050, "a2")), [
    { placement: { out: { before: 145, after: 93 } }, fields: {} },
    { placement: {}, fields: {} },
  ]);
  const [last] = commit(e.dispatch(move("m", 1))).clipPatches;
  assert.ok(last && Object.isFrozen(clipFieldChanges(last)));
});

test("undo keeps what unrelated edits did to the same clip since", () => {
  // A left trim, then a move: undo restores the edge where the move put the clip.
  const e = createEditor({ project: project() });
  commit(e.dispatch(trim("a", "left", 20)));
  commit(e.dispatch(move("a", 500), ignore));
  assert.deepEqual(placement(e, "a"), [1520, 80, 70]);
  pass(e.history.undo());
  assert.deepEqual(placement(e, "a"), [1500, 100, 50]);
  pass(e.history.redo());
  assert.deepEqual(placement(e, "a"), [1520, 80, 70]);

  // A move, then both trims: undo moves the trimmed clip's content back.
  const f = createEditor({ project: project() });
  commit(f.dispatch(move("a", 500)));
  commit(f.dispatch([trim("a", "left", 20), trim("a", "right", -10)], ignore));
  pass(f.history.undo());
  assert.deepEqual(placement(f, "a"), [1020, 70, 70]);

  // A split, then a left trim of its left half: undo restores only the right edge.
  const g = createEditor({ project: project() });
  commit(g.dispatch(split("a", 1060, "a2")));
  commit(g.dispatch(trim("a", "left", 10), ignore));
  pass(g.history.undo());
  assert.deepEqual(placement(g, "a"), [1010, 90, 60]);
  assert.deepEqual(ids(g), ["a", "b", "m"]);

  // A right trim, then a move to another track.
  const h = createEditor({ project: project() });
  commit(h.dispatch(trim("a", "right", -30)));
  commit(h.dispatch(move("a", 0, "mix"), ignore));
  pass(h.history.undo());
  assert.deepEqual(placement(h, "a"), [1000, 100, 50]);
  assert.equal(h.getSnapshot().clips[0]?.trackId, "mix");
});

test("undo still conflicts on the field it owns and on the rules of the result", () => {
  const cases: [EditCommand, EditCommand][] = [
    [move("a", 10), move("a", 5)],
    [trim("a", "left", 10), trim("a", "left", 5)],
    [trim("a", "right", -10), trim("a", "right", -5)],
    [move("a", 0, "mix"), move("a", 0, "mix")],
    // Undoing the trim would extend the clip into the one that moved next to it.
    [trim("a", "right", -40), move("b", -1940)],
  ];
  for (const [recorded, later] of cases.slice(0, 3)) {
    const e = createEditor({ project: project() });
    commit(e.dispatch(recorded));
    commit(e.dispatch(later, ignore));
    const before = e.getSnapshot();
    assert.equal(codeOf(e.history.undo()), "history-conflict", JSON.stringify(recorded));
    assert.equal(e.getSnapshot(), before);
  }
  const e = createEditor({ project: project() });
  commit(e.dispatch(move("a", 0, "mix")));
  commit(e.dispatch(move("a", 0, "voice"), ignore));
  assert.equal(codeOf(e.history.undo()), "history-conflict");
  const [recorded, later] = cases[4] ?? [];
  assert.ok(recorded && later);
  const f = createEditor({ project: project() });
  commit(f.dispatch(recorded));
  commit(f.dispatch(later, ignore));
  assert.deepEqual(placement(f, "b"), [1060, 100, 50]);
  assert.equal(codeOf(f.history.undo()), "history-conflict");
  // The merged clip must still be valid: here its left edge would pass its right edge.
  const h = createEditor({ project: project() });
  commit(h.dispatch(trim("a", "left", -40)));
  commit(h.dispatch(trim("a", "right", -120), ignore));
  assert.deepEqual(placement(h, "a"), [960, 20, 10]);
  assert.equal(codeOf(h.history.undo()), "history-conflict");
  // An edit of a clip that is gone has nothing to apply to.
  const k = createEditor({ project: project() });
  commit(k.dispatch(split("a", 1060, "a2")));
  commit(k.dispatch(move("a2", 100)));
  pass(k.history.undo());
  pass(k.history.undo());
  assert.equal(k.history.discard("redo"), true);
  assert.equal(codeOf(k.history.redo()), "history-conflict");
  assert.deepEqual(ids(k), ["a", "b", "m"]);
  // A removed clip must be exactly the recorded one.
  const g = createEditor({ project: project() });
  commit(g.dispatch(split("a", 1060, "a2")));
  commit(g.dispatch(move("a2", 100), ignore));
  assert.equal(codeOf(g.history.undo()), "history-conflict");
});

// For random pairs of edits on one clip, one recorded and one ignored: undo
// succeeds exactly when the two wrote different content-space fields, and then
// leaves what the ignored edit alone would have produced. Redo returns to both.
test("seeded pairs replay by content-space ownership and match applying the edits", () => {
  let seed = 19;
  const random = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return Math.floor((seed / 2147483648) * n);
  };
  const kinds = ["move", "left", "right"] as const;
  const make = (kind: (typeof kinds)[number]): EditCommand => {
    const delta = random(40) - 20 || 3;
    return kind === "move" ? move("m", delta * 10) : trim("m", kind, delta);
  };
  const base = (): Project => ({
    schemaVersion: 1,
    duration: 10000,
    tracks: [{ id: "mix" }],
    clips: [
      { ...clip("m", 2000, "mix"), duration: 200 + random(200), contentIn: 100 + random(100) },
    ],
  });
  const only = (p: Project, list: EditCommand[]): Editor => {
    const e = createEditor({ project: p });
    for (const command of list) commit(e.dispatch(command));
    return e;
  };
  let merged = 0;
  let conflicts = 0;
  for (let trial = 0; trial < 600; trial++) {
    const p = base();
    const a = kinds[random(3)] ?? "move";
    const b = kinds[random(3)] ?? "move";
    const first = make(a);
    const second = make(b);
    const e = createEditor({ project: p });
    commit(e.dispatch(first));
    commit(e.dispatch(second, ignore));
    const both = e.getSnapshot().clips;
    const undone = e.history.undo();
    if (a === b) {
      assert.equal(codeOf(undone), "history-conflict", a + " " + b);
      conflicts++;
      continue;
    }
    pass(undone);
    assert.deepEqual(e.getSnapshot().clips, only(p, [second]).getSnapshot().clips, a + " " + b);
    pass(e.history.redo());
    assert.deepEqual(e.getSnapshot().clips, both);
    assert.deepEqual(both, only(p, [second, first]).getSnapshot().clips);
    merged++;
  }
  assert.ok(merged > 300 && conflicts > 100, merged + " merged, " + conflicts + " conflicts");
});

test("a new clip whose anchor is absent goes to the end", () => {
  const [a, b] = project().clips;
  assert.ok(a && b);
  const x = { ...a, id: "x" };
  const y = { ...a, id: "y" };
  const z = { ...a, id: "z" };
  const placed = applyClips(
    [a, b],
    [
      { id: "x", before: undefined, after: x, follows: "gone" },
      { id: "z", before: undefined, after: z, follows: "x" },
      { id: "y", before: undefined, after: y },
      { id: "a", before: a, after: undefined },
    ],
  );
  assert.deepEqual(
    placed.map((c) => c.id),
    ["b", "y", "x", "z"],
  );
  assert.ok(Object.isFrozen(placed));
});

// The editor passes each clip's position, which spares a lookup per clip. The
// result is the same list, with the same clip objects, as without them.
test("patches apply the same with clip positions as without", () => {
  let seed = 0x2545f491;
  const random = (n: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 2 ** 32) * n);
  };
  const kinds = new Map<string, number>();
  for (let round = 0; round < 400; round++) {
    const base = Object.freeze(
      Array.from({ length: random(12) }, (_, i) => Object.freeze(clip("c" + i, i * 200))),
    );
    const positions = new Map(base.map((c, i) => [c.id, i]));
    const patches: {
      id: string;
      before: Clip | undefined;
      after: Clip | undefined;
      follows?: string;
    }[] = [];
    const added: string[] = [];
    const taken = new Set<string>();
    for (let n = random(6); n > 0; n--) {
      const kind = ["update", "remove", "add", "add", "loose", "absent"][random(6)] ?? "update";
      const target = base[random(base.length)];
      if (kind === "absent") {
        // A clip the list does not hold: nothing to update or remove.
        const gone = Object.freeze(clip("gone" + n, 9));
        patches.push({ id: gone.id, before: gone, after: random(2) ? gone : undefined });
      } else if (kind === "update" || kind === "remove") {
        if (!target || taken.has(target.id)) continue;
        taken.add(target.id);
        const after = kind === "update" ? Object.freeze({ ...target, start: 7 }) : undefined;
        patches.push({ id: target.id, before: target, after });
      } else {
        const id = "n" + round + "-" + n;
        const after = Object.freeze(clip(id, 5));
        // After a clip of the base, a clip this set adds, or one that is nowhere.
        const anchors = [target?.id, added[random(added.length)], "missing"];
        const follows = kind === "loose" ? undefined : anchors[random(3)];
        patches.push({ id, before: undefined, after, ...(follows ? { follows } : {}) });
        added.push(id);
      }
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
    const plain = applyClips(base, patches);
    const placed = applyClips(base, patches, positions);
    assert.ok(Object.isFrozen(placed));
    assert.notEqual(placed, base);
    assert.equal(placed.length, plain.length, JSON.stringify(patches));
    placed.forEach((c, i) => assert.equal(c, plain[i], JSON.stringify(patches)));
  }
  for (const kind of ["update", "remove", "add", "loose", "absent"])
    assert.ok((kinds.get(kind) ?? 0) > 100, kind);
});
