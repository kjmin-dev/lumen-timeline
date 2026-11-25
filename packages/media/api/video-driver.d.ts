import type { Editor, PlanIssue, StreamCatalog } from "@lumen-timeline/core";
import { VoiceScheduler } from "./voice-scheduler.ts";
import type { Anchor, Voice } from "./voice-scheduler.ts";
import type { AudioContextLike, AudioNodeLike, MediaCache, MediaErrorHandler, ResolveBuffer, StretchAudio, SeekResult, VideoElementLike } from "./types.ts";
export interface VideoDriverOptions {
    readonly editor: Editor;
    readonly catalog: StreamCatalog;
    readonly resolveBuffer?: ResolveBuffer | undefined;
    readonly media?: MediaCache | undefined;
    readonly stretch?: StretchAudio | undefined;
    readonly trackOutput?: ((trackId: string) => AudioNodeLike | undefined) | undefined;
    readonly fadeOutSeconds?: number | undefined;
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
    readonly context: AudioContextLike;
    readonly scheduler: VoiceScheduler;
    readonly onFrame: (seconds: number) => void;
    readonly useVideoFrameCallback: boolean;
    phaseResets: number;
    /** The largest gap between booked audio and the video clock at the last frame, in seconds. */
    phaseError: number;
    phaseExcursion: {
        readonly sign: number;
        readonly since: number;
    } | null;
    running: boolean;
    readonly listeners: AbortController;
    frame: number;
    seekInFlight?: boolean;
    pending?: PendingSeek | null;
    constructor(video: VideoElementLike, context: AudioContextLike, output: AudioNodeLike, { editor, catalog, resolveBuffer, media, stretch, trackOutput, fadeOutSeconds, onError, onFrame, }: VideoDriverOptions);
    get generation(): number;
    get anchor(): Anchor | null;
    get voices(): Map<string, Voice>;
    get issues(): readonly PlanIssue[];
    get catalog(): StreamCatalog;
    setCatalog(catalog: StreamCatalog): void;
    setPlaybackRate(rate: number): void;
    fill(): void;
    private sampleFrame;
    observe(): void;
    lostLock(media: number, audio: number): boolean;
    invalidate(): void;
    seek(target: number): Promise<SeekResult>;
    drainSeeks(): Promise<void>;
    /** Whether the element is playing with data ahead of it. */
    private playable;
    nativeSeek(target: number): Promise<void>;
    dispose(): void;
}
export {};
