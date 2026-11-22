import { commands, createEditor, unitsToTicks } from "@lumen-timeline/core";
import { createAudioTransport } from "@lumen-timeline/media";
import { bufferCatalog, bufferTakes, listTakes } from "./buffer-fixture.mjs";

// Use native audio nodes in one continuous offline graph. The controllable
// observation clock lets edits land on exact frames before rendering begins.
export async function verifyAudioOnlyPcm(rate) {
  const length = 1152;
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
  const sample = (id, i) => (id === "voice" ? -((i % 13) + 1) / 128 : ((i % 7) + 1) / 16);
  const takes = {};
  for (const id of ["voice", "bed"]) {
    const buffer = audio.createBuffer(1, length, rate);
    const pcm = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) pcm[i] = sample(id, i);
    takes[id] = { buffer };
  }
  const clip = (id, take, first, count, source) => ({
    id,
    kind: "audio",
    trackId: take,
    activeTakeId: take,
    start: tick(first),
    duration: tick(count),
    contentIn: tick(source),
  });
  const editor = createEditor({
    project: {
      schemaVersion: 1,
      tracks: [{ id: "voice" }, { id: "bed", gain: 0.5 }],
      clips: listTakes([
        clip("left", "voice", 0, 128, 32),
        clip("right", "voice", 128, 128, 160),
        clip("music", "bed", 384, 384, 0),
        clip("line", "voice", 448, 128, 16),
      ]),
      takes: bufferTakes(takes),
    },
  });
  const transport = createAudioTransport({
    editor,
    context,
    catalog: bufferCatalog(takes),
    resolveBuffer: (span) => takes[span.assetId].buffer,
  });
  const check = (result) => {
    if (!result.ok) throw new Error(result.reason);
  };
  try {
    await transport.play();
    const bed = transport.diagnostics("music");
    const first = transport.diagnostics("left").endSample - 128;
    if (first !== 128) throw new Error("Unexpected initial output reservation");
    context.currentTime = (first + 400) / rate;
    check(editor.dispatch(commands.moveClips({ clipIds: ["line"], delta: tick(64) })));
    context.currentTime = (first + 480) / rate;
    check(editor.history.undo());
    context.currentTime = (first + 520) / rate;
    check(editor.history.redo());
    const edited = transport.diagnostics("music");
    if (edited.reservation !== bed.reservation || edited.endSample !== bed.endSample)
      throw new Error("Music restarted");
    const pcm = (await audio.startRendering()).getChannelData(0);
    for (let i = 0; i < length; i++) {
      const project = i - 128;
      let expected = 0;
      if (project >= 0 && project < 256) expected += sample("voice", project + 32);
      if (project >= 384 && project < 768) expected += sample("bed", project - 384) * 0.5;
      if (project >= 480 && project < 640)
        expected += sample("voice", project - (project < 520 ? 448 : 512) + 16);
      if (pcm[i] !== expected)
        throw new Error(
          "Audio-only PCM mismatch at " +
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
  }
}
