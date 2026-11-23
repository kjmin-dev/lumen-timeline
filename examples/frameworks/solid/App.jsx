import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import {
  createEditorSelector,
  createTimeline,
  createTransportSelector,
  TimelineContext,
  useTimelineContext,
} from "@lumen-timeline/solid";
import {
  chooseTake,
  clockField,
  clockText,
  inspectorField,
  sameInspector,
  viewOptions,
} from "../shared/fixture.mjs";

function Timeline(props) {
  const [element, setElement] = createSignal();
  const view = createTimeline(element, () => props.options());
  createEffect(view, (mounted) => props.host.setView(mounted));
  onCleanup(() => props.host.setView(null));
  return <div class="timeline" ref={setElement} />;
}

function Inspector(props) {
  const context = useTimelineContext();
  const field = createEditorSelector(
    () => context.editor,
    (state) => inspectorField(context.editor)(state),
    sameInspector,
  );
  createEffect(field, () => {
    props.host.counts.inspector++;
  });
  const active = () => field()?.takes.find((take) => take.id === field().takeId)?.label ?? "none";
  return (
    <aside class="inspector" aria-label="Take inspector">
      <Show
        when={field()}
        fallback={
          <>
            <h2>No clip selected</h2>
            <p>Select a clip to choose its take.</p>
          </>
        }
      >
        <h2>{field().name}</h2>
        <p>Active: {active()}</p>
        <For each={field().takes}>
          {(take) => (
            <button
              type="button"
              data-take={take.id}
              aria-pressed={String(take.id === field().takeId)}
              onClick={() => chooseTake(context.editor, field().clipId, take.id)}
            >
              {take.label}
            </button>
          )}
        </For>
      </Show>
    </aside>
  );
}

function Clock(props) {
  const context = useTimelineContext();
  const tenths = createTransportSelector(() => context.transport, clockField);
  createEffect(tenths, () => {
    props.host.counts.clock++;
  });
  return <output class="clock">{clockText(tenths())}</output>;
}

export function App(props) {
  const { host } = props;
  const [controls, setControls] = createSignal(host.controls.get());
  createEffect(
    () => undefined,
    () => host.controls.subscribe(() => setControls(host.controls.get())),
  );
  const pair = () => host.pairs[controls().pair];
  const context = {
    get editor() {
      return pair().editor;
    },
    get transport() {
      return pair().transport;
    },
  };
  const options = () => ({
    ...viewOptions(host, controls()),
    editor: pair().editor,
    transport: pair().transport,
  });
  return (
    <TimelineContext value={context}>
      <header class="bar">
        <strong>Lumen · SolidJS</strong>
        <Show when={controls().panels}>
          <Clock host={host} />
        </Show>
      </header>
      <main class="workspace">
        <Show when={controls().timeline}>
          <Timeline host={host} options={options} />
        </Show>
        <Show when={controls().panels}>
          <Inspector host={host} />
        </Show>
      </main>
    </TimelineContext>
  );
}
