# Render a large timeline

**Status.** Planned. Starts from 6b5643d, after #38. [Milestone 4](../../ROADMAP.md#milestones)

**User outcome.** A two-hour project with forty tracks and twenty thousand clips pans, zooms and drags as smoothly as a short one, with waveforms in every visible clip. The view draws through WebGL2 by default, through WebGPU when the host asks for it, and through Canvas 2D wherever neither is available. A lost GPU device leaves the timeline in place, at the same position and selection, with every edit kept. Waveform peaks come from a worker, with an optional Rust SIMD kernel for large batches, and never block the page. [Architecture](../core-architecture.md#waveforms-rendering-and-extension-points)

## Starting point

- **Range queries exist.** The core keeps an interval index per track, and the view asks it for the clips in each visible row. Lane assignment covers the whole track and survives horizontal pans.
- **Some work still grows with the project.** The clip navigator is rebuilt with one option per clip whenever a clip is added or removed. A pan rebuilds the track headers. A waveform notification scans every clip to find the tracks to repaint. Each of these costs milliseconds at twenty thousand clips.
- **One drawing path.** `mountTimeline` paints Canvas 2D directly, row by row. No layout exists apart from the drawing calls, so another backend cannot reuse it.
- **Waveforms are a contract only.** The view asks a `WaveformProvider` for one min/max pair per pixel column of each clip's visible source range. The example's provider summarises decoded buffers on the main thread. The package ships none.
- **The kernel is measured.** `experiments/wasm` reduces complete 256-sample buckets in JS and in Rust 1.100.0 SIMD, in a worker. At 1,048,576 samples SIMD took 0.38–0.59 ms against 1.41–2.00 ms for JS. At 4,096 samples the two differed by less than 0.004 ms. [Measurements](../core-architecture.md#evidence-and-implementation-gates)

## Waveform tiles

A **tile** holds the peaks of 65,536 consecutive samples of one source stream at six resolutions: 16, 64, 256, 1,024, 4,096 and 16,384 samples per bucket. That is 5,460 min/max pairs, 43,680 bytes, about a sixth of the PCM it summarises. Each source also keeps an **overview** of one pair per tile, so a zoomed-out column reads a few overview pairs instead of whole tiles.

- **Key.** Asset ID, content version, stream ID and tile index. Placement, trim and viewport are not part of it, so a move or trim reuses every tile.
- **Exact peaks.** A bucket's pair is the minimum and maximum of the finite samples in it, including the final partial bucket. A bucket with no finite sample is empty, `+∞` and `−∞`, which is the identity for both. Negative zero is stored as zero. Coarser levels fold four finer pairs, which gives the same values as reducing the samples directly.
- **Columns.** For each pixel column the provider picks the coarsest level no wider than the column and combines the buckets it overlaps, at most six. A column whose tile is not ready, or that lies outside the source, is not drawn. Notifications coalesce, and the view repaints the tracks that draw the asset once per animation frame.
- **Versions.** The host's source names a content version. A tile built for an earlier version is never stored or drawn, including a worker reply that arrives after the source changed.
- **Budgets.** Tiles are evicted least recently used beyond a byte budget, 64 MiB by default. Tiles drawn in the current paint are never evicted. PCM stays the host's; the provider copies what it reads into scratch buffers it owns and transfers.

## Computing peaks

- **Worker.** A module worker shipped by the media package reduces batches of up to sixteen contiguous tiles, 1,048,576 samples, transferred in and out. The provider requests the tiles the last paint needed first, keeps two batches in flight and drops queued tiles that no paint has needed for a while.
- **Rust SIMD.** `packages/media/wasm/peaks.rs` is built with Rust 1.100.0 for `wasm32-unknown-unknown` with `simd128`. The repository commits the module's bytes, and CI rebuilds them and fails on any difference. The worker uses it for batches at or above a tunable size and JS below it. JS and WASM return bit-identical pairs for the same input, which Node tests check over random PCM with partial buckets, NaN, infinities and both zeros.
- **Fallbacks.** When SIMD, the module or its memory is unavailable, the worker runs the JS kernel. When workers are unavailable or one fails, the provider reduces on the main thread in cancellable slices of a few milliseconds. Diagnostics report the effective compute backend apart from the drawing backend.

## One layout, three backends

The view builds one CPU layout per paint: rectangles for row backgrounds, grid lines, clips, stripes and waveform columns, label placements, and the hit regions, in stacking order. A backend only draws it.

- **Positions.** Layout is in CSS pixels relative to the viewport origin, computed in doubles from ticks, so floats sent to the GPU stay small at any time in a seven-day project.
- **Labels.** Clip names and take captions are drawn once into a label atlas at the device pixel ratio and cropped to their clip. Canvas 2D copies from the atlas; the GPU backends sample it as a texture.
- **WebGL2.** The default. One instanced draw of the whole layout. The instance buffer is uploaded only when the layout changes, so a fixed viewport during playback uploads nothing and draws nothing.
- **WebGPU.** Opt-in with `renderer: "webgpu"`. The same instance layout and the same order, in WGSL. Until its device is ready the view draws through the next backend.
- **Canvas 2D.** The fallback, and the backend for `renderer: "canvas2d"`. It repaints only the dirty rows, as today.
- **Overlay.** Selection, handles, drag ghosts and marker lines stay on their own Canvas 2D layer, and the playhead stays a DOM element, on every backend.
- **Device loss.** On a lost WebGL2 context or WebGPU device, the view switches at once to the next backend on a fresh canvas and redraws from CPU state. When the context is restored or a new device is granted, it switches back. Selection, viewport, any drag in progress and every edit are untouched, since none of them live on the GPU.
- **Hit tests.** Picking reads the layout, not pixels, so it is the same on every backend. `view.hitTest(point)` returns the clip, edge, track and tick under a surface point for hosts and tests.

## Work bounded by the view

- The clip navigator updates only the options of changed clips, and renames update their text.
- A pan redraws the ruler and the layout and leaves the headers alone.
- A waveform notification repaints visible rows whose drawn clips play the asset, found from the last layout.
- Diagnostics count the clips laid out in the last paint, geometry uploads and device losses, so tests can show that work follows the view and not the project.

## Benchmark

`npm run bench:render` builds the benchmark project from the [engine targets](../../ROADMAP.md#engine-acceptance-targets) in Chrome: 1,440 × 900 CSS pixels at DPR 2, two hours, 40 tracks, 20,000 clips, 12 visible rows, a playing 1080p video and eight simultaneous audio sources, with waveforms from the tile provider. It runs a 60-second pan, zoom and drag trace on each backend and records:

- main-thread work per frame, p50/p95/p99, and missed refreshes;
- JS heap, tile cache and GPU buffer bytes;
- cold and warm seek latency, from a seek far away until every visible waveform is drawn;
- worker round trips for JS and WASM at 4,096 and 1,048,576 samples, with the JS/WASM crossover the default policy uses.

Results go to `docs/measurements/render.json` with the browser, GPU and hardware, and the [architecture](../core-architecture.md#evidence-and-implementation-gates) publishes them.

## Pull requests

| PR  | Scope                                                                                  | Gate                                                                                                                                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Peak kernels: JS and Rust SIMD, committed WASM bytes, rebuild check                    | JS and WASM pairs are bit-identical over seeded PCM, bucket sizes and lengths, including partial buckets, NaN, infinities and both zeros. Folding equals direct reduction. CI rebuilds the module with Rust 1.100.0 and finds no difference. Invalid lengths are refused before touching WASM memory.                  |
| R2  | Tile provider and worker in the media package; the vanilla example adopts it           | Columns equal a brute-force reduction of the same samples at every level. A stale version's reply is discarded. Eviction honours the budget and spares the current paint. A failed worker or module falls back and says so. A browser trace checks JS/WASM parity in the worker and the example's waveforms.           |
| R3  | One CPU layout, the Canvas 2D backend on it, label atlas, view-bounded work, `hitTest` | Every existing trace passes unchanged. On a 20,000-clip project the clips laid out equal the clips in visible rows and range, and an edit, a pan or a waveform notification does no work proportional to the project.                                                                                                  |
| R4  | WebGL2 by default, opt-in WebGPU, device loss and recovery, three-backend trace        | The same geometry, hit-test and edit fixtures give the same layout, hits and snapshots on all three backends, with matching pixels inside clips. Losing the device during playback and during a drag keeps position, selection and edits, and the view comes back on its backend. Steady playback uploads no geometry. |
| R5  | Benchmark project and trace, published measurements, milestone 4 status                | The benchmark runs on each backend and its results are published with the hardware and browser. The roadmap marks milestone 4 complete.                                                                                                                                                                                |

R1 and R2 change only the media package. R3 keeps today's drawing and adds no option. R4 changes the default backend.

## Settled

- **Tiles of 65,536 samples at six levels.** Tiles cover equal sample counts, so a batch is a contiguous range and a tile's levels are built in one pass.
- **WebGL2 is the default and WebGPU is opt-in,** as the architecture specifies. A host that cannot use the GPU passes `renderer: "canvas2d"`.
- **Labels are rasterized once.** The text is the browser's, at the device pixel ratio, so every backend shows the same glyphs.
