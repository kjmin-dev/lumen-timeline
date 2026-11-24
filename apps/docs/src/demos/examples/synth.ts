// Deterministic mono synthesis for the example screens: speech-like voices, a small band and
// ambience, all at DEMO_SAMPLE_RATE. Nothing is fetched, and the waveforms the timeline draws
// are computed from these same samples.
import { DEMO_SAMPLE_RATE as RATE } from "../fixtures.ts";

const TAU = Math.PI * 2;

/** A seeded generator of numbers in [0, 1). */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const samples = (seconds: number): number => Math.round(seconds * RATE);

/** Adds `source` into `target` from `at` seconds, scaled by `gain`. */
export function mixInto(target: Float32Array, source: Float32Array, at: number, gain = 1): void {
  const offset = samples(at);
  const end = Math.min(target.length, offset + source.length);
  for (let i = Math.max(0, offset); i < end; i++) {
    target[i] = (target[i] ?? 0) + (source[i - offset] ?? 0) * gain;
  }
}

/** Fades the first and last `seconds` of a buffer in place. */
export function fade(pcm: Float32Array, fadeIn: number, fadeOut: number): Float32Array {
  const a = samples(fadeIn);
  const b = samples(fadeOut);
  for (let i = 0; i < a && i < pcm.length; i++) pcm[i] = (pcm[i] ?? 0) * (i / a);
  for (let i = 0; i < b && i < pcm.length; i++) {
    const at = pcm.length - 1 - i;
    pcm[at] = (pcm[at] ?? 0) * (i / b);
  }
  return pcm;
}

// ------------------------------------------------------------------ speech

export interface Voice {
  /** Fundamental frequency in Hz. */
  readonly pitch: number;
  readonly seed: number;
  /** Seconds per syllable. Defaults to 0.17. */
  readonly pace?: number;
}

// First and second formant of a few vowels, in Hz.
const VOWELS: readonly (readonly [number, number])[] = [
  [730, 1090],
  [530, 1840],
  [390, 1990],
  [570, 840],
  [440, 1020],
  [300, 2200],
];

// One voiced syllable: harmonics of a gliding fundamental, weighted by two formants.
function syllable(out: Float32Array, at: number, length: number, f0: number, next: () => number) {
  const vowel = VOWELS[Math.floor(next() * VOWELS.length)] ?? [600, 1200];
  const start = samples(at);
  const count = samples(length);
  const glide = 0.94 + next() * 0.12;
  const level = 0.5 + next() * 0.35;
  const weights: number[] = [];
  for (let h = 1; h <= 9; h++) {
    const f = h * f0;
    const a =
      Math.exp(-(((f - vowel[0]) / 260) ** 2)) + 0.6 * Math.exp(-(((f - vowel[1]) / 420) ** 2));
    weights.push((a + 0.05) / h ** 0.35);
  }
  const attack = samples(0.018);
  const release = samples(0.05);
  let phase = next() * TAU;
  for (let i = 0; i < count && start + i < out.length; i++) {
    const progress = i / count;
    phase += (TAU * f0 * (1 + (glide - 1) * progress)) / RATE;
    let value = 0;
    for (let h = 0; h < weights.length; h++) value += (weights[h] ?? 0) * Math.sin((h + 1) * phase);
    const envelope = Math.min(1, i / attack, (count - i) / release);
    out[start + i] = (out[start + i] ?? 0) + value * envelope * level * 0.2;
  }
  // Every third syllable or so opens with a short consonant burst.
  if (next() < 0.4) {
    const burst = samples(0.022);
    let last = 0;
    for (let i = 0; i < burst && start + i < out.length; i++) {
      const noise = next() * 2 - 1;
      out[start + i] = (out[start + i] ?? 0) + (noise - last) * 0.12 * (1 - i / burst);
      last = noise;
    }
  }
}

