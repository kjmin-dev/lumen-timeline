import { commands, createEditor, sourceWindow, unitsToTicks } from '../../packages/core/index.mjs'
import { scheduleWindow } from './transport.mjs'

const renderLength = 64
const sourceSample = (take, index) => (take === 'voice' ? 1 : -1) * (index + 1) / 128

async function render(project, rate) {
  const context = new OfflineAudioContext(1, renderLength, rate)
  const buffers = new Map()
  for (const take of ['voice', 'bed']) {
    const buffer = context.createBuffer(1, renderLength, rate)
    const samples = buffer.getChannelData(0)
    for (let i = 0; i < samples.length; i++) samples[i] = sourceSample(take, i)
    buffers.set(take, buffer)
  }
  const available = unitsToTicks(renderLength, rate)
  for (const clip of project.clips) {
    const span = sourceWindow(clip, { availableStart: 0, availableEnd: available, sourceAtContentZero: 0 },
      0, available)
    if (!span) continue
    const source = context.createBufferSource()
    source.buffer = buffers.get(clip.activeTakeId)
    source.connect(context.destination)
    scheduleWindow(source, span, 0, rate)
  }
  return (await context.startRendering()).getChannelData(0)
}

// The oracle is expressed entirely in source/output sample indices, independently
// of the editor's tick conversion, placement objects and playback-plan helper.
const states = [
  [[8, 24, 6]],                         // initial placement
  [[8, 15, 6], [15, 24, 13]],           // split
  [[8, 15, 6], [17, 24, 15]],           // trim left on the right half
  [[8, 13, 6], [17, 24, 15]],           // trim right on the left half
  [[8, 13, 6], [21, 28, 15]],           // move the right half four samples
]

export async function verifyEditedPcm() {
  const rates = [44100, 48000]
  let renders = 0
  for (const rate of rates) {
    const tick = samples => unitsToTicks(samples, rate)
    const editor = createEditor({ project: {
      schemaVersion: 1, tracks: [{ id: 'voice', overlap: 'exclusive' }, { id: 'mix' }],
      clips: [
        { id: 'line', trackId: 'voice', kind: 'audio', start: tick(8), duration: tick(16),
          contentIn: tick(6), activeTakeId: 'voice' },
        { id: 'guide', trackId: 'mix', kind: 'audio', start: tick(23), duration: tick(6),
          contentIn: tick(2), activeTakeId: 'bed' },
      ],
    } })
    async function compare(state) {
      const actual = await render(editor.getSnapshot(), rate)
      const expected = new Float32Array(renderLength)
      for (const [start, end, offset] of states[state]) {
        for (let i = start; i < end; i++) expected[i] = sourceSample('voice', offset + i - start)
      }
      for (let i = 23; i < 29; i++) expected[i] += sourceSample('bed', 2 + i - 23)
      for (let i = 0; i < actual.length; i++) {
        if (actual[i] !== expected[i]) throw new Error(
          'PCM mismatch at rate ' + rate + ', revision ' + editor.getSnapshot().revision +
          ', sample ' + i + ': expected ' + expected[i] + ', got ' + actual[i])
      }
      renders++
    }
    const edits = [
      commands.splitClip({ clipId: 'line', at: tick(15), rightId: 'right' }),
      commands.trimClip({ clipId: 'right', edge: 'left', delta: tick(2) }),
      commands.trimClip({ clipId: 'line', edge: 'right', delta: tick(-2) }),
      commands.moveClips({ clipIds: ['right'], trackId: 'mix', delta: tick(4) }),
    ]
    try {
      await compare(0)
      for (let i = 0; i < edits.length; i++) {
        const result = editor.dispatch(edits[i])
        if (!result.ok) throw new Error(result.reason)
        await compare(i + 1)
      }
      for (let i = edits.length; i > 0; i--) {
        const result = editor.history.undo()
        if (!result.ok) throw new Error(result.reason)
        await compare(i - 1)
      }
      for (let i = 0; i < edits.length; i++) {
        const result = editor.history.redo()
        if (!result.ok) throw new Error(result.reason)
        await compare(i + 1)
      }
    } finally { editor.dispose() }
  }
  return { rates, renders, samplesCompared: renders * renderLength, passed: true }
}
