import { TICKS_PER_SECOND } from './time.mjs'

const MAX_TICK = 7 * 86400 * TICKS_PER_SECOND

export class EditError extends Error {
  constructor(code, target, message) {
    super(message)
    this.name = 'EditError'
    this.code = code
    this.target = target
  }
}

export function requireEdit(condition, code, target, reason) {
  if (!condition) throw new EditError(code, target, reason)
}

export function validId(id) {
  return typeof id === 'string' && id.length > 0
}

// Document payloads are JSON data. Cloning before freezing preserves host ownership.
function freezeJson(value, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) return value
  requireEdit(value && typeof value === 'object', 'invalid-project', null, 'Expected JSON project data')
  const prototype = Object.getPrototypeOf(value)
  requireEdit(Array.isArray(value) || prototype === null || Object.getPrototypeOf(prototype) === null,
    'invalid-project', null, 'Expected a plain project object')
  requireEdit(!ancestors.has(value), 'invalid-project', null, 'Project data contains a cycle')
  ancestors.add(value)
  const copy = Array.isArray(value)
    ? Array.from(value, item => freezeJson(item, ancestors))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeJson(item, ancestors)]))
  ancestors.delete(value)
  return Object.freeze(copy)
}

export function openProject(input) {
  const project = freezeJson(input, new Set())
  requireEdit(project?.schemaVersion === 1, 'unsupported-schema', null, 'Editing requires project schema version 1')
  requireEdit(project.timebase === undefined || project.timebase === TICKS_PER_SECOND, 'invalid-timebase', null,
    'Project times must use the timeline tick rate')
  requireEdit(Array.isArray(project.tracks) && Array.isArray(project.clips), 'invalid-project', null,
    'The project requires tracks and clips arrays')
  const revision = project.revision === undefined ? 0 : project.revision
  requireEdit(Number.isSafeInteger(revision) && revision >= 0, 'invalid-project', null, 'Invalid project revision')
  const duration = project.duration === undefined ? MAX_TICK : project.duration
  const minimum = project.minClipDuration === undefined ? 1 : project.minClipDuration
  requireEdit(Number.isSafeInteger(duration) && duration >= 0 && duration <= MAX_TICK &&
    Number.isSafeInteger(minimum) && minimum > 0 && minimum <= MAX_TICK,
    'invalid-project', null, 'Invalid sequence bounds or minimum clip duration')

  const tracks = new Map()
  for (const track of project.tracks) {
    requireEdit(validId(track?.id) && !tracks.has(track.id), 'invalid-track', track?.id, 'Track IDs must be unique')
    requireEdit(track.overlap === undefined || ['mix', 'exclusive'].includes(track.overlap), 'invalid-track', track.id,
      'Unknown overlap policy')
    requireEdit(track.locked === undefined || typeof track.locked === 'boolean', 'invalid-track', track.id,
      'Expected a boolean lock')
    requireEdit(track.accepts === undefined || (Array.isArray(track.accepts) && track.accepts.every(validId)),
      'invalid-track', track.id, 'Expected a list of clip kinds')
    tracks.set(track.id, track)
  }
  const rules = { tracks, duration, minimum }
  const ids = new Set()
  const byTrack = new Map()
  for (const clip of project.clips) {
    requireEdit(validId(clip?.id) && !ids.has(clip.id), 'invalid-clip', clip?.id, 'Clip IDs must be unique')
    ids.add(clip.id)
    validateClip(clip, rules)
    if (!byTrack.has(clip.trackId)) byTrack.set(clip.trackId, [])
    byTrack.get(clip.trackId).push(clip)
  }
  for (const [id, clips] of byTrack) orderTrack(clips, tracks.get(id))
  return { snapshot: Object.freeze({ ...project, revision }), rules, byTrack }
}

export function validateClip(clip, { tracks, duration, minimum }) {
  const { id, trackId, kind, start, duration: length, contentIn, contentBounds } = clip
  const track = tracks.get(trackId)
  requireEdit(track, 'missing-track', trackId, 'Track does not exist')
  requireEdit(validId(kind) && (!track.accepts || track.accepts.includes(kind)),
    'incompatible-kind', id, 'The target track does not accept this clip kind')
  requireEdit(Number.isSafeInteger(start) && Number.isSafeInteger(length) && start >= 0 &&
    length >= minimum && start + length <= duration, 'invalid-range', id, 'Clip exceeds the sequence or minimum duration')
  requireEdit(Number.isSafeInteger(contentIn) && Number.isSafeInteger(contentIn + length),
    'invalid-range', id, 'Invalid content time')
  if (contentBounds !== undefined) {
    requireEdit(Number.isSafeInteger(contentBounds?.start) && Number.isSafeInteger(contentBounds?.end) &&
      contentIn >= contentBounds.start && contentIn + length <= contentBounds.end,
      'source-bounds', id, 'Clip exceeds its available content handles')
  }
}

export function orderTrack(clips, track) {
  clips.sort((a, b) => a.start - b.start)
  if (track.overlap !== 'exclusive') return
  for (let i = 1; i < clips.length; i++) {
    const previous = clips[i - 1]
    requireEdit(previous.start + previous.duration <= clips[i].start, 'overlap', track.id,
      'Clips overlap on an exclusive track')
  }
}
