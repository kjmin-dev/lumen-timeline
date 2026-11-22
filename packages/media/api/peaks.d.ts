/** Samples in one tile. */
export declare const tileSamples = 65536;
/** Samples per bucket of each level in a tile, finest first. */
export declare const tileLevels: readonly number[];
/** Where each level starts in a tile, in pairs. */
export declare const levelOffsets: readonly number[];
/** Pairs in one tile. */
export declare const tilePairs = 5460;
/** The most samples one call accepts: 256 tiles. */
export declare const maxBatchSamples: number;
/** The kernel that computed a result. */
export type PeakBackend = "wasm-simd" | "js";
/** Peak kernels over one channel of PCM. Every method validates its lengths first. */
export interface PeakKernel {
    readonly backend: PeakBackend;
    /** Writes `2 * ceil(samples.length / perBucket)` values to `out`. */
    reduce(samples: Float32Array, perBucket: number, out: Float32Array): void;
    /** Combines `factor` pairs to one, writing `2 * ceil(pairs / factor)` values to `out`. */
    fold(pairs: Float32Array, factor: number, out: Float32Array): void;
    /**
     * Writes one tile per 65,536 samples, the last partial, to `out`: `2 *
     * tilePairs` values per tile. Returns the tile count.
     */
    tiles(samples: Float32Array, out: Float32Array): number;
}
/** The JavaScript kernels, available everywhere. */
export declare const jsKernel: PeakKernel;
/** The bytes of the bundled module, built from wasm/peaks.rs with Rust 1.100.0. */
export declare function peakModuleBytes(): Uint8Array<ArrayBuffer>;
/**
 * Instantiates the WebAssembly SIMD kernels. Rejects where WebAssembly or its
 * SIMD extension is unavailable, so the caller can keep the JavaScript ones. A
 * call whose memory cannot grow throws a `RangeError` and leaves the module
 * usable for smaller inputs.
 */
export declare function loadWasmKernel(bytes?: BufferSource): Promise<PeakKernel>;
