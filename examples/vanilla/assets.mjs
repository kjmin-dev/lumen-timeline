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
    streams: Object.freeze({ line: stream(8 * rate), bed: stream(music.length) }),
  });
  return {
    catalog,
    resolveBuffer: (span) => (span.assetId === "line" ? loadDialogue() : music),
    dispose: () => assets.abort(),
  };
}
