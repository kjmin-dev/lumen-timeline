import { unitsToTicks } from "@lumen-timeline/core";

// Bridge the synthetic impulse buffers to what a host supplies: project takes
// aligned in ticks, and a catalog of the decoded streams behind their assets.
// Fixtures describe takes as `{ [takeId]: { buffer, sourceAtContentZero?, assetId?, assetVersion? } }`,
// with the source position in the buffer's samples.
const assetOf = (id, take) => take.assetId ?? id;

export function bufferTakes(takes) {
  return Object.entries(takes).map(([id, take]) => ({
    id,
    assetId: assetOf(id, take),
    streamId: "mono",
    sourceAtContentZero: unitsToTicks(take.sourceAtContentZero ?? 0, take.buffer.sampleRate),
  }));
}

/** Gives each clip its active take as its only candidate. */
export function listTakes(clips) {
  return clips.map((clip) =>
    clip.activeTakeId == null ? clip : { ...clip, takeIds: [clip.activeTakeId] },
  );
}

export function bufferCatalog(takes, version = 1) {
  const streams = Object.entries(takes).map(([id, take]) => [
    assetOf(id, take),
    Object.freeze({
      mono: Object.freeze({
        assetVersion: take.assetVersion ?? 1,
        sampleRate: take.buffer.sampleRate,
        availableStart: 0,
        availableEnd: take.buffer.length,
      }),
    }),
  ]);
  return Object.freeze({ version, streams: Object.freeze(Object.fromEntries(streams)) });
}
