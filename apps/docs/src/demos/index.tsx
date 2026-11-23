import {
  commands,
  createEditor,
  shallowEqual,
  TICKS_PER_SECOND as hz,
  type Editor,
  type EditorState,
} from "@lumen-timeline/core";
import {
  createAudioTransport,
  createWaveformTiles,
  type AudioTransport,
  type AudioTransportState,
  type WaveformTiles,
} from "@lumen-timeline/media";
import {
  Timeline,
  TimelineProvider,
  useEditorSelector,
  useTimelineContext,
  useTransportSelector,
} from "@lumen-timeline/react";
import {
  connectSession,
  createSequencer,
  type Sequencer,
  type SessionStatus,
  type SyncSession,
} from "@lumen-timeline/sync";
import type { TimelineOptions, TimelineTransport, TimelineView } from "@lumen-timeline/timeline";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
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

function formatSeconds(tick: number): string {
  return `${(tick / hz).toFixed(1)} s`;
}

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
  const audio = createStudioAudioHost();
  const catalog = createDemoCatalog();
  const transport = createAudioTransport({
    editor,
    context: audio.context,
    catalog,
    resolveBuffer(span) {
      const buffer = audio.buffers.get(span.assetId);
      if (!buffer) throw new Error(`Missing demo buffer for ${span.assetId}`);
      return buffer;
    },
  });
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

interface SelectedClipInfo {
  readonly id: string;
  readonly name: string;
  readonly activeTakeId: string | null;
  readonly start: number;
  readonly end: number;
  readonly takes: readonly { readonly id: string; readonly label: string }[];
}

function selectClipInfo(editor: Editor) {
  return ({ snapshot, selection }: EditorState): SelectedClipInfo | null => {
    const id = selection.at(-1);
    if (!id) return null;
    const clip = snapshot.clips.find((item) => item.id === id);
    if (!clip) return null;
    const takes = editor
      .read(snapshot)
      .takesOf(clip.id)
      .map((take) => ({ id: take.id, label: take.label ?? take.id }));
    return {
      id: clip.id,
      name: clip.name ?? clip.id,
      activeTakeId: clip.activeTakeId ?? null,
      start: clip.start,
      end: clip.start + clip.duration,
      takes,
    };
  };
}

function sameClipInfo(a: SelectedClipInfo | null, b: SelectedClipInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.activeTakeId === b.activeTakeId &&
    a.start === b.start &&
    a.end === b.end &&
    a.takes.length === b.takes.length &&
    a.takes.every((take, i) => take.id === b.takes[i]?.id && take.label === b.takes[i]?.label)
  );
}

function StudioClock(): ReactElement {
  const { transport } = useTimelineContext();
  const tenths = useTransportSelector(transport, (state) =>
    Math.floor((state.requestedTick ?? state.presentedTick) / (hz / 10)),
  );
  return (
    <output className="demo-meta" data-demo-clock>
      {(tenths / 10).toFixed(1)} s
    </output>
  );
}

