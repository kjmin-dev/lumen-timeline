import type { AudioBufferLike, StretchAudio } from "./types.ts";
/** Decoded audio a rendering reads: the members of an `AudioBuffer` it uses. */
export interface DecodedAudio extends AudioBufferLike {
    readonly numberOfChannels: number;
    getChannelData(channel: number): Float32Array;
}
/** Audio a rendering writes into: an `AudioBuffer`. */
export interface WritableAudio extends DecodedAudio {
    copyToChannel(source: Float32Array<ArrayBuffer>, channel: number): void;
}
/** The members of an `OfflineAudioContext` that a rendering uses. */
export interface OfflineContextLike {
    readonly destination: object;
    createBuffer(channels: number, length: number, sampleRate: number): WritableAudio;
    startRendering(): Promise<DecodedAudio>;
}
/** The fields of a new offline context. */
export interface OfflineContextOptions {
    readonly numberOfChannels: number;
    readonly length: number;
    readonly sampleRate: number;
}
export interface SignalsmithStretchOptions {
    /**
     * Loads Signalsmith Stretch: its module, or its default export. Defaults to
     * `import("signalsmith-stretch")`, which the host installs.
     */
    readonly load?: (() => Promise<unknown>) | undefined;
    /** Creates the offline context of one rendering. Defaults to `new OfflineAudioContext(options)`. */
    readonly createContext?: ((options: OfflineContextOptions) => OfflineContextLike) | undefined;
    /** Bytes of rendered audio kept for reuse, least recently used first out. Defaults to 64 MiB. */
    readonly cacheBytes?: number | undefined;
    /** Renderings that run at once. Defaults to 2. */
    readonly concurrency?: number | undefined;
    /** `"cheaper"` trades quality for speed. Defaults to `"default"`. */
    readonly preset?: "default" | "cheaper" | undefined;
}
/** A stretch engine for `MediaOptions.stretch`, with its rendering cache. */
export interface SignalsmithStretch {
    readonly stretch: StretchAudio;
    /** Bytes of rendered audio the cache holds now. */
    cachedBytes(): number;
    /** Forgets cached renderings. Renderings in progress still settle. */
    clear(): void;
}
/**
 * A stretch engine on Signalsmith Stretch. Each rendering runs the library's
 * AudioWorklet in an `OfflineAudioContext`, off the main thread, and keeps the
 * result for later voices of the same clip. It changes speed without changing
 * pitch.
 */
export declare function createSignalsmithStretch(options?: SignalsmithStretchOptions): SignalsmithStretch;
