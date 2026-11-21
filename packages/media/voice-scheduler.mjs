import { TICKS_PER_SECOND as hz } from '@lumen-timeline/core'

// Quantize both endpoints on the same absolute output grid. A relative duration
// can round up independently and double the sample at a split in Web Audio.
export function scheduleWindow(node, window, audioAtProjectZero, outputRate, sharedStartSample, sourceSeconds = window.sourceStart / hz) {
  const sample = tick => Math.round((audioAtProjectZero + tick / hz) * outputRate)
  const start = sharedStartSample ?? sample(window.start)
  let end = sample(window.end)
  if (sharedStartSample !== undefined) {
    // Keep the shared sample but use the latest clock estimate for the far edge.
    // Spread a small correction over the clip, consuming exactly its source range.
    const sourceFrames = (window.end - window.start) / hz * outputRate
    const nominal = Math.round(sourceFrames)
    const limit = Math.floor(nominal * 0.001)
    const length = Math.min(nominal + limit, Math.max(nominal - limit, end - start))
    end = start + length
    if (length > 0 && length !== nominal) node.playbackRate.value = sourceFrames / length
  }
  node.start(start / outputRate, sourceSeconds)
  node.stop(end / outputRate)
  return end
}

export class VoiceScheduler {
  constructor({ context, output = context.destination, editor, catalog, resolveBuffer, onError = () => {} }) {
    this.context = context
    this.output = output
    this.read = editor.read()
    this.read.planAudio({ start: 0, end: 0 }, catalog)
    this.catalog = catalog
    this.resolveBuffer = resolveBuffer
    this.onError = onError
    this.generation = 0
    this.voices = new Map()
    this.issues = []
    this.anchor = null
    this.unsubscribe = editor.subscribe(s => s, (snapshot, change) => {
      this.read = editor.read(snapshot)
      if (!this.anchor || !change.changedIds.length) return
      const range = this.range()
      const intersects = edge => edge.start < range.end && edge.end > range.start
      if (change.changedIds.some(id => this.voices.has(id)) ||
          change.affected.before.some(intersects) || change.affected.after.some(intersects)) {
        this.fill(new Set(change.changedIds))
      }
    })
    this.timer = setInterval(() => this.fill(), 25)
  }

  setAnchor(tick, audio) {
    this.anchor = { tick, audio }
    this.fill()
  }

  range() {
    const start = this.anchor.tick + Math.ceil((this.context.currentTime - this.anchor.audio) * hz)
    return { start, end: start + hz / 10 }
  }

  fill(changed) {
    if (!this.anchor) return
    const range = this.range()
    const read = this.read
    const catalog = this.catalog
    const plan = read.planAudio(range, catalog)
    this.issues = plan.issues
    if (changed) {
      const desired = new Map(plan.spans.map(span => [span.clipId, span]))
      for (const [id, voice] of this.voices) {
        if ((changed === true || changed.has(id)) &&
            (!sameVoice(voice.span, desired.get(id)) || voice.failed)) this.cancel(voice)
      }
    }
    const generation = this.generation
    for (const span of plan.spans) {
      if (this.read !== read || this.catalog !== catalog || this.generation !== generation) return
      if (this.voices.has(span.clipId)) continue
      const voice = { span, generation, abort: new AbortController() }
      this.voices.set(span.clipId, voice)
      try {
        const buffer = this.resolveBuffer(span, voice.abort.signal)
        if (typeof buffer?.then === 'function') {
          Promise.resolve(buffer).then(value => this.ready(voice, value)).catch(error => this.fail(voice, error))
        } else {
          this.acceptBuffer(voice, buffer)
        }
      } catch (error) { this.fail(voice, error) }
    }
    if (this.read !== read || this.catalog !== catalog || this.generation !== generation) return
    this.scheduleReady(plan.spans)
    // Retain a finished edge briefly for a touching successor, then release it.
    for (const voice of this.voices.values()) {
      if (voice.span.audible.end < range.start - hz / 10) this.cancel(voice)
    }
  }

  current(voice) {
    return this.generation === voice.generation && this.voices.get(voice.span.clipId) === voice
  }

  ready(voice, buffer) {
    if (!this.current(voice) || !this.anchor) return
    const { spans } = this.read.planAudio(this.range(), this.catalog)
    const span = spans.find(s => s.clipId === voice.span.clipId)
    if (!sameVoice(voice.span, span)) return this.cancel(voice)
    this.acceptBuffer(voice, buffer)
    this.scheduleReady(spans)
  }

  acceptBuffer(voice, buffer) {
    if (buffer?.sampleRate !== voice.span.sampleRate || !(buffer.length >= voice.span.audible.sourceEnd)) {
      throw new Error('Audio buffer does not cover the planned stream')
    }
    voice.buffer = buffer
  }

