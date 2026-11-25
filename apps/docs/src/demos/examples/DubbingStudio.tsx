// Example screen 1: an AI dubbing studio. A preview monitor and a dialogue list sit over one
// timeline with the DX and M&E stems and one dub track per speaker. The language switch opens
// each dub, or the original as shot, which plays the DX row and has nothing to edit.
//
// While the scene plays, the line being spoken becomes the active one: its clip is selected on
// the timeline, and the list scrolls it into place and fills a bar under it as it is spoken.
// A line's play button auditions it alone, through the transport: just that voice, without the
// bed or the lines around it, while the rest of the screen stays where it is.
//
// What a row says about a line is measured from the timeline, not stored: how far its dub runs
// past the slot the picture leaves it, and whether its voice still says its words. Translations
// live in the project's entity data, so each edit is undoable.
import {
  commands,
  TICKS_PER_SECOND as hz,
  type Clip,
  type ProjectSnapshot,
  type Tick,
} from "@lumen-timeline/core";
import { Timeline, useEditorSelector, useTransportSelector } from "@lumen-timeline/react";
import type {
  ClipStyleFn,
  OverlayRenderer,
  TimelineChrome,
  TimelineEvents,
} from "@lumen-timeline/timeline";
import { type ReactElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DEMO_FONTS, type Scheme, useSiteScheme } from "../scheme.ts";
import {
  createDubProject,
  CUES,
  DUB_TRACK_IDS,
  EMOTIONS,
  isDubTrack,
  type Lang,
  LANGS,
  ORIGINAL,
  LINE_BY_KEY,
  lineAfter,
  loadDubAssets,
  SCENE_SECONDS,
  SLOT_TOLERANCE,
  slotOf,
  SPEAKERS,
  takeSeconds,
  type View,
} from "./dubbing-data.ts";
import { type Axis, createFollower, type Follower, scrollAxis, type Span } from "./follow.ts";
import { takeId } from "./script.ts";
import {
  clock,
  createExampleHost,
  createExampleSession,
  type ExampleHost,
  type ExampleSession,
  focusClip,
  HistoryButtons,
  Icon,
  Loading,
  PlayButton,
  Readout,
  sec,
  splitAtPlayhead,
  useClipsAtPlayhead,
  decibelWaveforms,
  usePlayhead,
  usePlaying,
  useTimelineView,
  ZoomButtons,
} from "./shared.tsx";

const BASE_ZOOM = 30;
const DX_TRACKS: readonly string[] = ["dx"];
const CHROME: TimelineChrome = {
  toolbar: false,
  editToolbar: false,
  markerEditor: false,
  status: false,
  // A line's voices are chosen in its editor, and the stems are heard through mute and solo.
  clipToolbar: false,
  takeLanes: false,
  trackReorder: false,
  trackRename: false,
};
// Tall enough that a clip's waveform, under its number, shows how loud the line is.
const LAYOUT = { laneHeight: 46, rowInset: 5 } as const;

// A dub clip is colored by who speaks, as the list is.
interface ClipColors {
  readonly fill: string;
  readonly stripe: string;
  readonly waveform: string;
}
const SPEAKER_COLORS: Readonly<Record<Scheme, Record<string, ClipColors>>> = {
  dark: {
    mara: { fill: "#f9a870", stripe: "#f9a870", waveform: "#6b3a14" },
    ivo: { fill: "#6cc4f5", stripe: "#6cc4f5", waveform: "#0f4263" },
    oda: { fill: "#c3aeff", stripe: "#c3aeff", waveform: "#40355e" },
  },
  light: {
    mara: { fill: "#fbe3d3", stripe: "#d9783a", waveform: "#e09460" },
    ivo: { fill: "#dcecf8", stripe: "#2f7fb8", waveform: "#6ba3cf" },
    oda: { fill: "#e9e4ff", stripe: "#7a66de", waveform: "#8b78e6" },
  },
};
const STEM_COLORS = {
  dark: {
    dx: { fill: "#2b3138", stripe: "#69727d", waveform: "#7d8792" },
    me: { fill: "#1d2f3d", stripe: "#5f9fcc", waveform: "#4b84ad" },
  },
  light: {
    dx: { fill: "#eceff0", stripe: "#8a999d", waveform: "#a3afb3" },
    me: { fill: "#e2eef7", stripe: "#3f82b5", waveform: "#6ba3cf" },
  },
} as const;
// The part of a dub that runs past its slot is hatched in this color on the timeline.
const OVERRUN = { dark: "#ff6a55", light: "#c7341b" } as const;

/** One line as the list shows it: what the project stores, and what is measured from it. */
interface LineView {
  readonly key: string;
  readonly clip: Clip;
  readonly text: string;
  readonly emotion: string;
  /** The original performance is kept: there is no dub. */
  readonly kept: boolean;
  /** Seconds the dub runs past its slot, or 0 while it fits. */
  readonly over: number;
  /** The words were edited after the voice was generated. */
  readonly stale: boolean;
}

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

/** Seconds a dub clip runs past the slot of its line. */
function overrun(clip: Clip): number {
  const line = LINE_BY_KEY.get(clip.name ?? "");
  if (!line) return 0;
  const over = (clip.start + clip.duration) / hz - (line.start + slotOf(line.key));
  return over > SLOT_TOLERANCE ? over : 0;
}

