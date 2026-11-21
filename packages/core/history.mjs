import { requireEdit } from './document.mjs'

// Approximate logical payload size. Immutable children are cheap to reweigh.
// Shared values may be counted multiple times; this is not a measurement of heap size.
function estimator() {
  const sizes = new WeakMap()
  function bytes(value) {
    if (typeof value === 'string') return 16 + value.length * 2
    if (value === null || typeof value !== 'object') return 8
    const cached = sizes.get(value)
    if (cached !== undefined) return cached
    let size = 32
    for (const key of Object.keys(value)) size += 8 + key.length * 2 + bytes(value[key])
    sizes.set(value, size)
    return size
  }
  return bytes
}

export function createHistory(options = {}) {
  requireEdit(options !== null && typeof options === 'object' && !Array.isArray(options), 'invalid-history', null,
    'Expected history options')
  const { maxEntries = 200, maxBytes = 16 * 1024 * 1024 } = options
  requireEdit(Number.isSafeInteger(maxEntries) && maxEntries >= 0 && Number.isSafeInteger(maxBytes) && maxBytes >= 0,
    'invalid-history', null, 'History limits must be nonnegative safe integers')
  const past = []
  const future = []
  const weigh = estimator()
  let estimatedBytes = 0

  return {
    get undoDepth() { return past.length },
    get redoDepth() { return future.length },
    get estimatedBytes() { return estimatedBytes },
    peek: mode => (mode === 'undo' ? past : future).at(-1),
    advance(mode) {
      if (mode === 'undo') future.push(past.pop())
      else past.push(future.pop())
    },
    record(entry) {
      const bytes = maxEntries && maxBytes ? weigh(entry) : 0
      for (const item of future) estimatedBytes -= item.bytes
      future.length = 0
      if (!bytes) return
      past.push({ ...entry, bytes })
      estimatedBytes += bytes
      // One atomic edit may exceed the byte budget. Keep the newest edit intact.
      while (past.length > 1 && (past.length > maxEntries || estimatedBytes > maxBytes)) {
        estimatedBytes -= past.shift().bytes
      }
    },
    discard(direction) {
      requireEdit(direction === 'undo' || direction === 'redo', 'invalid-history', null, 'Choose undo or redo')
      const entry = (direction === 'undo' ? past : future).pop()
      if (!entry) return false
      estimatedBytes -= entry.bytes
      return true
    },
    clear() {
      past.length = 0
      future.length = 0
      estimatedBytes = 0
    },
  }
}
