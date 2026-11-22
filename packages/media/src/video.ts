import { TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import type { Tick } from "@lumen-timeline/core";
import { auditionState, planAudition, watchAudition } from "./audition.ts";
import { VideoTransport as VideoDriver } from "./video-driver.ts";
import type {
  Audition,
  AuditionResult,
  SeekResult,
  VideoTransport,
  VideoTransportOptions,
  VideoTransportState,
} from "./types.ts";

interface ActiveAudition {
  readonly state: Audition;
  readonly resolve: (result: AuditionResult) => void;
  readonly reject: (error: unknown) => void;
  readonly unwatch: () => boolean;
}

export function createVideoTransport({
  video,
  editor,
  context,
  output = context.destination,
  catalog,
  resolveBuffer,
  onError,
}: VideoTransportOptions): VideoTransport {
  const listeners = new Set<(state: VideoTransportState) => void>();
  const events = new AbortController();
  const initial = Math.round(video.currentTime * hz);
  let state: VideoTransportState = Object.freeze({
    playing: !video.paused && !video.ended,
    presentedTick: initial,
    requestedTick: null,
    segment: 0,
    segmentStart: initial,
    audition: null,
  });
  let request = 0;
  let audition: ActiveAudition | null = null;
  let playIntent = 0;
  // A seek the element started itself, from native controls or a loop.
  let nativeSeek = false;
  function update(delta: Partial<VideoTransportState>): void {
    state = Object.freeze({ ...state, ...delta });
    for (const listener of listeners) listener(state);
  }
  // After a seek, presentation continues from the element's position.
  function landed(): void {
    const tick = Math.round(video.currentTime * hz);
    update({
      presentedTick: tick,
      requestedTick: null,
      segment: state.segment + 1,
      segmentStart: tick,
    });
  }
  const driver = new VideoDriver(video, context, output, {
    editor,
    catalog,
    resolveBuffer,
    onError,
    onFrame: (seconds) => {
      const tick = Math.round(seconds * hz);
      update({ presentedTick: tick });
      if (audition && tick >= audition.state.range.end) void endAudition(finished, true);
    },
  });
  for (const name of ["play", "pause", "ended"]) {
    video.addEventListener(
      name,
      () => {
        update({ playing: !video.paused && !video.ended });
        if (name === "ended" && audition) void endAudition(finished, true);
      },
      { signal: events.signal },
    );
  }
  async function move(tick: Tick): Promise<SeekResult> {
    const token = ++request;
    nativeSeek = false;
    update({ requestedTick: tick });
    try {
      return await driver.seek(tick / hz);
    } finally {
      if (token === request) landed();
    }
  }
  function halt(): void {
    playIntent++;
    video.pause();
    // Frames that arrive before the pause event must not book voices.
    driver.invalidate();
  }
  // Ends the audition and settles its promise. With `restore`, the element
  // seeks back to the position the audition left before the promise settles.
  async function endAudition(
    settle: (active: ActiveAudition) => void,
    restore: boolean,
  ): Promise<void> {
    const active = audition;
    if (!active) return;
    audition = null;
    active.unwatch();
    halt();
    driver.scheduler.setPlan(undefined);
    update({ audition: null });
    try {
      if (restore && !events.signal.aborted) await move(active.state.returnTick);
    } catch {
      // A failed return seek still ends the audition; the element reports its own error.
    }
    settle(active);
  }
  const cancelled = (active: ActiveAudition): void => active.resolve("cancelled");
  const finished = (active: ActiveAudition): void => active.resolve("finished");
  video.addEventListener(
    "seeking",
    () => {
      // The transport publishes its own target before it assigns the position.
      if (state.requestedTick !== null && !nativeSeek) return;
      nativeSeek = true;
      update({ requestedTick: Math.round(video.currentTime * hz) });
    },
    { signal: events.signal },
  );
  video.addEventListener(
    "seeked",
    () => {
      if (video.seeking || (!nativeSeek && state.requestedTick !== null)) return;
      nativeSeek = false;
      landed();
    },
    { signal: events.signal },
  );
  return {
    snapshot: () => state,
    subscribe(listener) {
      if (events.signal.aborted) throw new Error("Transport disposed");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async play(): Promise<void> {
      if (events.signal.aborted) throw new Error("Transport disposed");
      if (audition) await endAudition(cancelled, true);
      const intent = ++playIntent;
      await context.resume();
      if (intent === playIntent) await video.play();
    },
    pause() {
      if (events.signal.aborted) return;
      if (audition) void endAudition(cancelled, true);
      else {
        playIntent++;
        video.pause();
      }
    },
    async seek(tick: Tick): Promise<SeekResult> {
      if (events.signal.aborted) throw new Error("Transport disposed");
      if (!Number.isSafeInteger(tick) || tick < 0) throw new RangeError("Invalid project tick");
      // The seek target replaces the audition's return position.
      void endAudition(cancelled, false);
      return move(tick);
    },
    async audition(input): Promise<AuditionResult> {
      if (events.signal.aborted) throw new Error("Transport disposed");
      const plan = planAudition(editor, input);
      // A newer audition keeps the first one's return position.
      const returnTick = audition?.state.returnTick ?? state.requestedTick ?? state.presentedTick;
      void endAudition(cancelled, false);
      halt();
      driver.scheduler.setPlan(plan.options, plan.range.end);
      const { promise, resolve, reject } = Promise.withResolvers<AuditionResult>();
      const active: ActiveAudition = {
        state: auditionState(plan, returnTick),
        resolve,
        reject,
        unwatch: watchAudition(editor, plan, () => void endAudition(cancelled, true)),
      };
      audition = active;
      update({ audition: active.state });
      try {
        await move(plan.range.start);
        if (audition === active) await context.resume();
        if (audition === active) await video.play();
      } catch (error) {
        if (audition === active) await endAudition((a) => a.reject(error), true);
      }
      return promise;
    },
    cancelAudition() {
      if (!audition || events.signal.aborted) return false;
      void endAudition(cancelled, true);
      return true;
    },
    get catalog() {
      return driver.catalog;
    },
    setCatalog(next) {
      if (events.signal.aborted) throw new Error("Transport disposed");
      driver.setCatalog(next);
    },
    diagnostics: (id) => driver.scheduler.diagnostics(id),
    dispose() {
      if (events.signal.aborted) return;
      request++;
      playIntent++;
      events.abort();
      if (audition) {
        audition.unwatch();
        audition.reject(new Error("Transport disposed"));
        audition = null;
      }
      listeners.clear();
      driver.dispose();
    },
  };
}
