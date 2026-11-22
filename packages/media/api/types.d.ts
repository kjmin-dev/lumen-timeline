import type { AudioSpan, Editor, StreamCatalog, Tick, TickRange } from "@lumen-timeline/core";
/** A decoded stream. The transports read its rate and length. */
export interface AudioBufferLike {
    readonly sampleRate: number;
    readonly length: number;
}
export interface AudioParamLike {
    value: number;
}
export interface AudioNodeLike {
    connect(destination: AudioNodeLike): unknown;
    disconnect(): void;
}
export interface BufferSourceLike extends AudioNodeLike {
    buffer: AudioBufferLike | null;
    readonly playbackRate: AudioParamLike;
    onended: ((event: Event) => void) | null;
    start(when?: number, offset?: number): void;
    stop(when?: number): void;
}
export interface GainNodeLike extends AudioNodeLike {
    readonly gain: AudioParamLike;
}
export interface OutputTimestamp {
    readonly contextTime?: number;
    readonly performanceTime?: number;
}
/** An audio context that reports output timestamps, as the video transport requires. */
export interface TimedAudioContext extends AudioContextLike {
    readonly getOutputTimestamp: () => OutputTimestamp;
}
/** The audio context members the scheduler and both transports use. */
export interface AudioContextLike {
    readonly currentTime: number;
    readonly sampleRate: number;
    readonly destination: AudioNodeLike;
    readonly state: AudioContextState;
    createBufferSource(): BufferSourceLike;
    createGain(): GainNodeLike;
    /** Required by the video transport. The audio transport falls back to the rendering clock. */
    readonly getOutputTimestamp?: (() => OutputTimestamp) | undefined;
    resume(): Promise<void>;
    addEventListener(type: "statechange", listener: () => void): void;
    removeEventListener(type: "statechange", listener: () => void): void;
}
export interface VideoFrameMetadataLike {
    readonly mediaTime: number;
    readonly expectedDisplayTime?: number;
}
/** The video element members the video transport uses. */
export interface VideoElementLike {
    currentTime: number;
    readonly duration: number;
    readonly paused: boolean;
    readonly ended: boolean;
    readonly seeking: boolean;
    readonly readyState: number;
    play(): Promise<void> | void;
    pause(): void;
    addEventListener(type: string, listener: () => void, options?: {
        readonly signal?: AbortSignal;
    }): void;
    requestVideoFrameCallback(callback: (now: number, metadata: VideoFrameMetadataLike) => void): number;
    cancelVideoFrameCallback(handle: number): void;
}
/**
 * Supplies the decoded stream for a planned span. The buffer must use the span's
 * sample rate and cover its audible source range. The signal aborts when the
 * voice is no longer needed.
 */
export type ResolveBuffer = (span: AudioSpan, signal: AbortSignal) => AudioBufferLike | PromiseLike<AudioBufferLike>;
/** Receives resolution, decoding and scheduling failures for one voice. */
export type MediaErrorHandler = (error: unknown, span: AudioSpan) => void;
export interface MediaOptions {
    readonly editor: Editor;
    /** Host-owned. Pausing or disposing a transport never closes it. */
    readonly context: AudioContextLike;
    /** Defaults to `context.destination`. */
    readonly output?: AudioNodeLike | undefined;
    readonly catalog: StreamCatalog;
    readonly resolveBuffer: ResolveBuffer;
    readonly onError?: MediaErrorHandler | undefined;
}
export interface VideoTransportOptions extends MediaOptions {
    /** Host-owned reference video. It supplies the clock. */
    readonly video: VideoElementLike;
}
/** Scheduling state for one clip's voice, for tests and diagnostics. */
export interface TransportDiagnostics {
    readonly generation: number;
    readonly sampleRate: number;
    /** An opaque identity that changes when the voice is booked again. */
    readonly reservation: object | undefined;
    readonly endSample: number | undefined;
}
export type SeekResult = "arrived" | "superseded";
export interface PlayOptions {
    /**
     * Pauses here instead of playing on to the sequence end. It must follow the
     * position playback starts or continues from.
     */
    readonly until?: Tick | undefined;
}
/** `mix` plays the candidate with the rest of the project, `isolated` plays it alone. */
export type AuditionMode = "mix" | "isolated";
export interface AuditionRequest {
    readonly clipId: string;
    /** One of the clip's candidates, or `null` to hear the mix with the clip silent. */
    readonly takeId: string | null;
    /** Defaults to `mix`. */
    readonly mode?: AuditionMode | undefined;
}
/** An audition in progress. */
export interface Audition {
    readonly clipId: string;
    readonly takeId: string | null;
    readonly mode: AuditionMode;
    /** The clip's placement when the audition started. Playback stops at its end. */
    readonly range: TickRange;
    /** The position presentation returns to when the audition ends. */
    readonly returnTick: Tick;
}
/**
 * `finished` when playback reached the clip's end. `cancelled` when a command,
 * a newer audition, an edit of the clip or an interruption ended it first.
 */
