import { reducePeaks } from "./peaks.mjs";
import { unitsToTicks } from "@lumen-timeline/core";
export async function measure(moduleBytes) {
  const before = performance.now();
  const { instance } = await WebAssembly.instantiate(Uint8Array.from(moduleBytes));
  const instantiateMs = performance.now() - before;
  const { memory, __heap_base, source_position, units_to_ticks, peaks, peaks_simd } =
    instance.exports;
  const count = 1048576;
  const buckets = count / 256;
  const inputPtr = Math.ceil(__heap_base.value / 16) * 16;
  const outputPtr = inputPtr + count * 4;
  const pages = Math.ceil((outputPtr + buckets * 8 - memory.buffer.byteLength) / 65536);
  if (pages > 0) memory.grow(pages);
  const pcm = new Float32Array(count);
  const wasmPcm = new Float32Array(memory.buffer, inputPtr, count);
  const wasmPairs = new Float32Array(memory.buffer, outputPtr, buckets * 2);
  const jsPairs = new Float32Array(buckets * 2);
  const copied = new Float32Array(buckets * 2);
  let seed = 4443;
  for (let i = 0; i < count; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pcm[i] = seed / 2147483648 - 1;
  }
  wasmPcm.set(pcm);
  const jsPeaks = () => reducePeaks(pcm, jsPairs);
  function jsPosition(time, start, end, offset) {
    return time >= start && time < end ? time - start + offset : -1;
  }
  function query(fn) {
    let sum = 0;
    for (let i = 0; i < 100000; i++) sum += fn(i % 1600, 240, 1400, 73);
    return sum;
  }
  const rates = [30000, 44100, 48000, 90001];
  const denominators = [1001, 1, 1, 1];
  function convert(fn) {
    let checksum = 0;
    for (let i = 0; i < 100000; i++) {
      checksum ^= fn(i - 50000, rates[i % 4], denominators[i % 4]);
    }
    return checksum;
  }
  for (let i = 0; i < 100000; i++) {
    const args = [i - 50000, rates[i % 4], denominators[i % 4]];
    if (unitsToTicks(...args) !== units_to_ticks(...args))
      throw new Error("Different tick conversion");
  }
  // WebCodecs PTS are in microseconds. After thirty minutes the direct
  // numerator product exceeds Number.MAX_SAFE_INTEGER.
  function convertTimestamps(fn) {
    let checksum = 0;
    for (let i = 0; i < 100000; i++) checksum ^= fn(1800000000 + i * 33367, 1000000, 1);
    return checksum;
  }
  for (let i = 0; i < 100000; i++) {
    const value = 1800000000 + i * 33367;
    if (unitsToTicks(value, 1000000) !== units_to_ticks(value, 1000000, 1))
      throw new Error("Different PTS");
  }
  const ptsChecksum = convertTimestamps(unitsToTicks);
  const conversionChecksum = convert(unitsToTicks);
  const scalarChecksum = query(jsPosition);
  const cases = {
    jsQuery: () => query(jsPosition),
    wasmQuery: () => query(source_position),
    jsConvert: () => convert(unitsToTicks),
    wasmConvert: () => convert(units_to_ticks),
    jsPts: () => convertTimestamps(unitsToTicks),
    wasmPts: () => convertTimestamps(units_to_ticks),
    jsPeaks,
    wasmResident: () => peaks(inputPtr, buckets, outputPtr),
    simdResident: () => peaks_simd(inputPtr, buckets, outputPtr),
    simdWithCopies: () => {
      wasmPcm.set(pcm);
      peaks_simd(inputPtr, buckets, outputPtr);
      copied.set(wasmPairs);
    },
  };
  jsPeaks();
  for (const fn of [cases.wasmResident, cases.simdResident, cases.simdWithCopies]) {
    fn();
    const actual = fn === cases.simdWithCopies ? copied : wasmPairs;
    if (!jsPairs.every((v, i) => v === actual[i])) throw new Error("Different peak output");
  }
  const times = Object.fromEntries(Object.keys(cases).map((k) => [k, []]));
  const entries = Object.entries(cases);
  for (let round = 0; round < 39; round++) {
    for (let j = 0; j < entries.length; j++) {
      const [name, fn] = entries[(round + j) % entries.length];
      const start = performance.now();
      for (let repeat = 0; repeat < 8; repeat++) {
        const value = fn();
        if (name.endsWith("Pts") && value !== ptsChecksum)
          throw new Error("Different PTS checksum");
        if (name.endsWith("Convert") && value !== conversionChecksum)
          throw new Error("Different tick checksum");
        if (name.endsWith("Query") && value !== scalarChecksum)
          throw new Error("Different source position");
      }
      if (round >= 8) times[name].push((performance.now() - start) / 8);
    }
  }
  const ms = {};
  for (const [name, samples] of Object.entries(times)) {
    samples.sort((a, b) => a - b);
    ms[name] = { median: samples[15], p95: samples[29] };
  }
  return {
    moduleBytes: moduleBytes.length,
    instantiateMs,
    pcmSamples: count,
    queries: 100000,
    scalarChecksum,
    verifiedPeakValues: jsPairs.length,
    ms,
  };
}
