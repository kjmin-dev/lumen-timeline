// Example screen 2: a transcript-driven podcast editor. The transcript is derived from the clips
// on the two voice tracks, so deleting words in the text is a ripple cut on the timeline, and
// undo puts both back. The speakers talk over each other in one place, and a cut there takes
// the time from both. Chapters are the project's markers; a clip's level is its gain.
import {
  commands,
  MAX_CLIP_GAIN,
  TICKS_PER_SECOND as hz,
  type Clip,
  type EditCommand,
  type Editor as TimelineEditor,
  type Marker,
  type ProjectSnapshot,
  type Tick,
} from "@lumen-timeline/core";
import { Timeline, useEditorSelector } from "@lumen-timeline/react";
import type { ClipStyleFn, TimelineChrome, TimelineTheme } from "@lumen-timeline/timeline";
import {
  Fragment,
  type KeyboardEvent,
  type ReactElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DEMO_FONTS, type Scheme, useSiteScheme } from "../scheme.ts";
import { loadEpisode, type Paragraph, SPEAKERS } from "./podcast-data.ts";
import {
  clock,
  createExampleHost,
  createExampleSession,
  type ExampleHost,
  type ExampleSession,
  decibelWaveforms,
  HistoryButtons,
  Icon,
  Loading,
  PlayButton,
  Readout,
  sec,
  usePlayhead,
  useTimelineView,
  ZoomButtons,
} from "./shared.tsx";

const BASE_ZOOM = 22;
const VOICE_TRACKS = ["host", "guest"];
const LONG_GAP = sec(0.8);
const KEPT_GAP = sec(0.4);
const CHROME: TimelineChrome = {
  toolbar: false,
  editToolbar: false,
  markerEditor: false,
  status: false,
  takeLanes: false,
  clipToolbar: false,
  trackControls: false,
  trackRename: false,
  trackReorder: false,
};
// Tall enough that a clip's waveform shows how loud the speech is.
const LAYOUT = { laneHeight: 44, rowInset: 5 } as const;

const PALETTES: Readonly<Record<Scheme, NonNullable<TimelineTheme["palette"]>>> = {
  dark: [
    { fill: "#f9a870", stripe: "#f9a870", waveform: "#593215", text: "#0c0e11" },
    { fill: "#6cc4f5", stripe: "#6cc4f5", waveform: "#0f4265", text: "#0c0e11" },
    { fill: "#4cd7c8", stripe: "#4cd7c8", waveform: "#004942", text: "#0c0e11" },
  ],
  light: [
    { fill: "#fde6d6", stripe: "#d9783a", waveform: "#e08548", text: "#5a2a0c" },
    { fill: "#dcedf9", stripe: "#2f7fb8", waveform: "#5a9fd0", text: "#123f61" },
    { fill: "#d8f1ec", stripe: "#1a8f7d", waveform: "#2fa392", text: "#0b4a40" },
  ],
};

// ------------------------------------------------------------- transcript

interface WordView {
  /** Recording and word index, stable across cuts. */
  readonly id: string;
  /** The word's position in its recording, and how many words that recording has. */
  readonly index: number;
  readonly of: number;
  readonly text: string;
  readonly filler: boolean;
  readonly track: string;
  readonly start: Tick;
  readonly end: Tick;
}

interface Block {
  readonly key: string;
  readonly speaker: string;
  readonly start: Tick;
  readonly words: WordView[];
  /** The clips that play these words: one recording, in as many pieces as cuts have left it. */
  readonly clipIds: string[];
}

