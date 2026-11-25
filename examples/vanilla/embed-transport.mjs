// The adapter from docs/external-players.md, as that guide shows it: a player the page cannot
// reach into, such as an iframe embed, as the transport the timeline view needs.
import { TICKS_PER_SECOND } from "@lumen-timeline/core";

// `player`: getCurrentTime() and getPlaybackRate() in seconds, isPlaying(), play(), pause(),
// seekTo(seconds), and add/removeEventListener("statechange") for play, pause, seek and rate.
export function createEmbedTransport(player, { reportStep = 0.25 } = {}) {
  const listeners = new Set();
  const ticks = (seconds) => Math.max(0, Math.round(seconds * TICKS_PER_SECOND));
  let state = Object.freeze({
    playing: false,
    presentedTick: ticks(player.getCurrentTime()),
    requestedTick: null,
  });
  let lastReport = player.getCurrentTime();
  let lastRate = player.getPlaybackRate();
  // The position the last report stands for, and when it arrived.
  let anchor = { seconds: lastReport, at: performance.now() };
  let seeking = null;
  let frame = 0;

  function publish(next) {
    const same =
      next.playing === state.playing &&
      next.presentedTick === state.presentedTick &&
      next.requestedTick === state.requestedTick;
    if (same) return;
    state = Object.freeze(next);
    for (const listener of listeners) listener(state);
  }

  function sample() {
    const now = performance.now();
    const seconds = player.getCurrentTime();
    const playing = player.isPlaying();
    if (seeking) {
      const target = seeking.target / TICKS_PER_SECOND;
      if (Math.abs(seconds - target) >= reportStep) {
        publish({ ...state, playing, requestedTick: seeking.target });
        return;
      }
      // Landed: present the tick asked for until the player reports something new.
      const { resolve } = seeking;
      seeking = null;
      lastReport = seconds;
      anchor = { seconds: target, at: now };
      publish({ playing, presentedTick: ticks(target), requestedTick: null });
      resolve();
      return;
    }
    const rate = player.getPlaybackRate();
    if (seconds !== lastReport || playing !== state.playing || rate !== lastRate) {
      // A start reported a step behind the position shown starts from the position shown.
      const shown = state.presentedTick / TICKS_PER_SECOND;
      const start = playing && !state.playing && Math.abs(seconds - shown) < reportStep;
      lastReport = seconds;
      lastRate = rate;
      anchor = { seconds: start ? shown : seconds, at: now };
    }
    const position = playing ? anchor.seconds + ((now - anchor.at) / 1000) * rate : anchor.seconds;
    let tick = ticks(position);
    // A report a little behind the position shown is late, not a step back: hold.
    const behind = state.presentedTick - tick;
    if (playing && behind > 0 && behind < reportStep * TICKS_PER_SECOND) tick = state.presentedTick;
    publish({ playing, presentedTick: tick, requestedTick: null });
  }

  function loop() {
    frame = 0;
    sample();
    if (state.playing || seeking) frame = requestAnimationFrame(loop);
  }
  const wake = () => {
    if (!frame) frame = requestAnimationFrame(loop);
  };
  const onState = () => {
    sample();
    wake();
  };
  player.addEventListener("statechange", onState);

  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    play() {
      player.play();
      wake();
    },
    pause() {
      player.pause();
      wake();
    },
    seek(tick) {
      seeking?.resolve();
      return new Promise((resolve) => {
        seeking = { target: Math.max(0, Math.round(tick)), resolve };
        publish({ ...state, requestedTick: seeking.target });
        player.seekTo(seeking.target / TICKS_PER_SECOND);
        wake();
      });
    },
    dispose() {
      cancelAnimationFrame(frame);
      player.removeEventListener("statechange", onState);
      seeking?.resolve();
      listeners.clear();
    },
  };
}
