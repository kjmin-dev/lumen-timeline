import { TICKS_PER_SECOND as hz } from '@lumen-timeline/core'
import { VoiceScheduler } from './voice-scheduler.mjs'

// A frame timestamp must belong to the callback's performance time origin.
export function presentationTime(now, expected) {
  return Number.isFinite(expected) && Math.abs(expected - now) < 500 ? expected : now
}

// Unit-speed experiment. The video is the clock; Web Audio owns sample delivery.
export class VideoTransport {
  constructor(video, context, output, { editor, catalog, resolveBuffer, onError = () => {}, onFrame = () => {} }) {
    if (typeof video.requestVideoFrameCallback !== 'function' ||
        typeof context.getOutputTimestamp !== 'function') {
      throw new Error('This clock probe requires video frame callbacks and audio output timestamps')
    }
    this.video = video
    this.context = context
    this.scheduler = new VoiceScheduler({ editor, context, output, catalog, resolveBuffer, onError })
    this.onFrame = onFrame
    this.phaseResets = 0
    this.phaseExcursion = null
    this.running = !video.paused && !video.ended && video.readyState >= 3
    this.listeners = new AbortController()
    const listen = (type, fn) => video.addEventListener(type, fn, { signal: this.listeners.signal })
    for (const type of ['waiting', 'seeking', 'pause', 'ended']) {
      listen(type, () => { this.running = false; this.invalidate() })
    }
    listen('playing', () => { this.running = true })
    this.observe()
  }

  get generation() { return this.scheduler.generation }
  get anchor() { return this.scheduler.anchor }
  get voices() { return this.scheduler.voices }
  get issues() { return this.scheduler.issues }
  get catalog() { return this.scheduler.catalog }
  setCatalog(catalog) { this.scheduler.setCatalog(catalog) }
  fill() { this.scheduler.fill() }

  observe() {
    const generation = this.generation
    this.frame = this.video.requestVideoFrameCallback((now, frame) => {
      this.observe()
      if (generation !== this.generation || this.video.seeking || this.seekInFlight) return
      if (this.video.paused || this.running) this.onFrame(frame.mediaTime)
      if (this.video.paused || !this.running) return
      const stamp = this.context.getOutputTimestamp()
      if (!(stamp.performanceTime > 0)) return
      const audio = stamp.contextTime + (presentationTime(now, frame.expectedDisplayTime) - stamp.performanceTime) / 1000
      if (this.anchor && Math.abs(this.anchor.tick / hz + audio - this.anchor.audio - frame.mediaTime) > 0.075) {
        this.invalidate()
      } else if (this.lostLock(frame.mediaTime, audio)) {
        this.phaseResets++
        this.invalidate()
      }
      this.scheduler.setAnchor(Math.round(frame.mediaTime * hz), audio)
    })
  }

  lostLock(media, audio) {
    // Consecutive video observations can agree with one another while a long
    // source booked against an older anchor slips further from the output clock.
    const tick = media * hz
    let worst = 0
    for (const voice of this.voices.values()) {
      if (voice.endSample === undefined || voice.ended || voice.failed ||
          tick < voice.bookedStart || tick >= voice.span.audible.end) continue
      const fraction = (tick - voice.bookedStart) / (voice.span.audible.end - voice.bookedStart)
      const sample = voice.startSample + fraction * (voice.endSample - voice.startSample)
      const error = sample / this.context.sampleRate - audio
      if (Math.abs(error) > Math.abs(worst)) worst = error
    }
    if (Math.abs(worst) <= 0.025) {
      this.phaseExcursion = null
      return false
    }
    const sign = Math.sign(worst)
    if (this.phaseExcursion?.sign !== sign) this.phaseExcursion = { sign, since: audio }
    return audio - this.phaseExcursion.since >= 0.2
  }

  invalidate() {
    this.phaseExcursion = null
    this.scheduler.invalidate()
  }

  seek(target) {
    if (this.listeners.signal.aborted) return Promise.reject(new Error('Transport disposed'))
    if (!Number.isFinite(target) || target < 0 || target > this.video.duration) {
      return Promise.reject(new RangeError('Target outside media range'))
    }
    if (this.pending) this.pending.resolve('superseded')
    const result = new Promise((resolve, reject) => { this.pending = { target, resolve, reject } })
    if (!this.seekInFlight) void this.drainSeeks()
    return result
  }

  async drainSeeks() {
    this.seekInFlight = true
    this.invalidate()
    try {
      while (this.pending) {
        const request = this.pending
        this.pending = null
        try {
          if (this.video.seeking || Math.abs(this.video.currentTime - request.target) > 0.00001) {
            await this.nativeSeek(request.target)
          }
          if (!this.pending && Math.abs(this.video.currentTime - request.target) > 0.05) {
            throw new Error('Seek to ' + request.target + ' completed at ' + this.video.currentTime)
          }
          request.resolve(this.pending ? 'superseded' : 'arrived')
        } catch (error) { request.reject(error) }
      }
    } finally {
      this.seekInFlight = false
      this.running = !this.listeners.signal.aborted && !this.video.paused && !this.video.ended && this.video.readyState >= 3
    }
  }

  nativeSeek(target) {
    return new Promise((resolve, reject) => {
      const events = new AbortController()
      const finish = error => {
        events.abort()
        clearTimeout(timeout)
        error ? reject(error) : resolve()
      }
      const timeout = setTimeout(() => finish(new Error('Native seek timed out')), 5000)
      this.video.addEventListener('seeked', () => {
        // A queued native event from an older seek may arrive after assignment.
        if (!this.video.seeking && Math.abs(this.video.currentTime - target) <= 0.05) finish()
      }, { signal: events.signal })
      this.video.addEventListener('error', () => finish(new Error('Media error')), { signal: events.signal })
      this.listeners.signal.addEventListener('abort', () => finish(new Error('Transport disposed')), { signal: events.signal })
      try { this.video.currentTime = target } catch (error) { finish(error) }
    })
  }

  dispose() {
    this.pending?.reject(new Error('Transport disposed'))
    this.pending = null
    this.listeners.abort()
    this.video.cancelVideoFrameCallback(this.frame)
    this.running = false
    this.scheduler.dispose()
  }
}
