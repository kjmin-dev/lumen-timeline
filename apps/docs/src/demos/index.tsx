import { commands, createEditor, TICKS_PER_SECOND as hz, type Editor } from "@lumen-timeline/core";
import {
  createAudioTransport,
  createWaveformTiles,
  type AudioTransport,
  type WaveformTiles,
} from "@lumen-timeline/media";
import { Timeline, TimelineProvider, useEditorSelector } from "@lumen-timeline/react";
import {
  connectSession,
  createSequencer,
  type Sequencer,
  type SessionStatus,
  type SyncSession,
} from "@lumen-timeline/sync";
import type {
  TimelineEvents,
  TimelineOptions,
  TimelineTransport,
  TimelineView,
} from "@lumen-timeline/timeline";
import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import {
  createClockTransport,
  createDemoCatalog,
  createDirectChannel,
  createPeakSourceMap,
  createStudioAudioHost,
  createStudioProject,
  createSyncProject,
} from "./fixtures.ts";

export const DEMO_NAMES = ["studio", "sync"] as const;
export type DemoName = (typeof DEMO_NAMES)[number];

type RendererChoice = NonNullable<TimelineOptions["renderer"]>;

const RENDERERS: readonly RendererChoice[] = ["auto", "webgl2", "canvas2d"];

// ---------------------------------------------------------------- studio demo

interface StudioSession {
  readonly editor: Editor;
  readonly transport: AudioTransport;
  readonly waveforms: WaveformTiles;
  readonly dispose: () => void;
}

function createStudioSession(): StudioSession {
  const editor = createEditor({ project: createStudioProject(), actor: "studio.demo" });
  editor.session.select(["nar-1"]);
  const first = editor.getSnapshot().clips.find((clip) => clip.id === "nar-1");
  const audio = createStudioAudioHost();
  const catalog = createDemoCatalog();
  const transport = createAudioTransport({
    editor,
    context: audio.context,
    catalog,
    stretch: audio.stretch,
    resolveBuffer(span) {
      const buffer = audio.buffers.get(span.assetId);
      if (!buffer) throw new Error(`Missing demo buffer for ${span.assetId}`);
      return buffer;
    },
  });
  // The playhead starts inside the selected line, so Split has somewhere to cut.
  if (first) void transport.seek(first.start + Math.round(first.duration / 3));
  const sources = createPeakSourceMap();
  const waveforms = createWaveformTiles({
    source: (assetId) => sources.get(assetId) ?? null,
    // Keep main-thread slices available even inside strict sandboxed srcdoc iframes.
    worker: null,
  });
  return {
    editor,
    transport,
    waveforms,
    dispose() {
      waveforms.dispose();
      transport.dispose();
      editor.dispose();
      audio.close();
    },
  };
}

type Scheme = "light" | "dark";

function readScheme(): Scheme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

/** The site's color scheme, which the docs page copies onto the demo frame's root. */
function useSiteScheme(): Scheme {
  const [scheme, setScheme] = useState<Scheme>("dark");
  useEffect(() => {
    setScheme(readScheme());
    const watch = new MutationObserver(() => setScheme(readScheme()));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => watch.disconnect();
  }, []);
  return scheme;
}

const DEMO_FONTS = {
  nameFont: '600 11.5px "Inter", system-ui, sans-serif',
  captionFont: '10.5px "Inter", system-ui, sans-serif',
  markerFont: '700 10px "Inter", system-ui, sans-serif',
} as const;

// The selected clip's own toolbar splits it, so the edit form stays out.
const STUDIO_CHROME = { editToolbar: false } as const;

function StudioFooter({
  renderer,
  backend,
  onRenderer,
  onReset,
}: {
  readonly renderer: RendererChoice;
  readonly backend: string;
  readonly onRenderer: (next: RendererChoice) => void;
  readonly onReset: () => void;
}): ReactElement {
  return (
    <div className="demo-footer">
      <p className="demo-hint">
        Drag clips to move or trim, click the ruler to scrub. <kbd>S</kbd> splits, <kbd>T</kbd>{" "}
        shows takes, <kbd>R</kbd> makes edge drags stretch, <kbd>Ctrl/Cmd+Z</kbd> undoes.
      </p>
      <span className="demo-spacer" />
      <span className="demo-badge" data-demo-backend>
        {backend}
      </span>
      <label className="demo-meta">
        Renderer{" "}
        <select
          className="demo-select"
          aria-label="Drawing backend"
          value={renderer}
          onChange={(event) => {
            const found = RENDERERS.find((item) => item === event.target.value);
            if (found) onRenderer(found);
          }}
        >
          <option value="auto">auto</option>
          <option value="webgl2">webgl2</option>
          <option value="canvas2d">canvas2d</option>
        </select>
      </label>
      <button type="button" className="demo-btn" onClick={onReset}>
        Reset
      </button>
    </div>
  );
}

