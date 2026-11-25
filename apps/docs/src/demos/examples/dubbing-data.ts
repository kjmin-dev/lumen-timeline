// The project behind the dubbing studio example: nine lines of an original scene, each with a
// source recording, a translation per target language and three voice takes. The recordings
// named in `voices.ts` are loaded; a line without one is synthesized as a stand-in.
//
// The picture is cut to the original, so each line has a slot: the time until the next line
// begins. Whether a dub fits its slot is measured from the timeline, never stored.
import type { JsonValue, Project } from "@lumen-timeline/core";
import { DEMO_SAMPLE_RATE } from "../fixtures.ts";
import { DUB_SCRIPT, type Lang, originalId, ROLES, type ScriptLine, takeId } from "./script.ts";
import { loadRecordings, sec, VOICE_SAMPLE_RATE } from "./shared.tsx";
import { ambience, babble, type Note, midi, mixInto, pad, speak } from "./synth.ts";
import { VOICES } from "./voices.ts";

export type { Lang } from "./script.ts";

/** What the language switch shows: the original as shot, or one of the dubs. */
export type View = "en" | Lang;

export interface Language<Id extends View = View> {
  readonly id: Id;
  readonly label: string;
  readonly code: string;
}

/** The language the scene was shot in. Its view plays the original, with nothing to dub. */
export const ORIGINAL: Language<"en"> = { id: "en", label: "English", code: "EN" };

export const LANGS: readonly Language<Lang>[] = [
  { id: "ko", label: "한국어", code: "KO" },
  { id: "ja", label: "日本語", code: "JA" },
  { id: "es", label: "Español", code: "ES" },
  { id: "fr", label: "Français", code: "FR" },
];

export const SPEAKERS = ROLES;

/**
 * The dub is cut on one track per speaker, as a dialogue editor lays it out: each voice is
 * mixed and muted on its own, and a line that runs long overlaps the next speaker's track
 * instead of stacking under its own.
 */
export const DUB_SPEAKERS = ["mara", "ivo", "oda"] as const;
export const dubTrackOf = (speaker: string): string => `dub-${speaker}`;
export const DUB_TRACK_IDS: readonly string[] = DUB_SPEAKERS.map(dubTrackOf);
export const isDubTrack = (trackId: string): boolean => DUB_TRACK_IDS.includes(trackId);
// One header color per speaker, readable on both schemes; the clips are colored by `clipStyle`.
const TRACK_COLORS: Readonly<Record<(typeof DUB_SPEAKERS)[number], string>> = {
  mara: "#e8894a",
  ivo: "#4a9fd8",
  oda: "#9a85ea",
};
export const EMOTIONS = ["calm", "dry", "urgent", "panicked", "resolute", "relieved"] as const;

export interface Line extends ScriptLine {
  /** Where the source line sits in the scene and how long it runs, in seconds. */
  readonly start: number;
  readonly length: number;
}

/** A recording's length in seconds: the recorded one, or the stand-in's. */
export const secondsOf = (id: string, fallback: number): number => VOICES[id]?.seconds ?? fallback;

/** How long a dubbed take of a line runs, in seconds, given the length of its source line. */
function dubbedSeconds(lang: Lang, key: string, take: number, source: number): number {
  // The stand-ins differ a little in length, so the timing check has something to find.
  const first = { ko: 1.12, ja: 1.08, es: 1.14, fr: 1.1 }[lang];
  const stand = source * (take === 0 ? first : take === 1 ? 0.96 : 1.04);
  return secondsOf(takeId(lang, key, take), Math.round(stand * 100) / 100);
}

// Each line starts where the script puts it, or a breath after the original line before it is
// over. The radio call of line 05 is the exception: it begins under the laugh of line 04.
function layout(): Line[] {
  const lines: Line[] = [];
  let free = 0;
  for (const line of DUB_SCRIPT) {
    const length = secondsOf(originalId(line.key), line.length);
    const start = Math.round(Math.max(line.start, line.key === "05" ? 0 : free + 0.2) * 100) / 100;
    free = start + length;
    lines.push({ ...line, start, length });
  }
  return lines;
}

export const LINES: readonly Line[] = layout();
export const LINE_BY_KEY: ReadonlyMap<string, Line> = new Map(
  LINES.map((line) => [line.key, line]),
);

const last = LINES.at(-1);
export const SCENE_SECONDS = Math.ceil((last ? last.start + last.length : 28) + 2.4);

/**
 * How long a line may run, in seconds: until the next line begins, or until its own original
 * ends where the next line starts under it. The last line has until the scene ends.
 */
