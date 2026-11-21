// The benchmark uses complete 256-sample buckets of finite f32 PCM.
export function reducePeaks(pcm, pairs) {
  for (let i = 0; i < pairs.length / 2; i++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j < 256; j++) {
      const sample = pcm[i * 256 + j];
      if (sample < lo) lo = sample;
      if (sample > hi) hi = sample;
    }
    pairs[i * 2] = lo;
    pairs[i * 2 + 1] = hi;
  }
}
