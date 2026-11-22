// The waveform tiles' module worker. `createWaveformTiles` starts it with
// `new Worker(new URL("./peak-worker.js", import.meta.url), { type: "module" })`.
// Builds run one at a time, in the order they arrive.
import { createTileBuilder, defaultWasmFrom } from "./peak-builder.ts";
import { isToPeakWorker } from "./peak-messages.ts";
import type { BuiltTiles, FailedTiles } from "./peak-messages.ts";

let builder = createTileBuilder({ wasm: true, wasmFrom: defaultWasmFrom });
let queue: Promise<void> = Promise.resolve();

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (!isToPeakWorker(message)) return;
  if (message.type === "configure") {
    builder = createTileBuilder({ wasm: message.wasm, wasmFrom: message.wasmFrom });
    return;
  }
  const { id, samples, count } = message;
  queue = queue.then(async () => {
    try {
      const built = await builder.build(samples.subarray(0, count));
      const reply: BuiltTiles = { type: "built", id, samples, ...built };
      self.postMessage(reply, {
        transfer: [samples.buffer, ...built.tiles.map((tile) => tile.buffer)],
      });
    } catch (error) {
      const reply: FailedTiles = {
        type: "failed",
        id,
        samples,
        reason: error instanceof Error ? error.message : String(error),
      };
      self.postMessage(reply, { transfer: [samples.buffer] });
    }
  });
});
