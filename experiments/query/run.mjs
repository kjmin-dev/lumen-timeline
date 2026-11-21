import { createEditor } from "@lumen-timeline/core";
import { visitRange } from "@lumen-timeline/core/internal";

const tracks = Array.from({ length: 40 }, (_, i) => ({ id: "track-" + i }));
for (const dense of [false, true]) {
  const clips = tracks.flatMap(({ id }) =>
    Array.from({ length: 500 }, (_, i) => ({
      id: id + "-" + String(i).padStart(3, "0"),
      trackId: id,
      kind: "audio",
      start: dense ? 0 : i * 100,
      duration: dense || i === 0 ? 50000 : 10,
      contentIn: 0,
    })),
  );
  const read = createEditor({ project: { schemaVersion: 1, tracks, clips } }).read();
  const selected = clips.slice(0, 500);
  const elapsed = [];
  let visited = 0,
    matched = 0;
  for (let i = 0; i < 1050; i++) {
    const start = 100 * ((i * 17) % 480) + 1;
    const range = { start, end: start + 5 };
    const before = performance.now();
    const hits = read.clipsIn(range, { trackIds: [tracks[0].id] });
    const ms = performance.now() - before;
    const roots = visitRange(selected, start, range.end, () => {});
    if (i >= 50) {
      elapsed.push(ms);
      visited += roots;
      matched += hits.length;
    }
  }
  elapsed.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      node: process.version,
      shape: dense ? "dense" : "sparse",
      totalClips: clips.length,
      namedTracks: 1,
      meanInspectedPerQuery: visited / elapsed.length,
      meanMatches: matched / elapsed.length,
      warmQueryP95Ms: elapsed[Math.ceil(elapsed.length * 0.95) - 1],
    }),
  );
}
