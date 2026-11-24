// Example screen 3: a multitrack music session. The ruler counts bars and beats, a section can
// cycle, the lead vocal is comped from take lanes, and a mixer below drives the same track gain,
// mute and solo that the timeline's own headers show.
import { commands, type Editor, type Tick, type Track } from "@lumen-timeline/core";
import type { AudioTransportState } from "@lumen-timeline/media";
import { Timeline, useEditorSelector, useTransportSelector } from "@lumen-timeline/react";
import type {
  OverlayRenderer,
  TimelineChrome,
  TimelineEvents,
  TimelineTheme,
} from "@lumen-timeline/timeline";
import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import { DEMO_FONTS, type Scheme, useSiteScheme } from "../scheme.ts";
import {
  BAR,
  BARS,
  barTick,
  BEAT,
  BPM,
  createSessionAssets,
  createSessionProject,
} from "./session-data.ts";
import {
  clock,
  createExampleHost,
  createExampleSession,
  type ExampleHost,
  type ExampleSession,
  HistoryButtons,
  Icon,
  Loading,
  PlayButton,
  Readout,
  sec,
  sourceAt,
  splitAtPlayhead,
  useTimelineView,
  ZoomButtons,
} from "./shared.tsx";

const BASE_ZOOM = 36;
const BEAT_TICKS = sec(BEAT);
const BAR_TICKS = sec(BAR);
const CHROME: TimelineChrome = {
  toolbar: false,
  editToolbar: false,
  markerEditor: false,
  status: false,
  // The Takes panel splits and opens the lanes, so the floating clip toolbar stays out.
  clipToolbar: false,
};
const LAYOUT = { laneHeight: 40, rowInset: 7 } as const;
const SNAP = { gridTicks: BEAT_TICKS / 4 } as const;
const LABELS = { takeLanes: "Takes" } as const;

const PALETTES: Readonly<Record<Scheme, NonNullable<TimelineTheme["palette"]>>> = {
  dark: [
    { fill: "#f9a870", stripe: "#f9a870", waveform: "#593215", text: "#0c0e11" },
    { fill: "#f5c451", stripe: "#f5c451", waveform: "#5c4308", text: "#0c0e11" },
    { fill: "#c3aeff", stripe: "#c3aeff", waveform: "#40355e", text: "#0c0e11" },
    { fill: "#6cc4f5", stripe: "#6cc4f5", waveform: "#0f4265", text: "#0c0e11" },
    { fill: "#4cd7c8", stripe: "#4cd7c8", waveform: "#004942", text: "#0c0e11" },
  ],
  light: [
    { fill: "#fde6d6", stripe: "#d9783a", waveform: "#e08548", text: "#5a2a0c" },
    { fill: "#fdebc4", stripe: "#b7791f", waveform: "#c98d2e", text: "#553808" },
    { fill: "#e9e4ff", stripe: "#7a66de", waveform: "#8b78e6", text: "#2d2175" },
    { fill: "#dcedf9", stripe: "#2f7fb8", waveform: "#5a9fd0", text: "#123f61" },
    { fill: "#d8f1ec", stripe: "#1a8f7d", waveform: "#2fa392", text: "#0b4a40" },
  ],
};

/** `bar.beat.sixteenth`, each counted from 1. */
function position(tick: Tick): string {
  const sixteenths = Math.floor(Math.max(0, tick) / (BEAT_TICKS / 4) + 1e-6);
  return `${Math.floor(sixteenths / 16) + 1}.${(Math.floor(sixteenths / 4) % 4) + 1}.${(sixteenths % 4) + 1}`;
}

/** The ruler's label: the bar number on a bar line, `bar.beat` inside one. */
function rulerLabel(tick: Tick): string {
  const beats = Math.round(tick / BEAT_TICKS);
  return beats % 4 === 0
    ? String(beats / 4 + 1)
    : `${Math.floor(beats / 4) + 1}.${(beats % 4) + 1}`;
}

/** One label per beat when zoomed in, per bar by default, per two or four bars zoomed out. */
function gridSpacing(pixelsPerSecond: number): Tick {
  const bar = BAR * pixelsPerSecond;
  if (bar >= 260) return BEAT_TICKS;
  if (bar >= 44) return BAR_TICKS;
  return bar >= 22 ? BAR_TICKS * 2 : BAR_TICKS * 4;
}

const decibels = (gain: number): string =>
  gain <= 0.001 ? "−∞" : `${gain >= 1 ? "+" : "−"}${Math.abs(20 * Math.log10(gain)).toFixed(1)}`;

// ------------------------------------------------------------------- mixer

