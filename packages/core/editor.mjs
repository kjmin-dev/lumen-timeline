import { EditError, openProject, orderTrack, requireEdit, validId, validateClip } from './document.mjs'
import { ClipDraft, inverse, rebase } from './clip-patches.mjs'
import { DataDraft, applyData, invertData, normalizeEntityData } from './entity-data.mjs'
import { createHistory } from './history.mjs'
import { splitClip } from './time.mjs'

export const commands = Object.freeze({
  moveClips: args => ({ ...args, type: 'move' }),
  trimClip: args => ({ ...args, type: 'trim' }),
  splitClip: args => ({ ...args, type: 'split' }),
  setEntityData: args => ({ ...args, type: 'set-data' }),
  removeEntityData: args => ({ ...args, type: 'remove-data' }),
})

function positions(clips) {
  return new Map(clips.map((clip, index) => [clip.id, index]))
}

function intervals(clips) {
  return Object.freeze(clips.map(clip => Object.freeze({
    clipId: clip.id, trackId: clip.trackId, start: clip.start, end: clip.start + clip.duration,
  })))
}

export function createEditor({ project, history: limits }) {
  let { snapshot, rules, byTrack } = openProject(project)
  let byId = positions(snapshot.clips)
  if (Object.hasOwn(snapshot, 'entityData')) {
    const { entityData, ...rest } = snapshot
    const normalized = normalizeEntityData(entityData)
    snapshot = Object.freeze(normalized ? { ...rest, entityData: normalized } : rest)
  }
  const history = createHistory(limits)
  const subscribers = new Set()
  const historySubscribers = new Set()
  let historyVersion = 0
  const notifications = []
  let notifying = false
  let disposed = false
  let fallbackId = 0

  function newClipId(draft) {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
    // Embedded HTTP editors may lack randomUUID. Hosts can also supply a durable ID.
    let id
    do { id = 'clip-' + ++fallbackId } while (draft.get(id))
    return id
  }

  function stageClip(command, draft) {
    const type = command?.type
    requireEdit(['move', 'trim', 'split'].includes(type), 'unknown-command', null, 'Unknown clip command')
    const ids = type === 'move' ? command.clipIds : [command.clipId]
    requireEdit(Array.isArray(ids) && ids.length > 0 && ids.every(validId) && new Set(ids).size === ids.length,
      'invalid-selection', null, 'Expected distinct clip IDs')
    if (type !== 'split') {
      requireEdit(Number.isSafeInteger(command.delta), 'invalid-delta', null, 'Delta must be an integer tick count')
    }

    for (const id of ids) {
      const clip = draft.get(id)
      requireEdit(clip, 'missing-clip', id, 'Clip does not exist')
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
        const rightId = command.rightId === undefined ? newClipId(draft) : command.rightId
        requireEdit(validId(rightId) && !draft.get(rightId), 'invalid-id', rightId, 'The right clip requires a new ID')
        after = splitClip(clip, command.at, rightId)
      }
      for (const next of after) validateClip(next, rules)
      draft.replace(clip, after)
    }
  }

  function deliver(fn) {
    try { fn() } catch (error) {
      if (typeof globalThis.reportError === 'function') globalThis.reportError(error)
      else queueMicrotask(() => { throw error })
    }
  }

  function notify(result, historyChanged) {
    const state = historyChanged ? Object.freeze({ undoDepth: history.undoDepth, redoDepth: history.redoDepth,
      estimatedBytes: history.estimatedBytes }) : null
    if (state) historyVersion++
    notifications.push({ result, document: snapshot, state, version: historyVersion })
    if (notifying) return
    notifying = true
    try {
      for (const event of notifications) {
        if (event.result) {
          for (const sub of [...subscribers]) {
            if (!subscribers.has(sub) || sub.revision >= event.document.revision) continue
            sub.revision = event.document.revision
            deliver(() => {
              const next = sub.select(event.document)
              if (!Object.is(sub.value, next)) {
                sub.value = next
                sub.listen(next, event.result, event.document)
              }
            })
          }
        }
        if (event.state) {
          for (const sub of [...historySubscribers]) {
            if (!historySubscribers.has(sub) || sub.version >= event.version) continue
            sub.version = event.version
            deliver(() => sub.listen(event.state))
          }
        }
      }
    } finally {
      notifications.length = 0
      notifying = false
    }
  }

  function prepareLayout(patches, before, after) {
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
      for (const clip of patch.after) clips.push(clip)
      cursor += patch.before.length
    }
    while (cursor < snapshot.clips.length) clips.push(snapshot.clips[cursor++])
    // Placement-only changes keep every ID at its existing array position.
    const structural = patches.some(p => p.before.length !== p.after.length)
    return { clips: Object.freeze(clips), layout, positions: structural ? positions(clips) : byId }
  }

  function execute(input, mode, options) {
    try {
      requireEdit(!disposed, 'disposed', null, 'Editor has been disposed')
      requireEdit(options?.expectedRevision === undefined || options.expectedRevision === snapshot.revision,
        'stale-revision', null, 'Project changed before the edit')

      let patches, inverses, data, inverseData
      let policy = options?.history === undefined ? 'record' : options.history
      if (mode === 'edit') {
        requireEdit(policy === 'record' || policy === 'ignore', 'invalid-history-policy', null,
          'Choose record or ignore for the transaction')
        const clips = new ClipDraft(snapshot.clips, byId)
        const fields = new DataDraft(snapshot.entityData)
        for (const command of Array.isArray(input) ? input : [input]) {
          if (command?.type === 'set-data' || command?.type === 'remove-data') fields.stage(command)
          else stageClip(command, clips)
        }
        patches = clips.patches()
        data = fields.patches()
        if (!patches.length && !data.length) return { ok: true, revision: snapshot.revision, unchanged: true }
        inverses = inverse(patches)
        inverseData = invertData(data)
      } else {
        const entry = history.peek(mode)
        requireEdit(entry, 'empty-history', null, 'No history entry available')
        const undo = mode === 'undo'
        const stored = undo ? entry.inverse : entry.forward
        patches = rebase(stored, snapshot.clips, byId, clip => validateClip(clip, rules))
        inverses = patches === stored ? (undo ? entry.forward : entry.inverse) : inverse(patches)
        data = undo ? entry.inverseData : entry.data
        inverseData = undo ? entry.data : entry.inverseData
        policy = mode
      }

      const before = patches.flatMap(p => p.before)
      const after = patches.flatMap(p => p.after)
      const geometry = patches.length ? prepareLayout(patches, before, after) : null
      const entityData = applyData(snapshot.entityData, data)
      const revision = snapshot.revision + 1
      requireEdit(Number.isSafeInteger(revision), 'revision-overflow', null, 'Project revision exceeds safe integer range')
      const oldIds = new Set(before.map(c => c.id))
      const result = Object.freeze({
        ok: true, revision, history: policy, patches, inversePatches: inverses,
        dataPatches: data, inverseDataPatches: inverseData,
        changedIds: Object.freeze([...new Set([...oldIds, ...after.map(c => c.id)])]),
        createdIds: Object.freeze(after.filter(c => !oldIds.has(c.id)).map(c => c.id)),
        affected: Object.freeze({ before: intervals(before), after: intervals(after) }),
      })
      const next = { ...snapshot, revision, clips: geometry?.clips ?? snapshot.clips }
      if (entityData === undefined) delete next.entityData
      else next.entityData = entityData

      // Validation, conflict checks and staging finish before any observable write.
      if (mode !== 'edit') history.advance(mode)
      else if (policy === 'record') history.record({ forward: patches, inverse: inverses, data, inverseData })
      if (geometry) {
        byId = geometry.positions
        byTrack = geometry.layout
      }
      snapshot = Object.freeze(next)
      notify(result, policy !== 'ignore' && history.undoDepth + history.redoDepth > 0)
      return result
    } catch (error) {
      if (!(error instanceof EditError)) throw error
      const conflict = mode !== 'edit' && ['overlap', 'source-bounds', 'invalid-range'].includes(error.code)
      return { ok: false, revision: snapshot.revision, code: conflict ? 'history-conflict' : error.code,
        target: error.target, reason: error.message }
    }
  }

  return {
    getSnapshot: () => snapshot,
    dispatch: (command, options) => execute(command, 'edit', options),
    history: {
      undo: options => execute(null, 'undo', options),
      redo: options => execute(null, 'redo', options),
      get canUndo() { return history.undoDepth > 0 },
      get canRedo() { return history.redoDepth > 0 },
      get undoDepth() { return history.undoDepth },
      get redoDepth() { return history.redoDepth },
      get estimatedBytes() { return history.estimatedBytes },
      subscribe(listen) {
        requireEdit(!disposed, 'disposed', null, 'Editor has been disposed')
        const sub = { listen, version: historyVersion }
        historySubscribers.add(sub)
        return () => historySubscribers.delete(sub)
      },
      discard(direction) {
        const removed = history.discard(direction)
        if (removed) notify(null, true)
        return removed
      },
      clear() {
        if (history.undoDepth + history.redoDepth === 0) return
        history.clear()
        notify(null, true)
      },
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
      historySubscribers.clear()
      history.clear()
    },
  }
}
