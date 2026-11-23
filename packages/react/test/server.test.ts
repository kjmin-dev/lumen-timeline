import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { commands, createEditor, shallowEqual } from "@lumen-timeline/core";
import type { Editor, HistoryState } from "@lumen-timeline/core";
import type { TimelineTransport, TransportState } from "@lumen-timeline/timeline";
import {
  Timeline,
  TimelineProvider,
  useEditorSelector,
  useTimelineContext,
  useTransportSelector,
} from "@lumen-timeline/react";

/** An editor and a transport whose active subscriptions are counted. */
function host(): { editor: Editor; transport: TimelineTransport; active: () => number } {
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
        {
          id: "a",
          name: "Line one",
          trackId: "t",
          kind: "audio",
          start: 0,
          duration: 10,
          contentIn: 0,
          takeIds: ["k1", "k2"],
          activeTakeId: "k2",
        },
      ],
      takes: [
        { id: "k1", assetId: "x", streamId: "s", sourceAtContentZero: 0 },
        { id: "k2", assetId: "y", streamId: "s", sourceAtContentZero: 0 },
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
  const state: TransportState = { playing: false, presentedTick: 42, requestedTick: null };
  const transport: TimelineTransport = {
    snapshot: () => state,
    subscribe: () => track(() => true),
    play() {},
    pause() {},
    seek() {},
  };
  return { editor, transport, active: () => active };
}

function Inspector(): ReactElement {
  const { editor, transport } = useTimelineContext();
  const field = useEditorSelector(
    editor,
    ({ snapshot, selection }) => {
      const clip = snapshot.clips.find((c) => c.id === selection.at(-1));
      return { name: clip?.name ?? "", take: clip?.activeTakeId ?? "" };
    },
    shallowEqual,
  );
  const tick = useTransportSelector(transport, (s) => s.presentedTick);
  return createElement("p", null, `${field.name} · ${field.take} · ${tick}`);
}

test("the server renders the element and the panels, and nothing subscribes", () => {
  assert.equal(typeof Reflect.get(globalThis, "window"), "undefined");
  assert.equal(typeof Reflect.get(globalThis, "document"), "undefined");
  const { editor, transport, active } = host();
  const html = renderToString(
    createElement(
      TimelineProvider,
      { editor, transport },
      createElement(Timeline, { editor, transport, className: "timeline" }),
      createElement(Inspector),
    ),
  );
  assert.equal(html, '<div class="timeline"></div><p>Line one · k2 · 42</p>');
  assert.equal(active(), 0);
  // The host's editor is untouched.
  assert.ok(editor.dispatch(commands.selectTake({ clipId: "a", takeId: "k1" })).ok);
});

test("a panel without a provider says what it needs", () => {
  assert.throws(
    () => renderToString(createElement(Inspector)),
    /useTimelineContext needs a TimelineProvider/,
  );
});