export type AuditionResult = "finished" | "cancelled";
export type AudioTransportStatus = "paused" | "starting" | "playing" | "seeking" | "interrupted" | "ended" | "closed" | "disposed";
/** `output` follows the audio output timestamp, `estimated` the rendering clock. */
export type ClockPrecision = "exact" | "output" | "estimated";
export interface AudioTransportState {
    readonly status: AudioTransportStatus;
    readonly playing: boolean;
    readonly presentedTick: Tick;
    readonly requestedTick: Tick | null;
    readonly precision: ClockPrecision;
    /** Changes whenever the presented position moves other than by playback, as after a seek. */
    readonly segment: number;
    /** The tick that presentation continues from in this segment. */
    readonly segmentStart: Tick;
    /** The audition in progress, during which presentation follows the auditioned clip. */
    readonly audition: Audition | null;
    /** Where playback pauses, as `play({ until })` set it. `null` plays to the end. */
    readonly until: Tick | null;
}
export interface AudioTransport {
    snapshot(): AudioTransportState;
    subscribe(listener: (state: AudioTransportState) => void): () => void;
    /**
     * Resolves `empty` for an empty sequence and `superseded` after a later
     * command. With `until`, playback pauses there. Called while playing, it
     * moves the stop, or with no `until` clears it. A pause, a seek or an
     * audition clears it too. Rejects with a `RangeError` for a stop that does
     * not follow the playback position.
     */
    play(options?: PlayOptions): Promise<"playing" | "empty" | "superseded">;
    pause(): void;
    seek(tick: Tick): Promise<SeekResult>;
    /**
     * Pauses project playback and plays one candidate over its clip's placement,
     * without editing the project. When it ends, presentation returns to the
     * position it left, paused. `pause()` and `play()` cancel it and return there
     * too, and `seek()` cancels it for its own target. Rejects with an `EditError`
     * for an unknown clip or a take the clip does not list.
     */
    audition(request: AuditionRequest): Promise<AuditionResult>;
    /** Cancels the audition in progress. Returns whether there was one. */
    cancelAudition(): boolean;
    readonly catalog: StreamCatalog;
    setCatalog(catalog: StreamCatalog): void;
    diagnostics(clipId: string): TransportDiagnostics;
    dispose(): void;
}
export interface VideoTransportState {
    readonly playing: boolean;
    readonly presentedTick: Tick;
    readonly requestedTick: Tick | null;
    /** Changes whenever the presented position moves other than by playback, as after a seek. */
    readonly segment: number;
    /** The tick that presentation continues from in this segment. */
    readonly segmentStart: Tick;
    /** The audition in progress, during which the element plays the auditioned clip. */
    readonly audition: Audition | null;
    /** Where playback pauses, as `play({ until })` set it. `null` plays to the end. */
    readonly until: Tick | null;
}
export interface VideoTransport {
    snapshot(): VideoTransportState;
    /** The disposer returns whether the listener was still subscribed. */
    subscribe(listener: (state: VideoTransportState) => void): () => boolean;
    /**
     * Behaves as on the audio transport. A stop pauses the element at the first
     * frame at or past it, then presents the stop tick itself.
     */
    play(options?: PlayOptions): Promise<void>;
    pause(): void;
    seek(tick: Tick): Promise<SeekResult>;
    /** Behaves as on the audio transport, with the element as the clock. */
    audition(request: AuditionRequest): Promise<AuditionResult>;
    cancelAudition(): boolean;
    readonly catalog: StreamCatalog;
    setCatalog(catalog: StreamCatalog): void;
    diagnostics(clipId: string): TransportDiagnostics;
    dispose(): void;
}
/**
 * The samples of one asset stream that waveform tiles summarise. Tiles stay
 * valid while `version`, `sampleRate` and `length` are unchanged.
 */
