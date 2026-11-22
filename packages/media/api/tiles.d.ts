import type { BufferPeakSource, ChannelBufferLike, WaveformTiles, WaveformTilesOptions } from "./types.ts";
/**
 * Waveform peaks from tiles of 65,536 samples at six levels, built in a worker
 * and kept within a byte budget. Pass it as the timeline's `waveforms`.
 */
export declare function createWaveformTiles(options: WaveformTilesOptions): WaveformTiles;
/** A peak source over one channel of a decoded buffer. */
export declare function bufferPeakSource(buffer: ChannelBufferLike, { channel, version, }?: {
    readonly channel?: number;
    readonly version?: string | number;
}): BufferPeakSource;
