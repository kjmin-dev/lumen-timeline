import { TICKS_PER_SECOND as hz, ticksToUnits, unitsToTicks } from "@lumen-timeline/core";
import type {
  AudioSpan,
  EditCommit,
  Editor,
  PlanIssue,
  PlanOptions,
  ProjectSnapshot,
  ReadHandle,
  StreamCatalog,
  Tick,
  TickRange,
} from "@lumen-timeline/core";
import { defined } from "./invariant.ts";
import { cacheInternals, playbackNeed } from "./media-cache.ts";
import type { CacheInternals, Chunk, ChunkKey, ChunkLease } from "./media-cache.ts";
import type {
  AudioBufferLike,
  AudioContextLike,
  AudioNodeLike,
  BufferSourceLike,
  GainNodeLike,
  MediaCache,
  MediaErrorHandler,
  PlaybackDiagnostics,
  ResolveBuffer,
  TransportDiagnostics,
} from "./types.ts";

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

/** Project ticks of booked audio kept ahead of the playhead at 1×. */
const bookingLead = 2 * hz;
/** Milliseconds between plans of what to load ahead. */
const prefetchEvery = 250;
/** Project ticks after a start whose audio it waits for, at 1×. */
const readyAhead = hz;
/** Milliseconds a play waits for its audio before starting anyway. */
const readyTimeout = 2000;

// Quantize both endpoints on the same absolute output grid. A relative duration
// can round up independently and double the sample at a split in Web Audio.
export function scheduleWindow(
  node: BufferSourceLike,
  window: ScheduledWindow,
  audioAtProjectZero: number,
  outputRate: number,
  sharedStartSample?: number,
  // A missing sourceStart reads as NaN, exactly as undefined did in arithmetic.
  sourceSeconds: number = (window.sourceStart ?? NaN) / hz,
  playbackRate: number = 1,
): number {
  const sample = (tick: Tick): number =>
    Math.round((audioAtProjectZero + tick / (hz * playbackRate)) * outputRate);
  const start = sharedStartSample ?? sample(window.start);
  let end = sample(window.end);
  if (sharedStartSample !== undefined) {
    // Keep the shared sample but use the latest clock estimate for the far edge.
    // Spread a small correction over the clip, consuming exactly its source range.
    const sourceFrames = ((window.end - window.start) / (hz * playbackRate)) * outputRate;
    const nominal = Math.round(sourceFrames);
    const limit = Math.floor(nominal * 0.001);
    const length = Math.min(nominal + limit, Math.max(nominal - limit, end - start));
    end = start + length;
    if (length > 0 && length !== nominal)
      node.playbackRate.value = playbackRate * (sourceFrames / length);
    else if (playbackRate !== 1) node.playbackRate.value = playbackRate;
  } else if (playbackRate !== 1) {
    node.playbackRate.value = playbackRate;
  }
  node.start(start / outputRate, sourceSeconds);
  node.stop(end / outputRate);
  return end;
}

/**
 * Books a stretch that ends on a chunk edge, so the next segment continues from
 * its end sample. Its length follows the source frames it plays; when the clock
 * has moved more than a frame from them, the far edge follows the clock, by at
 * most 0.1%, and the node plays exactly its frames over that length.
 */
export function scheduleSegment(
  node: BufferSourceLike,
  startSample: number,
  projectedEnd: number,
  frames: number,
  sourceRate: number,
  outputRate: number,
  offsetSeconds: number,
  playbackRate: number = 1,
): { readonly end: number; readonly corrected: boolean } {
  const exact = (frames * outputRate) / (sourceRate * playbackRate);
  const nominal = Math.round(exact);
  const limit = Math.max(1, Math.floor(nominal * 0.001));
  const drift = projectedEnd - (startSample + nominal);
  const length = Math.abs(drift) > 1 ? nominal + Math.max(-limit, Math.min(limit, drift)) : nominal;
  if (length > 0 && (length !== nominal || exact !== nominal))
    node.playbackRate.value = playbackRate * (exact / length);
  else if (playbackRate !== 1) node.playbackRate.value = playbackRate;
  node.start(startSample / outputRate, offsetSeconds);
  node.stop((startSample + length) / outputRate);
  return { end: startSample + length, corrected: length !== nominal };
}

