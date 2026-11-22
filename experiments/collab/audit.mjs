// Probes from the design audit of November 2026. Each line shows what the
// current core does in a situation that makes undo or merging hard. The
// README records which probes later changes resolved.
import { commands, createEditor, TICKS_PER_SECOND as hz } from "@lumen-timeline/core";

const project = () => ({
  schemaVersion: 1,
  duration: 600 * hz,
  tracks: [{ id: "voice", overlap: "exclusive" }, { id: "mix" }],
  clips: [
    {
      id: "line",
      trackId: "voice",
      kind: "audio",
      start: 12 * hz,
      duration: 4 * hz,
      contentIn: hz,
      takeIds: ["b", "a"],
      activeTakeId: "a",
    },
    {
      id: "other",
      trackId: "voice",
      kind: "audio",
      start: 30 * hz,
      duration: 2 * hz,
      contentIn: 0,
    },
    {
      id: "bare",
      trackId: "mix",
      kind: "audio",
      start: 40 * hz,
      duration: 2 * hz,
      contentIn: 0,
      takeIds: ["a"],
    },
  ],
  takes: ["a", "b"].map((id) => ({ id, assetId: id, streamId: "s", sourceAtContentZero: 0 })),
});
const editor = () => createEditor({ project: project() });
const clip = (e, id) => e.getSnapshot().clips.find((c) => c.id === id);
const ignore = { history: "ignore" };
const fresh = (id) => ({ id, assetId: "x-" + id, streamId: "s", sourceAtContentZero: 0 });
const show = (name, value) => console.log(name.padEnd(52), JSON.stringify(value));
const brief = (r) => (r.ok ? (r.unchanged ? "unchanged" : "ok") : r.code + ": " + r.reason);

// 1. Coupled placement fields: a left trim, then an unrelated move.
{
  const e = editor();
  e.dispatch(commands.trimClip({ clipId: "line", edge: "left", delta: hz }));
  e.dispatch(commands.moveClips({ clipIds: ["line"], delta: 50 * hz }), ignore);
  show("1 undo a trim after an ignored move", brief(e.history.undo()));
}
// 2. A candidate list that returned to the same IDs through other edits.
{
  const e = editor();
  e.dispatch(commands.reorderTakes({ clipId: "line", takeIds: ["a", "b"] }));
  e.dispatch(commands.reorderTakes({ clipId: "line", takeIds: ["b", "a"] }), ignore);
  e.dispatch(commands.reorderTakes({ clipId: "line", takeIds: ["a", "b"] }), ignore);
  show("2 undo a reorder, list equal by value", brief(e.history.undo()));
}
// 3. The candidate list is one value: a background result adds another candidate.
{
  const e = editor();
  e.dispatch(commands.addTake({ clipIds: ["line"], take: fresh("c") }));
  e.dispatch(commands.addTake({ clipIds: ["line"], take: fresh("d") }), ignore);
  show("3 undo add-take after an ignored add-take", brief(e.history.undo()));
}
// 4. An undo that has to remove fields from a clip that changed since.
{
  const e = editor();
  e.dispatch(commands.addTake({ clipIds: ["other"], take: fresh("c") }));
  e.dispatch(commands.moveClips({ clipIds: ["other"], delta: hz }), ignore);
  const result = e.history.undo();
  show("4 undo a first candidate after an ignored move", [
    brief(result),
    clip(e, "other").takeIds ?? null,
  ]);
}
// 5. One JSON form per state: select a take, then clear it again.
{
  const e = editor();
  const before = JSON.stringify(clip(e, "bare"));
  e.dispatch(commands.selectTake({ clipId: "bare", takeId: "a" }));
  e.dispatch(commands.selectTake({ clipId: "bare", takeId: null }));
  show("5 same meaning, same JSON", before === JSON.stringify(clip(e, "bare")));
}
// 6. A take whose last listing is removed, and a new take under the same ID.
{
  const e = editor();
  e.dispatch([
    commands.addTake({ clipIds: ["other"], take: fresh("c") }),
    commands.setEntityData({ scope: "rating", id: "c", key: "stars", value: 5 }),
  ]);
  e.dispatch(commands.removeTake({ clipId: "other", takeId: "c" }));
  const again = e.dispatch(commands.addTake({ clipIds: ["other"], take: fresh("c") }));
  show("6 reuse the ID of an unlisted take", brief(again));
}
// 7. Generated IDs: without randomUUID, and replayed from a commit's commands.
{
  const crypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  const split = (e) =>
    e.dispatch(commands.splitClip({ clipId: "line", at: 14 * hz })).createdIds[0];
  const fallback = [editor(), editor()].map(split);
  if (crypto) Object.defineProperty(globalThis, "crypto", crypto);
  show("7a two editors without randomUUID", fallback);
  const first = editor();
  const result = first.dispatch(commands.splitClip({ clipId: "line", at: 14 * hz }));
  const second = editor();
  second.dispatch(result.commands);
  show(
    "7b a commit's commands replay to the same ID",
    second.getSnapshot().clips.some((c) => c.id === result.createdIds[0]),
  );
}
// 8. A source position that no plan could use.
{
  const e = editor();
  const result = e.dispatch(
    commands.updateTake({ takeId: "a", sourceAtContentZero: Number.MAX_SAFE_INTEGER }),
  );
  show("8 update a take to an unusable position", brief(result));
}
// 9. Undo an addition after another clip started to list the take.
{
  const e = editor();
  e.dispatch(commands.addTake({ clipIds: ["other"], take: fresh("c") }));
  e.dispatch(commands.addTake({ clipIds: ["line"], takeId: "c" }), ignore);
  show("9 undo add-take after an ignored sharing", brief(e.history.undo()));
}
// 10. Canonical order follows UTF-16 code units, not UTF-8 bytes.
{
  const ids = ["\u{10000}", ""];
  const js = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const utf8 = [...ids].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  show("10 JS order equals UTF-8 byte order", js.join() === utf8.join());
}
// 11. The revision guard is per project: a marker edit invalidates a clip edit.
{
  const e = editor();
  const base = e.getSnapshot().revision;
  e.dispatch(commands.addMarker({ id: "m", start: 0 }));
  const guarded = e.dispatch(commands.moveClips({ clipIds: ["other"], delta: hz }), {
    expectedRevision: base,
  });
  const scoped = e.dispatch([
    commands.expectClip({ clipId: "other", fields: { start: 30 * hz } }),
    commands.moveClips({ clipIds: ["other"], delta: hz }),
  ]);
  show("11 expectedRevision, then expectClip", [brief(guarded), brief(scoped)]);
}
