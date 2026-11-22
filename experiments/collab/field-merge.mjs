// Do two edits made against the same base merge field by field into what both
// users meant? Compares the stored clip fields (start, duration, contentIn)
// with a content-space form: origin = start - contentIn, in = contentIn and
// out = contentIn + duration.
import { commands, createEditor } from "@lumen-timeline/core";

let seed = 11;
// The high bits of this generator are well mixed; its low bits repeat quickly.
const rnd = (n) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return Math.floor((seed / 2147483648) * n);
};
const base = () => ({
  schemaVersion: 1,
  tracks: [{ id: "t" }],
  clips: [
    {
      id: "c",
      trackId: "t",
      kind: "audio",
      start: 1000 + rnd(1000),
      duration: 400 + rnd(400),
      contentIn: 500 + rnd(500),
    },
  ],
});
const run = (project, list) => {
  const e = createEditor({ project });
  for (const command of list) if (!e.dispatch(command).ok) return null;
  return Object.fromEntries(e.getSnapshot().clips.map((c) => [c.id, c]));
};
const toContent = (c) => ({
  id: c.id,
  trackId: c.trackId,
  kind: c.kind,
  origin: c.start - c.contentIn,
  in: c.contentIn,
  out: c.contentIn + c.duration,
});
const fromContent = (c) => ({
  id: c.id,
  trackId: c.trackId,
  kind: c.kind,
  start: c.origin + c.in,
  duration: c.out - c.in,
  contentIn: c.in,
});
const byKey = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);
const canonical = (state) =>
  JSON.stringify(
    Object.entries(state)
      .sort(byKey)
      .map(([id, clip]) => [id, Object.entries(clip).sort(byKey)]),
  );
const same = (a, b) => canonical(a) === canonical(b);
// The field writes of one edit: {clipId: {field: value}}. A created clip writes every field.
const writes = (before, after) => {
  const w = {};
  for (const [id, clip] of Object.entries(after))
    for (const [k, v] of Object.entries(clip))
      if (!before[id] || before[id][k] !== v) (w[id] ??= {})[k] = v;
  return w;
};
const overlap = (a, b) =>
  Object.keys(a).some((id) => b[id] && Object.keys(a[id]).some((k) => k in b[id]));
const apply = (state, ...all) => {
  const next = Object.fromEntries(Object.entries(state).map(([id, c]) => [id, { ...c }]));
  for (const w of all)
    for (const [id, fields] of Object.entries(w)) next[id] = { ...next[id], ...fields };
  return next;
};
const map = (state, f) => Object.fromEntries(Object.entries(state).map(([id, c]) => [id, f(c)]));

const ops = {
  move: () => commands.moveClips({ clipIds: ["c"], delta: rnd(400) - 200 || 7 }),
  trimL: () => commands.trimClip({ clipId: "c", edge: "left", delta: rnd(200) - 100 || 5 }),
  trimR: () => commands.trimClip({ clipId: "c", edge: "right", delta: rnd(200) - 100 || 5 }),
};
const pairs = [
  ["move", "trimL"],
  ["move", "trimR"],
  ["trimL", "trimR"],
  ["trimL", "split"],
  ["move", "move"],
  ["trimL", "trimL"],
];
console.log("pair".padEnd(16), "trials", " stored: clash  merged   content: clash  merged");
for (const [x, y] of pairs) {
  let n = 0;
  const tally = { clashS: 0, okS: 0, clashC: 0, okC: 0 };
  for (let i = 0; i < 4000 && n < 1500; i++) {
    const p = base();
    const clip = p.clips[0];
    const make = (name) =>
      name === "split"
        ? commands.splitClip({ clipId: "c", at: clip.start + 150 + rnd(100), rightId: "r" })
        : ops[name]();
    const a = make(x);
    const b = make(y);
    const ab = run(p, [a, b]);
    const ba = run(p, [b, a]);
    // Keep pairs whose meaning does not depend on their order.
    if (!ab || !ba || !same(ab, ba)) continue;
    n++;
    const s0 = run(p, []);
    const sa = run(p, [a]);
    const sb = run(p, [b]);
    const wa = writes(s0, sa);
    const wb = writes(s0, sb);
    if (overlap(wa, wb)) tally.clashS++;
    if (same(apply(s0, wa, wb), ab) && same(apply(s0, wb, wa), ab)) tally.okS++;
    const c0 = map(s0, toContent);
    const va = writes(c0, map(sa, toContent));
    const vb = writes(c0, map(sb, toContent));
    if (overlap(va, vb)) tally.clashC++;
    if (
      same(map(apply(c0, va, vb), fromContent), ab) &&
      same(map(apply(c0, vb, va), fromContent), ab)
    )
      tally.okC++;
  }
  const pct = (k) => (Math.round((100 * k) / n) + "%").padStart(6);
  console.log(
    (x + " + " + y).padEnd(16),
    String(n).padStart(6),
    " ".repeat(8),
    pct(tally.clashS),
    pct(tally.okS).padStart(8),
    " ".repeat(9),
    pct(tally.clashC),
    pct(tally.okC).padStart(8),
  );
}
