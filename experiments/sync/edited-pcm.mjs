import { commands, createEditor, unitsToTicks } from "@lumen-timeline/core";
import { verifyAudioOnlyPcm } from "./audio-only-pcm.mjs";
import { verifyContinuousEdits } from "./continuous-edits.mjs";
import { bufferCatalog } from "./buffer-fixture.mjs";
import { scheduleWindow } from "./transport.mjs";

const renderLength = 64;
const sourceSample = (take, index) => ((take === "voice" ? 1 : -1) * (index + 1)) / 128;

async function render(read, rate) {
  const context = new OfflineAudioContext(1, renderLength, rate);
  const buffers = new Map();
  for (const take of ["voice", "bed"]) {
    const buffer = context.createBuffer(1, renderLength, rate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = sourceSample(take, i);
    buffers.set(take, buffer);
  }
  const catalog = bufferCatalog(
    Object.fromEntries([...buffers].map(([id, buffer]) => [id, { buffer }])),
  );
  const plan = read.planAudio({ start: 0, end: unitsToTicks(renderLength, rate) }, catalog);
  for (const span of plan.spans) {
    const source = context.createBufferSource();
    source.buffer = buffers.get(span.assetId);
    source.connect(context.destination);
    scheduleWindow(
      source,
      span.window,
      0,
      rate,
      undefined,
      span.window.sourceStart / span.sampleRate,
    );
  }
  return (await context.startRendering()).getChannelData(0);
}

// The oracle is expressed entirely in source/output sample indices, independently
// of the editor's tick conversion, placement objects and playback-plan helper.
const states = [
  [[8, 24, 6]], // initial placement
  [
    [8, 15, 6],
    [15, 24, 13],
  ], // split
  [
    [8, 15, 6],
    [17, 24, 15],
  ], // trim left on the right half
  [
    [8, 13, 6],
    [17, 24, 15],
  ], // trim right on the left half
  [
    [8, 13, 6],
    [21, 28, 15],
  ], // move the right half four samples
];

export async function verifyEditedPcm() {
  const rates = [44100, 48000];
  let renders = 0;
  for (const rate of rates) {
    const tick = (samples) => unitsToTicks(samples, rate);
    const editor = createEditor({
      project: {
        schemaVersion: 1,
        tracks: [{ id: "voice", overlap: "exclusive" }, { id: "mix" }],
        clips: [
          {
            id: "line",
            trackId: "voice",
            kind: "audio",
            start: tick(8),
            duration: tick(16),
            contentIn: tick(6),
            activeTakeId: "voice",
          },
          {
            id: "guide",
            trackId: "mix",
            kind: "audio",
            start: tick(23),
            duration: tick(6),
            contentIn: tick(2),
            activeTakeId: "bed",
          },
        ],
      },
    });
    async function compare(state, guideStart = 23) {
      const actual = await render(editor.read(), rate);
      const expected = new Float32Array(renderLength);
      for (const [start, end, offset] of states[state]) {
        for (let i = start; i < end; i++) expected[i] = sourceSample("voice", offset + i - start);
      }
      for (let i = 0; i < 6; i++) expected[guideStart + i] += sourceSample("bed", 2 + i);
      for (let i = 0; i < actual.length; i++) {
        if (actual[i] !== expected[i])
          throw new Error(
            "PCM mismatch at rate " +
              rate +
              ", revision " +
              editor.getSnapshot().revision +
              ", sample " +
              i +
              ": expected " +
              expected[i] +
              ", got " +
              actual[i],
          );
      }
      renders++;
    }
    const edits = [
      commands.splitClip({ clipId: "line", at: tick(15), rightId: "right" }),
      commands.trimClip({ clipId: "right", edge: "left", delta: tick(2) }),
      commands.trimClip({ clipId: "line", edge: "right", delta: tick(-2) }),
      commands.moveClips({ clipIds: ["right"], trackId: "mix", delta: tick(4) }),
    ];
    try {
      await compare(0);
      for (let i = 0; i < edits.length; i++) {
        const result = editor.dispatch(edits[i]);
        if (!result.ok) throw new Error(result.reason);
        await compare(i + 1);
      }
      for (let i = edits.length; i > 0; i--) {
        const result = editor.history.undo();
        if (!result.ok) throw new Error(result.reason);
        await compare(i - 1);
      }
      for (let i = 0; i < edits.length; i++) {
        const result = editor.history.redo();
        if (!result.ok) throw new Error(result.reason);
        await compare(i + 1);
      }
      // A background alignment update moves a different voice while the user's
      // last edit is in the redo branch. Both the alignment and the take survive.
      const undo = editor.history.undo();
      if (!undo.ok) throw new Error(undo.reason);
      const synced = editor.dispatch(
        [
          commands.moveClips({ clipIds: ["guide"], delta: tick(2) }),
          commands.setEntityData({ scope: "take", id: "bed", key: "status", value: "ready" }),
        ],
        { history: "ignore", expectedRevision: undo.revision },
      );
      if (!synced.ok) throw new Error(synced.reason);
      await compare(3, 25);
      const redo = editor.history.redo();
      if (!redo.ok) throw new Error(redo.reason);
      await compare(4, 25);
      const back = editor.history.undo();
      if (!back.ok || editor.getSnapshot().entityData.take.bed.status !== "ready") {
        throw new Error("User history lost an independent take update");
      }
      await compare(3, 25);
    } finally {
      editor.dispose();
    }
  }
  let continuousSamples = 0;
  for (const rate of rates) continuousSamples += await verifyContinuousEdits(rate);
  let audioOnlySamples = 0;
  for (const rate of rates) audioOnlySamples += await verifyAudioOnlyPcm(rate);
  return {
    rates,
    renders: renders + 2 * rates.length,
    continuousSamples,
    audioOnlySamples,
    samplesCompared: renders * renderLength + continuousSamples + audioOnlySamples,
    passed: true,
  };
}
