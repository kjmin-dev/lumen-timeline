import { createEditor, unitsToTicks } from "@lumen-timeline/core";
import { createAudioTransport } from "@lumen-timeline/media";
import { bufferCatalog, bufferTakes } from "./buffer-fixture.mjs";

// Renders one audition per mode in a native offline graph and compares every
// output frame with an oracle written in sample indices. The line [256, 512)
// has candidates a and b, b aligned 32 samples later in its source. A bed
// under it runs past the line's end at half gain.
export async function verifyAuditionPcm(rate) {
  const length = 1024;
  const tick = (frame) => unitsToTicks(frame, rate);
  const sample = (id, i) =>
    id === "bed" ? ((i % 7) + 1) / 16 : ((id === "a" ? 1 : -1) * ((i % 13) + 1)) / 128;
  let compared = 0;
  for (const mode of ["mix", "isolated"]) {
    const audio = new OfflineAudioContext(1, length, rate);
    const context = Object.assign(new EventTarget(), {
      state: "running",
      currentTime: 0,
      sampleRate: rate,
      destination: audio.destination,
      createBufferSource: () => audio.createBufferSource(),
      createGain: () => audio.createGain(),
    });
    const takes = {};
    for (const id of ["a", "b", "bed"]) {
      const buffer = audio.createBuffer(1, length, rate);
      const pcm = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) pcm[i] = sample(id, i);
      takes[id] = { buffer, sourceAtContentZero: id === "b" ? 32 : 0 };
    }
    const editor = createEditor({
      project: {
        schemaVersion: 1,
        // The isolated render mutes the line's track: isolation ignores it.
        tracks: [
          { id: "voice", mute: mode === "isolated" },
          { id: "music", gain: 0.5 },
        ],
        clips: [
          {
            id: "line",
            kind: "audio",
            trackId: "voice",
            start: tick(256),
            duration: tick(256),
            contentIn: tick(16),
            takeIds: ["a", "b"],
            activeTakeId: "a",
          },
          {
            id: "bed",
            kind: "audio",
            trackId: "music",
            start: 0,
            duration: tick(length),
            contentIn: 0,
            takeIds: ["bed"],
            activeTakeId: "bed",
          },
        ],
        takes: bufferTakes(takes),
      },
    });
    const transport = createAudioTransport({
      editor,
      context,
      catalog: bufferCatalog(takes),
      resolveBuffer: (span) => takes[span.assetId].buffer,
    });
    try {
      const take = mode === "mix" ? "b" : "a";
      const heard = transport.audition({ clipId: "line", takeId: take, mode });
      heard.catch(() => {});
      const pcm = (await audio.startRendering()).getChannelData(0);
      // Output frame 128 plays the line's first frame, and frame 384 its end.
      for (let i = 0; i < length; i++) {
        const project = i - 128 + 256;
        let expected = 0;
        if (i >= 128 && i < 384) {
          expected += sample(take, project - 256 + 16 + (take === "b" ? 32 : 0));
          if (mode === "mix") expected += sample("bed", project) * 0.5;
        }
        if (pcm[i] !== expected)
          throw new Error(
            `Audition PCM mismatch (${mode}) at ${rate} Hz, frame ${i}: expected ${expected}, got ${pcm[i]}`,
          );
      }
      if (editor.getSnapshot().revision !== 0) throw new Error("Audition edited the project");
      compared += length;
    } finally {
      transport.dispose();
      editor.dispose();
    }
  }
  return compared;
}