export function slotOf(key: string): number {
  const index = LINES.findIndex((line) => line.key === key);
  const line = LINES[index];
  if (!line) return 0;
  const next = LINES[index + 1];
  return Math.max(line.length, (next ? next.start : SCENE_SECONDS - 0.5) - line.start);
}

/** The line that follows a line in the scene, if any. */
export const lineAfter = (key: string): Line | undefined =>
  LINES[LINES.findIndex((line) => line.key === key) + 1];

/** A dub this far past its slot is still taken to fit, in seconds. */
export const SLOT_TOLERANCE = 0.1;

/** When the scene on the monitor reaches each beat of the script, in seconds. */
export const CUES = {
  boat: (LINE_BY_KEY.get("05")?.start ?? 10.9) - 1.4,
  lit: (LINE_BY_KEY.get("06")?.start ?? 14.9) + 1.3,
  stuck: LINE_BY_KEY.get("07")?.start ?? 18.3,
  turning: (LINE_BY_KEY.get("08")?.start ?? 21) + 1.6,
} as const;

/** How long a dubbed take of a line runs, in seconds. */
export const takeSeconds = (lang: Lang, line: Line, take: number): number =>
  dubbedSeconds(lang, line.key, take, line.length);

const spoken = (line: Line): boolean => line.kept !== true;

export interface DubAssets {
  readonly assets: Map<string, Float32Array>;
  /** The assets that are recordings, at the recordings' sample rate. */
  readonly recorded: Set<string>;
}

function resample(pcm: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return pcm;
  const out = new Float32Array(Math.round((pcm.length * to) / from));
  const step = from / to;
  for (let i = 0; i < out.length; i++) {
    const at = i * step;
    const index = Math.floor(at);
    const a = pcm[index] ?? 0;
    out[i] = a + ((pcm[index + 1] ?? a) - a) * (at - index);
  }
  return out;
}

export async function loadDubAssets(): Promise<DubAssets> {
  const wanted: string[] = [];
  for (const line of LINES) {
    wanted.push(originalId(line.key));
    if (!spoken(line)) continue;
    for (const { id: lang } of LANGS)
      for (const take of [0, 1, 2]) wanted.push(takeId(lang, line.key, take));
  }
  const loaded = await loadRecordings(wanted.filter((id) => VOICES[id]));
  const assets = new Map<string, Float32Array>();
  const recorded = new Set<string>(["dx"]);

  // DX: every source line where it falls in the scene, as one stem.
  const dx = new Float32Array(SCENE_SECONDS * VOICE_SAMPLE_RATE);
  LINES.forEach((line, index) => {
    const role = ROLES[line.speaker];
    if (!role) return;
    let pcm = loaded.get(originalId(line.key));
    if (!pcm) {
      const stand = spoken(line)
        ? babble(line.length, { pitch: role.pitch, seed: 300 + index * 11 })
        : speak("ha ha ha ha, ha ha", {
            pitch: role.pitch * 1.35,
            seed: 41,
            pace: 0.11,
          }).pcm.subarray(0, Math.round(line.length * DEMO_SAMPLE_RATE));
      pcm = resample(stand, DEMO_SAMPLE_RATE, VOICE_SAMPLE_RATE);
    }
    const offset = Math.round(line.start * VOICE_SAMPLE_RATE);
    for (let i = 0; i < pcm.length && offset + i < dx.length; i++) {
      dx[offset + i] = (dx[offset + i] ?? 0) + (pcm[i] ?? 0);
    }
  });
  assets.set("dx", dx);

  // M&E: surf, a low drone and one foghorn as the radio call begins.
  const me = ambience(SCENE_SECONDS, 9, 6.2);
  const third = SCENE_SECONDS / 3;
  const drone: Note[] = [
    { beat: 0, beats: third, hz: midi(38) },
    { beat: 0, beats: third, hz: midi(45) },
    { beat: third, beats: third, hz: midi(36) },
    { beat: third, beats: third, hz: midi(43) },
    { beat: third * 2, beats: third, hz: midi(41) },
    { beat: third * 2, beats: third, hz: midi(48) },
    { beat: third * 2, beats: third, hz: midi(57) },
  ];
  mixInto(me, pad(drone, 1, SCENE_SECONDS), 0, 1.5);
  mixInto(me, pad([{ beat: 0, beats: 1.8, hz: 87 }], 1, 2), CUES.boat + 2.9, 3.2);
  assets.set("me", me);

  LINES.forEach((line, index) => {
    const role = ROLES[line.speaker];
    if (!role || !spoken(line)) return;
    for (const { id: lang } of LANGS) {
      for (const take of [0, 1, 2]) {
        const id = takeId(lang, line.key, take);
        const pcm = loaded.get(id);
        if (pcm) {
          assets.set(id, pcm);
          recorded.add(id);
          continue;
        }
        const order = LANGS.findIndex((item) => item.id === lang);
        const pitch = role.pitch * (0.97 + order * 0.02) * (1 + take * 0.03);
        const seed = role.pitch * 7 + index * 31 + take * 5 + order * 50 + 1;
        assets.set(
          id,
          babble(takeSeconds(lang, line, take), { pitch, seed, pace: 0.17 - take * 0.008 }),
        );
      }
    }
  });
  return { assets, recorded };
}

