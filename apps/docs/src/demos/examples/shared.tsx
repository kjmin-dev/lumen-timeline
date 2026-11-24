// What the three example screens share: one audio host per screen, an editor and transport per
// project, and the small controls every screen draws around its timeline.
import {
  commands,
  createEditor,
  TICKS_PER_SECOND as hz,
  type Clip,
  type Editor,
  type Project,
  type ProjectSnapshot,
  type Tick,
} from "@lumen-timeline/core";
import {
  createAudioTransport,
  createWaveformTiles,
  type AudioTransport,
  type AudioTransportState,
  type WaveformTiles,
} from "@lumen-timeline/media";
import { useEditorSelector, useTransportSelector } from "@lumen-timeline/react";
import type {
  TimelineEvents,
  TimelineView,
  Viewport,
  WaveformProvider,
} from "@lumen-timeline/timeline";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AudioHost,
  type RateOf,
  catalogFor,
  createAudioHost,
  DEMO_SAMPLE_RATE,
  peakSourcesFor,
} from "../fixtures.ts";

export const sec = (value: number): Tick => Math.round(value * hz);
export const seconds = (tick: Tick): number => tick / hz;

/** `m:ss.d` for readouts and lists. */
export function clock(tick: Tick, digits = 1): string {
  const total = Math.max(0, tick) / hz;
  const scale = 10 ** digits;
  const rounded = Math.round(total * scale) / scale;
  const minutes = Math.floor(rounded / 60);
  const rest = (rounded - minutes * 60).toFixed(digits).padStart(digits ? digits + 3 : 2, "0");
  return `${minutes}:${rest}`;
}

// -------------------------------------------------------------- sessions

/** Recordings are decoded at this rate, the audio context's own, so playback resamples nothing. */
export const VOICE_SAMPLE_RATE = 48000;

/**
 * Fetches and decodes the recordings named, as mono samples at `VOICE_SAMPLE_RATE`. A
 * recording that is missing or does not decode is left out, for the caller to synthesize.
 */
export async function loadRecordings(ids: readonly string[]): Promise<Map<string, Float32Array>> {
  const loaded = new Map<string, Float32Array>();
  if (ids.length === 0) return loaded;
  const decoder = new OfflineAudioContext(1, 1, VOICE_SAMPLE_RATE);
  await Promise.all(
    ids.map(async (id) => {
      try {
        const response = await fetch(`/examples/voices/${id}.mp3`);
        if (!response.ok) return;
        const buffer = await decoder.decodeAudioData(await response.arrayBuffer());
        loaded.set(id, buffer.getChannelData(0));
      } catch {
        // Synthesized instead.
      }
    }),
  );
  return loaded;
}

/** One AudioContext, its buffers and the waveform tiles for a set of assets. */
export interface ExampleHost {
  readonly assets: ReadonlyMap<string, Float32Array>;
  /** The sample rate of each asset. */
  readonly rateOf: RateOf;
  readonly audio: AudioHost;
  readonly waveforms: WaveformTiles;
  readonly close: () => void;
}

/** `recorded` names the assets sampled at `VOICE_SAMPLE_RATE`; the rest are synthesized. */
export function createExampleHost(
  assets: ReadonlyMap<string, Float32Array>,
  recorded: ReadonlySet<string> = new Set(),
): ExampleHost {
  const rateOf: RateOf = (id) => (recorded.has(id) ? VOICE_SAMPLE_RATE : DEMO_SAMPLE_RATE);
  const audio = createAudioHost(assets, rateOf);
  const sources = peakSourcesFor(assets, rateOf);
  const waveforms = createWaveformTiles({
    source: (assetId) => sources.get(assetId) ?? null,
    // Keep main-thread slices available even inside strict sandboxed srcdoc iframes.
    worker: null,
  });
  return {
    assets,
    rateOf,
    audio,
    waveforms,
    close() {
      waveforms.dispose();
      audio.close();
    },
  };
}

export interface ExampleSession {
  readonly editor: Editor;
  readonly transport: AudioTransport;
  readonly dispose: () => void;
}

export function createExampleSession(
  host: ExampleHost,
  project: Project,
  actor: string,
): ExampleSession {
  const editor = createEditor({ project, actor });
  const transport = createAudioTransport({
    editor,
    context: host.audio.context,
    catalog: catalogFor(host.assets, host.rateOf),
    stretch: host.audio.stretch,
    resolveBuffer(span) {
      const buffer = host.audio.buffers.get(span.assetId);
      if (!buffer) throw new Error(`Missing example buffer for ${span.assetId}`);
      return buffer;
    },
  });
  return {
    editor,
    transport,
    dispose() {
      transport.dispose();
      editor.dispose();
    },
  };
}

// ----------------------------------------------------------------- hooks

export const usePlaying = (transport: AudioTransport): boolean =>
  useTransportSelector<AudioTransportState, boolean>(transport, (state) => state.playing);

/**
 * Calls `draw` with the presented tick now and whenever it moves, outside React: a readout or
 * a canvas follows playback without rendering the screen.
 */
