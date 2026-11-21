import { commands, createEditor, unitsToTicks } from "../../packages/core/index.mjs";
import { VideoTransport } from "./transport.mjs";
import { bufferCatalog } from "./buffer-fixture.mjs";

// Drive the scheduler with exact edit times, then render all reservations
// through one native audio graph. No transport rebuild occurs between edits.
export async function verifyContinuousEdits(rate) {
  const frames = 896;
  const audio = new OfflineAudioContext(1, frames, rate);
  const tick = (frame) => unitsToTicks(frame, rate);
  const takes = {};
  for (const id of ["music", "line"]) {
    const buffer = audio.createBuffer(1, frames, rate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++)
      samples[i] = id === "music" ? ((i % 17) + 1) / 64 : -((i % 31) + 1) / 128;
    takes[id] = { buffer };
  }
  const editor = createEditor({
    project: {
      schemaVersion: 1,
      tracks: [{ id: "music", gain: 0.5 }, { id: "dialogue" }],
      clips: [
        {
          id: "music",
          kind: "audio",
          trackId: "music",
          start: 0,
          duration: tick(768),
          contentIn: 0,
          activeTakeId: "music",
        },
        {
          id: "line",
          kind: "audio",
          trackId: "dialogue",
          start: tick(256),
          duration: tick(256),
          contentIn: 0,
          activeTakeId: "line",
        },
      ],
    },
  });
  const player = Object.assign(new EventTarget(), {
    paused: false,
    seeking: false,
    requestVideoFrameCallback(callback) {
      this.frame = callback;
      return 1;
    },
    cancelVideoFrameCallback() {},
  });
  // OfflineAudioContext owns the actual nodes and sample clock for rendering.
  // The facade supplies deterministic observation/edit timestamps for scheduling.
  const clock = {
    currentTime: 0,
    sampleRate: rate,
    getOutputTimestamp() {
      return { contextTime: this.currentTime, performanceTime: 1000 };
    },
    createBufferSource: () => audio.createBufferSource(),
    createGain: () => audio.createGain(),
  };
  const driver = new VideoTransport(player, clock, audio.destination, {
    editor,
    catalog: bufferCatalog(takes),
    resolveBuffer: (span) => takes[span.assetId].buffer,
  });
  function at(frame) {
    clock.currentTime = frame / rate;
    player.frame(1000, { expectedDisplayTime: 1000, mediaTime: clock.currentTime });
  }
  function commit(result) {
    if (!result.ok) throw new Error(result.reason);
  }
  try {
    player.dispatchEvent(new Event("playing"));
    at(0);
    const music = driver.voices.get("music");
    at(128);
    commit(editor.dispatch(commands.moveClips({ clipIds: ["line"], delta: tick(128) })));
    at(256);
    commit(editor.history.undo());
    at(384);
    commit(editor.history.redo());
    at(512);
    commit(
      editor.dispatch(
        commands.setEntityData({
          scope: "take",
          id: "line",
          key: "status",
          value: "ready",
        }),
        { history: "ignore" },
      ),
    );
    if (
      driver.voices.get("music") !== music ||
      music.endSample !== 768 ||
      driver.generation !== 0
    ) {
      throw new Error("An edit replaced the continuing music reservation");
    }
    const output = (await audio.startRendering()).getChannelData(0);
    for (let i = 0; i < frames; i++) {
      let expected = i < 768 ? ((i % 17) + 1) / 128 : 0;
      if (i >= 256 && i < 640) {
        const sourceSample = i - (i < 384 ? 256 : 384);
        expected -= ((sourceSample % 31) + 1) / 128;
      }
      if (output[i] !== expected)
        throw new Error(
          "Continuous edit mismatch at " +
            rate +
            " Hz, sample " +
            i +
            ": expected " +
            expected +
            ", got " +
            output[i],
        );
    }
    return frames;
  } finally {
    driver.dispose();
    editor.dispose();
  }
}
