import { TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import { VideoTransport } from "./video-driver.mjs";

export function createVideoTransport({
  video,
  editor,
  context,
  output = context.destination,
  catalog,
  resolveBuffer,
  onError,
}) {
  const listeners = new Set();
  const events = new AbortController();
  let state = Object.freeze({
    playing: !video.paused && !video.ended,
    presentedTick: Math.round(video.currentTime * hz),
    requestedTick: null,
  });
  let request = 0;
  let playIntent = 0;
  function update(delta) {
    state = Object.freeze({ ...state, ...delta });
    for (const listener of listeners) listener(state);
  }
  const driver = new VideoTransport(video, context, output, {
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
    "seeked",
    () => {
      if (state.requestedTick === null)
        update({ presentedTick: Math.round(video.currentTime * hz) });
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
    async play() {
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
    async seek(tick) {
      if (events.signal.aborted) throw new Error("Transport disposed");
      if (!Number.isSafeInteger(tick) || tick < 0) throw new RangeError("Invalid project tick");
      const token = ++request;
      update({ requestedTick: tick });
      try {
        return await driver.seek(tick / hz);
      } finally {
        if (token === request)
          update({ presentedTick: Math.round(video.currentTime * hz), requestedTick: null });
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