export function usePlayhead(transport: AudioTransport, draw: (tick: Tick) => void): void {
  const latest = useRef(draw);
  latest.current = draw;
  useEffect(() => {
    let shown = -1;
    const show = (state: AudioTransportState) => {
      if (state.presentedTick === shown) return;
      shown = state.presentedTick;
      latest.current(shown);
    };
    show(transport.snapshot());
    return transport.subscribe(show);
  }, [transport]);
}

/**
 * The IDs of every clip on `trackIds` under the playhead, earliest start first; renders only
 * when the set changes. Overlapping clips are all listed.
 */
export function useClipsAtPlayhead(
  editor: Editor,
  transport: AudioTransport,
  trackIds: readonly string[],
): readonly string[] {
  const revision = useEditorSelector(editor, (state) => state.snapshot.revision);
  const select = useCallback(
    (state: AudioTransportState): string => {
      const tick = state.presentedTick;
      return editor
        .getSnapshot()
        .clips.filter(
          (clip) =>
            trackIds.includes(clip.trackId) &&
            clip.start <= tick &&
            tick < clip.start + clip.duration,
        )
        .sort((a, b) => a.start - b.start)
        .map((clip) => clip.id)
        .join("\n");
    },
    // A new revision moves clips, so the selector is rebuilt with it.
    [editor, trackIds, revision],
  );
  // The selector answers a string, so an unchanged set does not render.
  const joined = useTransportSelector<AudioTransportState, string>(transport, select);
  return useMemo(() => (joined ? joined.split("\n") : []), [joined]);
}

/**
 * A waveform provider that draws on a decibel scale, as a DAW's log view does: `floor` dB and
 * below is flat, full scale fills the clip. Speech spends most of its time well below its
 * peaks, and on a linear scale it reads as a thin line; this shows how loud it is. Only the
 * picture changes, never the sound.
 */
export function decibelWaveforms(provider: WaveformProvider, floor = -42): WaveformProvider {
  const scaled = new WeakMap<ArrayLike<number>, Float32Array>();
  const level = (value: number): number => {
    const size = Math.abs(value);
    if (size <= 0) return 0;
    const shown = Math.max(0, 1 - (20 * Math.log10(size)) / floor);
    return Math.sign(value) * Math.min(1, shown);
  };
  return {
    peaks(request) {
      const peaks = provider.peaks(request);
      if (!peaks) return null;
      const known = scaled.get(peaks);
      if (known) return known;
      const out = new Float32Array(peaks.length);
      for (let i = 0; i < peaks.length; i++) out[i] = level(peaks[i] ?? 0);
      scaled.set(peaks, out);
      return out;
    },
    ...(provider.subscribe && { subscribe: provider.subscribe.bind(provider) }),
  };
}

/** The mounted view, its zoom, and the events that keep the zoom readout current. */
export function useTimelineView(initialZoom: number): {
  readonly view: TimelineView | null;
  readonly attach: (view: TimelineView | null) => void;
  readonly zoom: number;
  readonly zoomBy: (factor: number) => void;
  readonly viewportEvents: Pick<TimelineEvents, "onViewportChange">;
} {
  const [view, setView] = useState<TimelineView | null>(null);
  const [zoom, setZoom] = useState(initialZoom);
  const attach = useCallback((next: TimelineView | null) => setView(next), []);
  const viewportEvents = useMemo(
    () => ({ onViewportChange: (viewport: Viewport) => setZoom(viewport.pixelsPerSecond) }),
    [],
  );
  const zoomBy = useCallback(
    (factor: number) => {
      if (!view) return;
      const next = Math.min(400, Math.max(6, view.getViewport().pixelsPerSecond * factor));
      view.setViewport({ pixelsPerSecond: next });
      setZoom(next);
    },
    [view],
  );
  return { view, attach, zoom, zoomBy, viewportEvents };
}

// -------------------------------------------------------------- commands

/** Selects a clip, moves the playhead to its start and scrolls it into view. */
export function focusClip(
  session: ExampleSession,
  view: TimelineView | null,
  clipId: string,
  seek = true,
): void {
  const clip = session.editor.getSnapshot().clips.find((item) => item.id === clipId);
  if (!clip) return;
  session.editor.session.select([clipId]);
  if (seek) void session.transport.seek(clip.start);
  view?.reveal(clipId);
}

/** Plays one clip from its start and pauses at its end. */
export function playClip(session: ExampleSession, clip: Clip): void {
  void session.transport
    .seek(clip.start)
    .then(() => session.transport.play({ until: clip.start + clip.duration }));
}

/** Splits the selected clip at the playhead, when the playhead is inside it. */
export function splitAtPlayhead(session: ExampleSession): boolean {
  const tick = session.transport.snapshot().presentedTick;
  const id = session.editor.session.getSelection().at(-1);
  const clip = session.editor.getSnapshot().clips.find((item) => item.id === id);
  if (!clip || tick <= clip.start || tick >= clip.start + clip.duration) return false;
  return session.editor.dispatch(commands.splitClip({ clipId: clip.id, at: tick })).ok;
}

