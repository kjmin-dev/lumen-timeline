// A stand-in for an embedded player the page cannot reach into, such as an iframe embed: it plays
// on its own clock, answers commands after a delay, and while it plays reports its position only
// every quarter second, as a remote player's messages would. `external.html` attaches a timeline to it through
// `embed-transport.mjs`.

/** How often the player reports its position, and how long a command takes to land. */
const REPORT_SECONDS = 0.25;
const LATENCY_MS = 60;

export function createEmbedPlayer({ duration }) {
  const listeners = new Set();
  let playing = false;
  let rate = 1;
  // The true position is `position` plus the time played since `since`.
  let position = 0;
  let since = performance.now();

  const now = () =>
    Math.min(duration, position + (playing ? ((performance.now() - since) / 1000) * rate : 0));
  function settle() {
    position = now();
    since = performance.now();
    if (playing && position >= duration) playing = false;
  }
  function changed() {
    for (const listener of listeners) listener();
  }
  const later = (fn) =>
    setTimeout(() => {
      settle();
      fn();
      changed();
    }, LATENCY_MS);
  // Ends on its own when it reaches the end.
  setInterval(() => {
    if (playing && now() >= duration) {
      settle();
      changed();
    }
  }, 50);

  return {
    /**
     * The last reported position: while it plays, the true one a quarter second at a time;
     * stopped, exactly where it stopped, as a player reports with a state change.
     */
    getCurrentTime: () => (playing ? Math.floor(now() / REPORT_SECONDS) * REPORT_SECONDS : now()),
    isPlaying: () => playing,
    getPlaybackRate: () => rate,
    getDuration: () => duration,
    play: () => later(() => (playing = position < duration)),
    pause: () => later(() => (playing = false)),
    seekTo: (seconds) => later(() => (position = Math.max(0, Math.min(duration, seconds)))),
    setPlaybackRate: (next) => later(() => (rate = next)),
    addEventListener: (type, listener) => type === "statechange" && listeners.add(listener),
    removeEventListener: (type, listener) => type === "statechange" && listeners.delete(listener),
    /** For the trace: where the player really is, between its reports. */
    truePosition: now,
  };
}
