// Measurements behind `npm run verify:stretch`: Signalsmith Stretch renderings
// of synthetic sources, and a retimed clip played through the audio transport.
import { TICKS_PER_SECOND as hz, commands, createEditor } from "@lumen-timeline/core";
import { createAudioTransport } from "@lumen-timeline/media";
import { createSignalsmithStretch } from "@lumen-timeline/media/signalsmith";

const sampleRate = 48000;
const tone = 440;

function sine(context, seconds) {
  const buffer = context.createBuffer(1, seconds * sampleRate, sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++)
    data[i] = 0.5 * Math.sin((2 * Math.PI * tone * i) / sampleRate);
  return buffer;
}

// Five-millisecond bursts of 1 kHz every quarter second.
const burstLength = 240;
function bursts(context, seconds) {
  const buffer = context.createBuffer(1, seconds * sampleRate, sampleRate);
  const data = buffer.getChannelData(0);
  const onsets = [];
  for (let at = 0.5 * sampleRate; at + burstLength < data.length; at += 0.25 * sampleRate) {
    onsets.push(at);
    for (let k = 0; k < burstLength; k++)
      data[at + k] =
        Math.sin((2 * Math.PI * 1000 * k) / sampleRate) * Math.sin((Math.PI * k) / burstLength);
  }
  return { buffer, onsets };
}

/** The frequency of a steady tone from its rising zero crossings, interpolated. */
export function frequency(data, rate = sampleRate) {
  const crossings = [];
  for (let i = 1; i < data.length; i++)
    if (data[i - 1] < 0 && data[i] >= 0)
      crossings.push(i - 1 + -data[i - 1] / (data[i] - data[i - 1]));
  if (crossings.length < 3) return 0;
  return ((crossings.length - 1) * rate) / (crossings.at(-1) - crossings[0]);
}

function request(buffer, sourceStart, sourceEnd, length) {
  return {
    span: { clipId: "lab", sampleRate, rate: (sourceEnd - sourceStart) / length },
    buffer,
    sourceStart,
    sourceEnd,
    length,
  };
}

/**
 * Stretches three seconds of a tone and of bursts at each rate. Reports the
 * rendering's length, the tone's frequency in its middle and where each burst's
 * energy lands against the position the rate maps it to.
 */
export async function measureRenderings(rates) {
  const scratch = new OfflineAudioContext(1, 1, sampleRate);
  const engine = createSignalsmithStretch();
  const signal = new AbortController().signal;
  const toneSource = sine(scratch, 6);
  const burstSource = bursts(scratch, 6);
  const start = sampleRate;
  const end = 4 * sampleRate;
  const results = [];
  for (const rate of rates) {
    const length = Math.round((end - start) / rate);
    const began = performance.now();
    const pitched = await engine.stretch(request(toneSource, start, end, length), signal);
    const elapsed = performance.now() - began;
    const timed = await engine.stretch(request(burstSource.buffer, start, end, length), signal);
    const middle = pitched
      .getChannelData(0)
      .subarray(Math.round(length * 0.25), Math.round(length * 0.75));
    const data = timed.getChannelData(0);
    const offsets = [];
    for (const onset of burstSource.onsets) {
      if (onset < start || onset + burstLength > end) continue;
      // The burst's centre, mapped to output frames.
      const expected = (onset + burstLength / 2 - start) / ((end - start) / length);
      const from = Math.max(0, Math.round(expected - 0.05 * sampleRate));
      const until = Math.min(data.length, Math.round(expected + 0.05 * sampleRate));
      let energy = 0;
      let moment = 0;
      for (let i = from; i < until; i++) {
        energy += data[i] * data[i];
        moment += data[i] * data[i] * i;
      }
      offsets.push(((moment / energy - expected) / sampleRate) * 1000);
    }
    // A cached rendering is the same buffer.
    const again = await engine.stretch(request(toneSource, start, end, length), signal);
    results.push({
      rate,
      length: pitched.length,
      expectedLength: length,
      sampleRate: pitched.sampleRate,
      hz: frequency(middle),
      offsetsMs: offsets,
      renderMs: elapsed,
      cached: again === pitched,
    });
  }
  return results;
}

let context = null;
document.querySelector("#start").addEventListener("click", () => {
  context ??= new AudioContext({ sampleRate });
  void context.resume();
});

/**
 * Plays a 440 Hz line retimed to `rate` through the audio transport and
 * measures the frequency it outputs, with or without the stretch engine.
 */
export async function measurePlayback(rate, stretched) {
  if (!context) throw new Error("Click Start audio first");
  await context.resume();
  const source = sine(context, 8);
  const editor = createEditor({
    project: {
      schemaVersion: 2,
      tracks: [{ id: "voice" }],
      takes: [{ id: "take", assetId: "tone", streamId: "mono", sourceAtContentZero: 0 }],
      clips: [
        {
          id: "line",
          trackId: "voice",
          kind: "audio",
          start: hz,
          duration: 4 * hz,
          contentIn: 0,
          takeIds: ["take"],
          activeTakeId: "take",
        },
      ],
    },
  });
  editor.dispatch(commands.retimeClip({ clipId: "line", rate }));
  const analyser = context.createAnalyser();
  analyser.fftSize = 8192;
  const mute = context.createGain();
  mute.gain.value = 0;
  analyser.connect(mute).connect(context.destination);
  const errors = [];
  const stretches = [];
  const engine = createSignalsmithStretch();
  const transport = createAudioTransport({
    editor,
    context,
    output: analyser,
    catalog: {
      version: 1,
      streams: {
        tone: {
          mono: { assetVersion: 1, sampleRate, availableStart: 0, availableEnd: source.length },
        },
      },
    },
    resolveBuffer: () => source,
    ...(stretched
      ? {
          stretch: (request, signal) => {
            stretches.push(request.length);
            return engine.stretch(request, signal);
          },
        }
      : {}),
    onError: (error) => errors.push(String(error)),
  });
  try {
    await transport.seek(1.5 * hz);
    await transport.play();
    // Wait until the voice has played for a while.
    const target = 1.5 * hz + 0.6 * hz;
    const started = performance.now();
    while (transport.snapshot().presentedTick < target) {
      if (performance.now() - started > 5000) throw new Error("Playback did not advance");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    return { hz: frequency(data, context.sampleRate), stretches, errors };
  } finally {
    transport.dispose();
    editor.dispose();
    analyser.disconnect();
    mute.disconnect();
  }
}
