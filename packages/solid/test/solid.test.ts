import assert from "node:assert/strict";
import test from "node:test";
import { createRoot } from "solid-js";
import { createEditor } from "@lumen-timeline/core";
import type { Editor, HistoryState } from "@lumen-timeline/core";
import type { TimelineTransport, TransportState } from "@lumen-timeline/timeline";
import {
  createEditorSelector,
  createTimeline,
  createTransportSelector,
  useTimelineContext,
} from "@lumen-timeline/solid";

function host(): { editor: Editor; transport: TimelineTransport; active: () => number } {
  let active = 0;
  const track = <R>(off: () => R): (() => R) => {
    active++;
    return () => {
      active--;
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

// Node loads SolidJS's server build, where effects do not run: this is what a
// server render of a component using the wrapper does.
test("on the server the primitives read values, mount nothing and subscribe to nothing", () => {
  assert.equal(typeof Reflect.get(globalThis, "window"), "undefined");
  const { editor, transport, active } = host();
  createRoot((dispose) => {
    const name = createEditorSelector(
      editor,
      ({ snapshot, selection }) => snapshot.clips.find((c) => c.id === selection.at(-1))?.name,
    );
    const tick = createTransportSelector(
      () => transport,
      (s) => s.presentedTick,
    );
    const view = createTimeline(
      () => undefined,
      () => ({ editor, transport }),
    );
    assert.equal(name(), "Line one");
    assert.equal(tick(), 7);
    assert.equal(view(), undefined);
    assert.equal(active(), 0);
    dispose();
  });
});

test("a panel without a TimelineContext says so", () => {
  assert.throws(() => createRoot(() => useTimelineContext()));
});
