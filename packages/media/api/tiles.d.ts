import type { BufferPeakSource, ChannelBufferLike, PeakOverview, WaveformTiles, WaveformTilesOptions } from "./types.ts";
/**
 * Waveform peaks from tiles of 65,536 samples at six levels, built in a worker
 * and kept within a byte budget. Pass it as the timeline's `waveforms`.
 */
export declare function createWaveformTiles(options: WaveformTilesOptions): WaveformTiles;
/**
 * Min/max pairs of `samplesPerPair` samples each, for a waveform overview a
 * host computes once, as when it imports a long recording, and stores beside
 * it. A pair without finite samples holds NaN.
 */
export declare function buildPeakOverview(samples: ArrayLike<number>, samplesPerPair: number): PeakOverview;
export declare function bufferPeakSource(buffer: ChannelBufferLike, { channel, version, }?: {
    readonly channel?: number;
    readonly version?: string | number;
}): BufferPeakSource;
