# Query clips and plan audio

`editor.read()` pins the current immutable document and its track layouts. Pass a snapshot from a selector callback to `editor.read(snapshot)` to query that exact revision, even if another subscriber has already committed an edit. Retained handles stay readable across move, undo and redo.

```js
const read = editor.read();
const range = { start: unitsToTicks(142, 10), end: unitsToTicks(143, 10) };
const visible = read.clipsIn(range, { trackIds: ["dialogue", "music"] });
const catalog = {
  version: 1,
  streams: {
    recording: {
      "audio-0": { assetVersion: 3, sampleRate: 48000, availableStart: 0, availableEnd: 960000 },
    },
  },
};
const plan = read.planAudio(range, catalog);
const preview = read.planAudio(range, catalog, { takeOverrides: { line: "take-b" } });
const alone = read.planAudio(range, catalog, {
  takeOverrides: { line: "take-b" },
  isolate: "line",
});
```

Ranges are half-open safe integer project ticks. Empty ranges contain no clips. Track order follows the document and ties within a track are ordered by start and then clip ID. An explicit track selection accepts existing track IDs and ignores duplicates. Results contain the document's immutable clip references, including muted placements and empty take slots.

Marker reads use the same pinned snapshot. `read.markersIn(range)` returns markers with `range.start <= start < range.end` in snapshot order. `read.nextMarker(tick)` returns the first marker after a safe integer tick, and `read.previousMarker(tick)` the last marker before it. Each returns `undefined` when there is none.

Supply a synchronous immutable catalog per version. Catalog and asset versions may be nonempty strings or nonnegative safe integers.

- **Streams.** A clip plays its active [take](headless-editing.md#takes) through `streams[take.assetId][take.streamId]`. The take's source position is in project ticks, and the stream's availability boundaries are native sample indices.
- **Overrides.** `takeOverrides` maps clip IDs to another of the clip's candidates, or to `null` for silence, for one plan without editing the project, as an audition preview needs. A take the clip does not list is reported as `unresolved-take`.
- **Isolation.** `isolate` names one clip and plans it alone, as if its track were soloed and unmuted. The track's gain still applies, and only that track can report `invalid-gain`. An unknown clip plans nothing. The transports' [isolated audition](media-transports.md#audition) uses it.
- **Candidates.** `read.takesOf(clipId)` returns a clip's takes in list order, and `read.clipsListing(takeId)` the IDs of the clips that list a take. An unknown clip throws `missing-clip`, and an unknown take `missing-take`.

Each audible span reports clip, track, take, asset/version, stream, sample rate and linear track gain. The span also exposes the optional clip continuity group as `chainId` and its source position at project tick zero as `sourceOriginTick`. Its `audible` object covers the complete available placement. Its `window` object covers only the requested intersection. Both carry project ticks in `start/end` and half-open native sample indices in `sourceStart/sourceEnd`. A scheduler can discover a voice from a short window and reserve through its audible end.

An absent active take or a zero-sample interval produces silence. A take whose stream the catalog lacks reports `unresolved-stream` with its asset and stream IDs, and a malformed stream binding reports `invalid-stream`. Both appear in `issues` with the clip and take ID. Default track gain is unity. Muted tracks and zero gain are silent, and when any track is soloed only unmuted solo tracks contribute. A query leaves the revision, subscriptions and undo history untouched.

Run `npm test` for the seeded brute-force query comparison, pinned reads and sample-boundary fixtures. Run `node experiments/query/run.mjs` for the 40-track, 20,000-clip sparse and dense benchmark. It reports visited tree roots, matches and warm public query p95 for one named track.
