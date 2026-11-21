import { sourceWindow, TICKS_PER_SECOND as hz } from '../../packages/core/time.mjs'

// A frame timestamp must belong to the callback's performance time origin.
export function presentationTime(now, expected) {
  return Number.isFinite(expected) && Math.abs(expected - now) < 500 ? expected : now
}

// Quantize both endpoints on the same absolute output grid. A relative duration
// can round up independently and double the sample at a split in Web Audio.
export function scheduleWindow(node, window, audioAtProjectZero, outputRate, sharedStartSample) {
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
  node.start(start / outputRate, window.sourceStart / hz)
  node.stop(end / outputRate)
  return end
}

// Unit-speed experiment. The video is the clock; Web Audio owns sample delivery.
export class VideoTransport {
  constructor(video, context, output, clips, takes) {
    if (typeof video.requestVideoFrameCallback !== 'function' ||
        typeof context.getOutputTimestamp !== 'function') {
      throw new Error('This clock probe requires video frame callbacks and audio output timestamps')
    }
    this.video = video
    this.context = context
    this.output = output
    this.clips = clips
    this.takes = takes
    this.generation = 0
    this.nodes = new Map()
    this.edgeSamples = new Map()
    this.anchor = null
    this.running = false
    this.listeners = new AbortController()
    const listen = (type, fn) => video.addEventListener(type, fn, { signal: this.listeners.signal })
    for (const type of ['waiting', 'seeking', 'pause', 'ended']) {
      listen(type, () => { this.running = false; this.invalidate() })
    }
    listen('playing', () => { this.running = true })
    this.observe()
    this.timer = setInterval(() => this.fill(), 25)
  }

  observe() {
    const generation = this.generation
    this.frame = this.video.requestVideoFrameCallback((now, frame) => {
      this.observe()
      if (generation !== this.generation || this.video.seeking || this.video.paused ||
          this.seekInFlight || !this.running) return
      const stamp = this.context.getOutputTimestamp()
      if (!(stamp.performanceTime > 0)) return
      const audio = stamp.contextTime + (presentationTime(now, frame.expectedDisplayTime) - stamp.performanceTime) / 1000
      if (this.anchor && Math.abs(this.anchor.media + audio - this.anchor.audio - frame.mediaTime) > 0.075) {
        this.invalidate()
      }
      this.anchor = { audio, media: frame.mediaTime }
      this.fill()
    })
  }

  fill() {
    if (!this.anchor || !this.running || this.seekInFlight) return
    const now = this.context.currentTime
    const projectNow = this.anchor.media + now - this.anchor.audio
    const from = Math.ceil(projectNow * hz)
    for (const clip of this.clips) {
      if (this.nodes.has(clip.id)) continue
      const take = this.takes[clip.take]
      const window = sourceWindow(clip, take, from, clip.start + clip.duration)
      if (!window || window.start / hz > projectNow + 0.100) continue
      const node = this.context.createBufferSource()
      node.buffer = take.buffer
      node.connect(this.output)
      const endSample = scheduleWindow(node, window, this.anchor.audio - this.anchor.media,
        this.context.sampleRate, this.edgeSamples.get(window.start))
      this.edgeSamples.set(window.end, endSample)
      this.nodes.set(clip.id, node)
      node.onended = () => {
        node.disconnect()
        // A null entry stops the scheduler from replaying this clip at its end.
        if (this.nodes.get(clip.id) === node) this.nodes.set(clip.id, null)
      }
    }
  }

  invalidate() {
    this.generation++
    this.anchor = null
    for (const node of this.nodes.values()) {
      node?.stop()
      node?.disconnect()
    }
    this.nodes.clear()
    this.edgeSamples.clear()
  }

  replace(clips) {
    this.clips = clips
    this.invalidate()
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
    clearInterval(this.timer)
    this.video.cancelVideoFrameCallback(this.frame)
    this.running = false
    this.invalidate()
  }
}
