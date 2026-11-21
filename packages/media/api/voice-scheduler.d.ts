import type { AudioSpan, Editor, PlanIssue, ReadHandle, TakeCatalog, Tick, TickRange } from "@lumen-timeline/core";
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
    token?: object;
    predecessorToken?: object | undefined;
    startSample?: number;
    endSample?: number;
}
export interface VoiceSchedulerOptions {
    readonly context: AudioContextLike;
    readonly output?: AudioNodeLike | undefined;
    readonly editor: Editor;
    readonly catalog: TakeCatalog;
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
export declare function scheduleWindow(node: BufferSourceLike, window: ScheduledWindow, audioAtProjectZero: number, outputRate: number, sharedStartSample?: number, sourceSeconds?: number): number;
export declare class VoiceScheduler {
    readonly context: AudioContextLike;
    readonly output: AudioNodeLike;
    read: ReadHandle;
    catalog: TakeCatalog;
    readonly resolveBuffer: ResolveBuffer;
    readonly onError: MediaErrorHandler;
    generation: number;
    readonly voices: Map<string, Voice>;
    issues: readonly PlanIssue[];
    anchor: Anchor | null;
    readonly unsubscribe: () => boolean;
    readonly timer: ReturnType<typeof setInterval>;
    constructor({ context, output, editor, catalog, resolveBuffer, onError, onWake, }: VoiceSchedulerOptions);
    setAnchor(tick: Tick, audio: number, earliestTick?: number): void;
    range(): TickRange;
    fill(changed?: ReadonlySet<string> | true): void;
    current(voice: Voice): boolean;
    ready(voice: Voice, buffer: AudioBufferLike): void;
    acceptBuffer(voice: Voice, buffer: AudioBufferLike): void;
    predecessor(span: AudioSpan, spans: readonly AudioSpan[], start: Tick): Voice | undefined;
    scheduleReady(spans: readonly AudioSpan[]): void;
    book(voice: Voice, span: AudioSpan, predecessor: Voice | undefined): void;
    fail(voice: Voice, error: unknown): void;
    cancel(voice: Voice, disconnect?: boolean): void;
    invalidate(disconnect?: boolean): void;
    setCatalog(catalog: TakeCatalog): void;
    diagnostics(clipId: string): TransportDiagnostics;
    dispose(): void;
}
