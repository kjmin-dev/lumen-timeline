import type { AudioSpan, Editor, PlanIssue, PlanOptions, ReadHandle, StreamCatalog, Tick, TickRange } from "@lumen-timeline/core";
import type { CacheInternals, Chunk, ChunkLease } from "./media-cache.ts";
import type { AudioBufferLike, AudioContextLike, AudioNodeLike, BufferSourceLike, GainNodeLike, MediaCache, MediaErrorHandler, PlaybackDiagnostics, ResolveBuffer, TransportDiagnostics } from "./types.ts";
/** A project tick paired with the audio-context time at which it plays. */
export interface Anchor {
    readonly tick: Tick;
    readonly audio: number;
    readonly earliestTick: number;
}
/** One source node of a voice: a stretch of the clip inside one chunk. */
export interface Segment {
    readonly node: BufferSourceLike;
    /** The project tick the segment starts at, and the tick it stops at. */
    readonly start: Tick;
    end: Tick;
    readonly startSample: number;
    endSample: number;
    /** Source frames it plays: `sourceEnd` is where the next segment continues. */
    readonly sourceStart: number;
    readonly sourceEnd: number;
    /** Whether it stops where the voice does, at the audible end or the stop tick. */
    final: boolean;
    ended: boolean;
}
/** One planned clip's resolution and reservation state. */
export interface Voice {
    readonly span: AudioSpan;
    readonly generation: number;
    readonly abort: AbortController;
    /** Where the plan placed the voice when it was made. A later first segment started late. */
    readonly planned: Tick;
    /** The whole stream, from `resolveBuffer`. */
    buffer?: AudioBufferLike;
    /** Chunk holds by index, from a media cache, until their segments have played. */
    readonly leases: Map<number, ChunkLease>;
    /** Booked segments that have not played out, in order. */
    segments: Segment[];
    /** The most recently booked segment's node. */
    node?: BufferSourceLike;
    gainNode?: GainNodeLike | null;
    /** The last segment is booked, up to the audible end or the stop tick. */
    complete?: boolean;
    ended?: boolean;
    failed?: boolean;
    bookedStart?: Tick | undefined;
    /** The tick the last booked segment stops at: the audible end, a chunk edge or an earlier stop. */
    bookedEnd?: Tick | undefined;
    /** The source frame the next segment starts at. */
    sourceEnd?: number | undefined;
    token?: object | undefined;
    predecessorToken?: object | undefined;
    startSample?: number | undefined;
    endSample?: number | undefined;
}
export interface VoiceSchedulerOptions {
    readonly context: AudioContextLike;
    readonly output?: AudioNodeLike | undefined;
    readonly trackOutput?: ((trackId: string) => AudioNodeLike | undefined) | undefined;
    readonly fadeOutSeconds?: number | undefined;
    readonly editor: Editor;
    readonly catalog: StreamCatalog;
    readonly resolveBuffer?: ResolveBuffer | undefined;
    readonly media?: MediaCache | undefined;
    readonly onError?: MediaErrorHandler | undefined;
    readonly onWake?: (() => void) | undefined;
}
/** The part of a span that `scheduleWindow` books. */
export interface ScheduledWindow {
    readonly start: Tick;
    readonly end: Tick;
    readonly sourceStart?: Tick;
}
export declare function scheduleWindow(node: BufferSourceLike, window: ScheduledWindow, audioAtProjectZero: number, outputRate: number, sharedStartSample?: number, sourceSeconds?: number, playbackRate?: number): number;
/**
 * Books a stretch that ends on a chunk edge, so the next segment continues from
 * its end sample. Its length follows the source frames it plays; when the clock
 * has moved more than a frame from them, the far edge follows the clock, by at
 * most 0.1%, and the node plays exactly its frames over that length.
 */