function StudioDemo(): ReactElement {
  const [session, setSession] = useState<StudioSession | null>(null);
  const [renderer, setRenderer] = useState<RendererChoice>("auto");
  const [backend, setBackend] = useState("mounting");
  // Counts resets, so each session mounts a view of its own.
  const [generation, setGeneration] = useState(0);
  const scheme = useSiteScheme();

  useEffect(() => {
    const created = createStudioSession();
    setSession(created);
    return () => {
      created.dispose();
    };
  }, []);

  const handleViewRef = useCallback((view: TimelineView | null) => {
    if (!view) return;
    setBackend(view.getDiagnostics().backend);
    // The selected line opens with its candidates as take lanes.
    view.showTakeLanes("nar-1");
  }, []);

  const handleReset = useCallback(() => {
    setSession((prev) => {
      prev?.dispose();
      return createStudioSession();
    });
    setGeneration((count) => count + 1);
  }, []);

  const transport = session?.transport;
  const events = useMemo<TimelineEvents | undefined>(
    () =>
      transport && {
        // The view asks; the audio transport plays the candidate on its own.
        onTakeAudition({ clipId, takeId }) {
          if (transport.snapshot().audition?.takeId === takeId) transport.cancelAudition();
          else void transport.audition({ clipId, takeId, mode: "isolated" });
        },
      },
    [transport],
  );
  const theme = useMemo(() => ({ scheme, ...DEMO_FONTS }), [scheme]);

  if (!session) {
    return (
      <div className="demo-shell">
        <p className="demo-hint">Initializing Web Audio &amp; waveforms…</p>
      </div>
    );
  }

  return (
    <TimelineProvider editor={session.editor} transport={session.transport}>
      <div className="demo-shell" data-demo-ready="studio">
        <Timeline
          key={generation}
          className="demo-timeline"
          editor={session.editor}
          transport={session.transport}
          waveforms={session.waveforms}
          renderer={renderer}
          pixelsPerSecond={36}
          snap={{ gridTicks: hz / 10 }}
          chrome={STUDIO_CHROME}
          theme={theme}
          events={events}
          ref={handleViewRef}
        />
        <StudioFooter
          renderer={renderer}
          backend={backend}
          onRenderer={setRenderer}
          onReset={handleReset}
        />
      </div>
    </TimelineProvider>
  );
}

// ---------------------------------------------------------------- sync demo

interface SyncDemoState {
  readonly sequencer: Sequencer;
  readonly sessionA: SyncSession;
  readonly sessionB: SyncSession;
  readonly editorA: Editor;
  readonly editorB: Editor;
  readonly transportA: TimelineTransport & { dispose(): void };
  readonly transportB: TimelineTransport & { dispose(): void };
  readonly waveforms: WaveformTiles;
  readonly toggleOfflineB: () => boolean;
  readonly dispose: () => void;
}

// Two editors side by side: each keeps the transport, history and the lanes.
const SYNC_CHROME = {
  clipNavigator: false,
  markerNavigator: false,
  markerEditor: false,
  editToolbar: false,
  snapToggle: false,
  stretchToggle: false,
  trackControls: false,
} as const;

function SyncPane({
  label,
  editor,
  transport,
  waveforms,
  actor,
  status,
  pending,
  offlineControl,
}: {
  readonly label: string;
  readonly editor: Editor;
  readonly transport: TimelineTransport;
  readonly waveforms: WaveformTiles;
  readonly actor: string;
  readonly status: SessionStatus;
  readonly pending: number;
  readonly offlineControl?: { readonly offline: boolean; readonly onToggle: () => void };
}): ReactElement {
  const revision = useEditorSelector(editor, (state) => state.snapshot.revision);
  const selectedId = useEditorSelector(editor, (state) => state.selection.at(-1) ?? null);
  const scheme = useSiteScheme();
  const theme = useMemo(() => ({ scheme, ...DEMO_FONTS }), [scheme]);

  const nudge = (deltaSec: number) => {
    const target = selectedId ?? editor.getSnapshot().clips[0]?.id;
    if (!target) return;
    editor.dispatch(commands.moveClips({ clipIds: [target], delta: Math.round(deltaSec * hz) }));
  };

  return (
    <div className="sync-pane" data-sync-pane={label}>
      <div className="demo-bar">
        <strong>{label}</strong>
        <span className="demo-badge">
          {actor} · rev {revision} · {status}
        </span>
        {pending > 0 && <span className="demo-meta">pending: {pending}</span>}
        <span className="demo-spacer" />
        <div className="demo-controls">
          <button type="button" className="demo-btn" data-nudge-right onClick={() => nudge(0.5)}>
            Move +0.5s
          </button>
          {offlineControl && (
            <button
              type="button"
              className="demo-btn"
              data-toggle-offline
              aria-pressed={offlineControl.offline}
              onClick={offlineControl.onToggle}
            >
              {offlineControl.offline ? "Reconnect" : "Go offline"}
            </button>
          )}
        </div>
      </div>
      <Timeline
        editor={editor}
        transport={transport}
        waveforms={waveforms}
        pixelsPerSecond={26}
        snap={{ gridTicks: hz / 10 }}
        chrome={SYNC_CHROME}
        theme={theme}
      />
    </div>
  );
}

