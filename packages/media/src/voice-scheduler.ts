import { TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
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
import type {
  AudioBufferLike,
  AudioContextLike,
  AudioNodeLike,
  BufferSourceLike,
  GainNodeLike,
  MediaErrorHandler,
  ResolveBuffer,
  TransportDiagnostics,
} from "./types.ts";

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
): number {
  const sample = (tick: Tick): number => Math.round((audioAtProjectZero + tick / hz) * outputRate);
  const start = sharedStartSample ?? sample(window.start);
  let end = sample(window.end);
  if (sharedStartSample !== undefined) {
    // Keep the shared sample but use the latest clock estimate for the far edge.
    // Spread a small correction over the clip, consuming exactly its source range.
    const sourceFrames = ((window.end - window.start) / hz) * outputRate;
    const nominal = Math.round(sourceFrames);
    const limit = Math.floor(nominal * 0.001);
    const length = Math.min(nominal + limit, Math.max(nominal - limit, end - start));
    end = start + length;
    if (length > 0 && length !== nominal) node.playbackRate.value = sourceFrames / length;
  }
  node.start(start / outputRate, sourceSeconds);
  node.stop(end / outputRate);
  return end;
}

export class VoiceScheduler {
  readonly context: AudioContextLike;
  readonly output: AudioNodeLike;
  read: ReadHandle;
  catalog: StreamCatalog;
  /** Plan options for every fill, as an audition sets them. */
  options: PlanOptions | undefined;
  /** No voice plays at or after this tick. */
  until: Tick;
  readonly resolveBuffer: ResolveBuffer;
  readonly onError: MediaErrorHandler;
  generation: number;
  readonly voices: Map<string, Voice>;
  issues: readonly PlanIssue[];
  anchor: Anchor | null;
  readonly unsubscribe: () => boolean;
  readonly timer: ReturnType<typeof setInterval>;

