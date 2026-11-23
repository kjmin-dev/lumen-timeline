import assert from "node:assert/strict";
import test from "node:test";
import {
  commands,
  createEditor,
  shallowEqual,
  watchEditor,
  watchSelect,
  watchSnapshots,
} from "@lumen-timeline/core";
import type { Editor, EditorState, HistoryState, SnapshotSource } from "@lumen-timeline/core";
import { commit } from "./support.ts";

function editor(): Editor {
  return createEditor({
    project: {
      schemaVersion: 1,
      tracks: [{ id: "t" }],
      clips: [
        {
          id: "a",
          trackId: "t",
          kind: "audio",
          start: 0,
          duration: 10,
          contentIn: 0,
          takeIds: ["k1", "k2"],
          activeTakeId: "k1",
        },
        { id: "c", trackId: "t", kind: "audio", start: 20, duration: 10, contentIn: 0 },
      ],
      takes: [
        { id: "k1", assetId: "x", streamId: "s", sourceAtContentZero: 0 },
        { id: "k2", assetId: "y", streamId: "s", sourceAtContentZero: 0 },
      ],
    },
  });
}

/** Counts the editor subscriptions that are active. */
function counted(e: Editor): { readonly editor: Editor; readonly active: () => number } {
  let active = 0;
  const track = (off: () => boolean): (() => boolean) => {
    active++;
    let on = true;
    return () => {
      if (on) active--;
      on = false;
      return off();
    };
  };
  const session: Editor["session"] = Object.create(e.session, {
    subscribeSelection: {
      value: (listen: (ids: readonly string[]) => void) =>
        track(e.session.subscribeSelection(listen)),
    },
  });
  const history: Editor["history"] = Object.create(e.history, {
    subscribe: {
      value: (listen: (state: HistoryState) => void) => track(e.history.subscribe(listen)),
    },
  });
  const wrapped: Editor = {
    ...e,
    session,
    history,
    subscribe: (select, listen) => track(e.subscribe(select, listen)),
  };
  return { editor: wrapped, active: () => active };
}

test("the editor state keeps its identity until the snapshot, selection or history changes", () => {
  const e = editor();
  const watch = watchEditor(e);
  const first = watch.get();
  assert.equal(watch.get(), first);
  assert.equal(first.snapshot, e.getSnapshot());
  assert.equal(first.selection, e.session.getSelection());
  assert.deepEqual(first.history, { undoDepth: 0, redoDepth: 0, estimatedBytes: 0 });
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.history));

  e.session.select(["a"]);
  const selected = watch.get();
  assert.notEqual(selected, first);
  assert.deepEqual(selected.selection, ["a"]);
  assert.equal(selected.snapshot, first.snapshot);
  assert.equal(selected.history, first.history, "an unchanged history keeps its object");

  commit(e.dispatch(commands.moveClips({ clipIds: ["c"], delta: 5 })));
  const moved = watch.get();
  assert.notEqual(moved.snapshot, selected.snapshot);
  assert.equal(moved.history.undoDepth, 1);
  assert.equal(watch.get(), moved);
});

test("the editor watch subscribes only while it has listeners", () => {
  const { editor: e, active } = counted(editor());
  const watch = watchEditor(e);
  watch.get();
  assert.equal(active(), 0, "reading does not subscribe");
  const offA = watch.subscribe(() => {});
  assert.equal(active(), 3);
  const offB = watch.subscribe(() => {});
  assert.equal(active(), 3, "listeners share one set of subscriptions");
  offA();
  offA();
  assert.equal(active(), 3);
  offB();
  assert.equal(active(), 0);
  watch.subscribe(() => {})();
  assert.equal(active(), 0);
});

test("one commit notifies once, with its selection pruned and its history recorded", () => {
  const e = editor();
  commit(e.dispatch(commands.splitClip({ clipId: "a", at: 5, rightId: "b" })));
  e.session.select(["a", "b"]);
  const watch = watchEditor(e);
  const seen: EditorState[] = [];
  const off = watch.subscribe(() => seen.push(watch.get()));
  // Undo removes clip b: the editor notifies its document, selection and
  // history subscribers in turn.
  e.history.undo();
  assert.equal(seen.length, 1);
  const [state] = seen;
  assert.ok(state);
  assert.deepEqual(state.selection, ["a"]);
  assert.equal(state.history.redoDepth, 1);
  assert.equal(state.snapshot, e.getSnapshot());
  e.session.select(["a"]);
  assert.equal(seen.length, 1, "an equal selection does not notify");
  off();
});

