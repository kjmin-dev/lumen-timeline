import type { PeakBackend } from "./peaks.ts";

// Messages between the waveform tiles and their worker. Sample and tile arrays
// travel in the transfer list; the scratch samples come back for reuse.

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
export function isTransferableFloats(value: unknown): value is Float32Array<ArrayBuffer> {
  return value instanceof Float32Array && value.buffer instanceof ArrayBuffer;
}

const field = (value: object, key: string): unknown => Reflect.get(value, key);

export function isToPeakWorker(value: unknown): value is ToPeakWorker {
  if (typeof value !== "object" || value === null) return false;
  const type = field(value, "type");
  if (type === "configure")
    return (
      typeof field(value, "wasm") === "boolean" && typeof field(value, "wasmFrom") === "number"
    );
  return (
    type === "build" &&
    typeof field(value, "id") === "number" &&
    isTransferableFloats(field(value, "samples")) &&
    typeof field(value, "count") === "number"
  );
}

export function isFromPeakWorker(value: unknown): value is FromPeakWorker {
  if (typeof value !== "object" || value === null || typeof field(value, "id") !== "number")
    return false;
  const type = field(value, "type");
  if (type === "failed")
    return (
      typeof field(value, "reason") === "string" && isTransferableFloats(field(value, "samples"))
    );
  const tiles = field(value, "tiles");
  const kernel = field(value, "kernel");
  const note = field(value, "note");
  return (
    type === "built" &&
    Array.isArray(tiles) &&
    tiles.every(isTransferableFloats) &&
    isTransferableFloats(field(value, "samples")) &&
    (kernel === "js" || kernel === "wasm-simd") &&
    (note === null || typeof note === "string")
  );
}
