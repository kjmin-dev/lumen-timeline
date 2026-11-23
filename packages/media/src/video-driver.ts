import { TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import type { Editor, PlanIssue, StreamCatalog } from "@lumen-timeline/core";
import { VoiceScheduler } from "./voice-scheduler.ts";
import type { Anchor, Voice } from "./voice-scheduler.ts";
import type {
  AudioContextLike,
  AudioNodeLike,
  MediaErrorHandler,
  ResolveBuffer,
  SeekResult,
  TimedAudioContext,
  VideoElementLike,
} from "./types.ts";

function reportsOutputTime(context: AudioContextLike): context is TimedAudioContext {
  return typeof context.getOutputTimestamp === "function";
}

export interface VideoDriverOptions {
  readonly editor: Editor;
  readonly catalog: StreamCatalog;
  readonly resolveBuffer: ResolveBuffer;
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

// A frame timestamp must belong to the callback's performance time origin.
export function presentationTime(now: number, expected: number | undefined): number {
  return Number.isFinite(expected) && typeof expected === "number" && Math.abs(expected - now) < 500
    ? expected
    : now;
}

// The video is the clock; Web Audio owns sample delivery.
export class VideoTransport {
  readonly video: VideoElementLike;
  readonly context: AudioContextLike;
  readonly scheduler: VoiceScheduler;
  readonly onFrame: (seconds: number) => void;
  readonly useVideoFrameCallback: boolean;
  phaseResets: number;
  phaseExcursion: { readonly sign: number; readonly since: number } | null;
  running: boolean;
  readonly listeners: AbortController;
  // Replaced by observe() before the constructor returns.
  frame = 0;
  // Created by the first seek, as before.
  declare seekInFlight?: boolean;
  declare pending?: PendingSeek | null;

  constructor(
    video: VideoElementLike,
    context: AudioContextLike,
    output: AudioNodeLike,
    {
      editor,
      catalog,
      resolveBuffer,
      trackOutput,
      fadeOutSeconds,
      onError = () => {},
      onFrame = () => {},
    }: VideoDriverOptions,
  ) {
    this.video = video;
    this.context = context;
    this.useVideoFrameCallback = typeof video.requestVideoFrameCallback === "function";
    this.scheduler = new VoiceScheduler({
      editor,
      context,
      output,
      trackOutput,
      fadeOutSeconds,
      catalog,
      resolveBuffer,
      onError,
    });
    if (
      typeof video.playbackRate === "number" &&
      Number.isFinite(video.playbackRate) &&
      video.playbackRate > 0
    ) {
      this.scheduler.setPlaybackRate(video.playbackRate);
    }
    this.onFrame = onFrame;
    this.phaseResets = 0;
    this.phaseExcursion = null;
    this.running = !video.paused && !video.ended && video.readyState >= 3;
    this.listeners = new AbortController();
    const listen = (type: string, fn: () => void): void =>
      video.addEventListener(type, fn, { signal: this.listeners.signal });
    for (const type of ["waiting", "seeking", "pause", "ended"]) {
      listen(type, () => {
        this.running = false;
        this.invalidate();
      });
    }
    listen("playing", () => {
      this.running = true;
    });
    this.observe();
  }

  get generation(): number {
    return this.scheduler.generation;
  }
  get anchor(): Anchor | null {
    return this.scheduler.anchor;
  }
  get voices(): Map<string, Voice> {
    return this.scheduler.voices;
  }
  get issues(): readonly PlanIssue[] {
    return this.scheduler.issues;
  }
  get catalog(): StreamCatalog {
    return this.scheduler.catalog;
  }
  setCatalog(catalog: StreamCatalog): void {
    this.scheduler.setCatalog(catalog);
  }
  setPlaybackRate(rate: number): void {
    this.scheduler.setPlaybackRate(rate);
  }
  fill(): void {
    this.scheduler.fill();
  }

  private sampleFrame(generation: number, now: number, mediaTime: number, expected?: number): void {
    if (generation !== this.generation || this.video.seeking || this.seekInFlight) return;
    if (this.video.paused || this.running) this.onFrame(mediaTime);
    if (this.video.paused || !this.running) return;
    let audio: number;
    if (reportsOutputTime(this.context)) {
      // Missing timestamp fields read as NaN, exactly as undefined did in arithmetic.
      const stamp = this.context.getOutputTimestamp();
      const performanceTime = stamp.performanceTime ?? NaN;
      if (!(performanceTime > 0)) return;
      audio =
        (stamp.contextTime ?? NaN) + (presentationTime(now, expected) - performanceTime) / 1000;
    } else {
      audio = this.context.currentTime;
    }
    const speed = this.scheduler.playbackRate;
    if (
      this.anchor &&
      Math.abs(this.anchor.tick / hz + (audio - this.anchor.audio) * speed - mediaTime) > 0.075
    ) {
      this.invalidate();
    } else if (this.lostLock(mediaTime, audio)) {
      this.phaseResets++;
      this.invalidate();
    }
    this.scheduler.setAnchor(Math.round(mediaTime * hz), audio);
  }

  observe(): void {
    const generation = this.generation;
    if (this.useVideoFrameCallback && this.video.requestVideoFrameCallback) {
      this.frame = this.video.requestVideoFrameCallback((now, frame) => {
        this.observe();
        this.sampleFrame(generation, now, frame.mediaTime, frame.expectedDisplayTime);
      });
    } else if (typeof globalThis.requestAnimationFrame === "function") {
      this.frame = globalThis.requestAnimationFrame((now) => {
        this.observe();
        this.sampleFrame(generation, now, this.video.currentTime);
      });
    }
  }

  lostLock(media: number, audio: number): boolean {
    // Consecutive video observations can agree with one another while a long
    // source booked against an older anchor slips further from the output clock.
    const tick = media * hz;
    let worst = 0;
    for (const voice of this.voices.values()) {
      // A voice with an end sample was booked, so its start fields are set too.
      const { bookedStart, bookedEnd, startSample, endSample } = voice;
      if (
        endSample === undefined ||
        bookedStart === undefined ||
        bookedEnd === undefined ||
        startSample === undefined ||
        voice.ended ||
        voice.failed ||
        tick < bookedStart ||
        tick >= bookedEnd
      )
        continue;
      const fraction = (tick - bookedStart) / (bookedEnd - bookedStart);
      const sample = startSample + fraction * (endSample - startSample);
      const error = sample / this.context.sampleRate - audio;
      if (Math.abs(error) > Math.abs(worst)) worst = error;
    }
    if (Math.abs(worst) <= 0.025) {
      this.phaseExcursion = null;
      return false;
    }
    const sign = Math.sign(worst);
    if (this.phaseExcursion?.sign !== sign) this.phaseExcursion = { sign, since: audio };
    return audio - this.phaseExcursion.since >= 0.2;
  }

  invalidate(): void {
    this.phaseExcursion = null;
    this.scheduler.invalidate();
  }

  seek(target: number): Promise<SeekResult> {
    if (this.listeners.signal.aborted) return Promise.reject(new Error("Transport disposed"));
    if (!Number.isFinite(target) || target < 0 || target > this.video.duration) {
      return Promise.reject(new RangeError("Target outside media range"));
    }
    if (this.pending) this.pending.resolve("superseded");
    const result = new Promise<SeekResult>((resolve, reject) => {
      this.pending = { target, resolve, reject };
    });
    if (!this.seekInFlight) void this.drainSeeks();
    return result;
  }

  async drainSeeks(): Promise<void> {
    this.seekInFlight = true;
    this.invalidate();
    try {
      while (this.pending) {
        const request = this.pending;
        this.pending = null;
        try {
          if (this.video.seeking || Math.abs(this.video.currentTime - request.target) > 0.00001) {
            await this.nativeSeek(request.target);
          }
          if (!this.pending && Math.abs(this.video.currentTime - request.target) > 0.05) {
            throw new Error(
              "Seek to " + request.target + " completed at " + this.video.currentTime,
            );
          }
          request.resolve(this.pending ? "superseded" : "arrived");
        } catch (error) {
          request.reject(error);
        }
      }
    } finally {
      this.seekInFlight = false;
      this.running =
        !this.listeners.signal.aborted &&
        !this.video.paused &&
        !this.video.ended &&
        this.video.readyState >= 3;
    }
  }

  nativeSeek(target: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const events = new AbortController();
      const finish = (error?: unknown): void => {
        events.abort();
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => finish(new Error("Native seek timed out")), 5000);
      this.video.addEventListener(
        "seeked",
        () => {
          // A queued native event from an older seek may arrive after assignment.
          if (!this.video.seeking && Math.abs(this.video.currentTime - target) <= 0.05) finish();
        },
        { signal: events.signal },
      );
      this.video.addEventListener("error", () => finish(new Error("Media error")), {
        signal: events.signal,
      });
      this.listeners.signal.addEventListener(
        "abort",
        () => finish(new Error("Transport disposed")),
        { signal: events.signal },
      );
      try {
        this.video.currentTime = target;
      } catch (error) {
        finish(error);
      }
    });
  }

  dispose(): void {
    this.pending?.reject(new Error("Transport disposed"));
    this.pending = null;
    this.listeners.abort();
    if (this.useVideoFrameCallback && this.video.cancelVideoFrameCallback) {
      this.video.cancelVideoFrameCallback(this.frame);
    } else if (this.frame && typeof globalThis.cancelAnimationFrame === "function") {
      globalThis.cancelAnimationFrame(this.frame);
    }
    this.running = false;
    this.scheduler.dispose();
  }
}
