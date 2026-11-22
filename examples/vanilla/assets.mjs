// The host owns the fixture sources and their decoding lifetime.
export function createDemoAssets(audio) {
  const assets = new AbortController();
  let dialogue;
  function loadDialogue() {
    if (!dialogue)
      dialogue = fetch(new URL("./media/dialogue.ogg", import.meta.url), { signal: assets.signal })
        .then(async (result) => {
          if (!result.ok) throw new Error("Unable to load the dialogue recording");
          return audio.decodeAudioData(await result.arrayBuffer());
        })
        .catch((error) => {
          dialogue = undefined;
          throw error;
        });
    return dialogue;
  }
  const music = audio.createBuffer(1, 24 * audio.sampleRate, audio.sampleRate);
  const samples = music.getChannelData(0);
  for (let i = 0; i < samples.length; i++) {
    const t = i / audio.sampleRate;
    samples[i] =
      (Math.sin(2 * Math.PI * 110 * t) + 0.5 * Math.sin(2 * Math.PI * 164.81 * t)) *
      0.035 *
      Math.min(1, t, 24 - t) *
      (0.8 + 0.2 * Math.cos(t));
  }
  // A synthesized guide line: a gliding tone in phrases, a second candidate for
  // the dialogue slot that sounds clearly different when auditioned.
  const guide = audio.createBuffer(1, 8 * audio.sampleRate, audio.sampleRate);
  const line = guide.getChannelData(0);
  let phase = 0;
  for (let i = 0; i < line.length; i++) {
    const t = i / audio.sampleRate;
    phase += (2 * Math.PI * (220 + 60 * Math.sin(1.7 * t))) / audio.sampleRate;
    const phrase = Math.max(0, Math.sin(Math.PI * ((t * 0.9) % 1)));
    line[i] = Math.sin(phase) * 0.12 * phrase * Math.min(1, t * 4, (8 - t) * 4);
  }
  const rate = audio.sampleRate;
  // The project's takes name these assets. The catalog describes their decoded streams.
  const stream = (length) =>
    Object.freeze({
      mono: Object.freeze({
        assetVersion: 1,
        sampleRate: rate,
        availableStart: 0,
        availableEnd: length,
      }),
    });
  const catalog = Object.freeze({
    version: 1,
    streams: Object.freeze({
      line: stream(8 * rate),
      guide: stream(guide.length),
      bed: stream(music.length),
    }),
  });
  const decoded = { guide, bed: music };
  return {
    catalog,
    resolveBuffer: (span) => (span.assetId === "line" ? loadDialogue() : decoded[span.assetId]),
    dispose: () => assets.abort(),
  };
}