/** The words still on the timeline, in the order they play, grouped by recording. */
function transcriptOf(
  snapshot: ProjectSnapshot,
  paragraphs: ReadonlyMap<string, Paragraph>,
): Block[] {
  const blocks: Block[] = [];
  const voice = snapshot.clips
    .filter((clip) => VOICE_TRACKS.includes(clip.trackId))
    .sort((a, b) => a.start - b.start);
  for (const clip of voice) {
    const paragraph = paragraphs.get(clip.source?.assetId ?? "");
    if (!paragraph) continue;
    const rate = clip.rate ?? 1;
    const from = clip.contentIn;
    const to = from + clip.duration * rate;
    const end = clip.start + clip.duration;
    const words: WordView[] = [];
    paragraph.words.forEach((word, index) => {
      const content = sec(word.start);
      if (content < from || content >= to) return;
      words.push({
        id: `${paragraph.id}:${index}`,
        index,
        of: paragraph.words.length,
        text: word.text,
        filler: word.filler,
        track: clip.trackId,
        start: clip.start + Math.round((content - from) / rate),
        end: Math.min(end, clip.start + Math.round((sec(word.end) - from) / rate)),
      });
    });
    const first = words[0];
    if (!first) continue;
    const last = blocks.at(-1);
    if (last && last.key.startsWith(`${paragraph.id}@`)) {
      last.words.push(...words);
      last.clipIds.push(clip.id);
    } else {
      blocks.push({
        key: `${paragraph.id}@${first.id}`,
        speaker: paragraph.speaker,
        start: first.start,
        words,
        clipIds: [clip.id],
      });
    }
  }
  return blocks;
}

// ----------------------------------------------------------- ripple edits

interface Piece {
  id: string;
  readonly track: string;
  start: Tick;
  duration: Tick;
}

/**
 * Builds one transaction out of several cuts. It tracks where each clip and marker will be
 * after the commands so far, since a later cut must name the pieces an earlier one made.
 */
function createPlan(snapshot: ProjectSnapshot) {
  const locked = new Set(snapshot.tracks.filter((track) => track.locked).map((track) => track.id));
  const pieces: Piece[] = snapshot.clips.map((clip) => ({
    id: clip.id,
    track: clip.trackId,
    start: clip.start,
    duration: clip.duration,
  }));
  const markers = (snapshot.markers ?? []).map((marker) => ({
    id: marker.id,
    start: marker.start,
  }));
  const list: EditCommand[] = [];
  let made = 0;
  const fresh = () => `cut-${snapshot.revision}-${++made}`;

  /** Closes `length` ticks of timeline before `from`: everything at or after it moves left. */
  function close(from: Tick, length: Tick): void {
    const moving = pieces.filter((piece) => piece.start >= from && !locked.has(piece.track));
    for (const piece of moving) piece.start -= length;
    if (moving.length) {
      list.push(commands.moveClips({ clipIds: moving.map((piece) => piece.id), delta: -length }));
    }
    for (const marker of markers) {
      if (marker.start < from) continue;
      marker.start -= length;
      list.push(commands.moveMarker({ markerId: marker.id, delta: -length }));
    }
  }

  /** Removes `[a, b)` from one track, leaving a hole. */
  function remove(track: string, a: Tick, b: Tick): void {
    for (const piece of pieces.filter((item) => item.track === track)) {
      const end = piece.start + piece.duration;
      if (end <= a || piece.start >= b) continue;
      if (a <= piece.start && b >= end) {
        list.push(commands.removeClip({ clipId: piece.id }));
        pieces.splice(pieces.indexOf(piece), 1);
      } else if (a <= piece.start) {
        const right = fresh();
        list.push(
          commands.splitClip({ clipId: piece.id, at: b, rightId: right }),
          commands.removeClip({ clipId: piece.id }),
        );
        piece.id = right;
        piece.start = b;
        piece.duration = end - b;
      } else if (b >= end) {
        const right = fresh();
        list.push(
          commands.splitClip({ clipId: piece.id, at: a, rightId: right }),
          commands.removeClip({ clipId: right }),
        );
        piece.duration = a - piece.start;
      } else {
        const middle = fresh();
        const right = fresh();
        list.push(
          commands.splitClip({ clipId: piece.id, at: a, rightId: middle }),
          commands.splitClip({ clipId: middle, at: b, rightId: right }),
          commands.removeClip({ clipId: middle }),
        );
        piece.duration = a - piece.start;
        pieces.push({ id: right, track, start: b, duration: end - b });
      }
    }
  }

  /**
   * Takes `[a, b)` out of the conversation: from every voice track, so a speaker who talked over
   * the cut words loses the same time, then closes the hole.
   */
  function cut(a: Tick, b: Tick): void {
    for (const track of VOICE_TRACKS) remove(track, a, b);
    close(b, b - a);
  }

  return { cut, close, commands: list };
}

