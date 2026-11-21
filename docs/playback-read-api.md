# Query clips and plan audio

`editor.read()` pins the current immutable document and its track layouts. Pass a snapshot from a selector callback to `editor.read(snapshot)` to query that exact revision, even if another subscriber has already committed an edit. Retained handles stay readable across move, undo and redo.

```js
const read = editor.read()
const range = { start: unitsToTicks(142, 10), end: unitsToTicks(143, 10) }
const visible = read.clipsIn(range, { trackIds: ['dialogue', 'music'] })
const plan = read.planAudio(range, {
  version: 1,
  takes: {
    'take-a': {
      assetId: 'recording', assetVersion: 3, streamId: 'audio-0', sampleRate: 48000,
      sourceAtContentZero: 0, availableStart: 0, availableEnd: 960000,
    },
  },
})
```

Ranges are half-open safe integer project ticks. Empty ranges contain no clips. Track order follows the document and ties within a track are ordered by start and then clip ID. An explicit track selection accepts existing track IDs and ignores duplicates. Results contain the document's immutable clip references, including muted placements and empty take slots.

Supply a synchronous immutable catalog per version. Catalog and asset versions may be nonempty strings or nonnegative safe integers. Source origin and availability boundaries use native sample indices. Each audible span reports clip, track, take, asset/version, stream, sample rate and linear track gain. The span also exposes the optional clip continuity group as `chainId` and its source position at project tick zero as `sourceOriginTick`. Its `audible` object covers the complete available placement. Its `window` object covers only the requested intersection. Both carry project ticks in `start/end` and half-open native sample indices in `sourceStart/sourceEnd`. A scheduler can discover a voice from a short window and reserve through its audible end.

An absent active take or a zero-sample interval produces silence. Missing and invalid selected bindings appear in `issues` with the clip and take ID. Default track gain is unity. Muted tracks and zero gain are silent, and when any track is soloed only unmuted solo tracks contribute. A query leaves the revision, subscriptions and undo history untouched.

Run `npm test` for the seeded brute-force query comparison, pinned reads and sample-boundary fixtures. Run `node experiments/query/run.mjs` for the 40-track, 20,000-clip sparse and dense benchmark. It reports visited tree roots, matches and warm public query p95 for one named track.