function SyncDemo(): ReactElement {
  const [state, setState] = useState<SyncDemoState | null>(null);
  const [statusA, setStatusA] = useState<SessionStatus>("connecting");
  const [statusB, setStatusB] = useState<SessionStatus>("connecting");
  const [pendingA, setPendingA] = useState(0);
  const [pendingB, setPendingB] = useState(0);
  const [offlineB, setOfflineB] = useState(false);
  const [lastEvent, setLastEvent] = useState("Both editors share one in-memory sequencer.");

  useEffect(() => {
    let active = true;
    let actorCount = 0;
    const sequencer = createSequencer({
      id: "docs-sync",
      project: createSyncProject(),
      newActor: () => {
        actorCount++;
        if (actorCount === 1) return "editor.a";
        if (actorCount === 2) return "editor.b";
        return `editor.${actorCount}`;
      },
    });
    const linkA = createDirectChannel();
    let linkB = createDirectChannel();
    const closeA = sequencer.connect(linkA.sequencer);
    let closeB = sequencer.connect(linkB.sequencer);
    const sessionA = connectSession({ id: "docs-sync", transport: linkA.editor, policy: "queue" });
    const sessionB = connectSession({ id: "docs-sync", transport: linkB.editor, policy: "queue" });

    const unsubA = sessionA.subscribe((report) => {
      if (report.type === "status") setStatusA(report.status);
      if (report.type === "pending") setPendingA(report.count);
      if (report.type === "rejected") setLastEvent(`Editor A rejected: ${report.reason}`);
    });
    const unsubB = sessionB.subscribe((report) => {
      if (report.type === "status") setStatusB(report.status);
      if (report.type === "pending") setPendingB(report.count);
      if (report.type === "rejected") setLastEvent(`Editor B rejected: ${report.reason}`);
      if (report.type === "settled") setLastEvent("Editor B settled queued edits on reconnect.");
    });

    const duration = 20 * hz;
    const transportA = createClockTransport(duration);
    const transportB = createClockTransport(duration);
    const sources = createPeakSourceMap();
    const waveforms = createWaveformTiles({
      source: (assetId) => sources.get(assetId) ?? null,
      worker: null,
    });

    let isOffline = false;
    let created: SyncDemoState | null = null;

    void Promise.all([sessionA.ready, sessionB.ready]).then(([editorA, editorB]) => {
      if (!active) return;
      editorA.session.select(["cue-1"]);
      editorB.session.select(["cue-2"]);
      setStatusA(sessionA.status);
      setStatusB(sessionB.status);
      created = {
        sequencer,
        sessionA,
        sessionB,
        editorA,
        editorB,
        transportA,
        transportB,
        waveforms,
        toggleOfflineB() {
          if (!isOffline) {
            isOffline = true;
            closeB();
            sessionB.disconnect();
            setOfflineB(true);
            setLastEvent("Editor B disconnected (queue policy): local edits stay queued.");
          } else {
            isOffline = false;
            linkB = createDirectChannel();
            closeB = sequencer.connect(linkB.sequencer);
            sessionB.reconnect(linkB.editor);
            setOfflineB(false);
            setLastEvent("Editor B reconnected: sequencer ordered pending transactions.");
          }
          return isOffline;
        },
        dispose() {
          unsubA();
          unsubB();
          closeA();
          closeB();
          waveforms.dispose();
          transportA.dispose();
          transportB.dispose();
          sessionA.dispose();
          sessionB.dispose();
          editorA.dispose();
          editorB.dispose();
          sequencer.dispose();
        },
      };
      setState(created);
    });

    return () => {
      active = false;
      if (created) {
        created.dispose();
      } else {
        unsubA();
        unsubB();
        closeA();
        closeB();
        waveforms.dispose();
        transportA.dispose();
        transportB.dispose();
        sessionA.dispose();
        sessionB.dispose();
        sequencer.dispose();
      }
    };
  }, []);

  if (!state) {
    return (
      <div className="demo-shell">
        <div className="demo-bar">
          <strong>Shared session demo</strong>
          <span className="demo-meta">Connecting two editors to sequencer…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="demo-shell" data-demo-ready="sync">
      <div className="sync-grid">
        <SyncPane
          label="Editor A"
          editor={state.editorA}
          transport={state.transportA}
          waveforms={state.waveforms}
          actor={state.sessionA.actor ?? "editor.a"}
          status={statusA}
          pending={pendingA}
        />
        <SyncPane
          label="Editor B"
          editor={state.editorB}
          transport={state.transportB}
          waveforms={state.waveforms}
          actor={state.sessionB.actor ?? "editor.b"}
          status={statusB}
          pending={pendingB}
          offlineControl={{
            offline: offlineB,
            onToggle: () => {
              state.toggleOfflineB();
            },
          }}
        />
      </div>
      <p className="sync-log" role="status" data-sync-log>
        {lastEvent}
      </p>
    </div>
  );
}

export function Demo({ name }: { readonly name: DemoName }): ReactElement {
  return name === "sync" ? <SyncDemo /> : <StudioDemo />;
}