function lineView(snapshot: ProjectSnapshot, clip: Clip, key: string): LineView {
  const source = LINE_BY_KEY.get(key);
  // A clip of the original dialogue is the line as shot.
  if (clip.trackId === "dx") {
    const words = source?.source ?? "";
    return {
      key,
      clip,
      text: words,
      emotion: source?.emotion ?? "calm",
      kept: true,
      over: 0,
      stale: false,
    };
  }
  const fields = snapshot.entityData?.["line"]?.[key];
  const words = text(fields?.["text"]);
  const kept = source?.kept === true;
  return {
    key,
    clip,
    text: words,
    emotion: text(fields?.["emotion"], "calm"),
    kept,
    over: kept ? 0 : overrun(clip),
    stale: !kept && words !== text(fields?.["voiced"], words),
  };
}

/**
 * One row per line: the first clip on `trackIds` that carries the line's key, in scene order. A
 * dub lists its speakers' tracks; the original lists the DX row.
 */
function linesOf(snapshot: ProjectSnapshot, trackIds: readonly string[]): LineView[] {
  const seen = new Set<string>();
  const lines: LineView[] = [];
  const dubs = snapshot.clips
    .filter((clip) => trackIds.includes(clip.trackId))
    .sort((a, b) => a.start - b.start);
  for (const clip of dubs) {
    const key = clip.name ?? "";
    if (!LINE_BY_KEY.has(key) || seen.has(key)) continue;
    seen.add(key);
    lines.push(lineView(snapshot, clip, key));
  }
  return lines;
}

const setLine = (key: string, field: string, value: string) =>
  commands.setEntityData({ scope: "line", id: key, key: field, value });

