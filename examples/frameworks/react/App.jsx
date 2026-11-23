import { useEffect, useSyncExternalStore } from "react";
import {
  Timeline,
  TimelineProvider,
  useEditorSelector,
  useTimelineContext,
  useTransportSelector,
} from "@lumen-timeline/react";
import {
  chooseTake,
  clockField,
  clockText,
  inspectorField,
  sameInspector,
  viewOptions,
} from "../shared/fixture.mjs";

function Inspector({ host }) {
  const { editor } = useTimelineContext();
  const field = useEditorSelector(editor, inspectorField(editor), sameInspector);
  useEffect(() => {
    host.counts.inspector++;
  }, [host, field]);
  if (!field)
    return (
      <aside className="inspector" aria-label="Take inspector">
        <h2>No clip selected</h2>
        <p>Select a clip to choose its take.</p>
      </aside>
    );
  const active = field.takes.find((take) => take.id === field.takeId);
  return (
    <aside className="inspector" aria-label="Take inspector">
      <h2>{field.name}</h2>
      <p>Active: {active?.label ?? "none"}</p>
      {field.takes.map((take) => (
        <button
          key={take.id}
          type="button"
          data-take={take.id}
          aria-pressed={take.id === field.takeId}
          onClick={() => chooseTake(editor, field.clipId, take.id)}
        >
          {take.label}
        </button>
      ))}
    </aside>
  );
}

function Clock({ host }) {
  const { transport } = useTimelineContext();
  const tenths = useTransportSelector(transport, clockField);
  useEffect(() => {
    host.counts.clock++;
  }, [host, tenths]);
  return <output className="clock">{clockText(tenths)}</output>;
}

export function App({ host }) {
  const state = useSyncExternalStore(host.controls.subscribe, host.controls.get, host.controls.get);
  const { editor, transport } = host.pairs[state.pair];
  const { renderer, ...options } = viewOptions(host, state);
  return (
    <TimelineProvider editor={editor} transport={transport}>
      <header className="bar">
        <strong>Lumen · React</strong>
        {state.panels && <Clock host={host} />}
      </header>
      <main className="workspace">
        {state.timeline && (
          <Timeline
            className="timeline"
            editor={editor}
            transport={transport}
            renderer={renderer}
            {...options}
            ref={host.setView}
          />
        )}
        {state.panels && <Inspector host={host} />}
      </main>
    </TimelineProvider>
  );
}
