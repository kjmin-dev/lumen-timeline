import type { PeakBackend } from "./peaks.ts";
/**
 * Batches of at least this many samples use WebAssembly by default. The
 * rendering benchmark measured the worker's round trip faster with WASM from
 * 4,096 samples, the smallest size it measured.
 */
export declare const defaultWasmFrom = 4096;
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
/**
 * Builds tiles with the JavaScript kernels below `wasmFrom` samples and the
 * WebAssembly ones from there. When the module cannot load, every batch uses
 * JavaScript; when one call cannot grow its memory, that batch does.
 */
export declare function createTileBuilder({ wasm, wasmFrom, module }: TileBuilderOptions): TileBuilder;
