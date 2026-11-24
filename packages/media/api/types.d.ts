import type { AudioSpan, Editor, StreamCatalog, Tick, TickRange } from "@lumen-timeline/core";
/** A decoded stream. The transports read its rate and length. */
export interface AudioBufferLike {
    readonly sampleRate: number;
    readonly length: number;
}
export interface AudioParamLike {
    value: number;
    setValueAtTime?(value: number, startTime: number): unknown;
    linearRampToValueAtTime?(value: number, endTime: number): unknown;
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
    playbackRate?: number;
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
    requestVideoFrameCallback?(callback: (now: number, metadata: VideoFrameMetadataLike) => void): number;
    cancelVideoFrameCallback?(handle: number): void;
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
    /**
     * Optional per-track output node resolver (for track FX chains, panners or meters).
     * Falls back to `output` when omitted or returning `undefined`.
     */
    readonly trackOutput?: ((trackId: string) => AudioNodeLike | undefined) | undefined;
    /**
     * Short gain fade-out duration in seconds when cancelling an active voice mid-playback
     * to prevent clicks. Defaults to `0` (immediate stop).
     */
    readonly fadeOutSeconds?: number | undefined;
    readonly catalog: StreamCatalog;
    /**
     * Supplies each voice's whole decoded stream. Give this or `media`, not both.
     * Suits short assets; a long one is better read in chunks through `media`.
     */
    readonly resolveBuffer?: ResolveBuffer | undefined;
    /**
     * Reads voices in chunks through a host-owned media cache, which keeps
     * decoded audio within a byte budget and loads ahead of the playhead. Give
     * this or `resolveBuffer`, not both.
     */
    readonly media?: MediaCache | undefined;
    readonly onError?: MediaErrorHandler | undefined;
}
export interface VideoTransportOptions extends MediaOptions {
    /** Host-owned reference video. It supplies the clock. */
    readonly video: VideoElementLike;
    /**
     * The reference video's frame rate, such as `30000 / 1001`. With it, a seek
     * asks the element for the middle of the frame that holds the target, so
     * rounding never lands on a neighbouring frame, and the target tick itself is
     * presented.
     */
    readonly frameRate?: number | undefined;
}
/** Scheduling state for one clip's voice, for tests and diagnostics. */
export interface TransportDiagnostics {
    readonly generation: number;
    readonly sampleRate: number;
    /** An opaque identity that changes when the voice is booked again. */
    readonly reservation: object | undefined;
    /** The output sample where the voice's last booked segment stops. */
    readonly endSample: number | undefined;
    /** Source nodes booked for the voice and not yet ended. */
    readonly segments: number;
}
/** Playback timing across all voices since the transport was made. */
export interface PlaybackDiagnostics {
    /** Source nodes booked and not yet ended. */
    readonly nodes: number;
    /** Segments booked from the previous segment's end sample, without a gap. */
    readonly seams: number;
    /** Segments whose length was corrected to follow the clock, within 0.1%. */
    readonly corrections: number;
    /**
     * Voices that started after their place on the timeline because their audio
     * was not ready, joining it in time but missing the start.
     */
    readonly lateStarts: number;
    /** Segments whose audio was not ready by their start, which then rejoined late. */
    readonly underruns: number;
    /** Times the video clock lost its lock with booked audio and everything was booked again. */
    readonly phaseResets: number;
    /**
     * The largest gap, in seconds, between a booked voice and the video clock at
     * the last frame observed. `0` for the audio transport, which is the clock.
     */
    readonly phaseError: number;
}
/**
 * Samples `start` to `end` of one stream at `sampleRate`. A chunk cache asks
 * for chunks on a fixed grid of the stream.
 */
export interface SampleRequest {
    readonly assetId: string;
    readonly streamId: string;
    readonly assetVersion: string | number;
    readonly sampleRate: number;
    /** The first sample frame. */
    readonly start: number;
    /** The frame after the last. */
    readonly end: number;
}
/**
 * Reads decoded samples for a media cache. This is where a host fetches,
 * authenticates and decodes its media: from pre-cut segments, byte ranges
 * through WebCodecs, a disk cache or anything else.
 */
export interface StreamReader {
    /**
     * Resolves the request's frames as a buffer whose frame 0 is `request.start`,
     * at `request.sampleRate`. It may end early where the stream does. The
     * signal aborts when nothing needs the chunk any more.
     */
    read(request: SampleRequest, signal: AbortSignal): ChannelBufferLike | PromiseLike<ChannelBufferLike>;
}
export interface MediaCacheOptions {
    readonly reader: StreamReader;
    /** Seconds of each stream in one chunk. Defaults to 10. */
    readonly chunkSeconds?: number | undefined;
    /**
     * Bytes of decoded audio to keep. Chunks nothing plays or wants are dropped,
     * least recently used first, to stay within it. Defaults to 256 MiB.
     */
    readonly budgetBytes?: number | undefined;
    /** Chunk reads in flight at once. Defaults to 4. */
    readonly concurrency?: number | undefined;
    /** Seconds of project time a transport loads ahead of its playhead. Defaults to 30. */
    readonly ahead?: number | undefined;
    /** Seconds of project time a transport keeps behind its playhead. Defaults to 5. */
    readonly behind?: number | undefined;
}
/** Part of a stream to load ahead, in sample frames. */
export interface StreamRange {
    readonly assetId: string;
    readonly streamId: string;
    readonly assetVersion: string | number;
    readonly sampleRate: number;
    readonly start: number;
    readonly end: number;
}
/** Keeps preloaded chunks wanted until released. */
export interface PreloadHandle {
    /** Resolves once every chunk is loaded or has failed, with the number that failed. */
    readonly settled: Promise<number>;
    /** Chunks loaded so far, and in all. */
    progress(): {
        readonly loaded: number;
        readonly total: number;
    };
    /** Lets the chunks go, so the budget can drop them. Returns whether it was held. */
    release(): boolean;
}
export interface MediaCacheEvent {
    readonly type: "loaded" | "evicted" | "failed";
    readonly assetId: string;
    readonly streamId: string;
    readonly assetVersion: string | number;
    /** The chunk's sample frames. */
    readonly start: number;
    readonly end: number;
    readonly error?: unknown;
}
export interface MediaCacheDiagnostics {
    readonly budgetBytes: number;
    /** Bytes of decoded chunks held now, and the most ever held. */
    readonly bytes: number;
    readonly peakBytes: number;
    readonly chunks: number;
    /** Chunks a voice, a waveform read or a hold is using, which the budget cannot drop. */
    readonly inUse: number;
    readonly loading: number;
    /** Chunks wanted ahead and not loaded yet. */
    readonly queued: number;
    readonly loads: number;
    readonly hits: number;
    readonly evictions: number;
    readonly failures: number;
    /** Reads that were aborted because nothing needed their chunk any more. */
    readonly aborted: number;
}
/**
 * Decoded audio in fixed chunks, shared by every transport and waveform source
 * that uses it, within a byte budget.
 */
