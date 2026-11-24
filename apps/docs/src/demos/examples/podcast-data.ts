// The project behind the podcast editor example: seven spoken paragraphs by two speakers, each a
// recording whose word timings are known, so the transcript can be edited as text. A paragraph
// recorded in `voices.ts` is loaded with its word timings; one that is not is synthesized.
import type { Project } from "@lumen-timeline/core";
import { DEMO_SAMPLE_RATE } from "../fixtures.ts";
import { paragraphId, POD_SCRIPT, ROLES } from "./script.ts";
import { loadRecordings, sec, VOICE_SAMPLE_RATE } from "./shared.tsx";
import { fade, keys, midi, mixInto, type Note, pad, speak, type WordSpan } from "./synth.ts";
import { VOICES } from "./voices.ts";

export interface Speaker {
  readonly track: string;
  readonly name: string;
}

/** The speakers, by the track each is on. */
export const SPEAKERS: Readonly<Record<string, Speaker>> = {
  host: { track: "host", name: ROLES["noor"]?.name ?? "Host" },
  guest: { track: "guest", name: ROLES["tomas"]?.name ?? "Guest" },
};
const TRACK_OF: Readonly<Record<string, string>> = { noor: "host", tomas: "guest" };

export interface Word extends WordSpan {
  readonly filler: boolean;
}

export interface Paragraph {
  /** The asset and clip ID of the recording. */
  readonly id: string;
  readonly speaker: string;
  readonly words: readonly Word[];
  /** Length of the recording in seconds. */
  readonly length: number;
  /** Silence left after it in the first cut, in seconds. */
  readonly gap: number;
}

const STAND_INS = {
  host: { pitch: ROLES["noor"]?.pitch ?? 198, pace: 0.16 },
  guest: { pitch: ROLES["tomas"]?.pitch ?? 121, pace: 0.172 },
} as const;

const INTRO = 3.2;

export interface Episode {
  readonly assets: Map<string, Float32Array>;
  /** The assets that are recordings, at the recordings' sample rate. */
  readonly recorded: Set<string>;
  readonly paragraphs: ReadonlyMap<string, Paragraph>;
  readonly project: Project;
}

export async function loadEpisode(): Promise<Episode> {
  const loaded = await loadRecordings(
    POD_SCRIPT.map((item) => paragraphId(item.id)).filter((id) => VOICES[id]?.words),
  );
  const recorded = new Set<string>();
  const assets = new Map<string, Float32Array>();
  const paragraphs = new Map<string, Paragraph>();
  const clips: Project["clips"][number][] = [];
  const starts: number[] = [];
  let at = INTRO;

  POD_SCRIPT.forEach(({ id, speaker: role, text: script, gap }, index) => {
    const speaker = TRACK_OF[role] ?? "host";
    const flags: boolean[] = [];
    let inside = false;
    for (const token of script.split(/\s+/)) {
      if (token.startsWith("{")) inside = true;
      flags.push(inside);
      if (token.endsWith("}")) inside = false;
    }
    const plain = script.replace(/[{}]/g, "");
    const tokens = plain.split(/\s+/);
    const clip = VOICES[paragraphId(id)];
    const pcm = loaded.get(paragraphId(id));
    let words: WordSpan[];
    let length: number;
    if (clip?.words?.length === tokens.length && pcm) {
      // A word runs to the start of the next one, so a cut takes the breath after it too.
      const timed = clip.words;
      words = tokens.map((text, i) => ({
        text,
        start: i === 0 ? 0 : (timed[i]?.[0] ?? 0),
        end: timed[i + 1]?.[0] ?? pcm.length / VOICE_SAMPLE_RATE,
      }));
      length = pcm.length / VOICE_SAMPLE_RATE;
      assets.set(id, pcm);
      recorded.add(id);
    } else {
      const stand = speaker === "host" ? STAND_INS.host : STAND_INS.guest;
      const synthesized = speak(plain, { ...stand, seed: 700 + index * 13 });
      words = synthesized.words;
      length = synthesized.pcm.length / DEMO_SAMPLE_RATE;
      assets.set(id, synthesized.pcm);
    }
    paragraphs.set(id, {
      id,
      speaker,
      words: words.map((word, i) => ({ ...word, filler: flags[i] === true })),
      length,
      gap,
    });
    starts.push(at);
    clips.push({
      id,
      name: id,
      trackId: speaker,
      kind: "audio",
      start: sec(at),
      duration: sec(length),
      contentIn: 0,
      source: { assetId: id, streamId: "mono", sourceAtContentZero: 0 },
    });
    at += length + gap;
  });

  // One six-second theme, used as the intro and again under the sign-off.
  const chords: Note[] = [];
  const voicings = [
    [57, 60, 64, 69],
    [55, 60, 64, 67],
    [53, 57, 60, 65],
  ];
  voicings.forEach((voicing, bar) => {
    for (const note of voicing) {
      chords.push({ beat: bar * 4, beats: 2.5, hz: midi(note) });
      chords.push({ beat: bar * 4 + 2.5, beats: 1.5, hz: midi(note + (bar === 2 ? 0 : 12)) });
    }
  });
  const theme = keys(chords, 0.5, 6);
  mixInto(theme, pad([{ beat: 0, beats: 12, hz: midi(45) }], 0.5, 6), 0, 1.6);
  assets.set("theme", fade(theme, 0.02, 2.4));

  const end = at;
  clips.push(
    {
      id: "theme-in",
      name: "Theme",
      trackId: "music",
      kind: "audio",
      start: 0,
      duration: sec(6),
      contentIn: 0,
      source: { assetId: "theme", streamId: "mono", sourceAtContentZero: 0 },
    },
    {
      id: "theme-out",
      name: "Theme · out",
      trackId: "music",
      kind: "audio",
      start: sec(end - 1.2),
      duration: sec(6),
      contentIn: 0,
      source: { assetId: "theme", streamId: "mono", sourceAtContentZero: 0 },
    },
  );

  return {
    assets,
    recorded,
    paragraphs,
    project: {
      schemaVersion: 1,
      duration: sec(Math.ceil(end + 5)),
      tracks: [
        { id: "host", name: SPEAKERS["host"]?.name ?? "Host", overlap: "exclusive" },
        { id: "guest", name: SPEAKERS["guest"]?.name ?? "Guest", overlap: "exclusive" },
        { id: "music", name: "Music", gain: 0.32 },
      ],
      clips,
      markers: [
        { id: "ch-1", start: 0, label: "Cold open" },
        { id: "ch-2", start: sec(starts[2] ?? 0), label: "What we're hearing" },
        { id: "ch-3", start: sec(starts[4] ?? 0), label: "Why it matters" },
      ],
    },
  };
}