interface Span {
  readonly start: Tick;
  readonly end: Tick;
}

/** Sorted spans with every overlapping or touching pair joined. */
function merge(spans: readonly Span[]): Span[] {
  const out: { start: Tick; end: Tick }[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else out.push({ ...span });
  }
  return out;
}

/**
 * The time a cut of `chosen` takes out. Words are whole: where another speaker talks over a
 * chosen word, the cut widens to the whole of their word too, and so on, so no one is left
 * with half a word.
 */
function cutSpans(chosen: readonly WordView[], words: readonly WordView[]): Span[] {
  let spans = merge(chosen);
  for (;;) {
    const wider = merge([...spans, ...wordsIn(spans, words)]);
    const same =
      wider.length === spans.length &&
      wider.every((span, i) => span.start === spans[i]?.start && span.end === spans[i]?.end);
    if (same) return wider;
    spans = wider;
  }
}

/** The words a cut of `spans` removes. */
function wordsIn(spans: readonly Span[], words: readonly WordView[]): WordView[] {
  return words.filter((word) =>
    spans.some((span) => word.start < span.end && word.end > span.start),
  );
}

/** Silences between spoken clips longer than `LONG_GAP`: where one starts and its length. */
function longGaps(snapshot: ProjectSnapshot): { readonly from: Tick; readonly length: Tick }[] {
  const voice = snapshot.clips
    .filter((clip) => VOICE_TRACKS.includes(clip.trackId))
    .sort((a, b) => a.start - b.start);
  const gaps: { from: Tick; length: Tick }[] = [];
  let heard = voice[0] ? voice[0].start + voice[0].duration : 0;
  for (const clip of voice.slice(1)) {
    if (clip.start - heard > LONG_GAP) gaps.push({ from: clip.start, length: clip.start - heard });
    heard = Math.max(heard, clip.start + clip.duration);
  }
  return gaps;
}

function runtimeOf(snapshot: ProjectSnapshot): Tick {
  return snapshot.clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);
}

