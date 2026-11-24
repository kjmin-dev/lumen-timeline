# Long media

An editor for sessions of two or three hours cannot hold each asset as one decoded buffer: three hours of 48 kHz stereo is 4.1 GB of samples. `createMediaCache` in `@lumen-timeline/media` reads decoded audio in chunks through a reader the host writes, keeps it within a byte budget, and loads ahead of the playhead. Both transports take it as `media` in place of `resolveBuffer`, and play each clip as a run of chunk-sized segments that follow the clock at every chunk edge. Waveforms of long streams draw from overviews the host computes once. [Plan](plans/long-media.md)

Run `npm run example:vanilla` and open `/examples/vanilla/long.html` for a three-hour session: two stems under the whole session and 2,400 lines across four speakers, read in ten-second WAV segments behind a bearer token that expires.

## Read media in chunks

The reader is where a host fetches, authenticates and decodes its media. The cache asks it for one chunk at a time, `chunkSeconds` of one stream at a time, on a fixed grid from the stream's first sample:

```js title="host.js"
import { createAudioTransport, createMediaCache } from "@lumen-timeline/media";

export const context = new AudioContext({ sampleRate: 48000 });

const reader = {
  // `request` is { assetId, streamId, assetVersion, sampleRate, start, end } in sample frames.
  async read(request, signal) {
    const index = request.start / (10 * request.sampleRate);
    const response = await fetch(`/media/${request.assetId}/${index}.opus`, { signal });
    if (!response.ok) throw new Error(`${request.assetId} chunk ${index}: ${response.status}`);
    return context.decodeAudioData(await response.arrayBuffer());
  },
};

export const media = createMediaCache({ reader, chunkSeconds: 10, budgetBytes: 256 * 1024 * 1024 });
export const transport = createAudioTransport({ editor, context, catalog, media });
```

- **Frames.** Resolve a buffer whose frame 0 is `request.start`, at `request.sampleRate`. It may end early where the stream does, and never holds more than `end - start` frames. `decodeAudioData` resamples to the context's rate, so a catalog read that way lists the context's rate.
- **Sources.** Anything that yields those frames works: segments cut when the media is imported, as above; byte ranges of the original file decoded with WebCodecs `AudioDecoder`; or a disk cache in the origin private file system in front of either.
- **Cancellation.** The signal aborts once nothing needs the chunk: no voice plays it, no waveform reads it, no preload holds it and no transport wants it ahead. Two voices or a voice and a waveform that share a chunk share one read.
- **Failures.** A read that throws or rejects is reported to the transport's `onError` for each voice that needed it, and in `subscribe` events. The cache does not keep the failure: the next voice or preload that needs the chunk reads it again. A chunk only wanted ahead is retried after one second, doubling to 30.
- **Catalog.** The transports still plan from the [stream catalog](playback-read-api.md), so each stream's rate and length are known before anything is decoded, from the host's own metadata.

`resolveBuffer` keeps working as before, one buffer and one node per clip. It suits short assets.

## Authenticated sources

The reader owns its requests, so headers, cookies and signed URLs are the host's choice. This reader refreshes an expired bearer token once and retries, and concurrent reads share one refresh:

```js title="reader.js"
let token = null;
let refreshing = null;
const refresh = () =>
  (refreshing ??= fetch("/auth/media-token", { method: "POST" })
    .then((response) => response.json())
    .then((body) => {
      token = body.token;
    })
    .finally(() => {
      refreshing = null;
    }));

export function createReader(context) {
  return {
    async read(request, signal) {
      const url = `/media/${request.assetId}/${request.start / (10 * request.sampleRate)}.opus`;
      for (let attempt = 0; ; attempt++) {
        if (!token) await refresh();
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal,
        });
        if (response.status === 401 && attempt === 0) {
          token = null;
          continue;
        }
        if (!response.ok) throw new Error(`${url}: ${response.status}`);
        return context.decodeAudioData(await response.arrayBuffer());
      }
    },
  };
}
```

Decoded chunks stay in the cache, so a token that expires later does not affect audio already loaded. A reference `<video>` cannot send headers: give it a signed URL, a cookie with `crossorigin="use-credentials"`, or Media Source Extensions fed by the same authenticated fetches.

## Load ahead

- **Following the playhead.** Each transport tells the cache which chunks it wants: those under the playhead, then `ahead` seconds after it, 30 by default, then `behind` seconds before it, 5 by default, in that order. It updates the list every 250 ms while playing, and at once when a seek or a pause moves the playhead. Reads for chunks that drop off the list are aborted.
- **Starting with sound.** With a media cache, `play()` and `audition()` wait at `starting` and a playing seek at `seeking` until the chunks of the second after the position are loaded, for at most two seconds. Playback then starts with its first and next chunk, also when it starts just before a chunk edge.
- **Order.** At most `concurrency` reads run at once, 4 by default. A voice about to play reads first, then a waveform, then a preload, then chunks wanted ahead.
- **Preloading.** `media.preload(ranges)` loads stream ranges in sample frames, or the source ranges of planned spans, and keeps them until the returned handle is released. To have a clip ready before it is played, preload its plan:

```js
const range = { start: clip.start, end: clip.start + clip.duration };
const hold = media.preload(editor.read().planAudio(range, catalog).spans);
await hold.settled; // the number of chunks that failed
hold.release();
```

