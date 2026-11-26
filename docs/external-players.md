# Attach to an existing player

An application often has a player before it has a timeline: a streaming player with its own controls, a video library's skin, an embed from a hosting service. The timeline attaches to it without replacing it. The player keeps its controls, and the timeline follows whatever they do, seeks the player from its ruler and, where the player plays through a media element, plays the project's own audio against it.

The view needs one thing from a player: a transport. That is an object with `snapshot()`, `subscribe(listener)`, `play()`, `pause()` and `seek(tick)`, whose snapshot is `{ playing, presentedTick, requestedTick }` in project ticks. Which way to get one depends on whether the page can reach the element the player plays through.

| The player                                                                                                                         | Transport                                         | Project audio                        |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------ |
| Plays through a `<video>` or `<audio>` element the page can reach: hls.js, dash.js, Shaka Player, Video.js, Plyr, a native element | `createVideoTransport({ video: element, … })`     | Scheduled on Web Audio against it    |
| Has no element the page can reach: an iframe embed, a cast receiver, a native app's player                                         | An adapter over the player's own API, shown below | Not played; the player has the sound |

`examples/vanilla/external.html` attaches a timeline to each kind, with the adapter below in `embed-transport.mjs`, and `npm run verify:external` drives it.

## A player that owns its element

Hand the element to `createVideoTransport`. The transport listens to the element's own `play`, `pause`, `seeking` and `ended` events, so it follows the player's controls, keyboard shortcuts and autoplay without the player knowing about it. Its ruler and keyboard seek the element by setting `currentTime`, which the player then sees as any seek. While the element plays, the transport books the project's audio clips on Web Audio and keeps them locked to the frames the element presents.

```js
import Hls from "hls.js";
import { createVideoTransport } from "@lumen-timeline/media";
import { mountTimeline } from "@lumen-timeline/timeline";
import { catalog, context, editor, resolveBuffer } from "./host.js";

// The player owns the element and its controls; the timeline never calls it.
const video = document.querySelector("video");
const hls = new Hls();
hls.loadSource("/streams/episode.m3u8");
hls.attachMedia(video);

const transport = createVideoTransport({
  video,
  frameRate: 30000 / 1001,
  context,
  output: context.destination,
  editor,
  catalog,
  resolveBuffer,
});
const view = mountTimeline(document.querySelector("#timeline"), { editor, transport });
```

`host.js` is the one from [Getting started](../apps/docs/src/content/docs/getting-started.mdx#minimal-integration): the editor, the `AudioContext`, the catalog and the buffer resolver. A framework wrapper takes the same transport as its `transport` option.

- **The element is the clock.** The transport presents the time of the frame the element last presented, so the playhead and the picture agree frame for frame, also when paused between two frames.
- **Pass the frame rate.** With `frameRate`, a seek asks the element for the middle of the frame that holds the target and the target tick itself is presented, so rounding never lands on a neighbouring frame. Without it, a seek asks for the target's time exactly.
- **Sound.** Mute the element when the project's audio replaces its sound, as for a dub over the original picture. Leave it unmuted when the project's audio adds to it, as music under a video's own sound.
- **Changing streams.** A player that switches renditions or reattaches its media source keeps the same element and time, and the transport follows it. A player that replaces the element itself needs a new transport: dispose the old one and make another for the new element.
- **Ownership.** The page and the player own the element. `transport.dispose()` removes the transport's listeners and stops its audio and leaves the element as it is; dispose the view first.

## A player with no element to reach

An iframe embed, a remote player or a native bridge answers commands and reports its position, often a few times a second. Adapt its API to the transport contract. The view repaints the playhead whenever the transport notifies, so while the player plays the adapter notifies every animation frame, running on from the player's last report at its playback rate:

```js title="embed-transport.js"
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
```

```js
import { mountTimeline } from "@lumen-timeline/timeline";
import { createEmbedTransport } from "./embed-transport.js";

// `player` wraps the embed's API in the calls above; most embeds need a few lines for it.
const transport = createEmbedTransport(player, { reportStep: 0.25 });
const view = mountTimeline(document.querySelector("#timeline"), { editor, transport });
```

- **Between reports.** While the player plays, the adapter presents its last report run on by the time since and the playback rate. A start, a stop and a change of rate begin a new run. A report up to `reportStep` behind the position already shown is late, so the playhead holds rather than stepping back; one further behind is a jump the player made, and the playhead follows it.
- **Seeks.** `seek` publishes the target as `requestedTick` at once, so the view draws the playhead there while the player catches up. Once the player reports a position within `reportStep` of the target, the target tick itself is presented and the promise resolves. A newer seek resolves the one before it.
- **`reportStep`.** How coarsely the player reports its position while playing, in seconds. A player that reports exact positions, as most do when they stop, can use a small value; one that reports four times a second needs 0.25.
- **Audio.** The adapter carries no sound. The project's audio clips need a clock the page can schedule against, which an element or an [audio transport](media-transports.md#audio-only-editing) provides and an embed does not; the timeline here shows, edits and seeks.
- **Ownership.** `dispose()` stops the frame loop and unsubscribes from the player. The player stays as it is.

## Verify it

`npm run verify:external` opens `examples/vanilla/external.html` in Chromium; pass `firefox` or `webkit` to `node examples/vanilla/verify-external.mjs` for the other engines. The page holds both kinds of player, each with its own controls, which the trace uses as a user would.

- **A player that owns its element.** The player's own play button starts the transport, which books the project's narration clip and stays within 0.1 s of the element. The player's scrub bar moves it, the timeline's ruler seeks the element, and the player's pause leaves the transport on the frame the element last presented, the start of a frame of the 10 fps reference. WebKit's `currentTime` can lag that frame by up to two frames on a loaded machine, so the trace bounds the element's time at 0.25 s.
- **An embed.** A stand-in embed reports its position four times a second while it plays and answers commands after 60 ms. Over a second and a half of play the adapter notifies every frame, draws more than three positions per report, never steps back and stays within 50 ms of the player's true position. A seek from the ruler presents the tick asked for once the player reports it, a pause from the player's own button stops on the player's exact position, and a seek while paused stays where it landed. Disposing both views and transports leaves no timeline behind.
