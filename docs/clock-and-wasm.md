# Playback clock verification and the Rust 1.100 WASM decision

Keep time, clip placement, commands and browser playback scheduling in JavaScript. The strongest candidate for an optional Rust 1.100 WebAssembly module is the **worker that builds large waveform tiles**. Browser clocks and output sample boundaries determine playback sync. A waveform reduction reads millions of independent samples in each large tile.

## What the playback probe measures

The runner generates its own H.264 fixture with FFmpeg. The top half of the video flashes on each integer second. Ten cells in the bottom half encode the source frame number. Audio buffers identify their take and source second in the PCM values. An AudioWorklet reads the rendered samples before the output device, detects source changes and pulse onsets, and outputs silence. This exercises real browser decoding, buffering, rendering and scheduling without producing audible test noise.

For each event, the observer maps the worklet's absolute sample number to the performance clock using the audio output timestamp. A separate video callback reads the screen-bound frame's decoded pixels and presentation metadata. The difference, in milliseconds, is **audio onset minus video flash time**. The detector timestamps the first sample of a stable four-sample run to reject resampling transients. A positive value means late audio. The foreground test uses a 30 fps reference, giving a one-frame budget of 33.33 ms. [Video frame callback fields](https://wicg.github.io/video-rvfc/) · [Web Audio output timestamp](https://www.w3.org/TR/2021/REC-webaudio-20210617/#dom-audiocontext-getoutputtimestamp)

The flash lasts three frames. When the onset callback is missed, an observed second or third white frame can identify the same onset from its frame number. The short probe accepts a neighboring decoded frame only when both frame IDs independently identify the same flash. The continuous probe requires an exact decoded frame ID. The report counts missing pairs. WebKit on this machine supplied an expected display timestamp from a different time origin, so the probe used callback arrival as an estimate and counted those frames separately. The measurement ends at the browser's output graph and estimated presentation time. Physical display, speaker and wireless latency require an external capture.

## Editing and transport checks

- **Mid-clip seek.** The second clip starts at project second 12 with a source offset of one second. Seeking to 14.2 enters source second three. The first complete pulse at project second 15 must identify source second four.
- **Split and take replacement.** Split at 14 and give the right half a new take whose source starts at the split. Check the tag and source second at the worklet while playing. Restore the previous placement snapshot, then seek backwards. The experiment isolates schedule replacement and restoration. The general command-history API belongs to the next milestone.
- **Seek races.** Issue a burst of 100 requests and require exactly one final arrival. Then pause and alternate between two clips for 100 individually acknowledged seeks. Before accepting arrival, check the element's position. Decode the source tag on the playback transitions and check for stale or mixed sources after a 200 ms drain allowance.
- **Starvation.** Supply only the first four seconds through Media Source Extensions. Wait for a native buffering event, verify that the audio goes silent, append the remaining fragments and check the first post-resume flashes. No synthetic waiting event is used in this browser test.
- **Sample boundaries.** Render impulses immediately before, on and after a split using an OfflineAudioContext at 44.1 and 48 kHz. Repeat with the cut displaced by one source sample. Assert both the exact amplitudes and the absence of extra nonzero samples. Separate pure-JS tests cover exact fractional-frame conversion and partition thirty minutes of 30000/1001 fps into audio sample intervals.
- **Negative control.** Insert a 100 ms DelayNode downstream of the scheduler. The one-frame acceptance check must fail and the observed offset must be consistent with the injected delay.

### Boundary faults found during verification

1. At 48 kHz, a source scheduled with a relative duration could play the split sample twice. The expected three impulse amplitudes were 0.25, 0.5 and 0.75. The middle sample measured 1.0. Compute start and stop as absolute positions on the same output sample grid and use an explicit stop time.
2. Two clips touching on the timeline could use slightly different clock observations for their common boundary. A 90-second continuous run with a new clip every ten seconds found seven unpaired pulses and one missing pair. Reuse the prior clip's clock projection at the shared boundary. The same 90-second test then measured all 90 pairs and zero unpaired pulses. The fake-clock regression exercises a 10 ms change between observations.
3. Reusing the entire original clock projection for a chain of clips preserved seams but accumulated phase error under a deterministic ±100 ppm clock difference. Keep the shared start sample, project the far edge from the latest observation and spread the adjustment across the new clip, capped at 0.1% of its duration. Both simulated thirty-minute runs kept every seam contiguous and the phase error below 2 ms. This experiment applies a small playback-rate adjustment at clip boundaries. The continuous test uses a single video and ten-second audio clips. A single uninterrupted long audio source would need its own drift policy.

The longer test plays one continuous muxed video at 1×. It reuses a ten-second source buffer across adjacent clip placements. Frame identity uses the encoded cycle plus the video's continuous PTS. Each second must have one matching pulse with the correct source index within half a second of its flash. Duplicate candidates and missing frames count against coverage. The probe reports the first and last minute's mean signed offsets, the absolute p95, maximum and coverage. This exercises repeated scheduling boundaries over the full wall-clock duration.

### Browser measurements

Short run on Apple M1, macOS 26.5.2, with FFmpeg 9.0.2. Each engine rendered four offline split fixtures with zero sample error, superseded 99 of 100 simultaneous seek requests, acknowledged 100 individual seeks, and passed the take switch, undo, backward seek and real stall checks. Each p95 below uses nine matched audio/video pairs. With nine samples, nearest-rank p95 equals the largest absolute offset.

| Engine                      | Pairs | Absolute p95 | Video timing                 |
| --------------------------- | ----: | -----------: | ---------------------------- |
| Google Chrome 157.0.8103.79 |   9/9 |      0.22 ms | Frame presentation timestamp |
| Playwright WebKit 27.2      |   9/9 |      0.67 ms | Callback-arrival estimate    |
| Playwright Firefox 157.0    |   9/9 |     13.18 ms | Frame presentation timestamp |

The 100 ms negative control produced a p95 of 105.38 ms and correctly failed the one-frame sync criterion. Pixel/PTS disagreements, the offset of each pair, inferred start frames and timing fallback counts are recorded in the [raw results](measurements/clock-and-wasm.json). The Firefox canvas occasionally returned the neighboring decoded frame. A missing flash stays visible as a failed short-run measurement.

### Thirty-minute continuous playback

Google Chrome 157.0.8103.79, 30 fps, 48 kHz, Apple M1. Both runs used real wall-clock playback in separate headless browser instances.

| Implementation                         | Matched pairs | Unpaired audio pulses | Absolute p95 | Absolute max | Mean signed offset, first / last minute |
| -------------------------------------- | ------------: | --------------------: | -----------: | -----------: | --------------------------------------: |
| Independent clock projections at seams |   1,791/1,800 |                   135 |      5.63 ms |     43.34 ms |                        +0.83 / -0.22 ms |
| Shared sample with phase correction    |   1,800/1,800 |                     0 |      6.29 ms |     33.46 ms |                        -0.12 / +0.35 ms |

The first implementation failed signal integrity even though its paired p95 was below one frame. The final run matched all 1,800 signals and passed the 33.33 ms p95 target. Its worst event reached 33.46 ms, just above one frame. The signed mean changed by 0.47 ms between the first and last minute. The final detector also filters short resampling transients. The 90-second regression above isolates the seam fix with the original detector. These measurements support the browser clock experiment. The wired display/speaker release gate remains open. [Full run records](measurements/clock-and-wasm.json)

## Where WASM helps

| Work                                            | Decision                               | Reason                                                                                                                                                                                                                            |
| ----------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport, native seek completion and buffering | JavaScript                             | Video frame observation, Web Audio node scheduling and invalidation run against browser APIs. Correcting two clock and sample-boundary errors directly changed the output.                                                        |
| Placement, clip edits, take choice and history  | JavaScript                             | Small operations work with IDs and project objects. A call across the WASM boundary per position adds overhead in the scalar fixture. History and the full command stack were outside the benchmark.                              |
| Time conversion                                 | JavaScript with exact integer fallback | Common rates fit the integer fast path. Large microsecond PTS can benefit from native integer arithmetic. Consider a bulk import kernel if an application trace spends significant time converting timestamp arrays.              |
| Large PCM waveform tiles                        | Optional Rust 1.100 SIMD worker kernel | One call processes a contiguous batch. The benchmark checks all min/max pairs and measures buffer transfer, input/output copies and worker dispatch separately. Preserve the JS implementation for small tiles and as a fallback. |
| GPU drawing and audio DSP                       | Keep their existing boundaries         | The benchmark covers peak reduction. It does not measure shaders, decoding or real-time DSP on the audio worklet thread.                                                                                                          |

Compile the experiment with Rust 1.100.0, target `wasm32-unknown-unknown`, optimization level 3 and an explicit 128-bit SIMD peak kernel. The JS binding supplies finite Float32 PCM and valid integer positions inside the project range. It verifies 100,000 timestamp conversions per fixture and every peak value against the JS implementation. The exported numeric probes are experimental, and the shipping core has no WASM dependency. [Rust WASM target](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html) · [WebAssembly design goals](https://webassembly.org/docs/high-level-goals/)

The scalar benchmark makes 100,000 calls with the same deterministic positions. The conversion cases cover a mixture of audio and fractional-frame rates, plus late microsecond PTS whose intermediate products exceed the JS safe-integer range. The large peak benchmark reduces 1,048,576 Float32 samples in 256-sample buckets to 8,192 min/max values. It compares JS, scalar Rust/WASM, explicit SIMD, and SIMD including copies into and out of linear memory.

For each kernel, warm eight rounds, rotate case order and record 31 rounds of eight calls. Report median and p95 per call. The worker test measures the page-to-worker round trip for 4,096 and 1,048,576 samples. Transfer input and output buffers, reuse allocations, alternate JS and SIMD order, and check every output value after each batch of 32 small or eight large round trips. The worker timing includes its linear-memory copies. Startup is reported separately. Browser timers can quantize small measurements.

## Measured kernel and worker costs

Apple M1, macOS 26.5.2, Node 26.13.1, Rust 1.100.0 and Playwright 1.64.1. Values below are warm median milliseconds per workload. Tests ran locally alongside real-time playback probes. The machine-readable record includes p95, worker startup time, build size, browser versions and Node results. [Recorded measurements](measurements/clock-and-wasm.json)

| Operation                                                            |    Chrome 157 |   WebKit 27.2 |   Firefox 157 |
| -------------------------------------------------------------------- | ------------: | ------------: | ------------: |
| 100,000 scalar source positions (JS / WASM)                          | 0.588 / 0.988 | 0.125 / 0.625 | 0.625 / 0.875 |
| 100,000 mixed native time conversions (JS / WASM)                    | 1.162 / 3.362 | 2.875 / 2.625 | 2.750 / 3.375 |
| 100,000 late microsecond PTS conversions (JS / WASM)                 | 7.650 / 3.400 | 8.375 / 2.625 | 4.625 / 3.000 |
| 1,048,576 PCM samples, SIMD with input and output copies (JS / WASM) | 1.287 / 0.400 | 1.625 / 0.375 | 2.250 / 0.375 |
| 4,096 samples, full worker round trip (JS / WASM SIMD)               | 0.034 / 0.031 | 0.062 / 0.062 | 0.031 / 0.031 |
| 1,048,576 samples, full worker round trip (JS / WASM SIMD)           | 1.412 / 0.588 | 1.625 / 0.500 | 2.000 / 0.375 |

For the 4 MiB buffer, worker round-trip medians improved by 2.4× in Chrome, 3.25× in WebKit and 5.33× in Firefox. For 4,096 samples the medians were within 0.004 ms. This favors a lazy, optional worker module for large batches. The scalar Rust peak kernel alone took 1.35 ms in Chrome versus 1.29 ms for JS. Explicit SIMD accounted for the Chrome speedup. The stripped benchmark module was 2,900 bytes.

For clip lookups, the JS implementation was faster in all three engines. For late microsecond timestamps, the Rust i128 implementation beat the current JS BigInt fallback. Even the largest Chrome gap here costs about 43 ns per conversion. A future import benchmark should include input packing and use representative files before moving that operation into WASM.

## The shipping kernel

The media package's peak kernels follow this decision. `packages/media/wasm/peaks.rs` reduces any bucket size, including a final partial bucket, and builds a waveform tile's six levels in one call. It has no imports and allocates nothing: the JS binding validates every length, places input and output in the module's memory and refreshes its views after growth. A pair holds the minimum and maximum of a bucket's finite samples. NaN and infinities are left out, a bucket without a finite sample is `+∞`/`−∞`, and negative zero is stored as zero. The JS kernels in `packages/media/src/peaks.ts` follow the same rules, so both return the same bits whatever order they visit samples in.

- **Bytes.** `npm run wasm:build` compiles the source with Rust 1.100.0, `opt-level=3`, one codegen unit, `simd128` and the repository path remapped, and writes the module to `packages/media/src/peaks-wasm.ts` with its SHA-256. `npm run wasm:check` rebuilds it and fails when the committed bytes differ. CI runs it.
- **Tiles.** The finest level reduces four 16-sample buckets at a time and transposes their lanes in one step, instead of collapsing each bucket's lanes alone. It skips the finite test: `pmin(extreme, sample)` keeps the extreme when the sample is NaN, so only `−∞` can reach a minimum and `+∞` a maximum, and a group where either did is reduced again with both left out. The coarser levels fold two pairs a step in SIMD, since a tile's levels hold no NaN and no negative zero. The exported `reduce` and `fold` accept any input and keep the general path.
- **Parity.** `packages/media/test/peaks.test.ts` compares both kernels with a direct reduction, bit for bit, over seeded PCM with NaN, infinities, both zeros and denormals, bucket sizes from 1 to 4,096 and partial lengths. Folding four pairs equals reducing at the coarser size. Tiles of finite PCM, of NaN, of a lone infinity at each place in a group, of groups of only special values and of every length of tail give the same bits through both paths. Both refuse a length they cannot honour before touching memory.
- **Browsers.** `npm run bench:peaks` compares the JS and WASM tiles bit for bit in Chrome, Firefox and WebKit over 3.2 million values, then times `kernel.tiles` in the page and the package worker's round trip with each kernel. `--baseline <rev>` times the module committed at that revision alongside, and `--write` records [`measurements/peaks.json`](measurements/peaks.json). In Chrome 157 on an Apple M1, a 1,048,576-sample batch took 0.21 ms in the kernel and 0.34 ms for the round trip, against 0.48 and 0.60 ms with the previous kernel.

## Reproduce

Use Node 22 or newer, npm, FFmpeg with libx264, Google Chrome and rustup. The installed Chrome channel is the default for the browser probes. Playwright-managed Chromium, Firefox and WebKit can also be selected. All generated media and WASM binaries live in temporary directories.

```sh
npm ci
npm test
npm run verify:sync
npm run verify:sync -- chrome --control
npm run verify:sync -- chrome 1800

npx playwright install firefox webkit
npm run verify:sync -- firefox
npm run verify:sync -- webkit

rustup toolchain install 1.100.0 --profile minimal
rustup target add --toolchain 1.100.0 wasm32-unknown-unknown
npm run wasm:check
npm run bench:wasm
npm run bench:wasm -- firefox
npm run bench:wasm -- webkit
npm run build
npm run bench:peaks
```

The sync runners exit unsuccessfully for an incomplete or out-of-budget short probe, a missed seek or sample assertion, or a continuous run below 99% coverage or above its p95 budget. The negative control succeeds when the observer detects the injected delay. The benchmark exits unsuccessfully if the algorithms disagree.