function Strip({
  editor,
  track,
  color,
  meter,
}: {
  editor: Editor;
  track: Track;
  color: string;
  meter: (element: HTMLElement | null) => void;
}): ReactElement {
  const gain = track.gain ?? 1;
  const before = useRef<number | null>(null);
  const set = (value: number, history: "record" | "ignore") =>
    editor.dispatch(commands.updateTrack({ trackId: track.id, gain: value }), { history });
  return (
    <div
      className="ses-strip"
      data-track={track.id}
      ref={(element) => element?.style.setProperty("--strip", color)}
    >
      <div className="ses-fader">
        <span className="ses-meter">
          <i ref={meter} />
        </span>
        <input
          type="range"
          min="0"
          max="1.4"
          step="0.01"
          value={gain}
          aria-label={`${track.name ?? track.id} level`}
          // A drag previews without history, then lands as one undoable edit.
          onPointerDown={() => (before.current = gain)}
          onChange={(event) => set(Number(event.target.value), "ignore")}
          onPointerUp={() => {
            const from = before.current;
            before.current = null;
            if (from === null || from === gain) return;
            set(from, "ignore");
            set(gain, "record");
          }}
          onKeyUp={() => set(gain, "record")}
        />
      </div>
      <output>{decibels(gain)}</output>
      <span className="ses-ms">
        <button
          type="button"
          aria-pressed={track.mute === true}
          aria-label={`Mute ${track.name ?? track.id}`}
          onClick={() =>
            editor.dispatch(commands.updateTrack({ trackId: track.id, mute: !track.mute }))
          }
        >
          M
        </button>
        <button
          type="button"
          data-solo
          aria-pressed={track.solo === true}
          aria-label={`Solo ${track.name ?? track.id}`}
          onClick={() =>
            editor.dispatch(commands.updateTrack({ trackId: track.id, solo: !track.solo }))
          }
        >
          S
        </button>
      </span>
      <strong>{track.name ?? track.id}</strong>
    </div>
  );
}

/** Drives each strip's meter from the samples under the playhead, outside React. */
function useMeters(host: ExampleHost, session: ExampleSession) {
  const bars = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    const { editor, transport } = session;
    const levels = new Map<string, number>();
    const show = (state: AudioTransportState) => {
      const snapshot = editor.getSnapshot();
      const soloed = snapshot.tracks.some((track) => track.solo);
      for (const track of snapshot.tracks) {
        let peak = 0;
        const heard = !track.mute && (!soloed || track.solo === true);
        if (state.playing && heard) {
          for (const clip of snapshot.clips) {
            if (clip.trackId !== track.id) continue;
            const source = sourceAt(snapshot, clip, state.presentedTick);
            const pcm = source && host.assets.get(source.assetId);
            if (!source || !pcm) continue;
            const end = Math.min(pcm.length, source.sample + 720);
            for (let i = Math.max(0, source.sample); i < end; i++) {
              peak = Math.max(peak, Math.abs(pcm[i] ?? 0));
            }
          }
        }
        // Fast up, slow down, like a peak meter.
        const level = Math.max(peak * (track.gain ?? 1) * 1.9, (levels.get(track.id) ?? 0) * 0.86);
        levels.set(track.id, level < 0.004 ? 0 : level);
        const bar = bars.current.get(track.id);
        if (bar) bar.style.transform = `scaleY(${Math.min(1, level)})`;
      }
    };
    show(transport.snapshot());
    const stop = transport.subscribe(show);
    // The meters fall back after playback stops, when the transport is quiet.
    const settle = window.setInterval(() => {
      if (!transport.snapshot().playing) show(transport.snapshot());
    }, 50);
    return () => {
      stop();
      window.clearInterval(settle);
    };
  }, [host, session]);
  return (trackId: string) => (element: HTMLElement | null) => {
    if (element) bars.current.set(trackId, element);
    else bars.current.delete(trackId);
  };
}

// ----------------------------------------------------------------- session