export interface PeakSource {
    /** Changes whenever the samples change. Tiles of another version are never drawn. */
    readonly version: string | number;
    readonly sampleRate: number;
    /** Sample frames. */
    readonly length: number;
    /**
     * Samples `start` to `end` of the stream, or a promise of them. The tiles copy
     * what they read, so this may return a view of a buffer that keeps playing.
     * Missing samples count as no samples.
     */
    read(start: number, end: number): ArrayLike<number> | PromiseLike<ArrayLike<number>>;
}
/** A peak source over a decoded buffer, which reads without waiting. */
export interface BufferPeakSource extends PeakSource {
    read(start: number, end: number): Float32Array;
}
/** A decoded buffer with channel data, such as an `AudioBuffer`. */
export interface ChannelBufferLike extends AudioBufferLike {
    readonly numberOfChannels: number;
    getChannelData(channel: number): Float32Array;
}
/**
 * The part of a stream a view draws, in source ticks, divided into `buckets`
 * equal columns. The timeline's waveform requests have this shape.
 */
export interface PeakRequest {
    readonly assetId: string;
    readonly streamId: string;
    readonly start: Tick;
    readonly end: Tick;
    readonly buckets: number;
}
/** The members of a `Worker` the waveform tiles use. */
export interface PeakWorker {
    postMessage(message: unknown, transfer: Transferable[]): void;
    addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
    addEventListener(type: "messageerror", listener: (event: MessageEvent<unknown>) => void): void;
    addEventListener(type: "error", listener: (event: {
        readonly message: string;
    }) => void): void;
    terminate(): void;
}
export interface WaveformTilesOptions {
    /**
     * The source behind an asset's stream, or `null` for none. Called for each
     * request, so it should be cheap; tiles are kept while the source's version,
     * rate and length are unchanged.
     */
    source(assetId: string, streamId: string): PeakSource | null | undefined;
    /**
     * Starts the worker. Defaults to the package's module worker. `null`
     * computes on the main thread in slices of a few milliseconds.
     */
    readonly worker?: (() => PeakWorker) | null | undefined;
    /** Use the Rust SIMD kernels in the worker for large batches. Defaults to true. */
    readonly wasm?: boolean | undefined;
    /** The smallest batch, in samples, that uses them. Defaults to 4,096. */
    readonly wasmFrom?: number | undefined;
    /** Bytes of tiles to keep. Defaults to 64 MiB. */
    readonly cacheBytes?: number | undefined;
}
export interface WaveformTileDiagnostics {
    /** Where tiles are built. Main-thread slices are the fallback when no worker runs. */
    readonly compute: "worker" | "main-thread";
    /** The kernel of the last batch built, or `null` before the first. */
    readonly kernel: "wasm-simd" | "js" | null;
    /** Batches built by each kernel. */
    readonly batches: {
        readonly js: number;
        readonly wasm: number;
    };
    /** Tiles held, and their bytes with each source's overview. */
    readonly tiles: number;
    readonly bytes: number;
    /** Tiles wanted or being built. */
    readonly pending: number;
    readonly evicted: number;
    /** Results discarded because their source changed or the provider was disposed. */
    readonly stale: number;
    /** Why the worker or its WebAssembly was not used, when either was not. */
    readonly fallback: string | null;
    /** The last error a source's `read` raised. */
    readonly error: string | null;
}
/**
 * Waveform peaks from tiles built off the main thread. It satisfies the
 * timeline's waveform provider.
 */
export interface WaveformTiles {
    /**
     * Min/max pairs for each column, with `NaN` for a column outside the source,
     * without finite samples or whose tile is not built yet. `null` for an
     * unknown source. Tiles a column needs are built, and listeners told.
     */
    peaks(request: PeakRequest): Float32Array | null;
    /** Calls the listener with an asset ID when more of its peaks are ready. */
    subscribe(listener: (assetId: string) => void): () => void;
    /** Drops an asset's tiles, so the next request reads its source again. */
    invalidate(assetId: string): void;
    /** Resolves once nothing is wanted or being built. */
    idle(): Promise<void>;
    diagnostics(): WaveformTileDiagnostics;
    /** Stops the worker and drops every tile. Later requests return `null`. */
    dispose(): void;
}
