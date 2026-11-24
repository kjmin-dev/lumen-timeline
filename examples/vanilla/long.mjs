// A three-hour session read in chunks. The media cache holds decoded audio
// within a budget and loads ahead of the playhead; the reader below is where
// a host fetches, authenticates and decodes its own media.
import { createEditor, TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import { createAudioTransport, createMediaCache, createWaveformTiles } from "@lumen-timeline/media";
import { mountTimeline } from "@lumen-timeline/timeline";

const rate = 48000;
const hours = 3;
const frames = hours * 3600 * rate;
const params = new URLSearchParams(location.search);
// `?ttl=` shortens the token lifetime, so refreshes happen while playing.
const ttl = Number(params.get("ttl") ?? 300);
const budgetBytes = Number(params.get("budget") ?? 192) * 1024 * 1024;

const context = new AudioContext({ sampleRate: rate, latencyHint: "playback" });

// Tokens expire. A read that is refused refreshes the token once and retries;
// concurrent reads share one refresh.
let token = null;
let refreshing = null;
function refresh() {
  refreshing ??= fetch("/media/long/token?ttl=" + ttl, { method: "POST" })
    .then((response) => {
      if (!response.ok) throw new Error("Token refused: " + response.status);
      return response.json();
    })
    .then((body) => {
      token = body.token;
      auth.refreshes++;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}
const auth = {
  refreshes: 0,
  async fetch(url, signal) {
    for (let attempt = 0; ; attempt++) {
      if (!token) await refresh();
      const response = await fetch(url, { headers: { Authorization: "Bearer " + token }, signal });
      if (response.status === 401 && attempt === 0) {
        token = null;
        continue;
      }
      if (!response.ok) throw new Error(url + ": " + response.status);
      return response;
    }
  },
};

const chunkSeconds = 10;
const reader = {
  async read(request, signal) {
    const index = request.start / (chunkSeconds * rate);
    const response = await auth.fetch(`/media/long/${request.assetId}/${index}.wav`, signal);
    return context.decodeAudioData(await response.arrayBuffer());
  },
};
const media = createMediaCache({ reader, chunkSeconds, budgetBytes });

// Two stems under the whole session and 2,400 lines across four speakers.
const speakers = ["Ada", "Bram", "Cleo", "Dov"];
const clips = [
  {
    id: "stem",
    name: "Original dialogue",
    trackId: "stem",
    kind: "audio",
    start: 0,
    duration: hours * 3600 * hz,
    contentIn: 0,
    source: { assetId: "stem", streamId: "main" },
  },
  {
    id: "music",
    name: "Score",
    trackId: "music",
    kind: "audio",
    start: 0,
    duration: hours * 3600 * hz,
    contentIn: 0,
    source: { assetId: "music", streamId: "main" },
  },
];
for (let i = 0; i < 2400; i++) {
  const start = Math.round((i * 4.5 + 0.4) * hz);
  clips.push({
    id: "line-" + i,
    name: `Line ${i + 1}`,
    trackId: speakers[i % 4].toLowerCase(),
    kind: "audio",
    start,
    duration: Math.round(3.6 * hz),
    contentIn: start,
    source: { assetId: "lines", streamId: "main" },
  });
}
const editor = createEditor({
  project: {
    schemaVersion: 1,
    duration: hours * 3600 * hz,
    tracks: [
      { id: "stem", name: "Original dialogue", locked: true, gain: 0.35 },
      { id: "music", name: "Score", locked: true, gain: 0.6 },
      ...speakers.map((name) => ({ id: name.toLowerCase(), name, overlap: "exclusive" })),
    ],
    clips,
  },
});
const binding = { assetVersion: 1, sampleRate: rate, availableStart: 0, availableEnd: frames };
const catalog = {
  version: 1,
  streams: { stem: { main: binding }, music: { main: binding }, lines: { main: binding } },
};
const report = (text) => {
  document.querySelector("#status").textContent = text;
};
const transport = createAudioTransport({
  editor,
  context,
  catalog,
  media,
  onError: (error) => report(error.message),
});

// Waveforms: the server's overview when zoomed out, chunks read through the
// same cache when zoomed in.
const sources = new Map();
const tiles = createWaveformTiles({ source: (assetId) => sources.get(assetId) ?? null });
const overviews = Promise.all(
  ["stem", "music", "lines"].map(async (assetId) => {
    const response = await auth.fetch(`/media/long/${assetId}/peaks.f32`);
    const peaks = new Float32Array(await response.arrayBuffer());
    sources.set(
      assetId,
      media.peakSource({
        assetId,
        streamId: "main",
        assetVersion: 1,
        sampleRate: rate,
        length: frames,
        overview: { samplesPerPair: 4096, peaks },
      }),
    );
    tiles.invalidate(assetId);
  }),
);

const host = document.querySelector("#timeline");
const view = mountTimeline(host, {
  editor,
  transport,
  waveforms: tiles,
  snap: { gridTicks: hz / 10 },
  pixelsPerSecond: 40,
});

const format = (tick) => {
  const seconds = tick / hz;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = (seconds % 60).toFixed(3).padStart(6, "0");
  return `${h}:${String(m).padStart(2, "0")}:${s}`;
};
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + " MB";
function panel() {
  const stats = media.diagnostics();
  const timing = transport.playback();
  document.querySelector("#bytes").textContent = mb(stats.bytes);
  document.querySelector("#budget").textContent =
    "of " + mb(stats.budgetBytes) + " · peak " + mb(stats.peakBytes);
  document.querySelector("#chunks").textContent = `${stats.chunks} held, ${stats.loading} loading`;
  document.querySelector("#reads").textContent =
    `${stats.loads} reads · ${stats.evictions} dropped · ${auth.refreshes} tokens`;
  const loaded = media.loaded("stem", "main", 1);
  document.querySelector("#loaded").textContent = loaded.length
    ? loaded
        .map((span) => format((span.start / rate) * hz) + "–" + format((span.end / rate) * hz))
        .join(", ")
    : "nothing";
  document.querySelector("#clock").textContent = format(transport.snapshot().presentedTick);
  document.querySelector("#seams").textContent = timing.seams;
  document.querySelector("#corrections").textContent = timing.corrections;
  document.querySelector("#late").textContent = timing.lateStarts;
  document.querySelector("#underruns").textContent = timing.underruns;
}
setInterval(panel, 250);

for (const button of document.querySelectorAll("[data-seek]"))
  button.addEventListener("click", () => {
    const tick = Number(button.dataset.seek) * hz;
    transport.seek(tick).catch((error) => report(error.message));
    view.setViewport({ startTick: Math.max(0, tick - 5 * hz) });
  });
document.querySelector("#whole").addEventListener("click", () => {
  view.setViewport({
    startTick: 0,
    pixelsPerSecond: Math.max(0.01, (host.clientWidth - 200) / (hours * 3600)),
  });
});

await overviews.catch((error) => report(error.message));
window.lumenLong = { editor, transport, media, tiles, view, auth, context, ready: true };
