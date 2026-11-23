import type { AudioSpan, Editor, PlanIssue, PlanOptions, ReadHandle, StreamCatalog, Tick, TickRange } from "@lumen-timeline/core";
import type { AudioBufferLike, AudioContextLike, AudioNodeLike, BufferSourceLike, GainNodeLike, MediaErrorHandler, ResolveBuffer, TransportDiagnostics } from "./types.ts";
/** A project tick paired with the audio-context time at which it plays. */
export interface Anchor {
    readonly tick: Tick;
    readonly audio: number;
    readonly earliestTick: number;
}
/** One planned clip's resolution and reservation state. */
export interface Voice {
    readonly span: AudioSpan;
    readonly generation: number;
    readonly abort: AbortController;
    buffer?: AudioBufferLike;
    node?: BufferSourceLike;
    gainNode?: GainNodeLike | null;
    ended?: boolean;
    failed?: boolean;
    bookedStart?: Tick;
    /** The tick the booked node stops at: the audible end, or an earlier stop tick. */
    bookedEnd?: Tick;
    token?: object;
    predecessorToken?: object | undefined;
    startSample?: number;
    endSample?: number;
}
export interface VoiceSchedulerOptions {
    readonly context: AudioContextLike;
    readonly output?: AudioNodeLike | undefined;
    readonly trackOutput?: ((trackId: string) => AudioNodeLike | undefined) | undefined;
    readonly fadeOutSeconds?: number | undefined;
    readonly editor: Editor;
    readonly catalog: StreamCatalog;
    readonly resolveBuffer: ResolveBuffer;
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
    readonly resolveBuffer: ResolveBuffer;
    readonly onError: MediaErrorHandler;
    generation: number;
    readonly voices: Map<string, Voice>;
    issues: readonly PlanIssue[];
    anchor: Anchor | null;
    readonly unsubscribe: () => boolean;
    readonly timer: ReturnType<typeof setInterval>;
    constructor({ context, output, trackOutput, fadeOutSeconds, editor, catalog, resolveBuffer, onError, onWake, }: VoiceSchedulerOptions);
    setAnchor(tick: Tick, audio: number, earliestTick?: number): void;
    setPlaybackRate(rate: number): void;
    range(): TickRange;
    fill(changed?: ReadonlySet<string> | true): void;
    stale(read: ReadHandle, catalog: StreamCatalog, options: PlanOptions | undefined, generation: number): boolean;
    current(voice: Voice): boolean;
    ready(voice: Voice, buffer: AudioBufferLike): void;
    acceptBuffer(voice: Voice, buffer: AudioBufferLike): void;
    predecessor(span: AudioSpan, spans: readonly AudioSpan[], start: Tick): Voice | undefined;
    scheduleReady(spans: readonly AudioSpan[]): void;
    book(voice: Voice, span: AudioSpan, predecessor: Voice | undefined): void;
    fail(voice: Voice, error: unknown): void;
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
    diagnostics(clipId: string): TransportDiagnostics;
    dispose(): void;
}
