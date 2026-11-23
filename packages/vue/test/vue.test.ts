import assert from "node:assert/strict";
import test from "node:test";
import { createSSRApp, defineComponent, effectScope, h, nextTick, shallowRef } from "vue";
import { renderToString } from "vue/server-renderer";
import { commands, createEditor, shallowEqual } from "@lumen-timeline/core";
import type { Editor, HistoryState } from "@lumen-timeline/core";
import type { TimelineTransport, TransportState } from "@lumen-timeline/timeline";
import {
  provideTimeline,
  Timeline,
  useEditorSelector,
  useTimelineContext,
  useTransportSelector,
} from "@lumen-timeline/vue";

function host(name: string): {
  editor: Editor;
  transport: TimelineTransport;
  active: () => number;
} {
  let active = 0;
  const track = <R>(off: () => R): (() => R) => {
    active++;
    let on = true;
    return () => {
      if (on) active--;
      on = false;
      return off();
    };
  };
  const base = createEditor({
    project: {
      schemaVersion: 1,
      tracks: [{ id: "t" }],
      clips: [
        { id: "a", name: name, trackId: "t", kind: "audio", start: 0, duration: 10, contentIn: 0 },
        {
          id: "b",
          name: "Other",
          trackId: "t",
          kind: "audio",
          start: 20,
          duration: 10,
          contentIn: 0,
        },
      ],
    },
  });
  base.session.select(["a"]);
  const session: Editor["session"] = Object.create(base.session, {
    subscribeSelection: {
      value: (listen: (ids: readonly string[]) => void) =>
        track(base.session.subscribeSelection(listen)),
    },
  });
  const history: Editor["history"] = Object.create(base.history, {
    subscribe: {
      value: (listen: (state: HistoryState) => void) => track(base.history.subscribe(listen)),
    },
  });
  const editor: Editor = {
    ...base,
    session,
    history,
    subscribe: (select, listen) => track(base.subscribe(select, listen)),
  };
  const state: TransportState = { playing: false, presentedTick: 7, requestedTick: null };
  const transport: TimelineTransport = {
    snapshot: () => state,
    subscribe: () => track(() => true),
    play() {},
    pause() {},
    seek() {},
  };
  return { editor, transport, active: () => active };
}

const selectedName = ({
  snapshot,
  selection,
}: {
  snapshot: { clips: readonly { id: string; name?: string | undefined }[] };
  selection: readonly string[];
}): string => snapshot.clips.find((c) => c.id === selection.at(-1))?.name ?? "";

const Inspector = defineComponent(() => {
  const context = useTimelineContext();
  const name = useEditorSelector(() => context.value.editor, selectedName);
  const tick = useTransportSelector(
    () => context.value.transport,
    (s) => s.presentedTick,
  );
  return () => h("p", `${name.value} · ${tick.value}`);
});

test("the server renders the element and the panels, and nothing subscribes", async () => {
  assert.equal(typeof Reflect.get(globalThis, "window"), "undefined");
  const { editor, transport, active } = host("Line one");
  const App = defineComponent(() => {
    provideTimeline({ editor, transport });
    return () => [h(Timeline, { editor, transport, class: "timeline" }), h(Inspector)];
  });
  const html = await renderToString(createSSRApp(App));
  assert.equal(html, '<!--[--><div class="timeline"></div><p>Line one · 7</p><!--]-->');
  assert.equal(active(), 0);
});

test("outside a component a selector follows its editor until its scope ends", async () => {
  const first = host("First");
  const second = host("Second");
  const editor = shallowRef(first.editor);
  const scope = effectScope();
  const field = scope.run(() => useEditorSelector(editor, selectedName, shallowEqual));
  assert.ok(field);
  assert.equal(field.value, "First");
  assert.equal(first.active(), 3);
  first.editor.session.select(["b"]);
  assert.equal(field.value, "Other");
  assert.ok(first.editor.dispatch(commands.moveClips({ clipIds: ["a"], delta: 1 })).ok);
  assert.equal(field.value, "Other");
  editor.value = second.editor;
  await nextTick();
  // A new editor is followed, and the old one let go.
  assert.equal(field.value, "Second");
  assert.equal(first.active(), 0);
  assert.equal(second.active(), 3);
  scope.stop();
  assert.equal(second.active(), 0);
});

test("a panel without provideTimeline says what it needs", async () => {
  const app = createSSRApp(Inspector);
  // The error is the point; keep Vue's warning about it out of the output.
  app.config.warnHandler = () => {};
  await assert.rejects(renderToString(app), /useTimelineContext needs provideTimeline/);
});