function download(name: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

// ------------------------------------------------------------------ editor

const SPEEDS = [1, 1.25, 1.5] as const;

/** How many words a cut removed before `word`, given the word shown before it. */
const cutBefore = (word: WordView, previous: WordView | undefined): number =>
  word.index - (previous ? previous.index + 1 : 0);

function Editor({
  host,
  session,
  paragraphs,
}: {
  host: ExampleHost;
  session: ExampleSession;
  paragraphs: ReadonlyMap<string, Paragraph>;
}): ReactElement {
  const { editor, transport } = session;
  const scheme = useSiteScheme();
  const { attach, zoom, zoomBy, viewportEvents } = useTimelineView(BASE_ZOOM);
  const snapshot = useEditorSelector(editor, (state) => state.snapshot);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [speed, setSpeed] = useState<number>(1);
  const [notice, setNotice] = useState("");
  const page = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const anchor = useRef<string | null>(null);
  const dragging = useRef(false);

  const blocks = useMemo(() => transcriptOf(snapshot, paragraphs), [snapshot, paragraphs]);
  const words = useMemo(() => blocks.flatMap((block) => block.words), [blocks]);
  const fillers = useMemo(() => words.filter((word) => word.filler), [words]);
  const gaps = useMemo(() => longGaps(snapshot), [snapshot]);
  const runtime = runtimeOf(snapshot);
  const markers = snapshot.markers ?? [];

  // Words that an edit removed leave the selection.
  const selection = useMemo(() => {
    const live = new Set(words.map((word) => word.id));
    return picked.filter((id) => live.has(id));
  }, [picked, words]);
  // A cut takes whole words from everyone talking at the time, so the selection shows all of them.
  const spans = useMemo(
    () =>
      cutSpans(
        words.filter((word) => selection.includes(word.id)),
        words,
      ),
    [words, selection],
  );
  const chosen = useMemo(() => wordsIn(spans, words), [spans, words]);
  const covered = useMemo(() => new Set(chosen.map((word) => word.id)), [chosen]);

  // The words under the playhead, one per speaker talking, are marked in the DOM without
  // rendering the transcript.
  const spoken = useRef<readonly Element[]>([]);
  usePlayhead(transport, (tick) => {
    const now = words.filter((word) => word.start <= tick && tick < word.end);
    const elements = now.flatMap(
      (word) => page.current?.querySelector(`[data-word="${word.id}"]`) ?? [],
    );
    const before = spoken.current;
    if (elements.length === before.length && elements.every((el, i) => el === before[i])) return;
    for (const element of before) element.removeAttribute("data-now");
    for (const element of elements) element.setAttribute("data-now", "");
    spoken.current = elements;
  });
  useEffect(() => {
    spoken.current = [...(page.current?.querySelectorAll("[data-now]") ?? [])];
  }, [blocks]);

  // The selection's actions float over its first word.
  useLayoutEffect(() => {
    const box = page.current;
    const pill = bubble.current;
    const first = box?.querySelector<HTMLElement>("[data-picked]");
    if (!box || !pill || !first) return;
    const frame = box.getBoundingClientRect();
    const rect = first.getBoundingClientRect();
    const left = Math.min(rect.left - frame.left, box.clientWidth - pill.offsetWidth - 12);
    pill.style.left = `${Math.max(8, left)}px`;
    pill.style.top = `${rect.top - frame.top + box.scrollTop - pill.offsetHeight - 6}px`;
  }, [selection, blocks]);

  useEffect(() => {
    const end = () => (dragging.current = false);
    window.addEventListener("pointerup", end);
    return () => window.removeEventListener("pointerup", end);
  }, []);

  const apply = (list: readonly EditCommand[], done: string) => {
    if (list.length === 0) return;
    const result = editor.dispatch(list);
    setNotice(result.ok ? done : `Edit rejected: ${result.reason}`);
  };

  const removeFillers = () => {
    const plan = createPlan(snapshot);
    // Last first, so the ticks of the earlier runs still hold when their turn comes.
    for (const span of cutSpans(fillers, words).toReversed()) plan.cut(span.start, span.end);
    apply(plan.commands, `Removed ${fillers.length} filler words. One undo brings them back.`);
  };
  const shortenGaps = () => {
    const plan = createPlan(snapshot);
    for (const gap of gaps.toReversed()) plan.close(gap.from, gap.length - KEPT_GAP);
    apply(plan.commands, `Shortened ${gaps.length} pauses to ${KEPT_GAP / hz} s.`);
  };
  const cutSelection = () => {
    if (chosen.length === 0) return;
    const plan = createPlan(snapshot);
    // One cut per run of selected time, last first.
    for (const span of spans.toReversed()) plan.cut(span.start, span.end);
    apply(plan.commands, `Cut ${chosen.length} word${chosen.length === 1 ? "" : "s"}.`);
    setPicked([]);
  };
  const playSelection = () => {
    const first = spans[0];
    const last = spans.at(-1);
    if (!first || !last) return;
    void transport.seek(first.start).then(() => transport.play({ until: last.end }));
  };

  const extendTo = (id: string) => {
    const from = words.findIndex((item) => item.id === anchor.current);
    const to = words.findIndex((item) => item.id === id);
    if (from < 0 || to < 0) return;
    setPicked(words.slice(Math.min(from, to), Math.max(from, to) + 1).map((item) => item.id));
  };
  const press = (word: WordView, extend: boolean) => {
    if (extend && anchor.current) {
      extendTo(word.id);
      return;
    }
    anchor.current = word.id;
    dragging.current = true;
    setPicked([word.id]);
    void transport.seek(word.start);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      cutSelection();
    } else if (event.key === "Escape") setPicked([]);
  };

  const changeSpeed = (next: number) => {
    transport.setPlaybackRate(next);
    setSpeed(next);
  };
  const exportText = () => {
    const lines: string[] = ["Field Notes — Ep. 12: The sound of a tide pool", "", "Chapters"];
    for (const marker of markers) lines.push(`${clock(marker.start, 0)} ${marker.label ?? ""}`);
    lines.push("");
    for (const block of blocks) {
      lines.push(`${SPEAKERS[block.speaker]?.name ?? ""} [${clock(block.start, 0)}]`);
      lines.push(block.words.map((word) => word.text).join(" "), "");
    }
    download("field-notes-ep12.txt", lines.join("\n"));
  };

  // Peaks on a decibel scale, after each clip's gain: a clip turned down draws smaller.
  const waveforms = useMemo(() => decibelWaveforms(host.waveforms), [host]);

  // The transcript already carries the words, so a clip shows its waveform alone.
  const clipStyle = useMemo<ClipStyleFn>(
    () => (clip) =>
      VOICE_TRACKS.includes(clip.trackId) ? { label: "", caption: null } : { caption: null },
    [],
  );
  const theme = useMemo(() => ({ scheme, ...DEMO_FONTS, palette: PALETTES[scheme] }), [scheme]);
  const snap = useMemo(() => ({ gridTicks: hz / 20 }), []);

  // A chapter heads the first paragraph that starts at or after it.
  const headings = new Map<string, Marker[]>();
  for (const marker of markers) {
    const block = blocks.find((item) => item.start >= marker.start) ?? blocks.at(-1);
    if (block) headings.set(block.key, [...(headings.get(block.key) ?? []), marker]);
  }
  const seconds = spans.reduce((sum, span) => sum + (span.end - span.start), 0) / hz;

  return (
    <div className="ex-app pod" data-demo-ready="podcast">
      <header className="ex-topbar">
        <span className="ex-brand">
          <i aria-hidden="true" />
          Field Notes
        </span>
        <span className="ex-project">
          <em>Ep. 12</em> The sound of a tide pool
        </span>
        <span className="ex-spacer" />
        <HistoryButtons editor={editor} />
        <button type="button" className="ex-btn" onClick={exportText}>
          <Icon name="download" />
          Export
        </button>
      </header>

      <div className="pod-assist">
        <button
          type="button"
          className="pod-suggest"
          disabled={fillers.length === 0}
          data-pod-fillers
          onClick={removeFillers}
        >
          <b>{fillers.length}</b> filler words
          <span>Remove</span>
        </button>
        <button
          type="button"
          className="pod-suggest"
          disabled={gaps.length === 0}
          data-pod-gaps
          onClick={shortenGaps}
        >
          <b>{gaps.length}</b> long pauses
          <span>Shorten</span>
        </button>
        <span className="ex-spacer" />
        <span className="pod-notice" role="status">
          {notice || "Drag across words to select them, then press Delete to cut the audio."}
        </span>
      </div>

      <div className="pod-page" ref={page} tabIndex={0} onKeyDown={onKey} aria-label="Transcript">
        {chosen.length > 0 && (
          <div className="pod-bubble" ref={bubble} data-pod-bubble>
            <span>
              {chosen.length} word{chosen.length === 1 ? "" : "s"} · {seconds.toFixed(1)} s
            </span>
            <button type="button" aria-label="Play selection" onClick={playSelection}>
              <Icon name="play" size={11} />
            </button>
            <button type="button" data-pod-cut onClick={cutSelection}>
              <Icon name="trash" size={12} /> Cut
            </button>
          </div>
        )}
        {blocks.map((block) => {
          const speaker = SPEAKERS[block.speaker];
          const last = block.words.at(-1);
          const tail = last ? last.of - 1 - last.index : 0;
          return (
            <section key={block.key} data-speaker={block.speaker}>
              {headings.get(block.key)?.map((marker) => (
                <h4 key={marker.id}>
                  <input
                    key={marker.label}
                    defaultValue={marker.label ?? ""}
                    aria-label="Chapter title"
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                    onBlur={(event) => {
                      const label = event.currentTarget.value.trim();
                      if (label && label !== marker.label) {
                        apply(
                          [commands.updateMarker({ markerId: marker.id, label })],
                          "Chapter renamed.",
                        );
                      }
                    }}
                  />
                  <time>{clock(marker.start, 0)}</time>
                  <button
                    type="button"
                    aria-label={`Remove chapter ${marker.label ?? ""}`}
                    onClick={() =>
                      apply([commands.removeMarker({ markerId: marker.id })], "Chapter removed.")
                    }
                  >
                    ×
                  </button>
                </h4>
              ))}
              <article>
                <header>
                  <button
                    type="button"
                    className="pod-speaker"
                    title="Select this paragraph on the timeline to set its level"
                    onClick={() => editor.session.select(block.clipIds)}
                  >
                    {speaker?.name}
                  </button>
                  <button
                    type="button"
                    className="pod-time"
                    title="Play from here"
                    onClick={() => void transport.seek(block.start)}
                  >
                    {clock(block.start, 0)}
                  </button>
                  {!headings.has(block.key) && (
                    <button
                      type="button"
                      className="pod-add"
                      data-pod-chapter
                      title="Start a chapter at this paragraph"
                      onClick={() =>
                        apply(
                          [commands.addMarker({ start: block.start, label: "New chapter" })],
                          "Chapter added. Click its title to rename it.",
                        )
                      }
                    >
                      + Chapter
                    </button>
                  )}
                </header>
                <p>
                  {block.words.map((word, index) => {
                    const cut = cutBefore(word, block.words[index - 1]);
                    return (
                      <Fragment key={word.id}>
                        {cut > 0 && (
                          <i className="pod-cut" title={`${cut} word${cut === 1 ? "" : "s"} cut`} />
                        )}
                        <span
                          data-word={word.id}
                          data-filler={word.filler || undefined}
                          data-picked={covered.has(word.id) || undefined}
                          onPointerDown={(event) => {
                            if (event.button === 0) press(word, event.shiftKey);
                          }}
                          onPointerEnter={() => {
                            if (dragging.current) extendTo(word.id);
                          }}
                        >
                          {word.text}
                        </span>{" "}
                      </Fragment>
                    );
                  })}
                  {tail > 0 && (
                    <i className="pod-cut" title={`${tail} word${tail === 1 ? "" : "s"} cut`} />
                  )}
                </p>
              </article>
            </section>
          );
        })}
      </div>

      <div className="ex-toolbar">
        <PlayButton transport={transport} />
        <span className="ex-lcd">
          <Readout transport={transport} format={(tick) => clock(tick)} />
          <i data-pod-runtime>/ {clock(runtime)}</i>
        </span>
        <span className="ex-seg" role="group" aria-label="Playback speed">
          {SPEEDS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={speed === value}
              onClick={() => changeSpeed(value)}
            >
              {value}×
            </button>
          ))}
        </span>
        <span className="ex-spacer" />
        <LevelControl editor={editor} blocks={blocks} />
        <ZoomButtons zoom={zoom} base={BASE_ZOOM} onZoom={zoomBy} />
      </div>

      <Timeline
        className="ex-timeline pod-timeline"
        editor={editor}
        transport={transport}
        waveforms={waveforms}
        pixelsPerSecond={BASE_ZOOM}
        snap={snap}
        chrome={CHROME}
        layout={LAYOUT}
        theme={theme}
        clipStyle={clipStyle}
        events={viewportEvents}
        ref={attach}
      />
    </div>
  );
}