- **What is loaded.** `media.loaded(assetId, streamId, assetVersion)` lists the loaded sample ranges of a stream, merged, for a buffered overlay. `media.subscribe(listener)` hears each chunk that loads, is dropped or fails.

## Memory budget

The cache keeps decoded chunks within `budgetBytes`, 256 MiB by default. A chunk costs its frames times its channels times four bytes: ten seconds of 48 kHz stereo is 3.84 MB, so the default holds about 11 minutes of stereo across all streams. Chunks that a voice plays, a waveform reads or a preload holds are never dropped, even past the budget. Others stay until their room is needed, least recently used first, so seeking back is often warm. Chunks wanted ahead load only while they fit. `media.diagnostics()` reports bytes held and the most ever held, chunks in use, loading and queued, and counts of reads, hits, drops, failures and aborted reads. `media.clear()` drops everything unused.

## Timing

- **Segments.** A clip read through the cache plays as one source node per chunk it crosses. Each segment starts on the output sample where the previous one stopped, and plays exactly the frames of its chunk. Its far edge follows the latest clock anchor: when the clock has moved more than one frame from the segment's nominal length, the segment absorbs the difference, by at most 0.1% of its length, and plays its frames over that length. The video transport's clock therefore stays locked to a stem of any length, and an error never accumulates past one segment and the two seconds it is booked ahead: 12 s × the clock difference for ten-second chunks.
- **Booking.** Segments are booked two seconds ahead of the playhead, so a long task on the main thread does not open a gap at a chunk edge.
- **Late audio.** A voice whose first chunk arrives after its place on the timeline joins in time and counts a late start. A segment whose chunk arrives after it was due rejoins where playback is and counts an underrun. `transport.playback()` reports booked nodes, seams, clock corrections, late starts, underruns and, on the video transport, phase resets and the latest phase error. `diagnostics(clipId).segments` counts a voice's booked nodes.
- **Frame-exact seeks.** Give the video transport `frameRate`, such as `30000 / 1001`, and a seek asks the element for the middle of the frame that holds the target tick, so floating-point rounding at a frame boundary never shows the previous frame. The target tick itself is presented.

## Waveforms of long streams

A zoomed-out view of three hours covers every sample, and building its tiles would read and decode the whole stream. Give each source an overview instead: min/max pairs the host computes once, when the recording is imported, with `buildPeakOverview(samples, 4096)` or its own tool, and stores beside the media. Columns at least `samplesPerPair` wide draw from the overview and read nothing. Closer views build [tiles](waveforms.md) from samples read through the same cache:

```js title="tiles.js"
import { createWaveformTiles } from "@lumen-timeline/media";
import { media } from "./host.js";

export async function createLongTiles(assetIds) {
  const sources = new Map();
  const tiles = createWaveformTiles({ source: (assetId) => sources.get(assetId) ?? null });
  for (const assetId of assetIds) {
    const response = await fetch(`/media/${assetId}/peaks.f32`);
    const peaks = new Float32Array(await response.arrayBuffer());
    sources.set(
      assetId,
      media.peakSource({
        assetId,
        streamId: "main",
        assetVersion: 1,
        sampleRate: 48000,
        length: 3 * 3600 * 48000,
        overview: { samplesPerPair: 4096, peaks },
      }),
    );
    tiles.invalidate(assetId);
  }
  return tiles;
}
```

## Checks

`npm test` runs `packages/media/test/media-cache.test.ts` and `packages/media/test/long-media.test.ts`:

- chunks on the grid, four reads at a time, progress and merged loaded ranges;
- a budget that drops the least recently used unused chunk and never one in use, and a shared read aborted only when no holder needs it;
- reader failures reported and read again, mismatched buffers refused, a short last chunk accepted, disposal;
- peak sources that read across chunk edges, and a zoomed-out three-hour view drawn from its overview with no read;
- three hours against a video clock that runs 100 ppm slower than the audio device: with chunks, 1,080 contiguous stem segments, no phase reset and a worst phase error of 1.2 ms; with one node per clip, a reset every few minutes;
- a play, an audition and a playing seek that wait for their audio, loading around a paused playhead, an underrun that rejoins in time, frame-centred seeks and option checks.

`npm run verify:pcm` renders chunked playback through native nodes at 44.1 and 48 kHz, with 256-frame chunks so a stem crosses twelve edges and two touching clips in one chain start mid-chunk, and compares every frame with the sources.

`npm run verify:long` plays the three-hour example in Chromium with eight-second tokens and a 192 MiB budget. Playback starts and ten seeks across the session land with their audio, playback runs on across chunk edges with no underrun or late start, the cache never holds more than its budget, expired tokens are refused and refreshed with no failed read, and the whole session draws from overviews without building a tile. Pass `firefox` or `webkit` to `node examples/vanilla/verify-long.mjs` for the other engines, and `--record` to write the [measurements](measurements/long-media.json). On an Apple M2 Pro in Chromium, a seek to audio not in the cache reached sound in a median of 0.33 s, most of it the example server synthesizing the segment, and one to cached audio in 0.08 s. The JavaScript heap stayed at 6 MB; decoded audio lives outside it.
