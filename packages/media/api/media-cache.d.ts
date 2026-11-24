import type { ChannelBufferLike, MediaCache, MediaCacheOptions } from "./types.ts";
/** One chunk of one stream version: frames `index * chunkFrames` onward. */
export interface ChunkKey {
    readonly assetId: string;
    readonly streamId: string;
    readonly assetVersion: string | number;
    readonly sampleRate: number;
    readonly index: number;
}
export type ChunkState = "idle" | "loading" | "ready" | "failed";
/**
 * Who needs a chunk, most urgent first: a voice about to play or a play
 * waiting for its audio, a waveform read, then a host preload.
 */
export type Need = 0 | 1 | 2;
export declare const playbackNeed: Need;
export interface Chunk {
    readonly key: string;
    readonly stream: string;
    readonly id: ChunkKey;
    /** The frames asked for. A buffer may end early where the stream does. */
    readonly start: number;
    readonly end: number;
    state: ChunkState;
    buffer: ChannelBufferLike | undefined;
    error: unknown;
}
/** A hold on a chunk. The budget never drops a held chunk. */
export interface ChunkLease {
    readonly chunk: Chunk;
    /** Resolves with the buffer, or rejects with the read's failure. */
    wait(): Promise<ChannelBufferLike>;
    release(): void;
}
export interface CacheInternals {
    readonly ahead: number;
    readonly behind: number;
    chunkFrames(sampleRate: number): number;
    acquire(key: ChunkKey, need: Need): ChunkLease;
    /** Replaces what `owner` wants loaded, most wanted first. Wanted chunks are not held. */
    want(owner: object, keys: readonly ChunkKey[]): void;
    /** Calls the listener when a chunk loads or fails. */
    watch(listener: (chunk: Chunk) => void): () => void;
    readonly disposed: boolean;
}
/** The scheduling side of a cache made by `createMediaCache`. */
export declare function cacheInternals(media: MediaCache): CacheInternals;
/**
 * Decoded audio in chunks of `chunkSeconds`, read through the host's reader and
 * kept within `budgetBytes`. Pass it to transports as `media` and to waveforms
 * through `peakSource`.
 */
export declare function createMediaCache(options: MediaCacheOptions): MediaCache;
