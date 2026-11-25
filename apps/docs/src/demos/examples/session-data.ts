// The project behind the music session example: twelve bars at 100 BPM, with a rhythm section,
// a lead vocal recorded in several takes and a harmony part.
import type { Project } from "@lumen-timeline/core";
import { bass, drums, keys, midi, type Note, sing } from "./synth.ts";
import { sec } from "./shared.tsx";

export const BPM = 100;
export const BEAT = 60 / BPM;
export const BAR = BEAT * 4;
export const BARS = 12;

/** The tick at the top of a bar, counted from 1. */
export const barTick = (bar: number): number => sec((bar - 1) * BAR);

const n = (beat: number, beats: number, note: number): Note => ({ beat, beats, hz: midi(note) });

// Am – F – C – G, one bar each.
const ROOTS = [45, 41, 48, 43];
const CHORDS = [
  [57, 60, 64],
  [57, 60, 65],
  [55, 60, 64],
  [55, 59, 62],
];

const VERSE: Note[] = [
  n(0, 1, 64),
  n(1, 0.5, 64),
  n(1.5, 0.5, 62),
  n(2, 1.5, 60),
  n(4, 1, 57),
  n(5, 1, 60),
  n(6, 1.5, 62),
  n(8, 1, 64),
  n(9, 1, 67),
  n(10, 1.5, 64),
  n(12, 1.5, 62),
  n(13.5, 2, 59),
];
const CHORUS: Note[] = [
  n(0, 1.5, 69),
  n(1.5, 0.5, 67),
  n(2, 2, 64),
  n(4, 1, 65),
  n(5, 1, 69),
  n(6, 2, 72),
  n(8, 1.5, 67),
  n(9.5, 0.5, 64),
  n(10, 2, 60),
  n(12, 1, 62),
  n(13, 1, 64),
  n(14, 1.5, 62),
];
const HARMONY: Note[] = [n(0, 3.8, 64), n(4, 3.8, 65), n(8, 3.8, 64), n(12, 3.5, 59)];

export function createSessionAssets(): Map<string, Float32Array> {
  const assets = new Map<string, Float32Array>();
  const total = BARS * BAR;
  const step = BEAT / 4;

  const kick: string[] = [];
  const snare: string[] = [];
  const hat: string[] = [];
  for (let bar = 0; bar < BARS; bar++) {
    const part = bar < 4 ? 0 : bar < 8 ? 1 : 2;
    kick.push(["k...............", "k.....k.k.......", "k..k..k.k..k..k."][part] ?? "");
    snare.push(["................", "....s.......s...", "....s.......s..s"][part] ?? "");
    hat.push(["h...h...h...h.h.", "h.h.h.h.h.h.h.H.", "hhhhhhhhhhhhhhHh"][part] ?? "");
  }
  assets.set("drums", drums([kick.join(""), snare.join(""), hat.join("")], step, 3));

  const low: Note[] = [];
  const chords: Note[] = [];
  for (let bar = 0; bar < BARS; bar++) {
    const root = ROOTS[bar % 4] ?? 45;
    const at = bar * 4;
    if (bar < 4) low.push(n(at, 3.5, root - 12));
    else if (bar < 8) {
      low.push(n(at, 1.25, root - 12), n(at + 1.5, 0.5, root - 12));
      low.push(n(at + 2, 1.25, root - 12), n(at + 3.5, 0.5, root - 5));
    } else {
      for (let eighth = 0; eighth < 8; eighth++) {
        low.push(n(at + eighth / 2, 0.45, eighth === 7 ? root - 5 : root - 12));
      }
    }
    for (const note of CHORDS[bar % 4] ?? []) {
      chords.push(n(at, 2.3, note), n(at + 2.5, 1.4, note));
    }
  }
  assets.set("bass", bass(low, BEAT, total));
  assets.set("keys", keys(chords, BEAT, total));

  const phrase = 4 * BAR + 0.4;
  assets.set(
    "verse-1",
    sing(VERSE, BEAT, phrase, { seed: 5, vibrato: 0.006, looseness: 0.09, level: 0.9 }),
  );
  assets.set(
    "verse-2",
    sing(VERSE, BEAT, phrase, { seed: 9, vibrato: 0.012, looseness: 0.02, level: 1 }),
  );
  assets.set(
    "verse-3",
    sing(VERSE, BEAT, phrase, { seed: 14, vibrato: 0.02, looseness: 0.04, level: 0.7 }),
  );
  assets.set(
    "chorus-1",
    sing(CHORUS, BEAT, phrase, { seed: 21, vibrato: 0.014, looseness: 0.03, level: 1.05 }),
  );
  assets.set(
    "chorus-2",
    sing(CHORUS, BEAT, phrase, { seed: 27, vibrato: 0.008, looseness: 0.07, level: 0.85 }),
  );
  assets.set(
    "harmony",
    sing(HARMONY, BEAT, phrase, { seed: 33, vibrato: 0.01, looseness: 0.02, level: 0.6 }),
  );
  return assets;
}

