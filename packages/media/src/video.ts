import { TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import type { Tick } from "@lumen-timeline/core";
import { VideoTransport as VideoDriver } from "./video-driver.ts";
import type {
  SeekResult,
  VideoTransport,
  VideoTransportOptions,
  VideoTransportState,
} from "./types.ts";

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
  });
  let request = 0;
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
    onFrame: (seconds) => update({ presentedTick: Math.round(seconds * hz) }),
  });
  for (const name of ["play", "pause", "ended"]) {
    video.addEventListener(name, () => update({ playing: !video.paused && !video.ended }), {
      signal: events.signal,
    });
  }
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
      const intent = ++playIntent;
      await context.resume();
      if (intent === playIntent) await video.play();
    },
    pause() {
      if (!events.signal.aborted) {
        playIntent++;
        video.pause();
      }
    },
    async seek(tick: Tick): Promise<SeekResult> {
      if (events.signal.aborted) throw new Error("Transport disposed");
      if (!Number.isSafeInteger(tick) || tick < 0) throw new RangeError("Invalid project tick");
      const token = ++request;
      nativeSeek = false;
      update({ requestedTick: tick });
      try {
        return await driver.seek(tick / hz);
      } finally {
        if (token === request) landed();
      }
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
      listeners.clear();
      driver.dispose();
    },
  };
}
