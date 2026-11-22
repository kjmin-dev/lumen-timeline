import { jsKernel, loadWasmKernel, tilePairs, tileSamples } from "./peaks.ts";
import type { PeakBackend, PeakKernel } from "./peaks.ts";

/**
 * Batches of at least this many samples use WebAssembly by default. The
 * rendering benchmark measured the worker's round trip faster with WASM from
 * 4,096 samples, the smallest size it measured.
 */
export const defaultWasmFrom = 4096;

export interface TileBuilderOptions {
  /** Use the WebAssembly SIMD kernels for large batches. */
  readonly wasm: boolean;
  /** The smallest batch, in samples, that uses them. */
  readonly wasmFrom: number;
  /** Module bytes, for tests. Defaults to the bundled module. */
  readonly module?: BufferSource | undefined;
}

export interface BuiltBatch {
  readonly tiles: Float32Array<ArrayBuffer>[];
  readonly kernel: PeakBackend;
  /** Why WebAssembly was not used for a batch that qualified for it. */
  readonly note: string | null;
}

export interface TileBuilder {
  build(samples: Float32Array): Promise<BuiltBatch>;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Builds tiles with the JavaScript kernels below `wasmFrom` samples and the
 * WebAssembly ones from there. When the module cannot load, every batch uses
 * JavaScript; when one call cannot grow its memory, that batch does.
 */
export function createTileBuilder({ wasm, wasmFrom, module }: TileBuilderOptions): TileBuilder {
  let loading: Promise<PeakKernel | string> | null = null;
  let scratch = new Float32Array(0);
  async function kernelFor(count: number): Promise<[PeakKernel, string | null]> {
    if (!wasm || count < wasmFrom) return [jsKernel, null];
    loading ??= loadWasmKernel(module).catch(
      (error: unknown) => "WebAssembly unavailable: " + describe(error),
    );
    const loaded = await loading;
    return typeof loaded === "string" ? [jsKernel, loaded] : [loaded, null];
  }
  return {
    async build(samples: Float32Array): Promise<BuiltBatch> {
      const count = Math.ceil(samples.length / tileSamples);
      const values = count * 2 * tilePairs;
      if (scratch.length < values) scratch = new Float32Array(values);
      let [kernel, note] = await kernelFor(samples.length);
      try {
        kernel.tiles(samples, scratch);
      } catch (error) {
        if (kernel === jsKernel) throw error;
        note = describe(error);
        kernel = jsKernel;
        kernel.tiles(samples, scratch);
      }
      const tiles: Float32Array<ArrayBuffer>[] = [];
      for (let t = 0; t < count; t++)
        tiles.push(scratch.slice(t * 2 * tilePairs, (t + 1) * 2 * tilePairs));
      return { tiles, kernel: kernel.backend, note };
    },
  };
}