// ------------------------------------------------------------------ level

const LEVEL_MIN = -24;
const LEVEL_MAX = 12;
const decibels = (gain: number): number => (gain > 0 ? 20 * Math.log10(gain) : -Infinity);
const gainOf = (db: number): number => Math.min(MAX_CLIP_GAIN, 10 ** (db / 20));
const dbText = (db: number): string =>
  db === -Infinity
    ? "−∞ dB"
    : `${db > 0.05 ? "+" : db < -0.05 ? "−" : ""}${Math.abs(db).toFixed(1)} dB`;

/**
 * The selected clips' level, as clip gain in decibels. The waveforms already show how loud each
 * clip plays; this is where it changes. A drag is heard as it moves and is one undo step.
 */
function LevelControl({
  editor,
  blocks,
}: {
  editor: TimelineEditor;
  blocks: readonly Block[];
}): ReactElement {
  const selection = useEditorSelector(editor, (state) => state.selection);
  const snapshot = useEditorSelector(editor, (state) => state.snapshot);
  const clips = useMemo(
    () => snapshot.clips.filter((clip) => selection.includes(clip.id)),
    [snapshot, selection],
  );
  const slider = useRef<HTMLInputElement>(null);
  // The gains a gesture started from, while it lasts.
  const before = useRef<ReadonlyMap<string, number> | null>(null);
  const first = clips[0];
  const db = first ? decibels(first.gain ?? 1) : 0;
  const mixed = clips.some((clip) => (clip.gain ?? 1) !== (first?.gain ?? 1));

  const name = (clip: Clip): string => {
    const block = blocks.find((item) => item.clipIds.includes(clip.id));
    const speaker = block ? SPEAKERS[block.speaker]?.name : undefined;
    return speaker ? `${speaker} ${clock(block?.start ?? clip.start, 0)}` : (clip.name ?? clip.id);
  };
  const label = first ? (clips.length === 1 ? name(first) : `${clips.length} clips`) : "No clip";

  const set = (gains: (id: string) => number, history: "record" | "ignore") =>
    editor.dispatch(
      clips.map((clip) => commands.updateClip({ clipId: clip.id, gain: gains(clip.id) })),
      { history },
    );
  // Heard while it moves, outside history; the change at the end is the one undo step.
  const preview = (value: number) => {
    before.current ??= new Map(clips.map((clip) => [clip.id, clip.gain ?? 1]));
    set(() => gainOf(value), "ignore");
  };
  useEffect(() => {
    const input = slider.current;
    if (!input) return;
    const commit = () => {
      const start = before.current;
      before.current = null;
      if (!start) return;
      const value = gainOf(Number(input.value));
      set((id) => start.get(id) ?? 1, "ignore");
      set(() => value, "record");
    };
    input.addEventListener("change", commit);
    return () => input.removeEventListener("change", commit);
  });

  return (
    <span className="pod-level" role="group" aria-label="Clip level" data-pod-level>
      <span className="pod-level-name" title={label}>
        {label}
      </span>
      <input
        ref={slider}
        type="range"
        min={LEVEL_MIN}
        max={LEVEL_MAX}
        step={0.5}
        disabled={!first}
        aria-label="Level"
        aria-valuetext={first ? (mixed ? "mixed" : dbText(db)) : "no clip selected"}
        value={Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, Number.isFinite(db) ? db : LEVEL_MIN))}
        onChange={(event) => preview(Number(event.currentTarget.value))}
      />
      <output data-pod-db>{first ? (mixed ? "mixed" : dbText(db)) : "—"}</output>
    </span>
  );
}

export default function PodcastEditor(): ReactElement {
  const [state, setState] = useState<{
    host: ExampleHost;
    session: ExampleSession;
    paragraphs: ReadonlyMap<string, Paragraph>;
  } | null>(null);

  useEffect(() => {
    let opened: { host: ExampleHost; session: ExampleSession } | null = null;
    let gone = false;
    void loadEpisode().then((episode) => {
      if (gone) return;
      const host = createExampleHost(episode.assets, episode.recorded);
      const session = createExampleSession(host, episode.project, "podcast.demo");
      opened = { host, session };
      setState({ host, session, paragraphs: episode.paragraphs });
    });
    return () => {
      gone = true;
      opened?.session.dispose();
      opened?.host.close();
    };
  }, []);

  if (!state) return <Loading label="Loading the episode's audio…" />;
  return <Editor host={state.host} session={state.session} paragraphs={state.paragraphs} />;
}