test("an edit made during delivery notifies again with the final state", () => {
  const e = editor();
  const watch = watchEditor(e);
  const revisions: number[] = [];
  const off = watch.subscribe(() => {
    const { snapshot } = watch.get();
    revisions.push(snapshot.revision);
    if (snapshot.revision === 1)
      commit(e.dispatch(commands.moveClips({ clipIds: ["c"], delta: 1 })));
  });
  commit(e.dispatch(commands.moveClips({ clipIds: ["c"], delta: 1 })));
  assert.deepEqual(revisions, [1, 2]);
  assert.equal(watch.get().snapshot.revision, 2);
  off();
});

test("a listener's error is reported and the other listeners still run", (t) => {
  const reported: unknown[] = [];
  // Node has no reportError, so install one for the duration of the test.
  Reflect.set(globalThis, "reportError", (error: unknown) => reported.push(error));
  t.after(() => Reflect.deleteProperty(globalThis, "reportError"));
  const e = editor();
  const watch = watchEditor(e);
  let heard = 0;
  watch.subscribe(() => {
    throw new Error("panel failed");
  });
  watch.subscribe(() => heard++);
  e.session.select(["c"]);
  assert.equal(heard, 1);
  assert.equal(reported.length, 1);
});

test("one function subscribed twice is two listeners", () => {
  const e = editor();
  const watch = watchEditor(e);
  let calls = 0;
  const listener = (): void => {
    calls++;
  };
  const offA = watch.subscribe(listener);
  watch.subscribe(listener);
  e.session.select(["a"]);
  assert.equal(calls, 2);
  offA();
  e.session.select(["c"]);
  assert.equal(calls, 3);
});

test("a selected field notifies only when it changes", () => {
  const e = editor();
  const state = watchEditor(e);
  let selects = 0;
  // A take inspector: the selected clip and its active take.
  const inspector = watchSelect(
    state,
    ({ snapshot, selection }) => {
      selects++;
      const clip = snapshot.clips.find((c) => c.id === selection.at(-1));
      return { clipId: clip?.id ?? null, takeId: clip?.activeTakeId ?? null };
    },
    shallowEqual,
  );
  const initial = inspector.get();
  assert.deepEqual(initial, { clipId: null, takeId: null });
  assert.equal(inspector.get(), initial);
  assert.equal(selects, 1, "a read of an unchanged state does not select again");

  const values: unknown[] = [];
  const off = inspector.subscribe(() => values.push(inspector.get()));
  e.session.select(["a"]);
  assert.deepEqual(values, [{ clipId: "a", takeId: "k1" }]);
  const shown = inspector.get();
  // Moving another clip changes the snapshot but not the field.
  commit(e.dispatch(commands.moveClips({ clipIds: ["c"], delta: 3 })));
  assert.equal(values.length, 1);
  assert.equal(inspector.get(), shown, "an equal field keeps its identity");
  commit(e.dispatch(commands.selectTake({ clipId: "a", takeId: "k2" })));
  assert.deepEqual(values.at(-1), { clipId: "a", takeId: "k2" });
  assert.equal(values.length, 2);
  off();
  e.session.select([]);
  assert.equal(values.length, 2);
  assert.deepEqual(inspector.get(), { clipId: null, takeId: null }, "reads stay current");
});

test("a snapshot source is watched only while it has listeners", () => {
  let state = { playing: false, tick: 0 };
  const listeners = new Set<(s: typeof state) => void>();
  const source: SnapshotSource<typeof state> = {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const emit = (next: typeof state): void => {
    state = next;
    for (const listener of Array.from(listeners)) listener(next);
  };
  const watch = watchSnapshots(source);
  assert.equal(watch.get(), state);
  assert.equal(listeners.size, 0);
  const seconds = watchSelect(watch, (s) => Math.floor(s.tick / 10));
  const heard: number[] = [];
  const off = seconds.subscribe(() => heard.push(seconds.get()));
  assert.equal(listeners.size, 1);
  emit({ playing: true, tick: 4 });
  emit({ playing: true, tick: 9 });
  emit({ playing: true, tick: 12 });
  assert.deepEqual(heard, [1]);
  off();
  assert.equal(listeners.size, 0);
});

test("shallow equality compares arrays and plain objects one level deep", () => {
  assert.ok(shallowEqual([1, "a", null], [1, "a", null]));
  assert.ok(!shallowEqual([1, 2], [1, 2, 3]));
  assert.ok(shallowEqual({ a: 1, b: NaN }, { b: NaN, a: 1 }));
  assert.ok(!shallowEqual({ a: 1 }, { a: 1, b: undefined }));
  assert.ok(!shallowEqual({ a: { x: 1 } }, { a: { x: 1 } }));
  assert.ok(!shallowEqual([1], { 0: 1, length: 1 }));
  assert.ok(!shallowEqual(new Map(), new Map()), "only plain objects compare by property");
  assert.ok(shallowEqual(null, null));
  assert.ok(!shallowEqual<unknown>(null, {}));
  assert.ok(!shallowEqual(0, -0));
});
