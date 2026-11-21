import type { Editor, PlanIssue, TakeCatalog } from "@lumen-timeline/core";
import { VoiceScheduler } from "./voice-scheduler.ts";
import type { Anchor, Voice } from "./voice-scheduler.ts";
import type { AudioContextLike, AudioNodeLike, MediaErrorHandler, ResolveBuffer, SeekResult, TimedAudioContext, VideoElementLike } from "./types.ts";
export interface VideoDriverOptions {
    readonly editor: Editor;
    readonly catalog: TakeCatalog;
    readonly resolveBuffer: ResolveBuffer;
    readonly onError?: MediaErrorHandler | undefined;
    readonly onFrame?: ((seconds: number) => void) | undefined;
}
interface PendingSeek {
    readonly target: number;
    readonly resolve: (result: SeekResult) => void;
    readonly reject: (error: unknown) => void;
}
export declare function presentationTime(now: number, expected: number | undefined): number;
export declare class VideoTransport {
    readonly video: VideoElementLike;
    readonly context: TimedAudioContext;
    readonly scheduler: VoiceScheduler;
    readonly onFrame: (seconds: number) => void;
    phaseResets: number;
    phaseExcursion: {
        readonly sign: number;
        readonly since: number;
    } | null;
    running: boolean;
    readonly listeners: AbortController;
    frame: number;
    seekInFlight?: boolean;
    pending?: PendingSeek | null;
    constructor(video: VideoElementLike, context: AudioContextLike, output: AudioNodeLike, { editor, catalog, resolveBuffer, onError, onFrame }: VideoDriverOptions);
    get generation(): number;
    get anchor(): Anchor | null;
    get voices(): Map<string, Voice>;
    get issues(): readonly PlanIssue[];
    get catalog(): TakeCatalog;
    setCatalog(catalog: TakeCatalog): void;
    fill(): void;
    observe(): void;
    lostLock(media: number, audio: number): boolean;
    invalidate(): void;
    seek(target: number): Promise<SeekResult>;
    drainSeeks(): Promise<void>;
    nativeSeek(target: number): Promise<void>;
    dispose(): void;
}
export {};
