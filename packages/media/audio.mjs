import { TICKS_PER_SECOND as hz, sequenceDuration } from "@lumen-timeline/core";
import { VoiceScheduler } from "./voice-scheduler.mjs";

function request() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Scheduling uses graph time. Presentation follows the sample heard at the
// output device, which can be behind the graph when the output pipeline is full.
function outputClock(context) {
  const stamp = context.getOutputTimestamp?.();
  if (
    Number.isFinite(stamp?.performanceTime) &&
    stamp.performanceTime > 0 &&
    Number.isFinite(stamp.contextTime) &&
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
}) {
  let end = sequenceDuration(editor.getSnapshot());
  let position = 0;
  let wantPlay = false;
  let disposed = false;
  let starting = null;
  let seeking = null;
  let frame = null;
  let state = Object.freeze({
    status: "paused",
    playing: false,
    presentedTick: 0,
    requestedTick: null,
    precision: "exact",
  });
  const listeners = new Set();
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
    if (
      !end ||
      (seeking ? seeking.tick >= end : position > end || (scheduler.anchor && currentTick() >= end))
    ) {
      stop(end, end ? "ended" : "paused");
    } else if (seeking && position > end) {
      // A backward seek may still be draining the former, longer sequence.
      position = end;
      publish("seeking", seeking.tick, state.precision);
    } else if (state.status === "ended" && position < end) publish("paused");
  });
  context.addEventListener("statechange", contextChanged);

  function publish(status, requestedTick = null, precision = "exact") {
    if (
      disposed ||
      (state.status === status &&
        state.presentedTick === position &&
        state.requestedTick === requestedTick &&
        state.precision === precision)
    )
      return;
    const next = Object.freeze({
      status,
      playing: status === "playing" || status === "seeking",
      presentedTick: position,
      requestedTick,
      precision,
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
  function currentTick(time = outputClock(context).time) {
    const anchor = scheduler.anchor;
    if (!anchor || (seeking && time < anchor.audio)) return Math.min(position, end);
    return Math.min(
      end,
      Math.max(seeking?.tick ?? position, anchor.tick + Math.round((time - anchor.audio) * hz)),
    );
  }
  function cancelFrame() {
    if (frame !== null) globalThis.cancelAnimationFrame(frame);
    frame = null;
  }
  function frames() {
    if (frame !== null || !listeners.size || !scheduler.anchor || !globalThis.requestAnimationFrame)
      return;
    frame = globalThis.requestAnimationFrame(() => {
      frame = null;
      observe();
      frames();
    });
  }
  function supersede() {
    starting?.resolve("superseded");
    seeking?.resolve("superseded");
    starting = null;
    seeking = null;
  }
  function stop(tick, status) {
    wantPlay = false;
    supersede();
    cancelFrame();
    scheduler.invalidate();
    position = tick;
    publish(status);
  }
  function anchorAt(tick) {
    // Give the first reservation one nominal render quantum to reach the graph.
    const sample = Math.ceil(context.currentTime * context.sampleRate) + 128;
    scheduler.setAnchor(tick, sample / context.sampleRate, tick);
    frames();
  }
  function observe() {
    if (disposed || !scheduler.anchor || context.state !== "running") return;
    const clock = outputClock(context);
    if (seeking && clock.time < scheduler.anchor.audio) return;
    if (seeking) {
      position = seeking.tick;
      seeking.resolve("arrived");
      seeking = null;
    }
    position = currentTick(clock.time);
    if (position >= end) stop(end, end ? "ended" : "paused");
    else publish("playing", null, clock.precision);
  }
  function contextChanged() {
    if (disposed) return;
    if (context.state === "closed") {
      const error = new Error("Audio context closed");
      starting?.reject(error);
      seeking?.reject(error);
      stop(currentTick(), "closed");
      return;
    }
    if (context.state !== "running" && wantPlay && !starting) {
      const frozen = seeking?.tick ?? currentTick();
      seeking?.resolve("arrived");
      seeking = null;
      cancelFrame();
      scheduler.invalidate();
      position = frozen;
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
    play() {
      if (disposed || context.state === "closed")
        return Promise.reject(new Error("Transport unavailable"));
      if (!end) return Promise.resolve("empty");
      if (starting) return starting.promise;
      if (scheduler.anchor || seeking) return Promise.resolve("playing");
      if (position === end) position = 0;
      const op = (starting = request());
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
      const failed = (error) => {
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
      if (!disposed && context.state !== "closed") stop(currentTick(), "paused");
    },
    seek(tick) {
      if (disposed || context.state === "closed")
        return Promise.reject(new Error("Transport unavailable"));
      if (!Number.isSafeInteger(tick) || tick < 0 || tick > end)
        return Promise.reject(new RangeError("Invalid seek tick"));
      const active = wantPlay && !starting && context.state === "running";
      const interrupted = wantPlay && state.status === "interrupted";
      const lastPresented = currentTick();
      supersede();
      cancelFrame();
      scheduler.invalidate();
      if (!active || tick === end) {
        wantPlay = interrupted && tick < end;
        position = tick;
        publish(wantPlay ? "interrupted" : tick === end && end ? "ended" : "paused");
        return Promise.resolve("arrived");
      }
      const op = (seeking = { ...request(), tick });
      position = lastPresented;
      publish("seeking", tick, state.precision);
      queueMicrotask(() => {
        if (seeking !== op) return;
        anchorAt(tick);
        observe();
      });
      return op.promise;
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
      position = currentTick();
      disposed = true;
      state = Object.freeze({
        status: "disposed",
        playing: false,
        presentedTick: position,
        requestedTick: null,
        precision: "exact",
      });
      const error = new Error("Transport disposed");
      starting?.reject(error);
      seeking?.reject(error);
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
