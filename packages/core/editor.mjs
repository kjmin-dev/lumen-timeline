import { EditError, openProject, orderTrack, requireEdit, validId, validateClip } from './document.mjs'
import { splitClip } from './time.mjs'

export const commands = Object.freeze({
  moveClips: args => ({ ...args, type: 'move' }),
  trimClip: args => ({ ...args, type: 'trim' }),
  splitClip: args => ({ ...args, type: 'split' }),
})

function splice(index, before, after) {
  return Object.freeze({ index, before: Object.freeze(before), after: Object.freeze(after) })
}

function inverse(patches) {
  let offset = 0
  return Object.freeze(patches.map(patch => {
    const position = patch.index + offset
    offset += patch.after.length - patch.before.length
    return splice(position, patch.after, patch.before)
  }))
}

function positions(clips) {
  return new Map(clips.map((clip, index) => [clip.id, index]))
}

function intervals(clips) {
  return Object.freeze(clips.map(clip => Object.freeze({
    clipId: clip.id, trackId: clip.trackId, start: clip.start, end: clip.start + clip.duration,
  })))
}

export function createEditor({ project }) {
  let { snapshot, rules, byTrack } = openProject(project)
  let byId = positions(snapshot.clips)
  const past = []
  const future = []
  const subscribers = new Set()
  const notifications = []
  let notifying = false
  let disposed = false
  let fallbackId = 0

  function newClipId() {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
    // Embedded HTTP editors may lack randomUUID. Hosts can also supply a durable ID.
    let id
    do { id = 'clip-' + ++fallbackId } while (byId.has(id))
    return id
  }

  function changes(command) {
    const type = command?.type
    requireEdit(['move', 'trim', 'split'].includes(type), 'unknown-command', null, 'Unknown clip command')
    const ids = type === 'move' ? command.clipIds : [command.clipId]
    requireEdit(Array.isArray(ids) && ids.length > 0 && ids.every(validId) && new Set(ids).size === ids.length,
      'invalid-selection', null, 'Expected distinct clip IDs')
    if (type !== 'split') {
      requireEdit(Number.isSafeInteger(command.delta), 'invalid-delta', null, 'Delta must be an integer tick count')
    }

    const patches = []
    for (const id of ids) {
      const index = byId.get(id)
      requireEdit(index !== undefined, 'missing-clip', id, 'Clip does not exist')
      const clip = snapshot.clips[index]
      requireEdit(!rules.tracks.get(clip.trackId).locked, 'locked-track', clip.trackId, 'Source track is locked')

      let after
      if (type === 'move') {
        const trackId = command.trackId === undefined ? clip.trackId : command.trackId
        const destination = rules.tracks.get(trackId)
        requireEdit(destination, 'missing-track', trackId, 'Destination does not exist')
        requireEdit(!destination.locked, 'locked-track', trackId, 'Destination is locked')
        if (command.delta === 0 && trackId === clip.trackId) continue
        after = [{ ...clip, trackId, start: clip.start + command.delta }]
      } else if (type === 'trim') {
        requireEdit(command.edge === 'left' || command.edge === 'right', 'invalid-edge', id, 'Choose left or right')
        if (command.delta === 0) continue
        after = command.edge === 'left'
          ? [{ ...clip, start: clip.start + command.delta, duration: clip.duration - command.delta,
              contentIn: clip.contentIn + command.delta }]
          : [{ ...clip, duration: clip.duration + command.delta }]
      } else {
        requireEdit(Number.isSafeInteger(command.at) && command.at > clip.start && command.at < clip.start + clip.duration,
          'invalid-range', id, 'Split must be inside the clip')
        requireEdit(!Object.keys(clip.extensions ?? {}).length, 'split-policy-required', id,
          'A split policy is required for this clip extension')
        const rightId = command.rightId === undefined ? newClipId() : command.rightId
        requireEdit(validId(rightId) && !byId.has(rightId), 'invalid-id', rightId, 'The right clip requires a new ID')
        after = splitClip(clip, command.at, rightId)
      }
      for (const next of after) {
        validateClip(next, rules)
        Object.freeze(next)
      }
      patches.push(splice(index, [clip], after))
    }
    return Object.freeze(patches.sort((a, b) => a.index - b.index))
  }

  function notify(result) {
    notifications.push({ result, document: snapshot })
    if (notifying) return
    notifying = true
    try {
      for (const { result, document } of notifications) {
        for (const sub of [...subscribers]) {
          if (!subscribers.has(sub) || sub.revision >= document.revision) continue
          sub.revision = document.revision
          try {
            const next = sub.select(document)
            if (!Object.is(sub.value, next)) {
              sub.value = next
              sub.listen(next, result, document)
            }
          } catch (error) {
            if (typeof globalThis.reportError === 'function') globalThis.reportError(error)
            else queueMicrotask(() => { throw error })
          }
        }
      }
    } finally {
      notifications.length = 0
      notifying = false
    }
  }

  function apply(patches, inverses, mode) {
    const before = patches.flatMap(patch => patch.before)
    const after = patches.flatMap(patch => patch.after)
    const removedIds = new Set(before.map(clip => clip.id))
    const touched = new Set(before.concat(after).map(clip => clip.trackId))
    const layout = new Map(byTrack)
    for (const trackId of touched) {
      layout.set(trackId, (byTrack.get(trackId) ?? []).filter(clip => !removedIds.has(clip.id)))
    }
    for (const clip of after) layout.get(clip.trackId).push(clip)
    for (const id of touched) orderTrack(layout.get(id), rules.tracks.get(id))

    const clips = []
    let cursor = 0
    for (const patch of patches) {
      while (cursor < patch.index) clips.push(snapshot.clips[cursor++])
      clips.push(...patch.after)
      cursor += patch.before.length
    }
    while (cursor < snapshot.clips.length) clips.push(snapshot.clips[cursor++])
    const revision = snapshot.revision + 1
    requireEdit(Number.isSafeInteger(revision), 'revision-overflow', null, 'Project revision exceeds safe integer range')
    const result = Object.freeze({
      ok: true, revision, patches, inversePatches: inverses,
      changedIds: Object.freeze([...new Set([...removedIds, ...after.map(clip => clip.id)])]),
      createdIds: Object.freeze(after.filter(clip => !removedIds.has(clip.id)).map(clip => clip.id)),
      affected: Object.freeze({ before: intervals(before), after: intervals(after) }),
    })

    byId = positions(clips)
    byTrack = layout
    snapshot = Object.freeze({ ...snapshot, clips: Object.freeze(clips), revision })
    if (mode === 'undo') future.push(past.pop())
    else if (mode === 'redo') past.push(future.pop())
    else {
      past.push({ forward: patches, inverse: inverses })
      future.length = 0
    }
    notify(result)
    return result
  }

  function execute(command, mode, options) {
    try {
      requireEdit(!disposed, 'disposed', null, 'Editor has been disposed')
      requireEdit(options?.expectedRevision === undefined || options.expectedRevision === snapshot.revision,
        'stale-revision', null, 'Project changed before the edit')
      if (mode === 'edit') {
        const patches = changes(command)
        if (patches.length === 0) return { ok: true, revision: snapshot.revision, unchanged: true }
        return apply(patches, inverse(patches), mode)
      }
      const entry = (mode === 'undo' ? past : future).at(-1)
      requireEdit(entry, 'empty-history', null, 'No history entry available')
      return mode === 'undo' ? apply(entry.inverse, entry.forward, mode) : apply(entry.forward, entry.inverse, mode)
    } catch (error) {
      if (!(error instanceof EditError)) throw error
      return { ok: false, revision: snapshot.revision, code: error.code, target: error.target, reason: error.message }
    }
  }

  return {
    getSnapshot: () => snapshot,
    dispatch: (command, options) => execute(command, 'edit', options),
    history: {
      undo: options => execute(null, 'undo', options),
      redo: options => execute(null, 'redo', options),
      get canUndo() { return past.length > 0 },
      get canRedo() { return future.length > 0 },
    },
    subscribe(select, listen) {
      requireEdit(!disposed, 'disposed', null, 'Editor has been disposed')
      const sub = { select, listen, value: select(snapshot), revision: snapshot.revision }
      subscribers.add(sub)
      return () => subscribers.delete(sub)
    },
    dispose() {
      disposed = true
      subscribers.clear()
      past.length = 0
      future.length = 0
    },
  }
}
