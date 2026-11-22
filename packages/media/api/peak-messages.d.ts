import type { PeakBackend } from "./peaks.ts";
/** Chooses the worker's kernels. Sent once, before any build. */
export interface ConfigureWorker {
    readonly type: "configure";
    readonly wasm: boolean;
    readonly wasmFrom: number;
}
/** Builds tiles from the first `count` samples of `samples`. */
export interface BuildTiles {
    readonly type: "build";
    readonly id: number;
    readonly samples: Float32Array<ArrayBuffer>;
    readonly count: number;
}
export type ToPeakWorker = ConfigureWorker | BuildTiles;
export interface BuiltTiles {
    readonly type: "built";
    readonly id: number;
    /** One array of `2 * tilePairs` values per tile, in order. */
    readonly tiles: readonly Float32Array<ArrayBuffer>[];
    /** The request's scratch samples, returned. */
    readonly samples: Float32Array<ArrayBuffer>;
    readonly kernel: PeakBackend;
    /** Why WebAssembly was not used for a batch that qualified for it. */
    readonly note: string | null;
}
export interface FailedTiles {
    readonly type: "failed";
    readonly id: number;
    readonly samples: Float32Array<ArrayBuffer>;
    readonly reason: string;
}
export type FromPeakWorker = BuiltTiles | FailedTiles;
/** A Float32Array over a plain ArrayBuffer, which can be transferred. */
export declare function isTransferableFloats(value: unknown): value is Float32Array<ArrayBuffer>;
export declare function isToPeakWorker(value: unknown): value is ToPeakWorker;
export declare function isFromPeakWorker(value: unknown): value is FromPeakWorker;