function download(name: string, body: string, type: string): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function srtTime(tick: Tick): string {
  const ms = Math.round((tick / hz) * 1000);
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(
    Math.floor(ms / 1000) % 60,
  )},${pad(ms % 1000, 3)}`;
}

// ---------------------------------------------------------------- monitor

// The scene the monitor plays: a night sea, a boat and a lighthouse whose lamp follows the
// script. It is a function of time alone, so scrubbing shows the right frame.
function drawScene(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void {
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, "#050816");
  sky.addColorStop(0.6, "#12223c");
  sky.addColorStop(1, "#081220");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  for (let i = 0; i < 46; i++) {
    const x = ((i * 137.5) % 100) / 100;
    const y = ((i * 61.8) % 55) / 100;
    const twinkle = 0.35 + 0.3 * Math.sin(t * 1.3 + i * 2.1);
    ctx.fillStyle = `rgba(220,232,255,${twinkle})`;
    ctx.fillRect(x * w, y * h, i % 7 === 0 ? 1.6 : 1, i % 7 === 0 ? 1.6 : 1);
  }

  const horizon = h * 0.62;
  const lampX = w * 0.76;
  const lampY = h * 0.3;
  const lit = t >= CUES.lit;
  const turning = t >= CUES.turning;
  // The lens sticks as Ivo calls out, and shakes until two people turn it by hand.
  const stuck = lit && !turning && t >= CUES.stuck ? Math.sin(t * 46) * 0.018 : 0;
  const swing = turning ? Math.cos((t - CUES.turning) * 1.15) : 1;

  if (lit) {
    const reach = w * 0.95 * Math.abs(swing);
    const side = swing >= 0 ? -1 : 1;
    const spread = h * (0.1 + 0.05 * (1 - Math.abs(swing)));
    const tilt = h * (0.2 + stuck * 3);
    const beam = ctx.createLinearGradient(lampX, 0, lampX + side * reach, 0);
    beam.addColorStop(0, "rgba(255,236,170,0.62)");
    beam.addColorStop(1, "rgba(255,236,170,0)");
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(lampX, lampY);
    ctx.lineTo(lampX + side * reach, lampY + tilt - spread);
    ctx.lineTo(lampX + side * reach, lampY + tilt + spread);
    ctx.closePath();
    ctx.fill();
  }

  // Sea: contour lines that drift, brighter once the lamp is lit.
  for (let line = 0; line < 9; line++) {
    const depth = line / 8;
    const y0 = horizon + depth * depth * (h - horizon) * 0.96;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 6) {
      const y =
        y0 +
        Math.sin(x * (0.018 - depth * 0.008) + t * (0.9 + depth) + line * 1.7) * (2 + depth * 6) +
        Math.sin(x * 0.05 + t * 1.6 + line) * (0.6 + depth);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = lit
      ? `rgba(160,214,224,${0.16 + depth * 0.34})`
      : `rgba(110,150,190,${0.12 + depth * 0.26})`;
    ctx.lineWidth = 1 + depth * 0.8;
    ctx.stroke();
  }

  // The Heron comes in from the left as its captain calls on the radio.
  if (t >= CUES.boat) {
    const drift = Math.min(1, (t - CUES.boat) / 18);
    const bx = w * (0.06 + drift * 0.3);
    const by = horizon + h * 0.075 + Math.sin(t * 1.4) * 2.5;
    const s = w / 640;
    ctx.fillStyle = "#04070d";
    ctx.beginPath();
    ctx.moveTo(bx - 26 * s, by);
    ctx.lineTo(bx + 30 * s, by);
    ctx.lineTo(bx + 22 * s, by + 8 * s);
    ctx.lineTo(bx - 20 * s, by + 8 * s);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(bx - 6 * s, by - 11 * s, 14 * s, 11 * s);
    ctx.fillRect(bx, by - 24 * s, 1.5 * s, 13 * s);
    ctx.fillStyle = "#ff6b5a";
    ctx.fillRect(bx - 22 * s, by - 3 * s, 2.4 * s, 2.4 * s);
    ctx.fillStyle = "#6dffb0";
    ctx.fillRect(bx + 24 * s, by - 3 * s, 2.4 * s, 2.4 * s);
  }

  // Headland and tower.
  ctx.fillStyle = "#03060b";
  ctx.beginPath();
  ctx.moveTo(w, h);
  ctx.lineTo(w * 0.52, h);
  ctx.quadraticCurveTo(w * 0.62, horizon + h * 0.02, w * 0.7, horizon - h * 0.015);
  ctx.lineTo(w, horizon - h * 0.07);
  ctx.closePath();
  ctx.fill();
  const tw = w * 0.022;
  ctx.beginPath();
  ctx.moveTo(lampX - tw * 0.62, lampY + h * 0.035);
  ctx.lineTo(lampX + tw * 0.62, lampY + h * 0.035);
  ctx.lineTo(lampX + tw, horizon);
  ctx.lineTo(lampX - tw, horizon);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(lampX - tw * 0.85, lampY + h * 0.025, tw * 1.7, h * 0.012);
  ctx.fillRect(lampX - tw * 0.5, lampY - h * 0.03, tw, h * 0.06);
  ctx.beginPath();
  ctx.moveTo(lampX - tw * 0.7, lampY - h * 0.03);
  ctx.lineTo(lampX, lampY - h * 0.065);
  ctx.lineTo(lampX + tw * 0.7, lampY - h * 0.03);
  ctx.closePath();
  ctx.fill();
  if (lit) {
    const glow = ctx.createRadialGradient(lampX, lampY, 0, lampX, lampY, h * 0.11);
    glow.addColorStop(0, "rgba(255,240,190,0.95)");
    glow.addColorStop(0.25, "rgba(255,226,150,0.4)");
    glow.addColorStop(1, "rgba(255,226,150,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(lampX - h * 0.12, lampY - h * 0.12, h * 0.24, h * 0.24);
  } else {
    ctx.fillStyle = "rgba(120,150,190,0.5)";
    ctx.fillRect(lampX - tw * 0.3, lampY - h * 0.012, tw * 0.6, h * 0.024);
  }
}

function Monitor({
  session,
  caption,
}: {
  session: ExampleSession;
  caption: { speaker: string; text: string } | null;
}): ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null);
  const shown = useRef(0);
  const paint = (tick: Tick) => {
    shown.current = tick;
    const element = canvas.current;
    const ctx = element?.getContext("2d");
    if (!element || !ctx) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.round(element.clientWidth * ratio);
    const height = Math.round(element.clientHeight * ratio);
    if (width === 0 || height === 0) return;
    if (element.width !== width || element.height !== height) {
      element.width = width;
      element.height = height;
    }
    drawScene(ctx, width, height, tick / hz);
  };
  usePlayhead(session.transport, paint);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const watch = new ResizeObserver(() => paint(shown.current));
    watch.observe(element);
    return () => watch.disconnect();
  });
  return (
    <div className="dub-monitor">
      <canvas ref={canvas} aria-label="Scene preview" />
      {caption && (
        <p className="dub-caption">
          <b>{caption.speaker}</b>
          {caption.text}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- lines

/** Which of a line's three recorded takes an asset is. */
const takeIndex = (assetId: string): number => Math.max(0, "abc".indexOf(assetId.at(-1) ?? "a"));

/** The edit that makes a line as long as one of its takes, at the speed the clip plays now. */
function resize(clip: Clip, seconds: number) {
  const target = Math.max(1, Math.round(sec(seconds) / (clip.rate ?? 1)));
  if (target === clip.duration) return [];
  return [commands.trimClip({ clipId: clip.id, edge: "right", delta: target - clip.duration })];
}

/** Ticks from where a line's clip starts to where its slot ends. */
function room(clip: Clip): Tick {
  const line = LINE_BY_KEY.get(clip.name ?? "");
  return line ? sec(line.start + slotOf(line.key)) - clip.start : clip.duration;
}

/** The edits that give a line a new voice from its current words, as the next take. */
function revoice(session: ExampleSession, line: LineView, lang: Lang, words: string) {
  const source = LINE_BY_KEY.get(line.key);
  if (!source) return [];
  const { editor } = session;
  // The third recorded take comes first, then the three in turn.
  const round = editor.read().takesOf(line.clip.id).length;
  const index = round % 3;
  const clip = editor.getSnapshot().clips.find((item) => item.id === line.clip.id) ?? line.clip;
  return [
    commands.addTake({
      clipIds: [clip.id],
      take: {
        assetId: takeId(lang, line.key, index),
        streamId: "mono",
        sourceAtContentZero: 0,
        label: `v${round + 1}`,
      },
      activate: true,
    }),
    ...resize(clip, takeSeconds(lang, source, index)),
    setLine(line.key, "voiced", words),
  ];
}

/**
 * Plays one line alone: its own voice, without the bed or the lines around it. The transport
 * auditions the clip's active take in isolation and puts the playhead back where it was.
 */
function audition(session: ExampleSession, clipId: string): void {
  const { editor, transport } = session;
  const clip = editor.getSnapshot().clips.find((item) => item.id === clipId);
  const takeId = clip?.activeTakeId;
  if (!clip || !takeId) return;
  transport.audition({ clipId, takeId, mode: "isolated" }).catch(() => undefined);
}

/** What a row says beside the speaker, measured from the timeline. */
function Marks({ line }: { line: LineView }): ReactElement | null {
  if (line.kept) return <span className="dub-kept">original audio</span>;
  const next = lineAfter(line.key);
  return (
    <>
      {line.over > 0 && (
        <span
          className="dub-mark"
          data-kind="over"
          title={`Runs ${line.over.toFixed(2)} s past its slot${
            next ? `, into ${SPEAKERS[next.speaker]?.name ?? "the next"}’s line` : ""
          }`}
        >
          +{line.over.toFixed(2)} s
        </span>
      )}
      {line.stale && (
        <span className="dub-mark" data-kind="stale">
          voice out of date
        </span>
      )}
    </>
  );
}

/**
 * One line of dialogue, read-only: number, when, who, the source and the translation, and
 * what the timeline says about it. A line is edited in `LineEditor`, on demand. In the
 * original, `lang` is null and a row is the line as shot.
 */
function LineRow({
  session,
  line,
  lang,
  selected,
  playing,
  auditioning,
  onSelect,
  onEdit,
}: {
  session: ExampleSession;
  line: LineView;
  lang: Lang | null;
  selected: boolean;
  /** The line is being heard. */
  playing: boolean;
  /** The line is being heard alone, through its play button. */
  auditioning: boolean;
  onSelect: () => void;
  onEdit: () => void;
}): ReactElement {
  const source = LINE_BY_KEY.get(line.key);
  const speaker = SPEAKERS[source?.speaker ?? ""];
  return (
    <li
      data-line={line.key}
      data-selected={selected || undefined}
      data-playing={playing || undefined}
      data-auditioning={auditioning || undefined}
      onClick={onSelect}
      onDoubleClick={onEdit}
    >
      <span className="dub-when">
        <b>{line.key}</b>
        <time>{clock(line.clip.start)}</time>
      </span>
      <div className="dub-line">
        <div className="dub-line-head">
          <strong data-speaker={speaker?.id}>{speaker?.name}</strong>
          {lang && <Marks line={line} />}
        </div>
        {lang && <p className="dub-source">{source?.source}</p>}
        <p className="dub-target">{line.text}</p>
      </div>
      <span className="dub-row-actions">
        {lang && !line.kept && (
          <button
            type="button"
            aria-label={`Edit line ${line.key}`}
            title="Edit (Enter)"
            data-dub-edit
            onClick={(event) => {
              event.stopPropagation();
              onEdit();
            }}
          >
            <Icon name="edit" size={12} />
          </button>
        )}
        <button
          type="button"
          aria-label={auditioning ? `Stop line ${line.key}` : `Play line ${line.key}`}
          title={auditioning ? "Stop" : "Play this line alone"}
          data-dub-audition
          onClick={(event) => {
            event.stopPropagation();
            if (auditioning) {
              session.transport.cancelAudition();
              return;
            }
            onSelect();
            audition(session, line.clip.id);
          }}
        >
          <Icon name={auditioning ? "pause" : "play"} size={11} />
        </button>
      </span>
    </li>
  );
}

/**
 * The editor for one line, floating over its row: translation, direction, voice take and
 * length. It opens on demand and holds a draft, so the list and the clips stay read-only views.
 */
function LineEditor({
  session,
  line,
  lang,
  onClose,
}: {
  session: ExampleSession;
  line: LineView;
  lang: Lang;
  onClose: () => void;
}): ReactElement {
  const { editor } = session;
  const source = LINE_BY_KEY.get(line.key);
  const speaker = SPEAKERS[source?.speaker ?? ""];
  const [draft, setDraft] = useState(line.text);
  const [generating, setGenerating] = useState(false);
  const timer = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // Escape closes the editor wherever the focus has gone.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Under the row when there is room, over it otherwise, and along with it when the list scrolls.
  useLayoutEffect(() => {
    const pop = box.current;
    const app = pop?.parentElement;
    const row = app?.querySelector<HTMLElement>(`[data-line="${line.key}"]`);
    const scroller = row?.parentElement;
    if (!pop || !app || !row || !scroller) return;
    const place = () => {
      const frame = app.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      const under = rect.bottom - frame.top + 4;
      const fits = under + pop.offsetHeight <= frame.height - 8;
      const top = fits ? under : rect.top - frame.top - pop.offsetHeight - 4;
      const left = Math.min(rect.left - frame.left + 46, frame.width - pop.offsetWidth - 10);
      pop.style.top = `${Math.max(8, top)}px`;
      pop.style.left = `${Math.max(10, left)}px`;
    };
    place();
    pop.querySelector("textarea")?.focus({ preventScroll: true });
    scroller.addEventListener("scroll", place);
    return () => scroller.removeEventListener("scroll", place);
  }, [line.key]);

  const takes = editor.read().takesOf(line.clip.id);
  // Whatever the editor plays, it plays alone.
  const play = () => audition(session, line.clip.id);
  const { clip } = line;
  const space = room(clip);
  const next = lineAfter(line.key);
  // A take already recorded that fits the slot as it is, the longest one first.
  const shorter = source
    ? takes
        .filter((take) => take.id !== clip.activeTakeId)
        .map((take) => ({ take, seconds: takeSeconds(lang, source, takeIndex(take.assetId)) }))
        .filter(({ seconds }) => sec(seconds) <= space + sec(SLOT_TOLERANCE))
        .sort((a, b) => b.seconds - a.seconds)[0]
    : undefined;
  // Retiming plays the same take faster: the button says how much faster.
  const speed = ((clip.rate ?? 1) * clip.duration) / Math.max(1, space);
  // Saving changes the words alone; the row then shows that the voice is out of date.
  const edited = () => (draft === line.text ? [] : [setLine(line.key, "text", draft)]);
  const save = () => {
    const list = edited();
    if (list.length) editor.dispatch(list);
    onClose();
  };
  const regenerate = () => {
    if (!source || generating) return;
    setGenerating(true);
    timer.current = window.setTimeout(() => {
      setGenerating(false);
      editor.dispatch([...edited(), ...revoice(session, line, lang, draft)]);
      play();
    }, 650);
  };

  return (
    <div
      className="dub-editor"
      ref={box}
      role="dialog"
      aria-label={`Edit line ${line.key}`}
      data-dub-editor
      onKeyDown={(event) => {
        if (event.key !== "Escape") event.stopPropagation();
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) save();
      }}
    >
      <header>
        <strong data-speaker={speaker?.id}>{speaker?.name}</strong>
        <span>
          {clock(line.clip.start)} – {clock(line.clip.start + line.clip.duration)}
        </span>
        <button type="button" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>
      <textarea
        value={draft}
        rows={2}
        aria-label="Translation"
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="dub-editor-row">
        <label className="dub-select">
          <span>Direction</span>
          <select
            value={line.emotion}
            onChange={(event) => editor.dispatch(setLine(line.key, "emotion", event.target.value))}
          >
            {[...new Set([...EMOTIONS, line.emotion])].map((emotion) => (
              <option key={emotion}>{emotion}</option>
            ))}
          </select>
        </label>
        <span className="ex-seg" role="radiogroup" aria-label="Voice take">
          {takes.map((take) => (
            <button
              key={take.id}
              type="button"
              role="radio"
              aria-checked={take.id === line.clip.activeTakeId}
              aria-pressed={take.id === line.clip.activeTakeId}
              title="Use this voice take and play the line"
              onClick={() => {
                const seconds = source
                  ? takeSeconds(lang, source, takeIndex(take.assetId))
                  : line.clip.duration / hz;
                editor.dispatch([
                  commands.selectTake({ clipId: line.clip.id, takeId: take.id }),
                  ...resize(line.clip, seconds),
                ]);
                play();
              }}
            >
              {(take.label ?? take.id).split(" ")[0]}
            </button>
          ))}
        </span>
        <span className="dub-length" data-over={line.over > 0 || undefined}>
          {(line.clip.duration / hz).toFixed(2)} s
        </span>
      </div>
      {line.over > 0 && (
        <div className="dub-editor-fit">
          <span>
            Runs {line.over.toFixed(2)} s past its slot
            {next ? `, into ${SPEAKERS[next.speaker]?.name ?? "the next speaker"}’s line` : ""}.
          </span>
          {shorter && (
            <button
              type="button"
              className="ex-btn"
              data-dub-shorter
              title="Switch to a recorded take that fits"
              onClick={() => {
                editor.dispatch([
                  commands.selectTake({ clipId: clip.id, takeId: shorter.take.id }),
                  ...resize(clip, shorter.seconds),
                ]);
                play();
              }}
            >
              Use {shorter.take.label ?? "take"} · {shorter.seconds.toFixed(2)} s
            </button>
          )}
          <button
            type="button"
            className="ex-btn"
            data-dub-fit
            title="Play this take faster so it ends with its slot"
            onClick={() => {
              editor.dispatch(commands.retimeClip({ clipId: clip.id, duration: space }));
              play();
            }}
          >
            Fit · {speed.toFixed(2)}×
          </button>
        </div>
      )}
      <footer>
        <button type="button" className="ex-btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="ex-btn" data-dub-save onClick={save}>
          Save
        </button>
        <button
          type="button"
          className="ex-btn ex-btn-primary"
          disabled={generating}
          data-dub-regenerate
          onClick={regenerate}
        >
          <Icon name="spark" />
          {generating ? "Generating…" : "Regenerate"}
        </button>
      </footer>
    </div>
  );
}

// ------------------------------------------------------------------ studio

function Studio({
  host,
  session,
  lang,
  onLang,
}: {
  host: ExampleHost;
  session: ExampleSession;
  lang: View;
  onLang: (lang: View) => void;
}): ReactElement {
  const { editor, transport } = session;
  // The language of the dub on screen, or null for the original.
  const dub = lang === "en" ? null : lang;
  const rows = dub ? DUB_TRACK_IDS : DX_TRACKS;
  const scheme = useSiteScheme();
  const { view, attach, zoom, zoomBy, viewportEvents } = useTimelineView(BASE_ZOOM);
  const snapshot = useEditorSelector(editor, (state) => state.snapshot);
  const selectedId = useEditorSelector(editor, (state) => state.selection.at(-1) ?? null);
  // A line auditioned on its own, or null while the scene plays as a whole.
  const auditionId = useTransportSelector(transport, (state) => state.audition?.clipId ?? null);
  // Every line under the playhead, and the one that began last, which leads. An audition is
  // heard alone, so it is the only line playing.
  const underPlayhead = useClipsAtPlayhead(editor, transport, rows);
  const playingIds = auditionId ? [auditionId] : underPlayhead;
  const playingId = playingIds.at(-1) ?? null;
  // The screen follows playback only while the scene itself plays.
  const following = usePlaying(transport) && auditionId === null;
  const [editing, setEditing] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);

  const lines = useMemo(() => linesOf(snapshot, rows), [snapshot, rows]);
  const keyOf = (clipId: string | null) =>
    snapshot.clips.find((clip) => clip.id === clipId)?.name ?? null;
  const selectedKey = keyOf(selectedId);
  const playing = lines.find((line) => line.key === keyOf(playingId)) ?? null;
  const playingKeys = playingIds
    .map((id) => keyOf(id))
    .filter((key): key is string => key !== null);
  const heard = lines.filter((line) => playingKeys.includes(line.key));
  const edited = lines.find((line) => line.key === editing) ?? null;
  const track = (id: string) => snapshot.tracks.find((item) => item.id === id);
  // The words on screen follow the dialogue that is heard: the dub of the speaking line, unless
  // its track is muted or another is soloed over it.
  const soloing = snapshot.tracks.some((item) => item.solo === true);
  const voiced = track(playing?.clip.trackId ?? "");
  // An audition plays the clip alone, whatever mute and solo say.
  const hearingSource = auditionId
    ? !dub || playing?.clip.trackId === "dx"
    : !dub || !voiced || voiced.mute === true || (soloing && voiced.solo !== true);

  // While the scene plays, the line that began last is the active one: it is selected, so its
  // clip is marked on the timeline.
  useEffect(() => {
    if (!following || !playingId) return;
    if (editor.session.getSelection().at(-1) === playingId) return;
    editor.session.select([playingId]);
  }, [editor, following, playingId]);

  // The list follows through `createFollower`: requests settle before the list moves, and it
  // glides on a spring, so a run of overlapping lines becomes one calm move instead of a jump
  // for each. The span followed covers every line being spoken, so a line that starts under
  // another does not move the list while both are in view.
  const follower = useRef<Follower | null>(null);
  useEffect(() => {
    const box = list.current;
    if (!box) return;
    const made = createFollower(scrollAxis(box), () => box.clientHeight, box);
    follower.current = made;
    return () => {
      made.dispose();
      follower.current = null;
    };
  }, []);
  const playingSet = playingKeys.join(" ");
  useEffect(() => {
    const box = list.current;
    const glide = follower.current;
    if (!box || !glide) return;
    const spanOf = (key: string | undefined): Span | null => {
      const row = key ? box.querySelector<HTMLElement>(`[data-line="${key}"]`) : null;
      if (!row) return null;
      const top = row.getBoundingClientRect().top - box.getBoundingClientRect().top;
      return { start: top + box.scrollTop, end: top + box.scrollTop + row.offsetHeight };
    };
    if (!following) {
      const span = spanOf(selectedKey ?? undefined);
      if (span) glide.reveal(span);
      return;
    }
    const spans = playingSet
      .split(" ")
      .map(spanOf)
      .filter((span): span is Span => span !== null);
    const lead = spanOf(playingSet.split(" ").at(-1));
    if (!lead || spans.length === 0) return;
    glide.follow(
      {
        start: Math.min(...spans.map((span) => span.start)),
        end: Math.max(...spans.map((span) => span.end)),
      },
      lead,
    );
  }, [selectedKey, following, playingSet]);

  // The timeline follows the playhead the same way, page by page: when it nears the right
  // edge, the view glides on until it sits a quarter of the way in. It never moves while the
  // whole scene is in view, and a press or a wheel on the timeline holds it off for a moment.
  const laneWidth = useRef(0);
  const timelineBox = useRef<HTMLDivElement>(null);
  const pager = useRef<Follower | null>(null);
  useEffect(() => {
    if (!view) return;
    const scale = () => view.getViewport().pixelsPerSecond;
    const axis: Axis = {
      read: () => (view.getViewport().startTick / hz) * scale(),
      write: (x) => view.setViewport({ startTick: Math.max(0, Math.round((x / scale()) * hz)) }),
      limit: () => Math.max(0, SCENE_SECONDS * scale() - laneWidth.current),
    };
    const made = createFollower(axis, () => laneWidth.current, timelineBox.current, {
      anchor: 0.25,
      anchorMax: Number.POSITIVE_INFINITY,
      comfort: 0.85,
      margin: 24,
      settle: 0,
      maxWait: 0,
      holdOnPress: true,
    });
    pager.current = made;
    return () => {
      made.dispose();
      pager.current = null;
    };
  }, [view]);

  // Each line being spoken fills a bar as it goes, drawn outside React at the playhead's pace.
  const spoken = useRef<readonly { key: string; start: Tick; duration: Tick }[]>([]);
  spoken.current = heard.map((line) => ({
    key: line.key,
    start: line.clip.start,
    duration: line.clip.duration,
  }));
  usePlayhead(transport, (tick) => {
    for (const line of spoken.current) {
      const row = list.current?.querySelector<HTMLElement>(`[data-line="${line.key}"]`);
      const done = Math.max(0, Math.min(1, (tick - line.start) / Math.max(1, line.duration)));
      row?.style.setProperty("--spoken", done.toFixed(4));
    }
    if (!view || laneWidth.current <= 0 || !transport.snapshot().playing) return;
    const x = (tick / hz) * view.getViewport().pixelsPerSecond;
    pager.current?.follow({ start: x, end: x }, { start: x, end: x });
  });

  // The editor belongs to one line: it closes when another is selected.
  useEffect(() => {
    if (editing && editing !== selectedKey) setEditing(null);
  }, [editing, selectedKey]);

  // The list carries each line's words, so a clip shows its number, in its speaker's color.
  const clipStyle = useMemo<ClipStyleFn>(() => {
    const speakers = SPEAKER_COLORS[scheme];
    const stems = STEM_COLORS[scheme];
    return (clip, row) => {
      if (row.id === "me") return { ...stems.me, caption: null };
      const key = clip.name ?? "";
      const line = LINE_BY_KEY.get(key);
      const colors = speakers[line?.speaker ?? ""];
      // Under a dub the original is a grey guide; in the original it is the dialogue itself.
      if (row.id === "dx") {
        return dub || !line || !colors
          ? { ...stems.dx, label: "", caption: null }
          : {
              ...colors,
              label: `${key}  ${SPEAKERS[line.speaker]?.name ?? ""}`,
              caption: null,
            };
      }
      if (!line || !colors) return undefined;
      // On a speaker's own track a clip needs only its line number, which the list shows too.
      if (line.kept) return { ...stems.dx, label: key, caption: null };
      return { ...colors, label: key, caption: null };
    };
  }, [scheme, dub]);

  // Where a dub runs past its slot, the part that is over is hatched on the clip itself.
  const renderOverlay = useMemo<OverlayRenderer>(
    () =>
      ({ ctx, width, snapshot: shown, pixelAt, boxOf }) => {
        // The width of the lanes, which the timeline's follower pages by.
        laneWidth.current = width;
        ctx.save();
        ctx.strokeStyle = OVERRUN[scheme];
        ctx.fillStyle = OVERRUN[scheme];
        for (const clip of shown.clips) {
          if (!isDubTrack(clip.trackId) || overrun(clip) === 0) continue;
          const box = boxOf(clip.id);
          const line = LINE_BY_KEY.get(clip.name ?? "");
          if (!box || !line) continue;
          const from = Math.max(box.x, pixelAt(sec(line.start + slotOf(line.key))));
          const width = box.endX - from;
          if (width <= 0) continue;
          ctx.save();
          ctx.beginPath();
          ctx.rect(from, box.y, width, box.height);
          ctx.clip();
          ctx.globalAlpha = 0.22;
          ctx.fillRect(from, box.y, width, box.height);
          ctx.globalAlpha = 0.9;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          for (let x = from - box.height; x < box.endX; x += 6) {
            ctx.moveTo(x, box.y + box.height);
            ctx.lineTo(x + box.height, box.y);
          }
          ctx.stroke();
          ctx.fillRect(from, box.y, 1.5, box.height);
          ctx.restore();
        }
        ctx.restore();
      },
    [scheme],
  );

  const theme = useMemo(() => ({ scheme, ...DEMO_FONTS }), [scheme]);
  const waveforms = useMemo(() => decibelWaveforms(host.waveforms), [host]);
  const snap = useMemo(() => ({ gridTicks: hz / 20 }), []);
  const events = useMemo<TimelineEvents>(
    () => ({
      ...viewportEvents,
      onClipDoubleClick({ clipId }) {
        const key = editor.getSnapshot().clips.find((clip) => clip.id === clipId);
        if (key && isDubTrack(key.trackId) && key.name) openEditor(key.name);
      },
    }),
    [editor, viewportEvents],
  );

  const select = (line: LineView) => focusClip(session, view, line.clip.id);
  function openEditor(key: string): void {
    const line = linesOf(editor.getSnapshot(), rows).find((item) => item.key === key);
    if (!line || line.kept) return;
    transport.pause();
    editor.session.select([line.clip.id]);
    setEditing(key);
  }
  const exportSrt = () => {
    const body = lines
      .map(
        (line, index) =>
          `${index + 1}\n${srtTime(line.clip.start)} --> ${srtTime(
            line.clip.start + line.clip.duration,
          )}\n${line.text}\n`,
      )
      .join("\n");
    download(`tidewatch-ep04.${lang}.srt`, body, "application/x-subrip");
  };
  const step = (delta: number) => {
    const index = lines.findIndex((line) => line.key === selectedKey);
    const next = lines[Math.max(0, Math.min(lines.length - 1, index + delta))];
    if (next) select(next);
  };

  const caption = playing
    ? {
        speaker: SPEAKERS[LINE_BY_KEY.get(playing.key)?.speaker ?? ""]?.name ?? "",
        text: hearingSource ? (LINE_BY_KEY.get(playing.key)?.source ?? "") : playing.text,
      }
    : null;

  return (
    <div className="ex-app dub" data-demo-ready="dubbing">
      <header className="ex-topbar">
        <span className="ex-brand">
          <i aria-hidden="true" />
          Tidewatch
        </span>
        <span className="ex-project">
          <em>EP.04</em> The Lantern Room
        </span>
        <nav className="ex-seg dub-langs" aria-label="Language">
          {[ORIGINAL, ...LANGS].map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={item.id === lang}
              title={item.id === "en" ? "The original, as shot" : `The ${item.label} dub`}
              data-dub-lang={item.id}
              onClick={() => onLang(item.id)}
            >
              <span className="dub-lang-name">{item.label}</span>
              <span className="dub-lang-code">{item.code}</span>
              {item.id === "en" && <small>original</small>}
            </button>
          ))}
        </nav>
        <span className="ex-spacer" />
        <HistoryButtons editor={editor} />
        <button type="button" className="ex-btn" onClick={exportSrt}>
          <Icon name="download" />
          Subtitles
        </button>
      </header>

      <div className="dub-body">
        <Monitor session={session} caption={caption} />

        <section className="dub-list" aria-label="Dialogue">
          <header>
            <h3>
              Dialogue
              <span data-dub-count>
                {lines.length} lines{dub ? "" : ", as shot"}
              </span>
            </h3>
          </header>
          <ol
            ref={list}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                step(event.key === "ArrowDown" ? 1 : -1);
              } else if (event.key === "Enter" && selectedKey) {
                event.preventDefault();
                openEditor(selectedKey);
              } else if (event.key === " ") {
                event.preventDefault();
                if (transport.snapshot().playing) transport.pause();
                else void transport.play();
              }
            }}
          >
            {lines.map((line) => (
              <LineRow
                key={line.key}
                session={session}
                line={line}
                lang={dub}
                selected={line.key === selectedKey}
                playing={playingKeys.includes(line.key)}
                auditioning={line.clip.id === auditionId}
                onSelect={() => select(line)}
                onEdit={() => openEditor(line.key)}
              />
            ))}
          </ol>
        </section>
      </div>

      <div className="ex-toolbar">
        <PlayButton transport={transport} />
        <span className="ex-lcd">
          <Readout transport={transport} format={(tick) => clock(tick, 2)} />
          <i>/ {clock(sec(SCENE_SECONDS), 2)}</i>
        </span>
        <span className="ex-spacer" />
        {dub && (
          <button
            type="button"
            className="ex-tool ex-tool-text"
            title="Split the selected line at the playhead"
            onClick={() => splitAtPlayhead(session)}
          >
            <Icon name="split" /> Split
          </button>
        )}
        <ZoomButtons zoom={zoom} base={BASE_ZOOM} onZoom={zoomBy} />
      </div>

      <div ref={timelineBox} className="dub-timeline-box">
        <Timeline
          className="ex-timeline dub-timeline"
          editor={editor}
          transport={transport}
          waveforms={waveforms}
          pixelsPerSecond={BASE_ZOOM}
          snap={snap}
          chrome={CHROME}
          layout={LAYOUT}
          theme={theme}
          clipStyle={clipStyle}
          renderOverlay={renderOverlay}
          events={events}
          ref={attach}
        />
      </div>

      {edited && dub && (
        <LineEditor
          key={edited.key}
          session={session}
          line={edited}
          lang={dub}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

export default function DubbingStudio(): ReactElement {
  const [host, setHost] = useState<ExampleHost | null>(null);
  const [lang, setLang] = useState<View>("ko");
  const sessions = useRef(new Map<View, ExampleSession>());
  // Where the playhead was in the language just left, for one not opened yet.
  const carried = useRef<Tick | null>(null);

  useEffect(() => {
    const open = sessions.current;
    let created: ExampleHost | null = null;
    let gone = false;
    void loadDubAssets().then(({ assets, recorded }) => {
      if (gone) return;
      created = createExampleHost(assets, recorded);
      setHost(created);
    });
    return () => {
      gone = true;
      for (const session of open.values()) session.dispose();
      open.clear();
      created?.close();
    };
  }, []);

  // Each dub is a project of its own, with its own takes and history; so is the original.
  const session = useMemo(() => {
    if (!host) return null;
    const open = sessions.current.get(lang);
    if (open) return open;
    const created = createExampleSession(host, createDubProject(lang), `dub.${lang}`);
    // Open on the first line that runs past its slot, a moment into it.
    const lines = linesOf(created.editor.getSnapshot(), lang === "en" ? DX_TRACKS : DUB_TRACK_IDS);
    const first = lines.find((line) => line.over > 0) ?? lines[0];
    if (first) created.editor.session.select([first.clip.id]);
    void created.transport.seek(carried.current ?? (first ? first.clip.start + sec(0.6) : 0));
    sessions.current.set(lang, created);
    return created;
  }, [host, lang]);

  if (!host || !session) return <Loading label="Loading the scene's audio…" />;

  const switchLang = (next: View) => {
    if (next === lang) return;
    const tick = session.transport.snapshot().presentedTick;
    session.transport.pause();
    carried.current = tick;
    const target = sessions.current.get(next);
    if (target) void target.transport.seek(tick);
    setLang(next);
  };

  return <Studio key={lang} host={host} session={session} lang={lang} onLang={switchLang} />;
}
