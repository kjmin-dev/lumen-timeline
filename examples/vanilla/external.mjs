// Two timelines attached to players the page did not build. `docs/external-players.md` walks
// through both; `npm run verify:external` drives this page.
//
// 1. A player that plays through a media element it owns, as hls.js with a custom skin, Video.js
//    or Plyr do. The page hands that element to `createVideoTransport`, which follows whatever
//    the player does to it and schedules the project's audio against it.
// 2. An embedded player with no element the page can reach, such as an iframe embed. An adapter
//    turns its position reports into the transport the view needs.
import { createEditor, TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import { createVideoTransport } from "@lumen-timeline/media";
import { mountTimeline } from "@lumen-timeline/timeline";
import { createEmbedPlayer } from "./embed-player.mjs";
import { createEmbedTransport } from "./embed-transport.mjs";

const clock = (seconds) =>
  `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;

// ------------------------------------------------- 1. a player that owns an element

/**
 * A stand-in for a player library: it owns the element and its controls. Nothing here knows
 * about the timeline, and the timeline never calls it.
 */
function mountPlayerControls(video, root) {
  const play = root.querySelector("[data-player-play]");
  const scrub = root.querySelector("[data-player-scrub]");
  const time = root.querySelector("[data-player-time]");
  play.addEventListener("click", () => (video.paused ? video.play() : video.pause()));
  scrub.addEventListener("input", () => (video.currentTime = Number(scrub.value)));
  const show = () => {
    play.textContent = video.paused ? "Play" : "Pause";
    scrub.max = String(video.duration || 0);
    scrub.value = String(video.currentTime);
    time.textContent = clock(video.currentTime);
  };
  for (const type of ["play", "pause", "timeupdate", "seeked", "loadedmetadata"])
    video.addEventListener(type, show);
  show();
}

const video = document.querySelector("#element video");
mountPlayerControls(video, document.querySelector("#element .player"));

// The project's own audio: a narration line, scheduled on Web Audio against the video's clock.
const context = new AudioContext();
document.addEventListener("pointerdown", () => void context.resume(), { capture: true });
const narration = context.createBuffer(1, 6 * context.sampleRate, context.sampleRate);
const samples = narration.getChannelData(0);
for (let i = 0; i < samples.length; i++) {
  const t = i / context.sampleRate;
  samples[i] = 0.08 * Math.sin(2 * Math.PI * 220 * t) * Math.min(1, t * 8, (6 - t) * 8);
}
const catalog = {
  version: 1,
  streams: {
    narration: {
      mono: {
        assetVersion: 1,
        sampleRate: context.sampleRate,
        availableStart: 0,
        availableEnd: narration.length,
      },
    },
  },
};

const elementEditor = createEditor({
  project: {
    schemaVersion: 2,
    duration: 24 * hz,
    tracks: [{ id: "voice", name: "Narration" }],
    clips: [
      {
        id: "narration",
        name: "Narration",
        trackId: "voice",
        kind: "audio",
        start: 2 * hz,
        duration: 6 * hz,
        contentIn: 0,
        source: { assetId: "narration", streamId: "mono" },
      },
    ],
    markers: [{ id: "scene", start: 12 * hz, label: "Scene 2" }],
  },
  actor: "element",
});
const elementTransport = createVideoTransport({
  video,
  // The reference is 10 fps. With its rate, a seek lands inside the frame that holds the tick.
  frameRate: 10,
  context,
  output: context.destination,
  editor: elementEditor,
  catalog,
  resolveBuffer: () => narration,
  onError: (error) => console.warn(error),
});
const elementView = mountTimeline(document.querySelector("#element .timeline"), {
  editor: elementEditor,
  transport: elementTransport,
  pixelsPerSecond: 40,
});

// ----------------------------------------------- 2. an embed the page cannot reach into

const player = createEmbedPlayer({ duration: 24 });
{
  // The embed's own controls, as its iframe would draw them.
  const root = document.querySelector("#embed .player");
  const play = root.querySelector("[data-player-play]");
  const time = root.querySelector("[data-player-time]");
  play.addEventListener("click", () => (player.isPlaying() ? player.pause() : player.play()));
  const show = () => {
    play.textContent = player.isPlaying() ? "Pause" : "Play";
    time.textContent = clock(player.getCurrentTime());
  };
  player.addEventListener("statechange", show);
  setInterval(show, 250);
  show();
}

const embedEditor = createEditor({
  project: {
    schemaVersion: 2,
    duration: 24 * hz,
    tracks: [{ id: "notes", name: "Notes" }],
    clips: [
      {
        id: "intro",
        name: "Intro",
        trackId: "notes",
        kind: "note",
        start: 0,
        duration: 5 * hz,
        contentIn: 0,
      },
      {
        id: "demo",
        name: "Demo",
        trackId: "notes",
        kind: "note",
        start: 6 * hz,
        duration: 9 * hz,
        contentIn: 0,
      },
    ],
    markers: [{ id: "q", start: 16 * hz, label: "Questions" }],
  },
  actor: "embed",
});
const embedTransport = createEmbedTransport(player, { reportStep: 0.25 });
const embedView = mountTimeline(document.querySelector("#embed .timeline"), {
  editor: embedEditor,
  transport: embedTransport,
  pixelsPerSecond: 40,
});

window.lumenExternal = {
  element: {
    editor: elementEditor,
    transport: elementTransport,
    view: elementView,
    video,
    context,
  },
  embed: { editor: embedEditor, transport: embedTransport, view: embedView, player },
  dispose() {
    elementView.dispose();
    elementTransport.dispose();
    embedView.dispose();
    embedTransport.dispose();
    return context.close();
  },
  ready: true,
};
