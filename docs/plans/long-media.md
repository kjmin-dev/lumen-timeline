# Edit long media within a memory budget

**Status.** Delivered in one pull request, from 55d9023, after #61. [Long media](../long-media.md) · [Media transports](../media-transports.md) · [Waveform tiles](../waveforms.md)

**User outcome.** A dubbing or podcast editor opens a session of two or three hours with thousands of clips. Memory stays within a budget the host sets, playback and seeks start with sound, the audio stays locked to a reference video for the whole session, and the host decides how media is fetched, authenticated and loaded ahead.

## Starting point

- **Whole buffers.** `resolveBuffer(span)` returned the whole decoded stream of a clip's asset, and the scheduler required it to cover the clip's audible end. Three hours of 48 kHz stereo is 4.1 GB of samples, and `decodeAudioData` also needs the whole encoded file in memory first.
- **One node per clip.** A clip played as one source node, booked once against the anchor of the moment. A long node drifts from the video clock at the device's clock difference. The video driver noticed only past 25 ms and booked everything again, which is audible; [the clock verification](../clock-and-wasm.md#boundary-faults-found-during-verification) left a drift policy for a single long source open.
- **No loading ahead.** The scheduler asked for a buffer when a clip entered its 100 ms lookahead. A buffer that arrived later started the clip late, and nothing loaded ahead of the playhead or around a paused one.
- **Zoomed-out waveforms read everything.** The tiles' overview of a stream is built from the tiles' own summaries, so a view of the whole session read and decoded every sample.
- **Rendering already scaled.** The view draws only visible rows in the visible range, and the 20,000-clip benchmark met its targets. This plan leaves the view alone.

## Delivery

- **Chunk cache.** `createMediaCache({ reader, chunkSeconds, budgetBytes, concurrency, ahead, behind })` reads chunks on a fixed grid through the host's `StreamReader`, shares a read among everything that needs its chunk, and aborts it when nothing does. Holds by voices, waveform reads and preloads are never dropped; other chunks are dropped least recently used first when their room is needed. Chunks wanted ahead load only while they fit.
- **Segments.** With `media`, a voice books one node per chunk it crosses, two seconds ahead. Each segment starts on its predecessor's end sample and plays exactly its chunk's frames; its far edge follows the latest anchor by at most 0.1% once the clock has moved more than a frame. Played segments release their chunks. `resolveBuffer` keeps one node per clip and its exact earlier behavior.
- **Loading ahead.** Transports tell the cache what they want around the playhead, every 250 ms while playing and at once after a seek or a pause. Play, auditions and playing seeks wait, for at most two seconds, until the second after their position is loaded. `preload` holds host-chosen ranges or planned spans.
- **Reporting.** `transport.playback()` counts seams, corrections, late starts, underruns and phase resets, and reports the latest phase error. The cache reports bytes, peaks, holds and reads.
- **Frame-exact seeks.** The video transport's `frameRate` option seeks to the middle of the target's frame and presents the target tick.
- **Overviews.** `PeakSource.overview` and `buildPeakOverview` let columns at least an overview pair wide draw without reading samples.

## Gates

| Check             | Pass condition                                                                                                                                                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing behavior | The 260 unit and probe tests pass unchanged, including the experiments' assertions on voice nodes, reservations and end samples.                                                                                                                                             |
| Cache             | Grid reads, concurrency, least-recently-used drops that spare held chunks, shared reads aborted only when unneeded, failures reported and read again, buffer validation and disposal.                                                                                        |
| Drift             | Three hours against a video clock 100 ppm off the audio device: no phase reset, worst phase error under 1.3 ms, 1,080 stem segments each starting on the previous end sample. The same session with one node per clip resets at least 30 times.                              |
| Loading           | A play and a playing seek wait for their audio; a paused seek loads around its target and aborts reads for the old one; a chunk that arrives late rejoins in time and counts one underrun.                                                                                   |
| PCM               | `npm run verify:pcm` renders chunked playback through native nodes at 44.1 and 48 kHz, across twelve chunk edges and a chained pair starting mid-chunk, equal to the sources frame for frame, in Chromium, Firefox and WebKit.                                               |
| Browser session   | `npm run verify:long`: a three-hour session with 2,402 clips and expiring tokens. Ten seeks land with sound, no underrun or late start, peak decoded bytes within the budget, no failed read across token refreshes, and a zoomed-out view that builds no tile. All engines. |

## Follow-ups

- Estimating the clock difference from successive anchors would shrink the residual phase error from 12 s × the difference toward the anchor jitter.
- A host that caches encoded segments, as in the origin private file system, keeps that layer in its reader. A packaged reader for byte ranges through WebCodecs would save hosts the demuxing.
- Level-of-detail drawing for a fully zoomed-out view with far more than 20,000 clips.