  predecessor(span, spans, start) {
    const sameChain = other => span.trackId === other.trackId && span.chainId === other.chainId
    if (start !== span.audible.start ||
        spans.some(s => s.clipId !== span.clipId && sameChain(s) && s.audible.start === start)) return
    let match
    for (const other of this.voices.values()) {
      if (other.endSample === undefined || other.failed || !sameChain(other.span) || other.span.audible.end !== start) continue
      if (match) return // More than one predecessor makes the seam ambiguous.
      match = other
    }
    return match
  }

  scheduleReady(spans) {
    const nowSample = this.context.currentTime * this.context.sampleRate
    const upcoming = spans.filter(span => {
      const v = this.voices.get(span.clipId)
      return v?.buffer && !v.failed && (!v.node || v.startSample > nowSample)
    })
    // Availability may delay the audible start inside its placement. Book seams
    // in audible order, including futures booked before a predecessor decoded.
    upcoming.sort((a, b) => a.audible.start - b.audible.start)
    for (const span of upcoming) {
      const voice = this.voices.get(span.clipId)
      if (!voice || !sameVoice(voice.span, span)) continue
      const predecessor = this.predecessor(span, spans, voice.bookedStart ?? span.window.start)
      if (voice.node) {
        if (voice.predecessorToken === predecessor?.token) continue
        if (voice.startSample === predecessor?.endSample) {
          voice.predecessorToken = predecessor.token
          continue
        }
        voice.node.stop(this.context.currentTime)
      }
      try { this.book(voice, span, predecessor) } catch (error) { this.fail(voice, error) }
    }
  }

  book(voice, span, predecessor) {
    const node = this.context.createBufferSource()
    voice.node = node
    voice.ended = false
    const gain = span.gain === 1 ? null : this.context.createGain()
    voice.gainNode = gain
    node.onended = () => {
      node.disconnect()
      gain?.disconnect()
      if (voice.node === node) voice.ended = true
    }
    node.buffer = voice.buffer
    if (gain) {
      gain.gain.value = span.gain
      gain.connect(this.output)
    }
    node.connect(gain ?? this.output)
    const origin = this.anchor.audio - this.anchor.tick / hz
    const rate = this.context.sampleRate
    const start = span.window.start
    const shared = predecessor?.endSample
    voice.bookedStart = start
    voice.token = {}
    voice.predecessorToken = predecessor?.token
    voice.startSample = shared ?? Math.round((origin + start / hz) * rate)
    voice.endSample = scheduleWindow(node, { start, end: span.audible.end }, origin, rate,
      shared, span.window.sourceStart / span.sampleRate)
  }

  fail(voice, error) {
    if (!this.current(voice)) return
    voice.node?.disconnect()
    voice.gainNode?.disconnect()
    voice.failed = true
    this.onError(error, voice.span)
  }

  cancel(voice, disconnect = false) {
    if (this.voices.get(voice.span.clipId) !== voice) return
    this.voices.delete(voice.span.clipId)
    voice.abort.abort()
    if (!voice.ended && !voice.failed && voice.endSample > this.context.currentTime * this.context.sampleRate) {
      voice.node.stop(this.context.currentTime)
    }
    if (disconnect) {
      voice.node?.disconnect()
      voice.gainNode?.disconnect()
    }
  }

  invalidate(disconnect = false) {
    this.generation++
    this.anchor = null
    for (const voice of this.voices.values()) this.cancel(voice, disconnect)
  }

  setCatalog(catalog) {
    this.read.planAudio({ start: 0, end: 0 }, catalog)
    this.catalog = catalog
    this.fill(true)
  }

  diagnostics(clipId) {
    const voice = this.voices.get(clipId)
    return Object.freeze({ generation: this.generation, sampleRate: this.context.sampleRate,
      reservation: voice?.token, endSample: voice?.endSample })
  }

  dispose() {
    clearInterval(this.timer)
    this.unsubscribe()
    this.invalidate(true)
  }
}

function sameVoice(a, b) {
  return b !== undefined && a.clipId === b.clipId && a.trackId === b.trackId && a.chainId === b.chainId &&
    a.takeId === b.takeId && a.assetId === b.assetId && a.assetVersion === b.assetVersion &&
    a.streamId === b.streamId && a.sampleRate === b.sampleRate && a.gain === b.gain &&
    a.sourceOriginTick === b.sourceOriginTick && a.audible.start === b.audible.start && a.audible.end === b.audible.end &&
    a.audible.sourceStart === b.audible.sourceStart && a.audible.sourceEnd === b.audible.sourceEnd
}
