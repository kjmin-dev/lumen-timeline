import { createEditor, unitsToTicks } from "@lumen-timeline/core";
import { createAudioTransport, createMediaCache } from "@lumen-timeline/media";

// Plays through native nodes in one offline graph with a media cache of
// 256-frame chunks, so every clip crosses chunk edges. Each segment starts on
// the previous one's end sample and copies its chunk frame for frame, so the
// render must equal the sources sample for sample.
export async function verifyChunkedPcm(rate) {
  const length = 4096;
  const chunk = 256;
  const audio = new OfflineAudioContext(1, length, rate);
  const context = Object.assign(new EventTarget(), {
    state: "running",
    currentTime: 0,
    sampleRate: rate,
    destination: audio.destination,
    createBufferSource: () => audio.createBufferSource(),
    createGain: () => audio.createGain(),
  });
  const tick = (frame) => unitsToTicks(frame, rate);
  const sources = {
    // Values that never repeat within a chunk, so a dropped or doubled frame shows.
    stem: (i) => ((i % 251) + 1) / 512,
    voice: (i) => -((i % 13) + 1) / 128,
  };
  const total = 8192;
  const reads = [];
  const reader = {
    read(request) {
      reads.push(request.start);
      const frames = Math.min(request.end, total) - request.start;
      const buffer = audio.createBuffer(1, frames, rate);
      const pcm = buffer.getChannelData(0);
      for (let i = 0; i < frames; i++) pcm[i] = sources[request.assetId](request.start + i);
      return buffer;
    },
  };
  const media = createMediaCache({ reader, chunkSeconds: chunk / rate });
  const clip = (id, trackId, asset, first, count, source) => ({
    id,
    trackId,
    kind: "audio",
    start: tick(first),
    duration: tick(count),
    contentIn: tick(source),
    source: { assetId: asset, streamId: "mono" },
  });
  const editor = createEditor({
    project: {
      schemaVersion: 1,
      tracks: [{ id: "stem" }, { id: "voice", gain: 0.5 }],
      clips: [
        // Starts 100 frames into its first chunk and crosses twelve edges.
        clip("stem", "stem", "stem", 0, 3000, 100),
        // Two touching clips in one chain, each starting mid-chunk.
        clip("left", "voice", "voice", 512, 388, 37),
        clip("right", "voice", "voice", 900, 800, 650),
      ],
    },
  });
  const binding = { assetVersion: 1, sampleRate: rate, availableStart: 0, availableEnd: total };
  const transport = createAudioTransport({
    editor,
    context,
    catalog: { version: 1, streams: { stem: { mono: binding }, voice: { mono: binding } } },
    media,
  });
  try {
    if ((await transport.play()) !== "playing") throw new Error("Chunked playback did not start");
    const timing = transport.playback();
    if (timing.seams < 14) throw new Error("Expected segments joined at chunk edges");
    if (timing.corrections || timing.underruns || timing.lateStarts)
      throw new Error("Unexpected timing correction: " + JSON.stringify(timing));
    const pcm = (await audio.startRendering()).getChannelData(0);
    for (let i = 0; i < length; i++) {
      const project = i - 128;
      let expected = 0;
      if (project >= 0 && project < 3000) expected += sources.stem(project + 100);
      if (project >= 512 && project < 900) expected += sources.voice(project - 512 + 37) * 0.5;
      if (project >= 900 && project < 1700) expected += sources.voice(project - 900 + 650) * 0.5;
      if (pcm[i] !== Math.fround(expected))
        throw new Error(
          "Chunked PCM mismatch at " +
            rate +
            " Hz, frame " +
            i +
            ": expected " +
            expected +
            ", got " +
            pcm[i],
        );
    }
    return length;
  } finally {
    transport.dispose();
    editor.dispose();
    media.dispose();
  }
}