/** The asset and source position a clip plays at a timeline tick, or `null` off the clip. */
export function sourceAt(
  snapshot: ProjectSnapshot,
  clip: Clip,
  tick: Tick,
  rateOf: RateOf = () => DEMO_SAMPLE_RATE,
): { readonly assetId: string; readonly sample: number } | null {
  if (tick < clip.start || tick >= clip.start + clip.duration) return null;
  const take = snapshot.takes?.find((item) => item.id === clip.activeTakeId);
  const assetId = take?.assetId ?? clip.source?.assetId;
  if (!assetId) return null;
  const zero = take?.sourceAtContentZero ?? clip.source?.sourceAtContentZero ?? 0;
  const content = clip.contentIn + (tick - clip.start) * (clip.rate ?? 1);
  return { assetId, sample: Math.round(((zero + content) / hz) * rateOf(assetId)) };
}

// -------------------------------------------------------------- controls

const ICONS = {
  play: "M5 3.2v9.6L13 8z",
  pause: "M4 3h3v10H4zM9 3h3v10H9z",
  undo: "M5.5 3 2.5 6l3 3M2.5 6h7a4 4 0 0 1 0 8H6",
  redo: "m10.5 3 3 3-3 3M13.5 6h-7a4 4 0 0 0 0 8H10",
  split: "M8 1.5v13M2.5 5.5l3 2.5-3 2.5M13.5 5.5l-3 2.5 3 2.5",
  check: "m3 8.5 3.2 3.2L13 4.8",
  spark: "M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8 6.6 6.6z",
  loop: "M3 7V6a2 2 0 0 1 2-2h7m0 0-2-2m2 2-2 2M13 9v1a2 2 0 0 1-2 2H4m0 0 2 2m-2-2 2-2",
  download: "M8 2v8m0 0L5 7m3 3 3-3M3 13h10",
  plus: "M8 3v10M3 8h10",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5",
  flag: "M4 14V2.5M4 3h8l-1.8 2.75L12 8.5H4",
  fit: "M2 8h12M2 8l2.5-2.5M2 8l2.5 2.5M14 8l-2.5-2.5M14 8l-2.5 2.5",
  ear: "M5 6.5a3.5 3.5 0 1 1 6.2 2.2c-.9 1-1.4 1.5-1.4 2.6a2 2 0 0 1-3.6 1.2",
  wave: "M2 8h1.5M5 5v6M7.5 3v10M10 5.5v5M12.5 7v2",
  edit: "M11 2.5l2.5 2.5L6 12.5l-3.2.7.7-3.2zM9.5 4l2.5 2.5",
} as const;

const FILLED: readonly IconName[] = ["play", "pause", "spark"];

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 14 }: { name: IconName; size?: number }): ReactElement {
  const filled = FILLED.includes(name);
  return (
    <svg
      className="ex-icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

export function PlayButton({ transport }: { transport: AudioTransport }): ReactElement {
  const playing = usePlaying(transport);
  return (
    <button
      type="button"
      className="ex-play"
      aria-label={playing ? "Pause" : "Play"}
      data-example-play
      onClick={() => (playing ? transport.pause() : void transport.play())}
    >
      <Icon name={playing ? "pause" : "play"} size={15} />
    </button>
  );
}

/** A readout that follows the playhead without rendering its parent. */
export function Readout({
  transport,
  format,
  className = "ex-time",
}: {
  transport: AudioTransport;
  format: (tick: Tick) => string;
  className?: string;
}): ReactElement {
  const element = useRef<HTMLSpanElement>(null);
  usePlayhead(transport, (tick) => {
    if (element.current) element.current.textContent = format(tick);
  });
  return <span ref={element} className={className} data-example-time />;
}

export function HistoryButtons({ editor }: { editor: Editor }): ReactElement {
  const history = useEditorSelector(editor, (state) => state.history);
  return (
    <span className="ex-group">
      <button
        type="button"
        className="ex-tool"
        aria-label="Undo"
        title="Undo"
        disabled={history.undoDepth === 0}
        onClick={() => editor.history.undo()}
      >
        <Icon name="undo" />
      </button>
      <button
        type="button"
        className="ex-tool"
        aria-label="Redo"
        title="Redo"
        disabled={history.redoDepth === 0}
        onClick={() => editor.history.redo()}
      >
        <Icon name="redo" />
      </button>
    </span>
  );
}

export function ZoomButtons({
  zoom,
  base,
  onZoom,
}: {
  zoom: number;
  base: number;
  onZoom: (factor: number) => void;
}): ReactElement {
  return (
    <span className="ex-zoom">
      <button type="button" aria-label="Zoom out" onClick={() => onZoom(1 / 1.25)}>
        −
      </button>
      <span>{Math.round((zoom / base) * 100)}%</span>
      <button type="button" aria-label="Zoom in" onClick={() => onZoom(1.25)}>
        +
      </button>
    </span>
  );
}

/** The frame every example opens in while its audio is synthesized. */
export function Loading({ label }: { label: string }): ReactElement {
  return (
    <div className="ex-app ex-loading">
      <p>{label}</p>
    </div>
  );
}
