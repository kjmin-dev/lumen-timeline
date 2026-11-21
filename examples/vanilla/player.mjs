import { TICKS_PER_SECOND as hz } from '@lumen-timeline/core'
import { VideoTransport } from '../../experiments/sync/transport.mjs'
import { bufferCatalog } from '../../experiments/sync/buffer-fixture.mjs'

export async function attachPlayer(video, editor, onError) {
  const audio = new AudioContext()
  try {
    const assets = new AbortController()
    let dialogue
    function loadDialogue() {
      if (!dialogue) dialogue = fetch(new URL('./media/dialogue.ogg', import.meta.url), { signal: assets.signal })
        .then(async result => {
          if (!result.ok) throw new Error('Unable to load the dialogue recording')
          return audio.decodeAudioData(await result.arrayBuffer())
        }).catch(error => { dialogue = undefined; throw error })
      return dialogue
    }
    const music = audio.createBuffer(1, 24 * audio.sampleRate, audio.sampleRate)
    const samples = music.getChannelData(0)
    for (let i = 0; i < samples.length; i++) {
      const t = i / audio.sampleRate
      samples[i] = (Math.sin(2 * Math.PI * 110 * t) + 0.5 * Math.sin(2 * Math.PI * 164.81 * t)) *
        0.035 * Math.min(1, t, 24 - t) * (0.8 + 0.2 * Math.cos(t))
    }
    const takes = { line: { buffer: { length: 8 * audio.sampleRate, sampleRate: audio.sampleRate } }, bed: { buffer: music } }
    const listeners = new Set()
    const events = new AbortController()
    let state = Object.freeze({ playing: false, presentedTick: Math.round(video.currentTime * hz), requestedTick: null })
    let request = 0
    function update(delta) {
      state = Object.freeze({ ...state, ...delta })
      for (const listener of listeners) listener(state)
    }
    const driver = new VideoTransport(video, audio, audio.destination, {
      editor, catalog: bufferCatalog(takes), resolveBuffer: span => span.assetId === 'line' ? loadDialogue() : music, onError,
      onFrame: seconds => update({ presentedTick: Math.round(seconds * hz) }),
    })
    for (const name of ['play', 'pause', 'ended']) {
      video.addEventListener(name, () => update({ playing: !video.paused && !video.ended }), { signal: events.signal })
    }
    video.addEventListener('seeked', () => {
      if (state.requestedTick === null) update({ presentedTick: Math.round(video.currentTime * hz) })
    }, { signal: events.signal })
    return {
      snapshot: () => state,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
      async play() { await audio.resume(); await video.play() },
      pause() { video.pause() },
      async seek(tick) {
        const token = ++request
        update({ requestedTick: tick })
        try { return await driver.seek(tick / hz) }
        finally {
          if (token === request) update({ presentedTick: Math.round(video.currentTime * hz), requestedTick: null })
        }
      },
      driver,
      dispose() { request++; assets.abort(); events.abort(); listeners.clear(); driver.dispose(); video.pause(); return audio.close() },
    }
  } catch (error) { await audio.close(); throw error }
}