function StudioTakeInspector({
  audioTransport,
}: {
  readonly audioTransport: AudioTransport;
}): ReactElement {
  const { editor } = useTimelineContext();
  const clip = useEditorSelector(editor, selectClipInfo(editor), sameClipInfo);
  const audition = useTransportSelector(
    audioTransport,
    (state: AudioTransportState) => state.audition?.takeId ?? null,
  );
  const [renders, setRenders] = useState(0);
  useEffect(() => {
    setRenders((count) => count + 1);
  }, [clip]);

  if (!clip) {
    return (
      <div className="demo-inspector" data-demo-inspector>
        <p className="demo-hint">Select a clip on the timeline to inspect and switch its takes.</p>
      </div>
    );
  }

  return (
    <div className="demo-inspector" data-demo-inspector>
      <div className="demo-inspector__info">
        <strong>{clip.name}</strong>
        <span className="demo-meta">
          {formatSeconds(clip.start)} – {formatSeconds(clip.end)}
        </span>
        <span className="demo-meta" title="Number of times the selected-clip inspector updated">
          inspector updates: {renders}
        </span>
      </div>
      <div className="demo-takes" role="group" aria-label="Candidate takes">
        {clip.takes.map((take) => {
          const active = take.id === clip.activeTakeId;
          const auditioning = audition === take.id;
          return (
            <span key={take.id} className="demo-controls">
              <button
                type="button"
                className="demo-btn"
                data-apply-take={take.id}
                aria-pressed={active}
                onClick={() => {
                  editor.dispatch(commands.selectTake({ clipId: clip.id, takeId: take.id }));
                }}
              >
                {take.label}
              </button>
              <button
                type="button"
                className="demo-btn"
                aria-label={`Audition ${take.label}`}
                aria-pressed={auditioning}
                onClick={() => {
                  if (auditioning) {
                    audioTransport.cancelAudition();
                  } else {
                    void audioTransport.audition({
                      clipId: clip.id,
                      takeId: take.id,
                      mode: "isolated",
                    });
                  }
                }}
              >
                {auditioning ? "Stop" : "Audition"}
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function StudioToolbar({
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
  const { editor, transport } = useTimelineContext();
  const history = useEditorSelector(
    editor,
    (state) => ({ undo: state.history.undoDepth, redo: state.history.redoDepth }),
    shallowEqual,
  );
  const selectedId = useEditorSelector(editor, (state) => state.selection.at(-1) ?? null);
  const [status, setStatus] = useState("");

  const handleSplit = () => {
    if (!selectedId) {
      setStatus("Select a clip first.");
      return;
    }
    const tick = transport.snapshot().presentedTick;
    const clip = editor.getSnapshot().clips.find((item) => item.id === selectedId);
    const cutAt =
      clip && tick > clip.start && tick < clip.start + clip.duration
        ? tick
        : clip
          ? clip.start + Math.floor(clip.duration / 2)
          : tick;
    const result = editor.dispatch(commands.splitClip({ clipId: selectedId, at: cutAt }));
    if (result.ok && !("unchanged" in result) && result.createdIds[0]) {
      editor.session.select([result.createdIds[0]]);
      setStatus(`Split ${selectedId} at ${formatSeconds(cutAt)}.`);
    } else if (!result.ok) {
      setStatus(result.reason);
    }
  };

  return (
    <div className="demo-bar">
      <strong>Dubbing studio</strong>
      <StudioClock />
      <span className="demo-badge" data-demo-backend>
        {backend}
      </span>
      <span className="demo-spacer" />
      <div className="demo-controls">
        <button type="button" className="demo-btn" data-demo-split onClick={handleSplit}>
          Split clip
        </button>
        <button
          type="button"
          className="demo-btn"
          data-demo-undo
          disabled={history.undo === 0}
          onClick={() => {
            editor.history.undo();
            setStatus("Undid last edit.");
          }}
        >
          Undo ({history.undo})
        </button>
        <button
          type="button"
          className="demo-btn"
          data-demo-redo
          disabled={history.redo === 0}
          onClick={() => {
            editor.history.redo();
            setStatus("Redid edit.");
          }}
        >
          Redo ({history.redo})
        </button>
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
      {status && (
        <span className="demo-meta" role="status">
          {status}
        </span>
      )}
    </div>
  );
}

function StudioDemo(): ReactElement {
  const [session, setSession] = useState<StudioSession | null>(null);
  const [renderer, setRenderer] = useState<RendererChoice>("auto");
  const [backend, setBackend] = useState("mounting");
  const viewRef = useRef<TimelineView | null>(null);

  useEffect(() => {
    const created = createStudioSession();
    setSession(created);
    return () => {
      created.dispose();
    };
  }, []);

  const handleViewRef = useCallback((view: TimelineView | null) => {
    viewRef.current = view;
    if (view) {
      setBackend(view.getDiagnostics().backend);
    }
  }, []);

  const handleReset = useCallback(() => {
    setSession((prev) => {
      prev?.dispose();
      return createStudioSession();
    });
  }, []);

  if (!session) {
    return (
      <div className="demo-shell">
        <div className="demo-bar">
          <strong>Dubbing studio</strong>
          <span className="demo-meta">Initializing Web Audio &amp; waveforms…</span>
        </div>
      </div>
    );
  }

  return (
    <TimelineProvider editor={session.editor} transport={session.transport}>
      <div className="demo-shell" data-demo-ready="studio">
        <StudioToolbar
          renderer={renderer}
          backend={backend}
          onRenderer={setRenderer}
          onReset={handleReset}
        />
        <Timeline
          className="demo-timeline"
          editor={session.editor}
          transport={session.transport}
          waveforms={session.waveforms}
          renderer={renderer}
          pixelsPerSecond={36}
          snap={{ gridTicks: hz / 10 }}
          ref={handleViewRef}
        />
        <StudioTakeInspector audioTransport={session.transport} />
        <p className="demo-hint">
          Drag clips to move or trim, click the ruler to scrub, press <code>S</code> to split or{" "}
          <code>Ctrl/Cmd+Z</code> to undo.
        </p>
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
  const undoDepth = useEditorSelector(editor, (state) => state.history.undoDepth);

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
          <button
            type="button"
            className="demo-btn"
            disabled={undoDepth === 0}
            onClick={() => {
              editor.history.undo();
            }}
          >
            Undo
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
