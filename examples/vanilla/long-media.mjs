// Synthetic media for the three-hour session, served in ten-second WAV
// segments behind a bearer token, with waveform overviews computed on the
// server. It stands in for a media backend: the page reads it through a
// stream reader that authenticates, refreshes an expired token and decodes.
import { randomBytes } from "node:crypto";

export const long = Object.freeze({
  rate: 48000,
  chunkSeconds: 10,
  hours: 3,
  samplesPerPair: 4096,
  assets: ["stem", "music", "lines"],
});
const frames = long.rate * long.chunkSeconds;
const total = long.hours * 3600 * long.rate;

// Deterministic per-asset signals: voiced phrases for the dialogue stem and
// the lines, a slow chord for the music bed.
function phrase(seconds, seed) {
  const slot = Math.floor(seconds / 2.7);
  const hash = (Math.imul(slot + seed, 2654435761) >>> 0) / 4294967296;
  if (hash < 0.3) return 0;
  const into = seconds - slot * 2.7;
  return Math.max(0, Math.min(1, into * 6, (2.2 - into) * 6)) * (0.5 + 0.5 * hash);
}
function sample(asset, frame) {
  const t = frame / long.rate;
  if (asset === "music") {
    const swell = 0.12 * (0.6 + 0.4 * Math.sin((2 * Math.PI * t) / 97));
    return swell * (Math.sin(2 * Math.PI * 110 * t) + 0.5 * Math.sin(2 * Math.PI * 164.81 * t));
  }
  const pitch = asset === "lines" ? 220 : 150;
  const level = phrase(t, asset === "lines" ? 17 : 3);
  if (!level) return 0;
  const tone = Math.sin(2 * Math.PI * pitch * t) * 0.6 + Math.sin(4 * Math.PI * pitch * t) * 0.2;
  return 0.45 * level * tone * Math.abs(Math.sin(Math.PI * 4.3 * t));
}

/** One ten-second segment as 16-bit stereo WAV, or null past the end. */
export function segment(asset, index) {
  if (!long.assets.includes(asset) || !Number.isSafeInteger(index) || index < 0) return null;
  const start = index * frames;
  if (start >= total) return null;
  const count = Math.min(frames, total - start);
  const data = Buffer.alloc(44 + count * 4);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + count * 4, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22);
  data.writeUInt32LE(long.rate, 24);
  data.writeUInt32LE(long.rate * 4, 28);
  data.writeUInt16LE(4, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(count * 4, 40);
  for (let i = 0; i < count; i++) {
    const value = Math.round(Math.max(-1, Math.min(1, sample(asset, start + i))) * 32767);
    data.writeInt16LE(value, 44 + i * 4);
    data.writeInt16LE(value, 46 + i * 4);
  }
  return data;
}

const overviews = new Map();
/**
 * Min/max pairs of 4,096 frames as little-endian Float32, from every 16th
 * frame: what a backend would compute once when a recording is imported.
 */
export function overview(asset) {
  if (!long.assets.includes(asset)) return null;
  let peaks = overviews.get(asset);
  if (!peaks) {
    const count = Math.ceil(total / long.samplesPerPair);
    peaks = new Float32Array(2 * count);
    for (let pair = 0; pair < count; pair++) {
      let lo = Infinity;
      let hi = -Infinity;
      const end = Math.min(total, (pair + 1) * long.samplesPerPair);
      for (let frame = pair * long.samplesPerPair; frame < end; frame += 16) {
        const value = sample(asset, frame);
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
      peaks[2 * pair] = lo;
      peaks[2 * pair + 1] = hi;
    }
    overviews.set(asset, peaks);
  }
  return Buffer.from(peaks.buffer, peaks.byteOffset, peaks.byteLength);
}

/** Bearer tokens that expire, so a reader has to refresh them. */
export function createTokens() {
  const tokens = new Map();
  const stats = { issued: 0, served: 0, unauthorized: 0 };
  return {
    stats,
    issue(ttlSeconds) {
      const token = randomBytes(12).toString("hex");
      tokens.set(token, Date.now() + ttlSeconds * 1000);
      stats.issued++;
      return token;
    },
    check(header) {
      const token = /^Bearer ([0-9a-f]+)$/.exec(header ?? "")?.[1];
      const ok = token !== undefined && (tokens.get(token) ?? 0) > Date.now();
      if (ok) stats.served++;
      else stats.unauthorized++;
      return ok;
    },
  };
}
