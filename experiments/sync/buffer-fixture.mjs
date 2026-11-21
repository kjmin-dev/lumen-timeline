// Bridge the synthetic impulse buffers to the same immutable, sample-based
// binding format that a host resolver supplies.
export function bufferCatalog(takes, version = 1) {
  const bindings = Object.entries(takes).map(([id, take]) => [
    id,
    Object.freeze({
      assetId: take.assetId ?? id,
      assetVersion: take.assetVersion ?? 1,
      streamId: 'mono',
      sampleRate: take.buffer.sampleRate,
      sourceAtContentZero: take.sourceAtContentZero ?? 0,
      availableStart: 0,
      availableEnd: take.buffer.length,
    }),
  ])
  return Object.freeze({ version, takes: Object.freeze(Object.fromEntries(bindings)) })
}
