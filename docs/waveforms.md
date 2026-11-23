# Waveform tiles

`createWaveformTiles` in `@lumen-timeline/media` turns the PCM a host already has into the peaks the timeline draws inside clips. Peaks are built in a module worker, with the Rust SIMD kernel for large batches, kept in tiles within a byte budget, and never block the page. The result satisfies the timeline's [`waveforms` option](vanilla-timeline.md#waveforms). [Plan](plans/scale-rendering.md#waveform-tiles)

```js
import { bufferPeakSource, createWaveformTiles } from "@lumen-timeline/media";

const sources = new Map(); // assetId → PeakSource
const waveforms = createWaveformTiles({
  source: (assetId, streamId) => sources.get(assetId) ?? null,
});
sources.set("stem", bufferPeakSource(decodedStem)); // channel 0, version 0
```

Pass the tiles to the view as its `waveforms`:

<!-- framework-tabs -->

**Vanilla**

```js
import { mountTimeline } from "@lumen-timeline/timeline";

mountTimeline(element, { editor, transport, waveforms });
```

**React**

```jsx
import { Timeline } from "@lumen-timeline/react";

<Timeline editor={editor} transport={transport} waveforms={waveforms} />;
```

**Svelte**

```svelte
<script>
  import { timeline } from "@lumen-timeline/svelte";
</script>

<div {@attach timeline(() => ({ editor, transport, waveforms }))}></div>
```

**SolidJS**

```jsx
import { createSignal } from "solid-js";
import { createTimeline } from "@lumen-timeline/solid";

function Workspace() {
  const [element, setElement] = createSignal();
  createTimeline(element, () => ({ editor, transport, waveforms }));
  return <div ref={setElement} />;
}
```

**Vue**

```vue
<script setup>
import { Timeline } from "@lumen-timeline/vue";
</script>

<template>
  <Timeline :editor="editor" :transport="transport" :waveforms="waveforms" />
</template>
```

<!-- /framework-tabs -->

The tiles belong to the host, like the editor and the transport: create them once, and call `dispose()` when no view needs them.

## Sources

A source is `{ version, sampleRate, length, read(start, end) }` for one stream of an asset. `read` returns the samples from `start` to `end`, or a promise of them. The tiles copy what it returns into scratch buffers they own and transfer, so `read` may return a view of a buffer that is still playing. Samples it does not return count as no samples. `bufferPeakSource(buffer, { channel, version })` reads one channel of an `AudioBuffer`.

- **Versions.** Tiles are kept while the source's `version`, `sampleRate` and `length` are unchanged. Give the source a new version when its samples change; tiles of the old one are dropped and never drawn, including a worker reply that arrives later. `invalidate(assetId)` drops an asset's tiles without a new version and tells listeners.
- **Failures.** A `read` that throws or rejects is reported in `diagnostics().error`. Its tiles are not read again until the asset is invalidated.

## Tiles

A tile holds 65,536 samples of one stream at six levels: 16, 64, 256, 1,024, 4,096 and 16,384 samples per bucket. Each source also keeps a summary of every tile it has built: the two coarsest levels and one overview pair, 21 pairs or 168 bytes a tile.

- **Pairs.** A bucket holds the minimum and maximum of its finite samples, the last bucket partial. NaN and infinities are left out, and negative zero reads as zero.
- **Columns.** `peaks(request)` answers the timeline's request, `buckets` equal columns over a source range in ticks. Each column takes the coarsest level no wider than itself and combines the buckets it overlaps. Columns of 4,096 samples or more read the summary, and columns wider than a tile its overview pairs. A column outside the source, without finite samples, or whose tile is not built yet is `NaN` and is not drawn.
- **Builds.** A column whose tile is missing asks for it. Requests made in one task, such as one paint, are served first, and a tile no paint has asked for in 120 paints is no longer wanted. Contiguous tiles of one stream build together, up to 16 per batch, two batches at a time. When a batch is done, listeners hear its asset ID once, and the timeline repaints the tracks that draw it.
- **Budget.** Tiles beyond `cacheBytes`, 64 MiB by default, are evicted least recently used. Tiles the current paint drew stay, even over the budget. The summary outlives its tiles and is not evicted, so a zoomed-out view draws without reading samples again. A tile that only zoomed-out columns asked for is summarised and not kept, so zooming out never pushes out the tiles a closer view uses.

## Compute

- **Worker.** The package's module worker, `peak-worker.js`, starts on the first batch. Pass `worker` to start it another way, for instance from a bundler's worker import; `null` builds on the main thread.
- **Rust SIMD.** In the worker, batches of at least `wasmFrom` samples, 4,096 by default, use the kernels in `packages/media/wasm/peaks.rs`, built with Rust 1.100.0. Smaller batches use the JavaScript kernels. Both return the same bits. Main-thread slices choose their kernels the same way, so a page without the worker spends less than half as long building each tile. `wasm: false` keeps both on JavaScript. [The shipping kernel](clock-and-wasm.md#the-shipping-kernel)
- **Fallbacks.** When the module cannot load or its memory cannot grow, the worker uses JavaScript. When the worker cannot start, fails or sends an unreadable reply, the tiles build on the main thread, one tile per step, yielding every 4 ms, and stop when the source changes. When the module cannot load there either, as under a content security policy without `wasm-unsafe-eval`, they build with JavaScript, and the fallback reason names both failures.

`diagnostics()` reports where tiles are built, the kernel of the last batch, batches per kernel, tiles and bytes held, pending, evicted and stale tiles, the reason for any fallback and the last read error. `idle()` resolves once nothing is wanted or building, and `dispose()` stops the worker.

## Checks

`npm test` runs `packages/media/test/tiles.test.ts`:

- columns against a direct reduction of the buckets they overlap, at every level and the overview, before the source, inside it and past its end;
- the JS/WASM cutoff, with the scratch samples transferred, and the same columns from either kernel;
- a result for an earlier version that is discarded, and the new samples drawn;
- eviction within the budget that spares the current paint, and an overview that answers with no new reads;
- tiles that only zoomed-out columns asked for, summarised and not kept, with the summary levels drawn from the summary;
- a worker that fails, cannot start or cannot build a batch, and a module that cannot load, each with its reason;
- notifications, invalidation, short and failing reads, unknown sources and disposal.

`npm run verify:peaks` builds the same columns in the browser with the package's worker and on the main thread, each with the Rust SIMD kernel and with the JavaScript one, compares them bit for bit, and checks that a worker that cannot load leaves the main thread on SIMD. CI runs it. Pass `firefox` or `webkit` to `node examples/vanilla/verify-peaks.mjs` for the other engines.
