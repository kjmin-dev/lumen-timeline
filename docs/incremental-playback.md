# Apply edits to a running player

The browser clock probe now consumes revision-pinned audio plans. A voice is one clip's pending or scheduled audio source. Moving dialogue across the playhead changes that voice while a running music source keeps its node, source offset and reserved end sample.

## Attach a source

The experimental `VideoTransport` constructor takes a video element, an AudioContext, an output node and the following bindings.

```js
const driver = new VideoTransport(video, audio, master, {
  editor,
  catalog,
  resolveBuffer: (span, signal) =>
    assets.loadStream(span.assetId, span.assetVersion, span.streamId, signal),
  onError: (error, span) => host.reportAudioError(span.clipId, error),
});
// When the host replaces the immutable catalog:
driver.setCatalog(nextCatalog);
```

The resolver may return a decoded AudioBuffer or a promise. This probe expects a buffer beginning at native sample zero, covering the planned source end at the declared rate. The catalog maps each take's asset and stream to a version and its available samples. Buffers belong to the media resolver. A new catalog version can update one asset while leaving other stream bindings intact.

## Scheduling behavior

- Each scheduler wakeup queries its 100 ms lookahead. A discovered voice is reserved through its complete audible end. A playhead already inside a clip starts at its mapped native sample offset.
- An editor notification pins the exact snapshot it delivered. Changed IDs and old/new track intervals identify edits that intersect the lookahead or an existing reservation. The driver compares take, asset version, stream, source mapping, audible interval, continuity chain and gain. Equal bindings retain their nodes. Metadata-only updates advance the read handle while leaving the audio graph untouched. A host that changes the catalog in response to metadata supplies the updated catalog explicitly.
- An asynchronous result must still own the reservation in the current generation. The driver replans at the current clock position before binding it. Cancelling an obsolete request aborts its signal. A resolver that completes after cancellation cannot attach audio. A failed buffer reports its error, and a catalog refresh can retry it. Missing stream bindings also appear in the planner issues.
- Each adjoining boundary belongs to a track and its optional clip `continuityId`. Unambiguous adjoining clips can share an output sample. Overlapping chains on a mixing track can use distinct IDs. When a producer changes or finishes decoding after its successor was booked, reconcile the affected future reservation with the ready buffer. Sources already playing retain their reservation unless their own playback mapping changes.
- Seek, loop via seek, native stall, pause and disposal invalidate the transport generation. Ordinary edits preserve the video clock anchor. To detect accumulated clock slip, compare a presented frame against the actual output-sample span of each playing voice. A same-direction error over 25 ms for at least 200 ms reacquires the clock. An isolated jitter sample leaves the voice running. The soak report includes the reacquisition count and ten-second offset summaries. The driver detaches its editor subscription on disposal. The caller owns the editor and AudioContext.

## Verification

Run `npm test` for fake-clock tests that inspect node identity, start and stop calls, shared seams, delayed resolution, stale results and recovery. Run `npm run verify:pcm` for native audio rendering. To run the same deterministic fixture on Firefox or WebKit, use `npm run verify:sync -- firefox --pcm` or `npm run verify:sync -- webkit --pcm`.

The continuous fixture schedules one native OfflineAudioContext graph at each of 44.1 and 48 kHz. It uses explicit observation times to schedule a dialogue move, undo, redo and an ignored take-status update within a continuous music clip. It checks the music reservation directly and compares the mixed PCM at every sample with independent source-index expectations. Together with the edit-state renders this covers **34 renders and 3,840 samples per engine**, including 1,792 samples from the continuous graphs.

Use `npm run verify:sync -- chrome` for the real video clock, `npm run verify:sync -- chrome --control` for the downstream 100 ms delay control and `npm run verify:sync -- chrome 90` for the continuous 90-second fixture. The earlier 30-minute measurements and their browser-output limits are recorded in the [clock report](clock-and-wasm.md). The read contract is in the [core API guide](playback-read-api.md).
