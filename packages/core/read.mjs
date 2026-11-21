import { requireEdit } from './document.mjs'
import { visitRange } from './interval-index.mjs'
import { planAudio } from './playback.mjs'

function validate(range) {
  requireEdit(Number.isSafeInteger(range?.start) && Number.isSafeInteger(range?.end) && range.start <= range.end,
    'invalid-range', null, 'Expected ordered integer range boundaries')
}

// Weak keys allow retained snapshots to pin their layout without retaining
// every revision for the lifetime of the editor.
export function readRegistry(tracks) {
  const layouts = new WeakMap()
  const handles = new WeakMap()
  const order = new Map(tracks.map((track, index) => [track.id, index]))
  return {
    pin(snapshot, layout) { layouts.set(snapshot, layout) },
    read(snapshot) {
      const layout = layouts.get(snapshot)
      requireEdit(layout, 'foreign-snapshot', null, 'Read requires a snapshot from this editor')
      if (!handles.has(snapshot)) {
        handles.set(snapshot, Object.freeze({
          revision: snapshot.revision,
          clipsIn(range, { trackIds } = {}) {
            validate(range)
            const found = []
            const visit = id => visitRange(layout.get(id), range.start, range.end, clip => found.push(clip))
            if (trackIds === undefined) {
              for (const track of tracks) visit(track.id)
            } else {
              requireEdit(Array.isArray(trackIds), 'invalid-selection', null, 'Expected track IDs')
              const ids = [...new Set(trackIds)]
              for (const id of ids) requireEdit(order.has(id), 'missing-track', id, 'Unknown query track')
              for (const id of ids.sort((a, b) => order.get(a) - order.get(b))) visit(id)
            }
            return Object.freeze(found)
          },
          planAudio(range, catalog) {
            validate(range)
            return planAudio(snapshot.revision, tracks, range, catalog,
              (id, emit) => visitRange(layout.get(id), range.start, range.end, emit))
          },
        }))
      }
      return handles.get(snapshot)
    },
  }
}
