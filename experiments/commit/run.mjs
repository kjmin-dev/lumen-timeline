// What one commit costs on the rendering benchmark's project: two hours, 40
// tracks, 20,000 clips with a take each, and 2,000 markers. Each figure is the
// time of `dispatch` and of the first `takesOf` a view makes afterwards.
// Usage (build first): node experiments/commit/run.mjs [--write]
import { writeFileSync } from "node:fs";
import os from "node:os";
import { commands, createEditor, TICKS_PER_SECOND as hz } from "@lumen-timeline/core";

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
const editor = createEditor({
  project: { schemaVersion: 1, duration: 7200 * hz, tracks, clips, takes, markers },
});
editor.subscribe(
  (snapshot) => snapshot,
  () => {},
);

const pass = (result) => {
  if (!result.ok || result.unchanged) throw new Error(JSON.stringify(result));
};
// Step `i` of each edit, on a clip of track `i % 40`, back and forth.
const there = (i) => Math.floor(i / 40) % 2 === 0;
const edits = {
  "move a clip": (i) =>
    pass(
      editor.dispatch(
        commands.moveClips({ clipIds: [`c${i % 40}-250`], delta: ((there(i) ? 1 : -1) * hz) / 10 }),
      ),
    ),
  "choose a take": (i) =>
    pass(
      editor.dispatch(
        commands.selectTake({
          clipId: `c${i % 40}-300`,
          takeId: there(i) ? null : `kc${i % 40}-300`,
        }),
      ),
    ),
  "set a field of entity data": (i) =>
    pass(
      editor.dispatch(
        commands.setEntityData({ scope: "notes", id: `c0-${i % 50}`, key: "text", value: i }),
      ),
    ),
  "move a marker": (i) =>
    pass(
      editor.dispatch(commands.moveMarker({ markerId: "m" + (i % 40), delta: there(i) ? 9 : -9 })),
    ),
  "relabel a take": (i) =>
    pass(editor.dispatch(commands.updateTake({ takeId: `kc${i % 40}-330`, label: "L" + i }))),
  "add a take": (i) =>
    pass(
      editor.dispatch(
        commands.addTake({
          clipIds: [`c${i % 40}-320`],
          take: { id: "new" + i, assetId: "wave1", streamId: "mono", sourceAtContentZero: 0 },
        }),
      ),
    ),
  "split a clip": (i) =>
    pass(
      editor.dispatch(
        commands.splitClip({ clipId: `c${i % 40}-${100 + Math.floor(i / 40)}`, atContent: 5 * hz }),
      ),
    ),
};

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const results = {};
for (const [name, edit] of Object.entries(edits)) {
  const times = [];
  for (let i = 0; i < 360; i++) {
    const start = performance.now();
    edit(i);
    editor.read().takesOf(`c${i % 40}-250`);
    // The first sixth warms the path.
    if (i >= 60) times.push(performance.now() - start);
  }
  results[name] = { p50: quantile(times, 0.5), p95: quantile(times, 0.95) };
  console.log(
    `${name.padEnd(28)} p50 ${results[name].p50.toFixed(3)} ms, p95 ${results[name].p95.toFixed(3)} ms`,
  );
}
if (process.argv.includes("--write")) {
  const record = {
    recorded: new Date().toISOString(),
    machine: {
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model ?? null,
      load: os.loadavg(),
    },
    node: process.version,
    fixture: { tracks: 40, clips: clips.length, takes: takes.length, markers: markers.length },
    commits: results,
  };
  writeFileSync(
    new URL("../../docs/measurements/commit.json", import.meta.url),
    JSON.stringify(record, null, 2) + "\n",
  );
  console.log("Wrote docs/measurements/commit.json");
}
