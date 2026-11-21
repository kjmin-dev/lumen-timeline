import type { AudioSpan, Editor, TakeCatalog, Tick } from "@lumen-timeline/core";

// Host interfaces list only the members the transports use. Real DOM objects
// satisfy them, and test doubles can implement them without casts.

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
  addEventListener(
    type: string,
    listener: () => void,
    options?: { readonly signal?: AbortSignal },
  ): void;
  requestVideoFrameCallback(
    callback: (now: number, metadata: VideoFrameMetadataLike) => void,
  ): number;
  cancelVideoFrameCallback(handle: number): void;
}

/**
 * Supplies the decoded stream for a planned span. The buffer must use the span's
 * sample rate and cover its audible source range. The signal aborts when the
 * voice is no longer needed.
 */
export type ResolveBuffer = (
  span: AudioSpan,
  signal: AbortSignal,
) => AudioBufferLike | PromiseLike<AudioBufferLike>;

/** Receives resolution, decoding and scheduling failures for one voice. */
export type MediaErrorHandler = (error: unknown, span: AudioSpan) => void;

export interface MediaOptions {
  readonly editor: Editor;
  /** Host-owned. Pausing or disposing a transport never closes it. */
  readonly context: AudioContextLike;
  /** Defaults to `context.destination`. */
  readonly output?: AudioNodeLike | undefined;
  readonly catalog: TakeCatalog;
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

export type AudioTransportStatus =
  | "paused"
  | "starting"
  | "playing"
  | "seeking"
  | "interrupted"
  | "ended"
  | "closed"
  | "disposed";

/** `output` follows the audio output timestamp, `estimated` the rendering clock. */
export type ClockPrecision = "exact" | "output" | "estimated";

export interface AudioTransportState {
  readonly status: AudioTransportStatus;
  readonly playing: boolean;
  readonly presentedTick: Tick;
  readonly requestedTick: Tick | null;
  readonly precision: ClockPrecision;
}

export interface AudioTransport {
  snapshot(): AudioTransportState;
  subscribe(listener: (state: AudioTransportState) => void): () => void;
  /** Resolves `empty` for an empty sequence and `superseded` after a later command. */
  play(): Promise<"playing" | "empty" | "superseded">;
  pause(): void;
  seek(tick: Tick): Promise<SeekResult>;
  readonly catalog: TakeCatalog;
  setCatalog(catalog: TakeCatalog): void;
  diagnostics(clipId: string): TransportDiagnostics;
  dispose(): void;
}

export interface VideoTransportState {
  readonly playing: boolean;
  readonly presentedTick: Tick;
  readonly requestedTick: Tick | null;
}

export interface VideoTransport {
  snapshot(): VideoTransportState;
  /** The disposer returns whether the listener was still subscribed. */
  subscribe(listener: (state: VideoTransportState) => void): () => boolean;
  play(): Promise<void>;
  pause(): void;
  seek(tick: Tick): Promise<SeekResult>;
  readonly catalog: TakeCatalog;
  setCatalog(catalog: TakeCatalog): void;
  diagnostics(clipId: string): TransportDiagnostics;
  dispose(): void;
}