  constructor({
    context,
    output = context.destination,
    editor,
    catalog,
    resolveBuffer,
    onError = () => {},
    onWake,
  }: VoiceSchedulerOptions) {
    this.context = context;
    this.output = output;
    this.read = editor.read();
    this.read.planAudio({ start: 0, end: 0 }, catalog);
    this.catalog = catalog;
    this.options = undefined;
    this.until = Infinity;
    this.resolveBuffer = resolveBuffer;
    this.onError = onError;
    this.generation = 0;
    this.voices = new Map();
    this.issues = [];
    this.anchor = null;
    this.unsubscribe = editor.subscribe(
      (s: ProjectSnapshot) => s,
      (snapshot: ProjectSnapshot, change: EditCommit) => {
        this.read = editor.read(snapshot);
        if (!this.anchor || !change.changedIds.length) return;
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
    this.timer = setInterval(() => {
      onWake?.();
      this.fill();
    }, 25);
  }

  setAnchor(tick: Tick, audio: number, earliestTick: number = -Infinity): void {
    this.anchor = { tick, audio, earliestTick };
    this.fill();
  }

  // Callers check that an anchor is set.
  range(): TickRange {
    const anchor = defined(this.anchor ?? undefined, "playback anchor");
    const projected = anchor.tick + Math.ceil((this.context.currentTime - anchor.audio) * hz);
    const start = Math.max(anchor.earliestTick, projected);
    const end = Math.min(start + hz / 10, this.until);
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
      const voice: Voice = { span, generation, abort: new AbortController() };
      this.voices.set(span.clipId, voice);
      try {
        const buffer = this.resolveBuffer(span, voice.abort.signal);
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
    this.scheduleReady(plan.spans);
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
    const { spans } = this.read.planAudio(this.range(), this.catalog, this.options);
    const span = spans.find((s) => s.clipId === voice.span.clipId);
    if (!sameVoice(voice.span, span)) return this.cancel(voice);
    this.acceptBuffer(voice, buffer);
    this.scheduleReady(spans);
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

  scheduleReady(spans: readonly AudioSpan[]): void {
    const nowSample = this.context.currentTime * this.context.sampleRate;
    const upcoming = spans.filter((span) => {
      const v = this.voices.get(span.clipId);
      return (
        v?.buffer && !v.failed && (!v.node || defined(v.startSample, "booked start") > nowSample)
      );
    });
    // Availability may delay the audible start inside its placement. Book seams
    // in audible order, including futures booked before a predecessor decoded.
    upcoming.sort((a, b) => a.audible.start - b.audible.start);
    for (const span of upcoming) {
      const voice = this.voices.get(span.clipId);
      if (!voice || !sameVoice(voice.span, span)) continue;
      const predecessor = this.predecessor(span, spans, voice.bookedStart ?? span.window.start);
      if (voice.node) {
        if (voice.predecessorToken === predecessor?.token) continue;
        // A booked voice has a start sample, so only a real predecessor can match it.
        if (predecessor && voice.startSample === predecessor.endSample) {
          voice.predecessorToken = predecessor.token;
          continue;
        }
        voice.node.stop(this.context.currentTime);
      }
      try {
        this.book(voice, span, predecessor);
      } catch (error) {
        this.fail(voice, error);
      }
    }
  }

  // Called only while an anchor is set.
  book(voice: Voice, span: AudioSpan, predecessor: Voice | undefined): void {
    const node = this.context.createBufferSource();
    voice.node = node;
    voice.ended = false;
    const gain = span.gain === 1 ? null : this.context.createGain();
    voice.gainNode = gain;
    node.onended = () => {
      node.disconnect();
      gain?.disconnect();
      if (voice.node === node) voice.ended = true;
    };
    node.buffer = defined(voice.buffer, "accepted buffer");
    if (gain) {
      gain.gain.value = span.gain;
      gain.connect(this.output);
    }
    node.connect(gain ?? this.output);
    const anchor = defined(this.anchor ?? undefined, "playback anchor");
    const origin = anchor.audio - anchor.tick / hz;
    const rate = this.context.sampleRate;
    const start = span.window.start;
    const end = Math.min(span.audible.end, this.until);
    const shared = predecessor?.endSample;
    voice.bookedStart = start;
    voice.bookedEnd = end;
    voice.token = {};
    voice.predecessorToken = predecessor?.token;
    voice.startSample = shared ?? Math.round((origin + start / hz) * rate);
    voice.endSample = scheduleWindow(
      node,
      { start, end },
      origin,
      rate,
      shared,
      span.window.sourceStart / span.sampleRate,
    );
  }

  fail(voice: Voice, error: unknown): void {
    if (!this.current(voice)) return;
    voice.node?.disconnect();
    voice.gainNode?.disconnect();
    voice.failed = true;
    this.onError(error, voice.span);
  }

  cancel(voice: Voice, disconnect: boolean = false): void {
    if (this.voices.get(voice.span.clipId) !== voice) return;
    this.voices.delete(voice.span.clipId);
    voice.abort.abort();
    if (
      !voice.ended &&
      !voice.failed &&
      voice.node &&
      voice.endSample !== undefined &&
      voice.endSample > this.context.currentTime * this.context.sampleRate
    ) {
      // A voice has an end sample only after its node is booked.
      voice.node.stop(this.context.currentTime);
    }
    if (disconnect) {
      voice.node?.disconnect();
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
    const origin = anchor.audio - anchor.tick / hz;
    const rate = this.context.sampleRate;
    for (const voice of this.voices.values()) {
      const { node, bookedStart, bookedEnd, startSample } = voice;
      if (
        !node ||
        voice.ended ||
        voice.failed ||
        bookedStart === undefined ||
        bookedEnd === undefined ||
        startSample === undefined ||
        bookedEnd <= until
      )
        continue;
      // A voice that would start after the stop never sounds.
      const endSample = Math.max(startSample, Math.round((origin + until / hz) * rate));
      node.stop(endSample / rate);
      voice.bookedEnd = Math.max(bookedStart, until);
      voice.endSample = endSample;
    }
  }

  setCatalog(catalog: StreamCatalog): void {
    this.read.planAudio({ start: 0, end: 0 }, catalog, this.options);
    this.catalog = catalog;
    this.fill(true);
  }

  diagnostics(clipId: string): TransportDiagnostics {
    const voice = this.voices.get(clipId);
    return Object.freeze({
      generation: this.generation,
      sampleRate: this.context.sampleRate,
      reservation: voice?.token,
      endSample: voice?.endSample,
    });
  }

  dispose(): void {
    clearInterval(this.timer);
    this.unsubscribe();
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
