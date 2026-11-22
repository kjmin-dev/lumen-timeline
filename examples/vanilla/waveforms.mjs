import { TICKS_PER_SECOND as hz } from "@lumen-timeline/core";

const block = 64;

/**
 * A waveform provider over decoded buffers, keyed by asset ID. It keeps the
 * minimum and maximum of every 64 samples, and reads raw samples when a bucket
 * covers fewer than two blocks. Assets it does not hold draw no waveform.
 */
export function createWaveforms(buffers) {
  const summaries = new Map();
  function summary(assetId) {
    let found = summaries.get(assetId);
    if (found) return found;
    const samples = buffers[assetId].getChannelData(0);
    const count = Math.ceil(samples.length / block);
    const min = new Float32Array(count);
    const max = new Float32Array(count);
    for (let b = 0; b < count; b++) {
      let lo = 0;
      let hi = 0;
      for (let i = b * block, end = Math.min(samples.length, i + block); i < end; i++) {
        if (samples[i] < lo) lo = samples[i];
        if (samples[i] > hi) hi = samples[i];
      }
      min[b] = lo;
      max[b] = hi;
    }
    found = { samples, min, max };
    summaries.set(assetId, found);
    return found;
  }
  return {
    peaks({ assetId, start, end, buckets }) {
      if (!Object.hasOwn(buffers, assetId)) return null;
      const rate = buffers[assetId].sampleRate;
      const { samples, min, max } = summary(assetId);
      const peaks = new Float32Array(2 * buckets);
      const step = (end - start) / buckets;
      for (let i = 0; i < buckets; i++) {
        // Sample positions of this bucket, clamped to the decoded source.
        const from = Math.max(0, Math.floor(((start + i * step) / hz) * rate));
        const to = Math.min(samples.length, Math.ceil(((start + (i + 1) * step) / hz) * rate));
        let lo = 0;
        let hi = 0;
        if (to - from < 2 * block) {
          for (let s = from; s < to; s++) {
            if (samples[s] < lo) lo = samples[s];
            if (samples[s] > hi) hi = samples[s];
          }
        } else {
          for (let b = Math.floor(from / block), last = Math.ceil(to / block); b < last; b++) {
            if (min[b] < lo) lo = min[b];
            if (max[b] > hi) hi = max[b];
          }
        }
        peaks[2 * i] = lo;
        peaks[2 * i + 1] = hi;
      }
      return peaks;
    },
  };
}