export class VoiceScheduler {
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
  private prefetched: { at: number; tick: Tick } | null;
  private woken: boolean;

  constructor({
    context,
    output = context.destination,
    trackOutput,
    fadeOutSeconds = 0,
    editor,
    catalog,
    resolveBuffer,
    media,
    onError = () => {},
    onWake,
  }: VoiceSchedulerOptions) {
    if (!Number.isFinite(fadeOutSeconds) || fadeOutSeconds < 0)
      throw new RangeError("fadeOutSeconds must be a finite nonnegative number");
    if ((resolveBuffer === undefined) === (media === undefined))
      throw new TypeError("Expected either resolveBuffer or media");
    if (resolveBuffer !== undefined && typeof resolveBuffer !== "function")
      throw new TypeError("Expected resolveBuffer to be a function");
    this.context = context;
    this.output = output;
    this.trackOutput = trackOutput;
    this.fadeOutSeconds = fadeOutSeconds;
    this.read = editor.read();
    this.read.planAudio({ start: 0, end: 0 }, catalog);
    this.catalog = catalog;
    this.options = undefined;
    this.until = Infinity;
    this.playbackRate = 1;
    this.resolveBuffer = resolveBuffer;
    this.media = media === undefined ? undefined : cacheInternals(media);
    this.onError = onError;
    this.generation = 0;
    this.voices = new Map();
    this.issues = [];
    this.anchor = null;
    this.focus = 0;
    this.counts = { seams: 0, corrections: 0, lateStarts: 0, underruns: 0 };
    this.prefetched = null;
    this.woken = false;
    this.unsubscribe = editor.subscribe(
      (s: ProjectSnapshot) => s,
      (snapshot: ProjectSnapshot, change: EditCommit) => {
        this.read = editor.read(snapshot);
        this.prefetched = null;
        if (!this.anchor) return;
        if (change.trackPatches.length) {
          this.fill(true);
          return;
        }
        if (!change.changedIds.length) return;
        const range = this.range();
        const intersects = (edge: TickRange): boolean =>
          edge.start < range.end && edge.end > range.start;
        if (
          change.changedIds.some((id) => this.voices.has(id)) ||
          change.affected.before.some(intersects) ||
          change.affected.after.some(intersects)
        ) {
          this.fill(new Set(change.changedIds));
        }
      },
    );
    // A chunk that loads or fails wakes the voices waiting for it.
    this.unwatch = this.media ? this.media.watch((chunk) => this.chunkSettled(chunk)) : () => {};
    this.timer = setInterval(() => {
      onWake?.();
      this.fill();
      this.prefetch();
    }, 25);
  }

  setAnchor(tick: Tick, audio: number, earliestTick: number = -Infinity): void {
    this.anchor = { tick, audio, earliestTick };
    this.fill();
  }

  setPlaybackRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0)
      throw new RangeError("Playback rate must be a finite positive number");
    this.playbackRate = rate;
  }

  // Callers check that an anchor is set.
  range(): TickRange {
    const anchor = defined(this.anchor ?? undefined, "playback anchor");
    const projected =
      anchor.tick + Math.ceil((this.context.currentTime - anchor.audio) * hz * this.playbackRate);
    const start = Math.max(anchor.earliestTick, projected);
    const end = Math.min(start + Math.round((hz / 10) * this.playbackRate), this.until);
    return { start: Math.min(start, end), end };
  }

  fill(changed?: ReadonlySet<string> | true): void {
    if (!this.anchor) return;
    const range = this.range();
    const read = this.read;
    const catalog = this.catalog;
    const options = this.options;
    const plan = read.planAudio(range, catalog, options);
    this.issues = plan.issues;
    if (changed) {
      const desired = new Map(plan.spans.map((span) => [span.clipId, span]));
      for (const [id, voice] of this.voices) {
        if (
          (changed === true || changed.has(id)) &&
          (!sameVoice(voice.span, desired.get(id)) || voice.failed)
        )
          this.cancel(voice);
      }
    }
    const generation = this.generation;
    for (const span of plan.spans) {
      if (this.stale(read, catalog, options, generation)) return;
      if (this.voices.has(span.clipId)) continue;
      const voice: Voice = {
        span,
        generation,
        abort: new AbortController(),
        planned: span.window.start,
        leases: new Map(),
        segments: [],
      };
      this.voices.set(span.clipId, voice);
      const resolve = this.resolveBuffer;
      if (!resolve) continue;
      try {
        const buffer = resolve(span, voice.abort.signal);
        if (isThenable(buffer)) {
          Promise.resolve(buffer)
            .then((value) => this.ready(voice, value))
            .catch((error) => this.fail(voice, error));
        } else {
          this.acceptBuffer(voice, buffer);
        }
      } catch (error) {
        this.fail(voice, error);
      }
    }
    if (this.stale(read, catalog, options, generation)) return;
    this.scheduleReady(plan.spans, range);
    // Retain a finished edge briefly for a touching successor, then release it.
    for (const voice of this.voices.values()) {
      if (voice.span.audible.end < range.start - hz / 10) this.cancel(voice);
    }
  }

  // A buffer resolver may edit, swap the catalog or start an audition.
  stale(
    read: ReadHandle,
    catalog: StreamCatalog,
    options: PlanOptions | undefined,
    generation: number,
  ): boolean {
    return (
      this.read !== read ||
      this.catalog !== catalog ||
      this.options !== options ||
      this.generation !== generation
    );
  }

  current(voice: Voice): boolean {
    return this.generation === voice.generation && this.voices.get(voice.span.clipId) === voice;
  }

  ready(voice: Voice, buffer: AudioBufferLike): void {
    if (!this.current(voice) || !this.anchor) return;
    const range = this.range();
    const { spans } = this.read.planAudio(range, this.catalog, this.options);
    const span = spans.find((s) => s.clipId === voice.span.clipId);
    if (!sameVoice(voice.span, span)) return this.cancel(voice);
    this.acceptBuffer(voice, buffer);
    this.scheduleReady(spans, range);
  }

  // JavaScript hosts are unchecked, so verify what the scheduler relies on.
  acceptBuffer(voice: Voice, buffer: AudioBufferLike): void {
    if (
      buffer?.sampleRate !== voice.span.sampleRate ||
      !(buffer.length >= voice.span.audible.sourceEnd)
    ) {
      throw new Error("Audio buffer does not cover the planned stream");
    }
    voice.buffer = buffer;
  }

  /** Wakes the voices waiting on a chunk once, after the current task's other events. */
  chunkSettled(chunk: Chunk): void {
    if (!this.anchor || this.woken) return;
    const waiting = [...this.voices.values()].some(
      (voice) => voice.leases.get(chunk.id.index)?.chunk === chunk,
    );
    if (!waiting) return;
    this.woken = true;
    queueMicrotask(() => {
      this.woken = false;
      this.fill();
    });
  }

  predecessor(span: AudioSpan, spans: readonly AudioSpan[], start: Tick): Voice | undefined {
    const sameChain = (other: AudioSpan): boolean =>
      span.trackId === other.trackId && span.chainId === other.chainId;
    if (
      start !== span.audible.start ||
      spans.some((s) => s.clipId !== span.clipId && sameChain(s) && s.audible.start === start)
    )
      return;
    let match: Voice | undefined;
    for (const other of this.voices.values()) {
      if (
        !other.complete ||
        other.endSample === undefined ||
        other.failed ||
        !sameChain(other.span) ||
        other.span.audible.end !== start
      )
        continue;
      if (match) return; // More than one predecessor makes the seam ambiguous.
      match = other;
    }
    return match;
  }

  scheduleReady(spans: readonly AudioSpan[], range: TickRange): void {
    const nowSample = this.context.currentTime * this.context.sampleRate;
    // Availability may delay the audible start inside its placement. Book seams
    // in audible order, including futures booked before a predecessor decoded.
    const ordered = [...spans];
    ordered.sort((a, b) => a.audible.start - b.audible.start);
    const horizon = Math.min(range.end + Math.round(bookingLead * this.playbackRate), this.until);
    for (const span of ordered) {
      const voice = this.voices.get(span.clipId);
      if (!voice || voice.failed || !sameVoice(voice.span, span)) continue;
      this.release(voice, nowSample);
      const first = voice.segments[0];
      if (first && voice.startSample !== undefined && voice.startSample > nowSample) {
        // A voice that has not started follows its predecessor's end sample.
        const predecessor = this.predecessor(span, spans, voice.bookedStart ?? span.window.start);
        if (voice.predecessorToken !== predecessor?.token) {
          if (predecessor && voice.startSample === predecessor.endSample)
            voice.predecessorToken = predecessor.token;
          else this.unbook(voice);
        }
      }
      try {
        this.book(voice, span, spans, range, horizon);
      } catch (error) {
        this.fail(voice, error);
      }
    }
  }

  /** Stops a voice's booked segments so it can be booked again from its start. */
  unbook(voice: Voice): void {
    const now = this.context.currentTime;
    for (const segment of voice.segments) if (!segment.ended) segment.node.stop(now);
    voice.segments = [];
    voice.complete = false;
    voice.token = undefined;
    voice.predecessorToken = undefined;
    voice.startSample = undefined;
    voice.endSample = undefined;
    voice.bookedStart = undefined;
    voice.bookedEnd = undefined;
    voice.sourceEnd = undefined;
  }

  /** Lets go of segments that have played out, and of their chunks. */
  release(voice: Voice, nowSample: number): void {
    if (!voice.leases.size && voice.segments.length < 2) return;
    let played = 0;
    for (const segment of voice.segments) {
      if (segment.endSample > nowSample || segment === voice.segments.at(-1)) break;
      played++;
    }
    if (played) voice.segments = voice.segments.slice(played);
    if (!this.media || !voice.leases.size) return;
    const first = voice.segments[0];
    const keep = first
      ? Math.floor(
          (first.endSample > nowSample ? first.sourceStart : first.sourceEnd) /
            this.media.chunkFrames(voice.span.sampleRate),
        )
      : -1;
    for (const [index, lease] of voice.leases)
      if (index < keep) {
        lease.release();
        voice.leases.delete(index);
      }
  }

  /** The chunk lease for a source frame, taken if the voice does not hold it yet. */
  lease(voice: Voice, frame: number): ChunkLease {
    const media = defined(this.media, "media cache");
    const span = voice.span;
    const index = Math.floor(frame / media.chunkFrames(span.sampleRate));
    let lease = voice.leases.get(index);
    if (!lease) {
      const key: ChunkKey = {
        assetId: span.assetId,
        streamId: span.streamId,
        assetVersion: span.assetVersion,
        sampleRate: span.sampleRate,
        index,
      };
      lease = media.acquire(key, playbackNeed);
      voice.leases.set(index, lease);
    }
    return lease;
  }

  /**
   * The buffer and offset holding a source frame, or undefined while it loads
   * or after its read failed, which fails the voice.
   */
  sourceAt(
    voice: Voice,
    frame: number,
    frames: number,
  ): { readonly buffer: AudioBufferLike; readonly offset: number } | undefined {
    if (!this.media) {
      const buffer = voice.buffer;
      return buffer ? { buffer, offset: frame } : undefined;
    }
    const { chunk } = this.lease(voice, frame);
    if (chunk.state === "failed") {
      this.fail(voice, chunk.error ?? new Error("Chunk failed to load"));
      return undefined;
    }
    if (chunk.state !== "ready" || !chunk.buffer) return undefined;
    if (chunk.buffer.length < frame - chunk.start + frames)
      throw new Error("Audio buffer does not cover the planned stream");
    return { buffer: chunk.buffer, offset: frame - chunk.start };
  }

  /** Books segments of a voice from where it stands up to the horizon. */
  book(
    voice: Voice,
    span: AudioSpan,
    spans: readonly AudioSpan[],
    range: TickRange,
    horizon: Tick,
  ): void {
    const stop = Math.min(span.audible.end, this.until);
    while (!voice.complete) {
      const previous = voice.segments.at(-1);
      let start: Tick;
      let frame: number;
      let shared: number | undefined;
      let predecessor: Voice | undefined;
      const first = voice.bookedEnd === undefined || voice.sourceEnd === undefined;
      if (voice.bookedEnd === undefined || voice.sourceEnd === undefined) {
        start = span.window.start;
        frame = span.window.sourceStart;
        predecessor = this.predecessor(span, spans, start);
        shared = predecessor?.endSample;
      } else {
        start = voice.bookedEnd;
        frame = voice.sourceEnd;
        shared = previous?.endSample ?? voice.endSample;
      }
      if (start >= stop) {
        voice.complete = true;
        break;
      }
      if (start >= horizon) break;
      const grid = this.media ? this.media.chunkFrames(span.sampleRate) : Infinity;
      // A segment whose start has passed rejoins the clip where playback is.
      const behind = !first && start < range.start;
      if (behind) {
        start = Math.min(range.start, stop);
        frame =
          span.audible.sourceStart + ticksToUnits(start - span.audible.start, span.sampleRate);
        shared = undefined;
        if (start >= stop) {
          voice.complete = true;
          break;
        }
      }
      const edge = Math.min((Math.floor(frame / grid) + 1) * grid, span.audible.sourceEnd);
      const edgeTick =
        edge === span.audible.sourceEnd
          ? span.audible.end
          : span.audible.start + unitsToTicks(edge - span.audible.sourceStart, span.sampleRate);
      const final = edgeTick >= stop;
      const end = final ? stop : edgeTick;
      const source = this.sourceAt(voice, frame, edge - frame);
      if (!source) break;
      if (behind) this.counts.underruns++;
      if (first && start > voice.planned) this.counts.lateStarts++;
      this.bookSegment(voice, span, source, { start, end, frame, edge, final, shared });
      if (first) {
        voice.token = {};
        voice.predecessorToken = predecessor?.token;
      }
    }
  }

  bookSegment(
    voice: Voice,
    span: AudioSpan,
    source: { readonly buffer: AudioBufferLike; readonly offset: number },
    at: {
      readonly start: Tick;
      readonly end: Tick;
      readonly frame: number;
      readonly edge: number;
      readonly final: boolean;
      readonly shared: number | undefined;
    },
  ): void {
    const node = this.context.createBufferSource();
    const destination = this.trackOutput?.(span.trackId) ?? this.output;
    if (voice.gainNode === undefined) {
      const gain = span.gain === 1 && this.fadeOutSeconds === 0 ? null : this.context.createGain();
      if (gain) {
        gain.gain.value = span.gain;
        gain.connect(destination);
      }
      voice.gainNode = gain;
    }
    const gain = voice.gainNode;
    node.buffer = source.buffer;
    node.connect(gain ?? destination);
    const anchor = defined(this.anchor ?? undefined, "playback anchor");
    const speed = this.playbackRate;
    const origin = anchor.audio - anchor.tick / (hz * speed);
    const rate = this.context.sampleRate;
    const offsetSeconds = source.offset / span.sampleRate;
    const startSample = at.shared ?? Math.round((origin + at.start / (hz * speed)) * rate);
    let endSample: number;
    if (at.final) {
      endSample = scheduleWindow(
        node,
        { start: at.start, end: at.end },
        origin,
        rate,
        at.shared,
        offsetSeconds,
        speed,
      );
    } else {
      const booked = scheduleSegment(
        node,
        startSample,
        Math.round((origin + at.end / (hz * speed)) * rate),
        at.edge - at.frame,
        span.sampleRate,
        rate,
        offsetSeconds,
        speed,
      );
      endSample = booked.end;
      if (booked.corrected) this.counts.corrections++;
    }
    if (at.shared !== undefined && voice.segments.length) this.counts.seams++;
    const segment: Segment = {
      node,
      start: at.start,
      end: at.end,
      startSample,
      endSample,
      sourceStart: at.frame,
      sourceEnd: at.edge,
      final: at.final,
      ended: false,
    };
    node.onended = () => {
      node.disconnect();
      segment.ended = true;
      if (segment.final && voice.node === node) {
        gain?.disconnect();
        voice.ended = true;
      }
    };
    if (!voice.segments.length) {
      voice.bookedStart = at.start;
      voice.startSample = startSample;
    }
    voice.segments.push(segment);
    voice.node = node;
    voice.ended = false;
    voice.bookedEnd = at.end;
    voice.sourceEnd = at.edge;
    voice.endSample = endSample;
    if (at.final) voice.complete = true;
  }

  fail(voice: Voice, error: unknown): void {
    if (!this.current(voice)) return;
    for (const segment of voice.segments) segment.node.disconnect();
    voice.gainNode?.disconnect();
    voice.failed = true;
    this.releaseAll(voice);
    this.onError(error, voice.span);
  }

  releaseAll(voice: Voice): void {
    for (const lease of voice.leases.values()) lease.release();
    voice.leases.clear();
  }

  cancel(voice: Voice, disconnect: boolean = false): void {
    if (this.voices.get(voice.span.clipId) !== voice) return;
    this.voices.delete(voice.span.clipId);
    voice.abort.abort();
    this.releaseAll(voice);
    const now = this.context.currentTime;
    const nowSample = now * this.context.sampleRate;
    if (!voice.ended && !voice.failed) {
      const fade = !disconnect && this.fadeOutSeconds > 0 ? this.fadeOutSeconds : 0;
      const param = voice.gainNode?.gain;
      const sounding = voice.segments.find(
        (segment) => segment.startSample <= nowSample && segment.endSample > nowSample,
      );
      const ramp =
        fade > 0 &&
        sounding !== undefined &&
        param?.setValueAtTime !== undefined &&
        param.linearRampToValueAtTime !== undefined;
      let fadeEnd = now;
      if (ramp && sounding && param?.setValueAtTime && param.linearRampToValueAtTime) {
        fadeEnd = Math.min(sounding.endSample / this.context.sampleRate, now + fade);
        param.setValueAtTime(param.value, now);
        param.linearRampToValueAtTime(0, fadeEnd);
      }
      for (const segment of voice.segments) {
        // A segment has an end sample only after its node is booked.
        if (segment.ended || segment.endSample <= nowSample) continue;
        segment.node.stop(segment === sounding ? fadeEnd : now);
      }
    }
    if (disconnect) {
      for (const segment of voice.segments) segment.node.disconnect();
      voice.gainNode?.disconnect();
    }
  }

  invalidate(disconnect: boolean = false): void {
    this.generation++;
    this.anchor = null;
    for (const voice of this.voices.values()) this.cancel(voice, disconnect);
  }

  /**
   * Plans with these options and stops every voice at `until`. Callers set
   * them while no anchor is held.
   */
  setPlan(options: PlanOptions | undefined, until: Tick = Infinity): void {
    if (options) this.read.planAudio({ start: 0, end: 0 }, this.catalog, options);
    this.options = options;
    this.until = until;
    this.prefetched = null;
  }

  /**
   * Moves the stop to `until` or earlier while playback holds an anchor. A
   * voice booked past it is cut at its output sample. A later stop needs a new
   * anchor, because booked voices already end at the earlier one.
   */
  stopAt(until: Tick): void {
    this.until = until;
    const anchor = this.anchor;
    if (!anchor) return;
    const speed = this.playbackRate;
    const origin = anchor.audio - anchor.tick / (hz * speed);
    const rate = this.context.sampleRate;
    for (const voice of this.voices.values()) {
      if (voice.ended || voice.failed || voice.bookedEnd === undefined || voice.bookedEnd <= until)
        continue;
      const untilSample = Math.round((origin + until / (hz * speed)) * rate);
      for (const segment of voice.segments) {
        if (segment.ended || segment.end <= until) continue;
        // A segment that would start after the stop never sounds.
        const endSample = Math.max(segment.startSample, untilSample);
        segment.node.stop(endSample / rate);
        segment.end = Math.max(segment.start, until);
        segment.endSample = endSample;
        segment.final = true;
      }
      const last = voice.segments.at(-1);
      voice.bookedEnd = Math.max(voice.bookedStart ?? until, until);
      voice.endSample = last?.endSample ?? voice.endSample;
      voice.complete = true;
    }
  }

  setCatalog(catalog: StreamCatalog): void {
    this.read.planAudio({ start: 0, end: 0 }, catalog, this.options);
    this.catalog = catalog;
    this.prefetched = null;
    this.fill(true);
  }

  /**
   * Plans what to load ahead around the playhead, at most every 250 ms or
   * when the playhead moves elsewhere, and tells the media cache.
   */
  prefetch(force: boolean = false): void {
    const media = this.media;
    if (!media || media.disposed) return;
    const tick = this.anchor ? this.range().start : this.focus;
    const now = Date.now();
    const last = this.prefetched;
    const speed = this.playbackRate;
    const moved = !last || Math.abs(tick - last.tick) > (prefetchEvery / 1000) * 4 * hz * speed;
    if (!force && last && !moved && now - last.at < prefetchEvery) return;
    this.prefetched = { at: now, tick };
    const ahead = Math.round(media.ahead * hz * speed);
    const behind = Math.round(media.behind * hz * speed);
    const window = {
      start: Math.max(0, tick - behind),
      end: Math.min(tick + ahead, this.until === Infinity ? tick + ahead : this.until),
    };
    if (window.end <= window.start) {
      media.want(this, []);
      return;
    }
    let spans: readonly AudioSpan[];
    try {
      spans = this.read.planAudio(window, this.catalog, this.options).spans;
    } catch {
      return;
    }
    const wanted: { readonly key: ChunkKey; readonly order: number }[] = [];
    for (const span of spans) {
      const frames = media.chunkFrames(span.sampleRate);
      const lastIndex = Math.ceil(span.window.sourceEnd / frames) - 1;
      for (let index = Math.floor(span.window.sourceStart / frames); index <= lastIndex; index++) {
        const chunkStart = Math.max(index * frames, span.audible.sourceStart);
        const chunkEnd = Math.min((index + 1) * frames, span.audible.sourceEnd);
        const from =
          span.audible.start + unitsToTicks(chunkStart - span.audible.sourceStart, span.sampleRate);
        const to =
          span.audible.start + unitsToTicks(chunkEnd - span.audible.sourceStart, span.sampleRate);
        // The chunk under the playhead first, then those ahead, then those behind.
        const order = to <= tick ? ahead + (tick - to) : Math.max(0, from - tick);
        wanted.push({
          key: {
            assetId: span.assetId,
            streamId: span.streamId,
            assetVersion: span.assetVersion,
            sampleRate: span.sampleRate,
            index,
          },
          order,
        });
      }
    }
    wanted.sort((a, b) => a.order - b.order);
    media.want(
      this,
      wanted.map((entry) => entry.key),
    );
  }

  /** Moves where loading ahead centres while paused. */
  setFocus(tick: Tick): void {
    if (tick === this.focus) return;
    this.focus = tick;
    if (!this.anchor) this.prefetch(true);
  }

  /**
   * Resolves once the chunks of every voice in the second after `tick` are
   * loaded, so a start just before a chunk edge also has the next chunk, or
   * after two seconds, or `null` when they already are.
   */
  whenReady(tick: Tick): Promise<void> | null {
    const media = this.media;
    if (!media || media.disposed) return null;
    this.focus = tick;
    this.prefetch(true);
    let spans: readonly AudioSpan[];
    try {
      const end = Math.min(tick + Math.round(readyAhead * this.playbackRate), this.until);
      if (end <= tick) return null;
      spans = this.read.planAudio({ start: tick, end }, this.catalog, this.options).spans;
    } catch {
      return null;
    }
    const leases: ChunkLease[] = [];
    for (const span of spans) {
      const frames = media.chunkFrames(span.sampleRate);
      const last = Math.ceil(span.window.sourceEnd / frames) - 1;
      for (let index = Math.floor(span.window.sourceStart / frames); index <= last; index++)
        leases.push(
          media.acquire(
            {
              assetId: span.assetId,
              streamId: span.streamId,
              assetVersion: span.assetVersion,
              sampleRate: span.sampleRate,
              index,
            },
            playbackNeed,
          ),
        );
    }
    const release = (): void => {
      for (const lease of leases) lease.release();
    };
    if (leases.every((lease) => lease.chunk.state !== "loading" && lease.chunk.state !== "idle")) {
      release();
      return null;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      Promise.allSettled(leases.map((lease) => lease.wait())).then(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, readyTimeout);
      }),
    ]).finally(() => {
      clearTimeout(timer);
      release();
    });
  }

  /**
   * The largest gap, in seconds, between where booked audio plays `tick` and
   * the clock's `audio` time for it, signed, or 0 with nothing sounding.
   */
  phaseError(tick: Tick, audio: number): number {
    let worst = 0;
    for (const voice of this.voices.values()) {
      if (voice.ended || voice.failed) continue;
      for (const segment of voice.segments) {
        if (segment.ended || tick < segment.start || tick >= segment.end) continue;
        const fraction = (tick - segment.start) / (segment.end - segment.start);
        const sample = segment.startSample + fraction * (segment.endSample - segment.startSample);
        const error = sample / this.context.sampleRate - audio;
        if (Math.abs(error) > Math.abs(worst)) worst = error;
      }
    }
    return worst;
  }

  diagnostics(clipId: string): TransportDiagnostics {
    const voice = this.voices.get(clipId);
    const now = this.context.currentTime * this.context.sampleRate;
    return Object.freeze({
      generation: this.generation,
      sampleRate: this.context.sampleRate,
      reservation: voice?.token,
      endSample: voice?.endSample,
      segments: voice ? voice.segments.filter((s) => !s.ended && s.endSample > now).length : 0,
    });
  }

  playback(phaseResets: number = 0, phaseError: number = 0): PlaybackDiagnostics {
    const now = this.context.currentTime * this.context.sampleRate;
    let nodes = 0;
    for (const voice of this.voices.values())
      for (const segment of voice.segments) if (!segment.ended && segment.endSample > now) nodes++;
    return Object.freeze({ nodes, ...this.counts, phaseResets, phaseError });
  }

  dispose(): void {
    clearInterval(this.timer);
    this.unsubscribe();
    this.unwatch();
    this.media?.want(this, []);
    this.invalidate(true);
  }
}

// A thenable is any object or function with a callable `then`, as for `await`.
function isThenable(
  value: AudioBufferLike | PromiseLike<AudioBufferLike>,
): value is PromiseLike<AudioBufferLike> {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    typeof Reflect.get(value, "then") === "function"
  );
}

function sameVoice(a: AudioSpan, b: AudioSpan | undefined): boolean {
  return (
    b !== undefined &&
    a.clipId === b.clipId &&
    a.trackId === b.trackId &&
    a.chainId === b.chainId &&
    a.takeId === b.takeId &&
    a.assetId === b.assetId &&
    a.assetVersion === b.assetVersion &&
    a.streamId === b.streamId &&
    a.sampleRate === b.sampleRate &&
    a.gain === b.gain &&
    a.sourceOriginTick === b.sourceOriginTick &&
    a.audible.start === b.audible.start &&
    a.audible.end === b.audible.end &&
    a.audible.sourceStart === b.audible.sourceStart &&
    a.audible.sourceEnd === b.audible.sourceEnd
  );
}