export function createSessionProject(): Project {
  const section = (
    id: string,
    name: string,
    track: string,
    asset: string,
    bar: number,
    bars: number,
  ) => ({
    id,
    name,
    trackId: track,
    kind: "audio",
    start: barTick(bar),
    duration: sec(bars * BAR),
    contentIn: 0,
    source: { assetId: asset, streamId: "mono", sourceAtContentZero: barTick(bar) },
  });
  const take = (id: string, label: string, asset: string) => ({
    id,
    label,
    assetId: asset,
    streamId: "mono",
    sourceAtContentZero: 0,
  });
  const four = sec(4 * BAR);
  return {
    schemaVersion: 2,
    duration: sec((BARS + 1) * BAR),
    tracks: [
      { id: "lead", name: "Lead vox", overlap: "exclusive", gain: 1 },
      { id: "harmony", name: "Harmony", gain: 0.7 },
      { id: "keys", name: "Rhodes", gain: 0.7 },
      { id: "bass", name: "Bass", gain: 0.8 },
      { id: "drums", name: "Drums", gain: 0.6 },
    ],
    clips: [
      {
        id: "vox-verse",
        name: "Verse",
        trackId: "lead",
        kind: "audio",
        start: barTick(5),
        duration: four,
        contentIn: 0,
        takeIds: ["verse-t1", "verse-t2", "verse-t3"],
        activeTakeId: "verse-t2",
      },
      {
        id: "vox-chorus",
        name: "Chorus",
        trackId: "lead",
        kind: "audio",
        start: barTick(9),
        duration: four,
        contentIn: 0,
        takeIds: ["chorus-t1", "chorus-t2"],
        activeTakeId: "chorus-t1",
      },
      {
        id: "harmony-chorus",
        name: "Chorus stack",
        trackId: "harmony",
        kind: "audio",
        start: barTick(9),
        duration: four,
        contentIn: 0,
        source: { assetId: "harmony", streamId: "mono", sourceAtContentZero: 0 },
      },
      section("keys-a", "Rhodes", "keys", "keys", 1, 8),
      section("keys-b", "Rhodes · chorus", "keys", "keys", 9, 4),
      section("bass-a", "Long notes", "bass", "bass", 1, 4),
      section("bass-b", "Verse line", "bass", "bass", 5, 4),
      section("bass-c", "Eighths", "bass", "bass", 9, 4),
      section("drums-a", "Hats", "drums", "drums", 1, 4),
      section("drums-b", "Verse groove", "drums", "drums", 5, 4),
      section("drums-c", "Chorus groove", "drums", "drums", 9, 4),
    ],
    takes: [
      take("verse-t1", "Take 1", "verse-1"),
      take("verse-t2", "Take 2", "verse-2"),
      take("verse-t3", "Take 3", "verse-3"),
      take("chorus-t1", "Take 1", "chorus-1"),
      take("chorus-t2", "Take 2", "chorus-2"),
    ],
    markers: [
      { id: "intro", start: barTick(1), duration: four, label: "Intro", color: "#8493a8" },
      { id: "verse", start: barTick(5), duration: four, label: "Verse", color: "#5aa9e6" },
      { id: "chorus", start: barTick(9), duration: four, label: "Chorus", color: "#e6a23c" },
    ],
  };
}