/** Where one spoken word sits in its recording, in seconds. `end` runs to the next word. */
export interface WordSpan {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Speaks `text` as syllable bursts: one per three letters of each word, with a longer rest
 * after punctuation. Returns the samples and where each word sits in them.
 */
export function speak(text: string, voice: Voice): { pcm: Float32Array; words: WordSpan[] } {
  const next = random(voice.seed);
  const pace = voice.pace ?? 0.17;
  const tokens = text.split(/\s+/).filter(Boolean);
  const plan: { text: string; start: number; syllables: number[] }[] = [];
  let at = 0.08;
  for (const token of tokens) {
    const letters = token.replace(/[^\p{L}\p{N}]/gu, "").length;
    const count = Math.max(1, Math.round(letters / 3));
    const lengths: number[] = [];
    for (let i = 0; i < count; i++) lengths.push(pace * (0.8 + next() * 0.45));
    plan.push({ text: token, start: at, syllables: lengths });
    at += lengths.reduce((sum, value) => sum + value, 0);
    at += /[.?!]$/.test(token) ? 0.34 + next() * 0.12 : /[,;:—]$/.test(token) ? 0.2 : 0.045;
  }
  const pcm = new Float32Array(samples(at + 0.06));
  const words: WordSpan[] = [];
  plan.forEach((word, index) => {
    let cursor = word.start;
    // A falling contour over the sentence, lifted a little on each word's first syllable.
    const declination = 1.06 - 0.12 * (index / Math.max(1, plan.length - 1));
    word.syllables.forEach((length, s) => {
      const f0 = voice.pitch * declination * (s === 0 ? 1.05 : 1) * (0.96 + next() * 0.08);
      syllable(pcm, cursor, length * 0.92, f0, next);
      cursor += length;
    });
    words.push({ text: word.text, start: word.start, end: plan[index + 1]?.start ?? at });
  });
  return { pcm, words };
}

const FILLER =
  "so we have been walking over the ridge since morning, and nobody on this side has seen it yet. " +
  "listen, if the weather turns again we go back down, all of us. that was the plan from the start.";

/** `seconds` of running speech in a voice, for lines whose words do not matter. */
export function babble(seconds: number, voice: Voice): Float32Array {
  const out = new Float32Array(samples(seconds));
  let at = 0;
  let round = 0;
  while (at < seconds) {
    const { pcm } = speak(FILLER, { ...voice, seed: voice.seed + round * 97 });
    mixInto(out, pcm, at);
    at += pcm.length / RATE;
    round++;
  }
  return out;
}

// ------------------------------------------------------------------- music

export interface Note {
  /** Start, in beats from the top of the part. */
  readonly beat: number;
  /** Length in beats. */
  readonly beats: number;
  readonly hz: number;
}

/** Equal-tempered pitch: `midi(69)` is 440 Hz. */
export const midi = (note: number): number => 440 * 2 ** ((note - 69) / 12);

/** A round bass: a sine and its octave, plucked. */
export function bass(notes: readonly Note[], beat: number, seconds: number): Float32Array {
  const out = new Float32Array(samples(seconds));
  for (const note of notes) {
    const start = samples(note.beat * beat);
    const count = samples(note.beats * beat);
    for (let i = 0; i < count && start + i < out.length; i++) {
      const t = i / RATE;
      const envelope = Math.min(1, i / 60) * Math.exp(-t * 2.4) * Math.min(1, (count - i) / 300);
      const value = Math.sin(TAU * note.hz * t) + 0.35 * Math.sin(TAU * note.hz * 2 * t);
      out[start + i] = (out[start + i] ?? 0) + Math.tanh(value * 1.4) * envelope * 0.42;
    }
  }
  return out;
}

/** An electric piano: struck partials that ring out. */
export function keys(notes: readonly Note[], beat: number, seconds: number): Float32Array {
  const out = new Float32Array(samples(seconds));
  for (const note of notes) {
    const start = samples(note.beat * beat);
    const count = samples(note.beats * beat + 0.25);
    for (let i = 0; i < count && start + i < out.length; i++) {
      const t = i / RATE;
      const envelope = Math.min(1, i / 40) * Math.exp(-t * 1.9) * Math.min(1, (count - i) / 900);
      const bell = 0.3 * Math.exp(-t * 9) * Math.sin(TAU * note.hz * 4 * t);
      const value = Math.sin(TAU * note.hz * t) + 0.22 * Math.sin(TAU * note.hz * 2 * t) + bell;
      out[start + i] = (out[start + i] ?? 0) + value * envelope * 0.13;
    }
  }
  return out;
}

/** A soft sustained pad, one slow swell per note. */
export function pad(notes: readonly Note[], beat: number, seconds: number): Float32Array {
  const out = new Float32Array(samples(seconds));
  for (const note of notes) {
    const start = samples(note.beat * beat);
    const count = samples(note.beats * beat);
    const swell = samples(Math.min(0.9, (note.beats * beat) / 3));
    for (let i = 0; i < count && start + i < out.length; i++) {
      const t = i / RATE;
      const envelope = Math.min(1, i / swell, (count - i) / swell);
      const value =
        Math.sin(TAU * note.hz * t) +
        0.5 * Math.sin(TAU * note.hz * 1.004 * t) +
        0.18 * Math.sin(TAU * note.hz * 2 * t);
      out[start + i] = (out[start + i] ?? 0) + value * envelope * 0.055;
    }
  }
  return out;
}

export interface Singer {
  readonly seed: number;
  /** Vibrato depth as a fraction of pitch. */
  readonly vibrato: number;
  /** How far, in seconds, the singer lands off the beat. */
  readonly looseness: number;
  readonly level: number;
}

/** A sung line: a voiced tone on an open vowel, with vibrato and a scoop into each note. */
export function sing(
  notes: readonly Note[],
  beat: number,
  seconds: number,
  singer: Singer,
): Float32Array {
  const next = random(singer.seed);
  const out = new Float32Array(samples(seconds));
  for (const note of notes) {
    const late = (next() - 0.35) * singer.looseness;
    const start = samples(Math.max(0, note.beat * beat + late));
    const count = samples(note.beats * beat * (0.86 + next() * 0.1));
    const dynamics = singer.level * (0.8 + next() * 0.35);
    const weights: number[] = [];
    for (let h = 1; h <= 8; h++) {
      const f = h * note.hz;
      const a = Math.exp(-(((f - 700) / 300) ** 2)) + 0.5 * Math.exp(-(((f - 1150) / 420) ** 2));
      weights.push((a + 0.08) / h ** 0.4);
    }
    let phase = 0;
    for (let i = 0; i < count && start + i < out.length; i++) {
      const t = i / RATE;
      const scoop = 1 - 0.035 * Math.exp(-t * 28);
      const wobble = 1 + singer.vibrato * Math.min(1, t * 3) * Math.sin(TAU * 5.4 * t);
      phase += (TAU * note.hz * scoop * wobble) / RATE;
      let value = 0;
      for (let h = 0; h < weights.length; h++) {
        value += (weights[h] ?? 0) * Math.sin((h + 1) * phase);
      }
      const envelope = Math.min(1, i / 700, (count - i) / 1500);
      out[start + i] = (out[start + i] ?? 0) + value * envelope * dynamics * 0.17;
    }
  }
  return out;
}

/** One drum hit per step of a pattern string: `k` kick, `s` snare, `h` hat, `.` rest. */
export function drums(pattern: readonly string[], step: number, seed: number): Float32Array {
  const next = random(seed);
  const steps = Math.max(...pattern.map((line) => line.length));
  const out = new Float32Array(samples(steps * step));
  for (const line of pattern) {
    for (let index = 0; index < line.length; index++) {
      const hit = line[index];
      const start = samples(index * step);
      if (hit === "k") {
        const count = samples(0.22);
        let phase = 0;
        for (let i = 0; i < count && start + i < out.length; i++) {
          const t = i / RATE;
          phase += (TAU * (46 + 95 * Math.exp(-t * 34))) / RATE;
          out[start + i] = (out[start + i] ?? 0) + Math.sin(phase) * Math.exp(-t * 15) * 0.62;
        }
      } else if (hit === "s") {
        const count = samples(0.17);
        for (let i = 0; i < count && start + i < out.length; i++) {
          const t = i / RATE;
          const body = Math.sin(TAU * 196 * t) * Math.exp(-t * 30) * 0.3;
          const snap = (next() * 2 - 1) * Math.exp(-t * 24) * 0.34;
          out[start + i] = (out[start + i] ?? 0) + body + snap;
        }
      } else if (hit === "h" || hit === "H") {
        const count = samples(hit === "H" ? 0.11 : 0.035);
        let last = 0;
        for (let i = 0; i < count && start + i < out.length; i++) {
          const noise = next() * 2 - 1;
          const decay = Math.exp((-i / count) * 5);
          out[start + i] = (out[start + i] ?? 0) + (noise - last) * decay * 0.11;
          last = noise;
        }
      }
    }
  }
  return out;
}

/** Slow filtered noise, like surf or room tone. */
export function ambience(seconds: number, seed: number, period = 5.5): Float32Array {
  const next = random(seed);
  const out = new Float32Array(samples(seconds));
  let low = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    low += (next() * 2 - 1 - low) * 0.06;
    const swell = 0.35 + 0.65 * Math.sin((Math.PI * (t % period)) / period) ** 2;
    out[i] = low * swell * 0.5;
  }
  return out;
}
