import { createEditor, TICKS_PER_SECOND as hz } from '@lumen-timeline/core'
import { mountTimeline } from '@lumen-timeline/timeline'
import { attachPlayer } from './player.mjs'

const video = document.querySelector('video')
export const project = { schemaVersion: 1, duration: 24 * hz,
  tracks: [{ id: 'dialogue', name: 'Dialogue', overlap: 'exclusive' }, { id: 'music', name: 'Music', locked: true }],
  clips: [
    { id: 'line', name: 'Tidal contours', trackId: 'dialogue', kind: 'audio', start: 12 * hz,
      duration: 4 * hz, contentIn: hz, contentBounds: { start: 0, end: 8 * hz }, activeTakeId: 'line' },
    { id: 'return', name: 'Return cue', trackId: 'dialogue', kind: 'audio', start: 19 * hz,
      duration: 3 * hz, contentIn: hz, contentBounds: { start: 0, end: 8 * hz }, activeTakeId: 'line' },
    { id: 'bed', name: 'Low water', trackId: 'music', kind: 'audio', start: 0,
      duration: 24 * hz, contentIn: 0, contentBounds: { start: 0, end: 24 * hz }, activeTakeId: 'bed' },
  ],
}
export async function openProject(data) {
  const editor = createEditor({ project: data })
  const transport = await attachPlayer(video, editor, error => { document.querySelector('#status').textContent = error.message })
  const view = mountTimeline(document.querySelector('#timeline'), { editor, transport, snap: { gridTicks: hz / 10 },
    pixelsPerSecond: Math.max(20, (document.querySelector('#timeline').clientWidth - 160) / 24) })
  function inspector() {
    const snapshot = editor.getSnapshot()
    const c = snapshot.clips.find(clip => clip.id === editor.session.getSelection().at(-1))
    document.querySelector('#clip-name').textContent = c?.name ?? 'No selection'
    document.querySelector('#track').textContent = snapshot.tracks.find(t => t.id === c?.trackId)?.name ?? '—'
    document.querySelector('#range').textContent = c ? (c.start / hz).toFixed(3) + ' – ' + ((c.start + c.duration) / hz).toFixed(3) + ' s' : '—'
    document.querySelector('#offset').textContent = c ? (c.contentIn / hz).toFixed(3) + ' s' : '—'
    document.querySelector('#take').textContent = c?.activeTakeId ?? '—'
  }
  let off = () => {}
  function bindInspector() {
    off()
    const id = editor.session.getSelection().at(-1)
    off = editor.subscribe(s => s.clips.find(c => c.id === id), inspector)
    inspector()
  }
  const deselect = editor.session.subscribeSelection(bindInspector)
  bindInspector()
  return { editor, view, transport, async dispose() {
    off(); deselect(); view.dispose(); await transport.dispose(); editor.dispose()
  } }
}
export let studio
try { studio = await openProject(project) }
catch (error) { document.querySelector('#status').textContent = error.message; throw error }

const storageKey = 'lumen-timeline:vanilla:project:v1'
const save = document.querySelector('#save'), reopen = document.querySelector('#reopen')
const status = document.querySelector('#status')
try { reopen.disabled = !localStorage.getItem(storageKey) } catch { reopen.disabled = true }
save.onclick = () => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(studio.editor.getSnapshot()))
    reopen.disabled = false
    status.textContent = 'Project saved.'
  } catch (error) { status.textContent = error.message }
}
reopen.onclick = async () => {
  save.disabled = reopen.disabled = true
  try {
    const restored = JSON.parse(localStorage.getItem(storageKey))
    const next = await openProject(restored)
    const old = studio
    studio = next
    await old.dispose()
    await next.transport.seek(0)
    status.textContent = 'Saved project reopened.'
  } catch (error) { status.textContent = error.message }
  finally { save.disabled = reopen.disabled = false }
}