function Session({ host, session }: { host: ExampleHost; session: ExampleSession }): ReactElement {
  const { editor, transport } = session;
  const scheme = useSiteScheme();
  const { view, attach, zoom, zoomBy, viewportEvents } = useTimelineView(BASE_ZOOM);
  const snapshot = useEditorSelector(editor, (state) => state.snapshot);
  const selectedId = useEditorSelector(editor, (state) => state.selection.at(-1) ?? null);
  const loop = useTransportSelector<AudioTransportState, AudioTransportState["loop"]>(
    transport,
    (state) => state.loop,
  );
  const auditioning = useTransportSelector<AudioTransportState, string | null>(
    transport,
    (state) => state.audition?.takeId ?? null,
  );
  const [speed, setSpeed] = useState(1);
  // The clip whose take lanes are open. They close when the selection leaves it.
  const [lanes, setLanes] = useState<string | null>("vox-verse");
  const meter = useMeters(host, session);
  const palette = PALETTES[scheme];

  const selected = snapshot.clips.find((clip) => clip.id === selectedId) ?? null;
  const takes = useMemo(
    () => (selected?.takeIds?.length ? editor.read(snapshot).takesOf(selected.id) : []),
    [editor, snapshot, selected],
  );
  const sections = (snapshot.markers ?? []).filter((marker) => marker.duration);
  const cycling = sections.find(
    (marker) =>
      loop && marker.start === loop.start && marker.start + (marker.duration ?? 0) === loop.end,
  );

  useEffect(() => {
    if (!view) return;
    const open = lanes !== null && lanes === selectedId;
    if (!view.showTakeLanes(open ? lanes : null) || !open) setLanes(null);
  }, [view, lanes, selectedId]);

  // The cycle range is the transport's; the view only tints it.
  useEffect(() => view?.repaint("overlay"), [view, loop]);
  const renderOverlay = useMemo<OverlayRenderer>(
    () =>
      ({ ctx, height, pixelAt }) => {
        const range = transport.snapshot().loop;
        if (!range) return;
        const x0 = pixelAt(range.start);
        const x1 = pixelAt(range.end);
        ctx.fillStyle = scheme === "dark" ? "rgba(193,243,84,0.07)" : "rgba(156,75,30,0.07)";
        ctx.fillRect(x0, 0, x1 - x0, height);
        ctx.fillStyle = scheme === "dark" ? "rgba(193,243,84,0.6)" : "rgba(156,75,30,0.55)";
        ctx.fillRect(x0, 0, 1.5, height);
        ctx.fillRect(x1 - 1.5, 0, 1.5, height);
      },
    [transport, scheme],
  );

  const events = useMemo<TimelineEvents>(
    () => ({
      ...viewportEvents,
      onTakeAudition({ clipId, takeId }) {
        if (transport.snapshot().audition?.takeId === takeId) transport.cancelAudition();
        else void transport.audition({ clipId, takeId, mode: "mix" });
      },
    }),
    [transport, viewportEvents],
  );
  const theme = useMemo(
    () => ({
      scheme,
      ...DEMO_FONTS,
      palette,
      grid: scheme === "dark" ? "#ffffff0d" : "#0000000d",
    }),
    [scheme, palette],
  );

  const cycle = (markerId: string | null) => {
    const marker = sections.find((item) => item.id === markerId);
    if (!marker) {
      transport.setLoop(null);
      return;
    }
    transport.setLoop({ start: marker.start, end: marker.start + (marker.duration ?? 0) });
    void transport.seek(marker.start);
  };
  const changeSpeed = (next: number) => {
    transport.setPlaybackRate(next);
    setSpeed(next);
  };

  return (
    <div className="ex-app ses" data-demo-ready="session">
      <header className="ex-topbar ses-topbar">
        <span className="ex-brand">
          <i aria-hidden="true" />
          Session
        </span>
        <span className="ex-project">
          Low Tide <em>demo · v3</em>
        </span>
        <span className="ex-spacer" />
        <div className="ses-transport">
          <button
            type="button"
            className="ex-tool"
            aria-label="Return to start"
            title="Return to start"
            onClick={() => void transport.seek(loop?.start ?? 0)}
          >
            <span className="ses-rewind" aria-hidden="true" />
          </button>
          <PlayButton transport={transport} />
          <span className="ex-lcd ses-lcd">
            <Readout transport={transport} format={position} />
            <Readout transport={transport} format={(tick) => clock(tick)} className="ses-clock" />
          </span>
          <span className="ses-readout">
            <b>{BPM}</b>
            <i>BPM</i>
          </span>
          <span className="ses-readout">
            <b>4/4</b>
            <i>Time</i>
          </span>
          <span className="ses-readout">
            <b>A min</b>
            <i>Key</i>
          </span>
        </div>
        <span className="ex-spacer" />
        <span className="ex-seg" role="group" aria-label="Cycle a section">
          <button type="button" aria-pressed={!loop} onClick={() => cycle(null)}>
            <Icon name="loop" size={12} /> Off
          </button>
          {sections.map((marker) => (
            <button
              key={marker.id}
              type="button"
              aria-pressed={cycling?.id === marker.id}
              data-ses-cycle={marker.id}
              onClick={() => cycle(marker.id)}
            >
              {marker.label}
            </button>
          ))}
        </span>
      </header>

      <div className="ex-toolbar ses-tools">
        <HistoryButtons editor={editor} />
        <button
          type="button"
          className="ex-tool ex-tool-text"
          title="Split the selected region at the playhead, then pick a take for each piece"
          onClick={() => splitAtPlayhead(session)}
        >
          <Icon name="split" /> Split
        </button>
        <span className="ex-seg" role="group" aria-label="Varispeed">
          {[0.5, 0.75, 1].map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={speed === value}
              onClick={() => changeSpeed(value)}
            >
              {value === 1 ? "1×" : value === 0.5 ? "½×" : "¾×"}
            </button>
          ))}
        </span>
        <span className="ses-hint">Snap 1/16</span>
        <span className="ex-spacer" />
        <ZoomButtons zoom={zoom} base={BASE_ZOOM} onZoom={zoomBy} />
      </div>

      <Timeline
        className="ex-timeline ses-timeline"
        editor={editor}
        transport={transport}
        waveforms={host.waveforms}
        pixelsPerSecond={BASE_ZOOM}
        snap={SNAP}
        chrome={CHROME}
        labels={LABELS}
        layout={LAYOUT}
        theme={theme}
        formatTime={rulerLabel}
        gridSpacing={gridSpacing}
        renderOverlay={renderOverlay}
        events={events}
        ref={attach}
      />

      <div className="ses-lower">
        <section className="ses-mixer" aria-label="Mixer">
          {snapshot.tracks.map((track, index) => (
            <Strip
              key={track.id}
              editor={editor}
              track={track}
              color={palette[index % palette.length]?.stripe ?? "#888"}
              meter={meter(track.id)}
            />
          ))}
        </section>
        <aside className="ses-takes" data-ses-takes>
          <h3>
            Takes
            {selected && (
              <em>
                {selected.name} · bars {Math.round(selected.start / BAR_TICKS) + 1}–
                {Math.round((selected.start + selected.duration) / BAR_TICKS)}
              </em>
            )}
            {selected && takes.length > 1 && (
              <button
                type="button"
                className="ex-btn"
                aria-pressed={lanes === selected.id}
                onClick={() => setLanes(lanes === selected.id ? null : selected.id)}
              >
                <Icon name="wave" size={12} /> Lanes
              </button>
            )}
          </h3>
          {takes.length > 0 && selected ? (
            <>
              <ul>
                {takes.map((take) => (
                  <li key={take.id} data-active={take.id === selected.activeTakeId || undefined}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={take.id === selected.activeTakeId}
                      onClick={() =>
                        editor.dispatch(
                          commands.selectTake({ clipId: selected.id, takeId: take.id }),
                        )
                      }
                    >
                      {take.label ?? take.id}
                    </button>
                    <button
                      type="button"
                      className="ex-tool"
                      aria-label={`Audition ${take.label ?? take.id}`}
                      onClick={() =>
                        events.onTakeAudition?.({ clipId: selected.id, takeId: take.id })
                      }
                    >
                      <Icon name={auditioning === take.id ? "pause" : "play"} size={11} />
                    </button>
                  </li>
                ))}
              </ul>
              <p>
                To comp, put the playhead inside the region, <b>Split</b>, then choose a take for
                each piece. The play buttons audition a take in the mix without changing the comp.
              </p>
            </>
          ) : (
            <p>Select a lead vocal region to choose between its takes.</p>
          )}
        </aside>
      </div>

      <footer className="ex-statusbar">
        <span>
          {BARS} bars · {snapshot.tracks.length} tracks · {clock(barTick(BARS + 1), 0)}
        </span>
        <span>
          <kbd>T</kbd> take lanes <kbd>S</kbd> split <kbd>R</kbd> stretch edges
        </span>
        <span className="ex-spacer" />
        <span>{cycling ? `Cycling ${cycling.label}` : "Cycle off"}</span>
      </footer>
    </div>
  );
}

export default function MusicSession(): ReactElement {
  const [state, setState] = useState<{ host: ExampleHost; session: ExampleSession } | null>(null);

  useEffect(() => {
    const host = createExampleHost(createSessionAssets());
    const session = createExampleSession(host, createSessionProject(), "session.demo");
    session.editor.session.select(["vox-verse"]);
    void session.transport.seek(barTick(5));
    setState({ host, session });
    return () => {
      session.dispose();
      host.close();
    };
  }, []);

  if (!state) return <Loading label="Synthesizing the band…" />;
  return <Session host={state.host} session={state.session} />;
}
