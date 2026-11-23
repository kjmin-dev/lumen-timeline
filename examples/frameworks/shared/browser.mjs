// The browser host every consumer starts from: two editor and transport pairs
// over the same project, synthesized sources played through Web Audio, and
// waveform tiles, all from the packages' public exports. The suite reads the
// host through `window.consumer`.
import { TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import { bufferPeakSource, createAudioTransport, createWaveformTiles } from "@lumen-timeline/media";
import {
  assetSeconds,
  catalog,
  countedEditor,
  countedSource,
  createControls,
  createCounter,
  editorFor,
  initialControls,
  rate,
} from "./fixture.mjs";

// A deterministic source per asset: a voice's phrases, a music chord or room tone.
function synthesize(context, id, seconds) {
  const buffer = context.createBuffer(1, seconds * rate, rate);
  const data = buffer.getChannelData(0);
  let seed = [...id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
  const voice = id.startsWith("voice");
  const pitch = 140 + (seed % 9) * 25;
  for (let i = 0; i < data.length; i++) {
    const t = i / rate;
    if (voice) {
      const phrase = Math.max(0, Math.sin(Math.PI * ((t * 0.8) % 1)));
      data[i] = 0.2 * phrase * Math.sin(2 * Math.PI * pitch * t);
    } else if (id === "music") {
      data[i] = 0.05 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277 * t));
    } else {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      data[i] = 0.02 * (seed / 2147483648 - 1);
    }
  }
  return buffer;
}

export function createHost(name) {
  const params = new URLSearchParams(location.search);
  const context = new AudioContext({ sampleRate: 48000, latencyHint: "playback" });
  const buffers = {};
  const sources = new Map();
  for (const [id, seconds] of Object.entries(assetSeconds())) {
    buffers[id] = synthesize(context, id, seconds);
    sources.set(id, bufferPeakSource(buffers[id]));
  }
  const counter = createCounter();
  const streams = catalog();
  const pair = (key) => {
    const editor = countedEditor(editorFor(key), counter, key);
    const transport = createAudioTransport({
      editor,
      context,
      catalog: streams,
      resolveBuffer: (span) => buffers[span.assetId],
    });
    return { editor, transport: countedSource(transport, counter, key + ".transport") };
  };
  const tiles = createWaveformTiles({ source: (assetId) => sources.get(assetId) ?? null });
  const views = [];
  const host = {
    name,
    hz,
    context,
    catalog: streams,
    pairs: { a: pair("a"), b: pair("b") },
    tiles: countedSource(tiles, counter, "waveforms"),
    rawTiles: tiles,
    controls: createControls(
      initialControls({
        timeline: params.get("mount") !== "0",
        renderer: params.get("renderer") ?? "auto",
      }),
    ),
    counts: { inspector: 0, clock: 0 },
    /** The mounted view, as the consumer's wrapper hands it over. */
    view: null,
    views,
    setView(view) {
      host.view = view ?? null;
      if (view && !views.includes(view)) views.push(view);
    },
    subscriptions: () => Object.fromEntries(counter.active),
  };
  window.consumer = host;
  return host;
}
