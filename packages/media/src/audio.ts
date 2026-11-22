import { TICKS_PER_SECOND as hz, sequenceDuration } from "@lumen-timeline/core";
import type { Tick } from "@lumen-timeline/core";
import { auditionState, planAudition, watchAudition } from "./audition.ts";
import type { AuditionPlan } from "./audition.ts";
import { VoiceScheduler } from "./voice-scheduler.ts";
import type {
  AudioContextLike,
  Audition,
  AuditionResult,
  AudioTransport,
  AudioTransportState,
  AudioTransportStatus,
  ClockPrecision,
  MediaOptions,
  SeekResult,
} from "./types.ts";

interface Request<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

type PlayResult = "playing" | "empty" | "superseded";

interface ActiveAudition {
  readonly state: Audition;
  readonly request: Request<AuditionResult>;
  readonly unwatch: () => boolean;
}

function request<T>(): Request<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject };
}

// Scheduling uses graph time. Presentation follows the sample heard at the
// output device, which can be behind the graph when the output pipeline is full.
function outputClock(context: AudioContextLike): { time: number; precision: ClockPrecision } {
  const stamp = context.getOutputTimestamp?.();
  if (
    Number.isFinite(stamp?.performanceTime) &&
    typeof stamp?.performanceTime === "number" &&
    stamp.performanceTime > 0 &&
    Number.isFinite(stamp.contextTime) &&
    typeof stamp.contextTime === "number" &&
    stamp.contextTime >= 0 &&
    stamp.contextTime <= context.currentTime
  ) {
    return { time: stamp.contextTime, precision: "output" };
  }
  return { time: context.currentTime, precision: "estimated" };
}