/**
 * The project for one view of the scene. A dub has the original dialogue muted under its own
 * DUB track; the original view plays the dialogue as shot and has nothing to dub.
 */
export function createDubProject(view: View): Project {
  const data: Record<string, Record<string, JsonValue>> = {};
  const clips: Project["clips"][number][] = [];
  const takes: NonNullable<Project["takes"]>[number][] = [];
  LINES.forEach((line, index) => {
    // The original stem is one recording, so a line that runs under the next ends where it starts.
    const next = LINES[index + 1];
    const heard = Math.min(line.length, (next?.start ?? SCENE_SECONDS) - line.start);
    // Every clip of a line plays a take, even one with a single candidate: a take is what the
    // transport can audition on its own.
    const original = (id: string) => ({
      id,
      label: "original",
      assetId: "dx",
      streamId: "mono",
      sourceAtContentZero: sec(line.start),
    });
    takes.push(original(`${line.key}-dx`));
    clips.push({
      id: `dx-${line.key}`,
      name: line.key,
      trackId: "dx",
      kind: "audio",
      start: sec(line.start),
      duration: sec(heard),
      contentIn: 0,
      takeIds: [`${line.key}-dx`],
      activeTakeId: `${line.key}-dx`,
    });
    if (view === "en") return;
    const lang = view;
    if (line.kept) {
      // The laugh is not dubbed: the dub track plays the original recording.
      data[line.key] = { text: line.text[lang], emotion: line.emotion };
      takes.push(original(`${line.key}-kept`));
      clips.push({
        id: `dub-${line.key}`,
        name: line.key,
        trackId: dubTrackOf(line.speaker),
        kind: "audio",
        start: sec(line.start),
        duration: sec(line.length),
        contentIn: 0,
        takeIds: [`${line.key}-kept`],
        activeTakeId: `${line.key}-kept`,
      });
      return;
    }
    for (const take of [0, 1]) {
      takes.push({
        id: `${line.key}-${take}`,
        label: `v${take + 1}`,
        assetId: takeId(lang, line.key, take),
        streamId: "mono",
        sourceAtContentZero: 0,
      });
    }
    clips.push({
      id: `dub-${line.key}`,
      name: line.key,
      trackId: dubTrackOf(line.speaker),
      kind: "audio",
      start: sec(line.start),
      duration: sec(takeSeconds(lang, line, 0)),
      contentIn: 0,
      takeIds: [`${line.key}-0`, `${line.key}-1`],
      activeTakeId: `${line.key}-0`,
    });
    const text = line.text[lang];
    // `voiced` is the words the voice was generated from.
    data[line.key] = { text, voiced: text, emotion: line.emotion };
  });
  clips.push({
    id: "me-bed",
    name: "Sea · foghorn · score",
    trackId: "me",
    kind: "audio",
    start: 0,
    duration: sec(SCENE_SECONDS),
    contentIn: 0,
    source: { assetId: "me", streamId: "mono", sourceAtContentZero: 0 },
  });
  return {
    schemaVersion: 2,
    duration: sec(SCENE_SECONDS),
    // Levels that leave the mix headroom where two voices and the bed overlap.
    tracks:
      view === "en"
        ? [
            { id: "dx", name: "DX", locked: true, gain: 0.72 },
            { id: "me", name: "M&E", locked: true, gain: 0.5 },
          ]
        : [
            { id: "dx", name: "DX", locked: true, mute: true, gain: 0.72 },
            { id: "me", name: "M&E", locked: true, gain: 0.5 },
            ...DUB_SPEAKERS.map((speaker) => ({
              id: dubTrackOf(speaker),
              name: ROLES[speaker]?.short ?? ROLES[speaker]?.name ?? speaker,
              color: TRACK_COLORS[speaker],
              gain: 0.72,
            })),
          ],
    clips,
    takes,
    markers: [
      { id: "shot-11", start: 0, label: "Shot 11" },
      { id: "shot-12", start: sec(LINE_BY_KEY.get("05")?.start ?? 10.9), label: "Shot 12 · radio" },
      { id: "shot-13", start: sec(LINE_BY_KEY.get("07")?.start ?? 18.3), label: "Shot 13" },
    ],
    entityData: { line: data },
  };
}