export interface MediaCache {
    readonly chunkSeconds: number;
    readonly budgetBytes: number;
    /**
     * Loads these ranges, or the source ranges of these planned spans, and keeps
     * them until the handle is released.
     */
    preload(ranges: readonly (StreamRange | AudioSpan)[]): PreloadHandle;
    /**
     * A waveform source that reads through the cache. `overview` gives peaks the
     * host computed ahead, which a zoomed-out view draws without reading samples.
     */
    peakSource(stream: CachedPeakStream): PeakSource;
    /** The loaded sample ranges of a stream, merged and in order. */
    loaded(assetId: string, streamId: string, assetVersion: string | number): readonly SampleSpan[];
    subscribe(listener: (event: MediaCacheEvent) => void): () => void;
    diagnostics(): MediaCacheDiagnostics;
    /** Drops every chunk nothing uses. */
    clear(): void;
    /** Aborts reads and drops every chunk. Transports using it stop finding audio. */
    dispose(): void;
}
/** A half-open range of sample frames. */
export interface SampleSpan {
    readonly start: number;
    readonly end: number;
}
export interface CachedPeakStream {
    readonly assetId: string;
    readonly streamId: string;
    readonly assetVersion: string | number;
    readonly sampleRate: number;
    /** Sample frames in the stream. */
    readonly length: number;
    /** Defaults to 0. */
    readonly channel?: number | undefined;
    readonly overview?: PeakOverview | undefined;
}
/**
 * Min/max pairs the host computed ahead, as `buildPeakOverview` makes them.
 * Pair `i` covers samples `i * samplesPerPair` up to the next pair's first.
 */
export interface PeakOverview {
    readonly samplesPerPair: number;
    /** Interleaved minimum and maximum for each pair. */
    readonly peaks: Float32Array;
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
    /** Playback speed multiplier (`1` is real time). */
    readonly playbackRate: number;
    /** Half-open loop range in project ticks, or `null` when looping is off. */
    readonly loop: TickRange | null;
}
export interface AudioTransport {
    snapshot(): AudioTransportState;
    subscribe(listener: (state: AudioTransportState) => void): () => void;
    /**
     * Resolves `empty` for an empty sequence and `superseded` after a later
     * command. With `until`, playback pauses there. Called while playing, it
     * moves the stop, or with no `until` clears it. A pause, a seek or an
     * audition clears it too. Rejects with a `RangeError` for a stop that does
     * not follow the playback position. With a media cache, a play or a
     * playing seek waits at `starting` or `seeking` until the audio of the
     * second after its position is loaded, for at most two seconds, so it
     * starts with sound.
     */
    play(options?: PlayOptions): Promise<"playing" | "empty" | "superseded">;
    pause(): void;
    seek(tick: Tick): Promise<SeekResult>;
    /** Sets the playback speed multiplier (finite positive number). Re-anchors live playback. */
    setPlaybackRate(rate: number): void;
    /** Sets or clears a half-open loop range `[start, end)`. */
    setLoop(range: TickRange | null): void;
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
    /** Timing across all voices: seams, corrections, late starts and underruns. */
    playback(): PlaybackDiagnostics;
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
    /** Playback speed multiplier (`1` is real time). */
    readonly playbackRate: number;
    /** Half-open loop range in project ticks, or `null` when looping is off. */
    readonly loop: TickRange | null;
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
    /** Sets the playback speed multiplier (finite positive number) on the video and audio graph. */
    setPlaybackRate(rate: number): void;
    /** Sets or clears a half-open loop range `[start, end)`. */
    setLoop(range: TickRange | null): void;
    /** Behaves as on the audio transport, with the element as the clock. */
    audition(request: AuditionRequest): Promise<AuditionResult>;
    cancelAudition(): boolean;
    readonly catalog: StreamCatalog;
    setCatalog(catalog: StreamCatalog): void;
    diagnostics(clipId: string): TransportDiagnostics;
    /** Timing across all voices: seams, corrections, late starts and underruns. */
    playback(): PlaybackDiagnostics;
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
    /**
     * Peaks computed ahead. Columns at least `samplesPerPair` wide draw from
     * them and read no samples, so a zoomed-out view of a long stream stays cheap.
     */
    readonly overview?: PeakOverview | undefined;
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
    /**
     * Use the Rust SIMD kernels for large batches, in the worker and in
     * main-thread slices. Defaults to true.
     */
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