export declare function scheduleSegment(node: BufferSourceLike, startSample: number, projectedEnd: number, frames: number, sourceRate: number, outputRate: number, offsetSeconds: number, playbackRate?: number): {
    readonly end: number;
    readonly corrected: boolean;
};
export declare class VoiceScheduler {
    readonly context: AudioContextLike;
    readonly output: AudioNodeLike;
    readonly trackOutput: ((trackId: string) => AudioNodeLike | undefined) | undefined;
    readonly fadeOutSeconds: number;
    read: ReadHandle;
    catalog: StreamCatalog;
    /** Plan options for every fill, as an audition sets them. */
    options: PlanOptions | undefined;
    /** No voice plays at or after this tick. */
    until: Tick;
    /** Playback speed multiplier (`1` is real time). */
    playbackRate: number;
    readonly resolveBuffer: ResolveBuffer | undefined;
    readonly media: CacheInternals | undefined;
    readonly onError: MediaErrorHandler;
    generation: number;
    readonly voices: Map<string, Voice>;
    issues: readonly PlanIssue[];
    anchor: Anchor | null;
    /** Where loading ahead centres while no anchor is held, as the transport presents it. */
    focus: Tick;
    readonly counts: {
        seams: number;
        corrections: number;
        lateStarts: number;
        underruns: number;
    };
    readonly unsubscribe: () => boolean;
    readonly unwatch: () => void;
    readonly timer: ReturnType<typeof setInterval>;
    private prefetched;
    private woken;
    constructor({ context, output, trackOutput, fadeOutSeconds, editor, catalog, resolveBuffer, media, onError, onWake, }: VoiceSchedulerOptions);
    setAnchor(tick: Tick, audio: number, earliestTick?: number): void;
    setPlaybackRate(rate: number): void;
    range(): TickRange;
    fill(changed?: ReadonlySet<string> | true): void;
    stale(read: ReadHandle, catalog: StreamCatalog, options: PlanOptions | undefined, generation: number): boolean;
    current(voice: Voice): boolean;
    ready(voice: Voice, buffer: AudioBufferLike): void;
    acceptBuffer(voice: Voice, buffer: AudioBufferLike): void;
    /** Wakes the voices waiting on a chunk once, after the current task's other events. */
    chunkSettled(chunk: Chunk): void;
    predecessor(span: AudioSpan, spans: readonly AudioSpan[], start: Tick): Voice | undefined;
    scheduleReady(spans: readonly AudioSpan[], range: TickRange): void;
    /** Stops a voice's booked segments so it can be booked again from its start. */
    unbook(voice: Voice): void;
    /** Lets go of segments that have played out, and of their chunks. */
    release(voice: Voice, nowSample: number): void;
    /** The chunk lease for a source frame, taken if the voice does not hold it yet. */
    lease(voice: Voice, frame: number): ChunkLease;
    /**
     * The buffer and offset holding a source frame, or undefined while it loads
     * or after its read failed, which fails the voice.
     */
    sourceAt(voice: Voice, frame: number, frames: number): {
        readonly buffer: AudioBufferLike;
        readonly offset: number;
    } | undefined;
    /** Books segments of a voice from where it stands up to the horizon. */
    book(voice: Voice, span: AudioSpan, spans: readonly AudioSpan[], range: TickRange, horizon: Tick): void;
    bookSegment(voice: Voice, span: AudioSpan, source: {
        readonly buffer: AudioBufferLike;
        readonly offset: number;
    }, at: {
        readonly start: Tick;
        readonly end: Tick;
        readonly frame: number;
        readonly edge: number;
        readonly final: boolean;
        readonly shared: number | undefined;
    }): void;
    fail(voice: Voice, error: unknown): void;
    releaseAll(voice: Voice): void;
    cancel(voice: Voice, disconnect?: boolean): void;
    invalidate(disconnect?: boolean): void;
    /**
     * Plans with these options and stops every voice at `until`. Callers set
     * them while no anchor is held.
     */
    setPlan(options: PlanOptions | undefined, until?: Tick): void;
    /**
     * Moves the stop to `until` or earlier while playback holds an anchor. A
     * voice booked past it is cut at its output sample. A later stop needs a new
     * anchor, because booked voices already end at the earlier one.
     */
    stopAt(until: Tick): void;
    setCatalog(catalog: StreamCatalog): void;
    /**
     * Plans what to load ahead around the playhead, at most every 250 ms or
     * when the playhead moves elsewhere, and tells the media cache.
     */
    prefetch(force?: boolean): void;
    /** Moves where loading ahead centres while paused. */
    setFocus(tick: Tick): void;
    /**
     * Resolves once the chunks of every voice in the second after `tick` are
     * loaded, so a start just before a chunk edge also has the next chunk, or
     * after two seconds, or `null` when they already are.
     */
    whenReady(tick: Tick): Promise<void> | null;
    /**
     * The largest gap, in seconds, between where booked audio plays `tick` and
     * the clock's `audio` time for it, signed, or 0 with nothing sounding.
     */
    phaseError(tick: Tick, audio: number): number;
    diagnostics(clipId: string): TransportDiagnostics;
    playback(phaseResets?: number, phaseError?: number): PlaybackDiagnostics;
    dispose(): void;
}
