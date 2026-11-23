import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compileModule } from "svelte/compiler";
import { createEditor } from "@lumen-timeline/core";
import type { Editor, HistoryState } from "@lumen-timeline/core";
import type { TimelineTransport, TransportState } from "@lumen-timeline/timeline";
import { editorSelector, getTimelineContext, transportSelector } from "@lumen-timeline/svelte";

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

test("outside an effect, as on the server, a selector reads its field and subscribes to nothing", () => {
  assert.equal(typeof Reflect.get(globalThis, "window"), "undefined");
  const { editor, transport, active } = host();
  const name = editorSelector(
    () => editor,
    ({ snapshot, selection }) => snapshot.clips.find((c) => c.id === selection.at(-1))?.name,
  );
  const tick = transportSelector(transport, (s) => s.presentedTick);
  assert.equal(name.current, "Line one");
  assert.equal(tick.current, 7);
  editor.session.select([]);
  assert.equal(name.current, undefined, "reads stay current");
  assert.equal(active(), 0);
});

test("the attachment's runes compile for the browser and the server without warnings", async () => {
  const source = await readFile(new URL("../dist/attach.svelte.js", import.meta.url), "utf8");
  for (const generate of ["client", "server"] as const) {
    const { warnings } = compileModule(source, { generate, filename: "attach.svelte.js" });
    assert.deepEqual(warnings, [], generate);
  }
});

test("context is read during component setup only", () => {
  assert.throws(() => getTimelineContext());
});