export function createAudioTransport({
  editor,
  context,
  output = context.destination,
  catalog,
  resolveBuffer,
  onError,
}: MediaOptions): AudioTransport {
  let end = sequenceDuration(editor.getSnapshot());
  let position = 0;
  // Presentation moves by playback only within a segment. Every other move
  // starts a new one, so hosts can tell crossed markers from skipped ones.
  let segment = 0;
  let segmentStart = 0;
  let wantPlay = false;
  let disposed = false;
  let starting: Request<PlayResult> | null = null;
  let seeking: (Request<SeekResult> & { readonly tick: Tick }) | null = null;
  let frame: number | null = null;
  let audition: ActiveAudition | null = null;
  let state: AudioTransportState = Object.freeze({
    status: "paused",
    playing: false,
    presentedTick: 0,
    requestedTick: null,
    precision: "exact",
    segment,
    segmentStart,
    audition: null,
  });
  const listeners = new Set<(state: AudioTransportState) => void>();
  const scheduler = new VoiceScheduler({
    editor,
    context,
    output,
    catalog,
    resolveBuffer,
    onError,
    onWake: observe,
  });
  const offExtent = editor.subscribe(sequenceDuration, (next) => {
    end = next;
    // An audition plays inside its clip. An edit that moves the clip ends it,
    // and the return position is clamped then.
    if (audition) return;
    if (
      !end ||
      (seeking ? seeking.tick >= end : position > end || (scheduler.anchor && currentTick() >= end))
    ) {
      // Playback that reaches the shortened end keeps its segment. A clamp or
      // an abandoned seek moves presentation without playing.
      if (!end || seeking || position > end) jump(end);
      stop(end, end ? "ended" : "paused");
    } else if (seeking && position > end) {
      // A backward seek may still be draining the former, longer sequence.
      jump(end);
      publish("seeking", seeking.tick, state.precision);
    } else if (state.status === "ended" && position < end) publish("paused");
  });
  context.addEventListener("statechange", contextChanged);

  function publish(
    status: AudioTransportStatus,
    requestedTick: Tick | null = null,
    precision: ClockPrecision = "exact",
  ): void {
    if (
      disposed ||
      (state.status === status &&
        state.presentedTick === position &&
        state.requestedTick === requestedTick &&
        state.precision === precision &&
        state.segment === segment &&
        state.audition === (audition?.state ?? null))
    )
      return;
    const next = Object.freeze({
      status,
      playing: status === "playing" || status === "seeking",
      presentedTick: position,
      requestedTick,
      precision,
      segment,
      segmentStart,
      audition: audition?.state ?? null,
    });
    state = next;
    // oxlint-disable-next-line unicorn/no-useless-spread -- Listeners may unsubscribe or issue commands during delivery, so iterate a snapshot.
    for (const listener of [...listeners]) {
      if (state !== next) break; // A listener issued a newer command.
      if (listeners.has(listener)) {
        try {
          listener(next);
        } catch (error) {
          if (typeof globalThis.reportError === "function") globalThis.reportError(error);
          else
            queueMicrotask(() => {
              throw error;
            });
        }
      }
    }
  }
  // Presentation continues from `tick` without playing the ticks before it.
  function jump(tick: Tick): void {
    segment++;
    segmentStart = tick;
    position = tick;
  }
  // A playing seek has landed once the output clock reaches its anchor, even
  // before a frame observes it.
  function land(): void {
    const anchor = scheduler.anchor;
    if (seeking && anchor && outputClock(context).time >= anchor.audio) jump(seeking.tick);
  }
  // Playback stops at the sequence end, or at the end of an auditioned clip.
  function limit(): Tick {
    return audition ? Math.min(end, audition.state.range.end) : end;
  }
  function currentTick(time: number = outputClock(context).time): Tick {
    const anchor = scheduler.anchor;
    const stop = limit();
    if (!anchor || (seeking && time < anchor.audio)) return Math.min(position, stop);
    return Math.min(
      stop,
      Math.max(seeking?.tick ?? position, anchor.tick + Math.round((time - anchor.audio) * hz)),
    );
  }
  function cancelFrame(): void {
    if (frame !== null) globalThis.cancelAnimationFrame(frame);
    frame = null;
  }
  function frames(): void {
    if (frame !== null || !listeners.size || !scheduler.anchor || !globalThis.requestAnimationFrame)
      return;
    frame = globalThis.requestAnimationFrame(() => {
      frame = null;
      observe();
      frames();
    });
  }
  function supersede(): void {
    starting?.resolve("superseded");
    seeking?.resolve("superseded");
    starting = null;
    seeking = null;
  }
  function stop(tick: Tick, status: AudioTransportStatus): void {
    wantPlay = false;
    supersede();
    cancelFrame();
    scheduler.invalidate();
    position = tick;
    publish(status);
  }
  // Ends the audition, stops its voices and settles its promise. With
  // `restore`, presentation returns to the position the audition left.
  function endAudition(settle: (request: Request<AuditionResult>) => void, restore: boolean): void {
    const active = audition;
    if (!active) return;
    audition = null;
    active.unwatch();
    cancelFrame();
    scheduler.invalidate();
    scheduler.setPlan(undefined);
    if (restore) {
      jump(Math.min(active.state.returnTick, end));
      publish(position === end && end ? "ended" : "paused");
    }
    settle(active.request);
  }
  const cancelled = (request: Request<AuditionResult>): void => request.resolve("cancelled");
  function anchorAt(tick: Tick): void {
    // Give the first reservation one nominal render quantum to reach the graph.
    const sample = Math.ceil(context.currentTime * context.sampleRate) + 128;
    scheduler.setAnchor(tick, sample / context.sampleRate, tick);
    frames();
  }
  function observe(): void {
    if (disposed || !scheduler.anchor || context.state !== "running") return;
    const clock = outputClock(context);
    if (seeking && clock.time < scheduler.anchor.audio) return;
    if (seeking) {
      jump(seeking.tick);
      seeking.resolve("arrived");
      seeking = null;
    }
    position = currentTick(clock.time);
    if (audition && position >= limit())
      endAudition((request) => request.resolve("finished"), true);
    else if (position >= end) stop(end, end ? "ended" : "paused");
    else publish("playing", null, clock.precision);
  }
  function contextChanged(): void {
    if (disposed) return;
    if (context.state === "closed") {
      land();
      const error = new Error("Audio context closed");
      starting?.reject(error);
      seeking?.reject(error);
      const back = audition ? Math.min(audition.state.returnTick, end) : currentTick();
      endAudition((request) => request.reject(error), false);
      stop(back, "closed");
      return;
    }
    // An interruption ends an audition that is playing. One that waits for
    // the context to resume keeps waiting.
    if (context.state !== "running" && audition && scheduler.anchor) {
      endAudition(cancelled, true);
      return;
    }
    if (context.state !== "running" && wantPlay && !starting) {
      // A pending seek freezes at its target. Otherwise playback stops where it is.
      if (seeking) jump(seeking.tick);
      else position = currentTick();
      seeking?.resolve("arrived");
      seeking = null;
      cancelFrame();
      scheduler.invalidate();
      publish("interrupted");
    } else if (
      context.state === "running" &&
      wantPlay &&
      !starting &&
      state.status === "interrupted"
    ) {
      anchorAt(position);
      observe();
    }
  }

  return {
    snapshot: () => state,
    subscribe(listener) {
      if (disposed) throw new Error("Transport disposed");
      listeners.add(listener);
      frames();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) cancelFrame();
      };
    },
    play(): Promise<PlayResult> {
      if (disposed || context.state === "closed")
        return Promise.reject(new Error("Transport unavailable"));
      endAudition(cancelled, true);
      if (!end) return Promise.resolve("empty");
      if (starting) return starting.promise;
      if (scheduler.anchor || seeking) return Promise.resolve("playing");
      if (position === end) jump(0);
      const op = (starting = request<PlayResult>());
      wantPlay = true;
      publish("starting");
      const start = () => {
        if (starting !== op) return;
        if (context.state !== "running") throw new Error("Audio context did not resume");
        anchorAt(position);
        if (starting !== op) return;
        starting = null;
        op.resolve("playing");
        observe();
      };
      const failed = (error: unknown): void => {
        if (starting !== op) return;
        starting = null;
        op.reject(error);
        stop(position, "paused");
      };
      if (starting === op) {
        try {
          if (context.state === "running") start();
          else Promise.resolve(context.resume()).then(start).catch(failed);
        } catch (error) {
          failed(error);
        }
      }
      return op.promise;
    },
    pause() {
      if (disposed || context.state === "closed") return;
      if (audition) {
        endAudition(cancelled, true);
        return;
      }
      land();
      stop(currentTick(), "paused");
    },
    seek(tick: Tick): Promise<SeekResult> {
      if (disposed || context.state === "closed")
        return Promise.reject(new Error("Transport unavailable"));
      if (!Number.isSafeInteger(tick) || tick < 0 || tick > end)
        return Promise.reject(new RangeError("Invalid seek tick"));
      // The seek target replaces the audition's return position.
      endAudition(cancelled, false);
      const active = wantPlay && !starting && context.state === "running";
      const interrupted = wantPlay && state.status === "interrupted";
      land();
      const lastPresented = currentTick();
      supersede();
      cancelFrame();
      scheduler.invalidate();
      if (!active || tick === end) {
        wantPlay = interrupted && tick < end;
        jump(tick);
        publish(wantPlay ? "interrupted" : tick === end && end ? "ended" : "paused");
        return Promise.resolve("arrived");
      }
      const op = (seeking = { ...request<SeekResult>(), tick });
      position = lastPresented;
      publish("seeking", tick, state.precision);
      queueMicrotask(() => {
        if (seeking !== op) return;
        anchorAt(tick);
        observe();
      });
      return op.promise;
    },
    audition(input): Promise<AuditionResult> {
      if (disposed || context.state === "closed")
        return Promise.reject(new Error("Transport unavailable"));
      let plan: AuditionPlan;
      try {
        plan = planAudition(editor, input);
      } catch (error) {
        return Promise.reject(error);
      }
      // A newer audition keeps the first one's return position.
      land();
      const returnTick = audition?.state.returnTick ?? seeking?.tick ?? currentTick();
      endAudition(cancelled, false);
      wantPlay = false;
      supersede();
      cancelFrame();
      scheduler.invalidate();
      scheduler.setPlan(plan.options, plan.range.end);
      const active: ActiveAudition = {
        state: auditionState(plan, returnTick),
        request: request<AuditionResult>(),
        unwatch: watchAudition(editor, plan, () => endAudition(cancelled, true)),
      };
      audition = active;
      jump(plan.range.start);
      publish("starting");
      const start = (): void => {
        if (audition !== active) return;
        if (context.state !== "running") throw new Error("Audio context did not resume");
        anchorAt(plan.range.start);
        observe();
      };
      const failed = (error: unknown): void => {
        if (audition === active) endAudition((r) => r.reject(error), true);
      };
      try {
        if (context.state === "running") start();
        else Promise.resolve(context.resume()).then(start).catch(failed);
      } catch (error) {
        failed(error);
      }
      return active.request.promise;
    },
    cancelAudition() {
      if (!audition) return false;
      endAudition(cancelled, true);
      return true;
    },
    get catalog() {
      return scheduler.catalog;
    },
    setCatalog(next) {
      if (disposed) throw new Error("Transport disposed");
      scheduler.setCatalog(next);
    },
    diagnostics: (id) => scheduler.diagnostics(id),
    dispose() {
      if (disposed) return;
      position = audition ? Math.min(audition.state.returnTick, end) : currentTick();
      disposed = true;
      state = Object.freeze({
        status: "disposed",
        playing: false,
        presentedTick: position,
        requestedTick: null,
        precision: "exact",
        segment,
        segmentStart,
        audition: null,
      });
      const error = new Error("Transport disposed");
      starting?.reject(error);
      seeking?.reject(error);
      if (audition) {
        audition.unwatch();
        audition.request.reject(error);
        audition = null;
      }
      starting = null;
      seeking = null;
      cancelFrame();
      offExtent();
      context.removeEventListener("statechange", contextChanged);
      listeners.clear();
      scheduler.dispose();
    },
  };
}
