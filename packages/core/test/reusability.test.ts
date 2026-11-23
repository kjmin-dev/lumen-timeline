import assert from "node:assert/strict";
import test from "node:test";
import {
  commands,
  createEditor,
  definePlugin,
  EditError,
  sequenceDuration,
  TICKS_PER_SECOND as hz,
} from "@lumen-timeline/core";
import type { Project, StreamCatalog } from "@lumen-timeline/core";
import { codeOf, commit, pass } from "./support.ts";
import type { Draft } from "./support.ts";

const project = (): Draft<Project> => ({
  schemaVersion: 1,
  duration: 1000,
  tracks: [
    { id: "voice", name: "Voice", overlap: "exclusive", accepts: ["audio"] },
    { id: "music", name: "Music", gain: 0.5 },
  ],
  clips: [
    {
      id: "line",
      trackId: "voice",
      kind: "audio",
      start: 100,
      duration: 200,
      contentIn: 10,
      takeIds: ["a"],
      activeTakeId: "a",
    },
    {
      id: "bed",
      trackId: "music",
      kind: "audio",
      start: 0,
      duration: 900,
      contentIn: 0,
      source: { assetId: "bed-asset", streamId: "stereo" },
    },
  ],
  takes: [{ id: "a", assetId: "line-a", streamId: "mono", sourceAtContentZero: 0 }],
});

test("addClip, updateClip and removeClip support generated IDs, ordering, undo, redo and replay", () => {
  const ana = createEditor({ project: project(), actor: "ana" });
  const ben = createEditor({ project: project(), actor: "ben" });

  const added = commit(
    ana.dispatch(
      commands.addClip({
        after: "line",
        clip: {
          trackId: "voice",
          kind: "audio",
          start: 350,
          duration: 120,
          name: "Reply",
          color: "#66aaff",
          source: { assetId: "reply-asset", streamId: "mono", sourceAtContentZero: -50 },
        },
      }),
    ),
  );
  assert.deepEqual(added.createdIds, ["ana-1"]);
  assert.deepEqual(
    ana.getSnapshot().clips.map((c) => c.id),
    ["line", "ana-1", "bed"],
  );
  assert.equal(ana.getSnapshot().clips[1]?.contentIn, 0);
  assert.equal(ana.getSnapshot().clips[1]?.color, "#66aaff");
  assert.deepEqual(ana.getSnapshot().clips[1]?.source, {
    assetId: "reply-asset",
    streamId: "mono",
    sourceAtContentZero: -50,
  });

  // Replay commit commands on another editor reaches identical snapshot.
  commit(ben.dispatch(added.commands, { history: "ignore" }));
  assert.deepEqual(ben.getSnapshot(), ana.getSnapshot());

  // Update clip metadata and remove optional fields with null.
  const updated = commit(
    ana.dispatch(
      commands.updateClip({
        clipId: "ana-1",
        name: "Reply edited",
        color: null,
        contentBounds: { start: 0, end: 200 },
      }),
    ),
  );
  const clipAfter = ana.getSnapshot().clips[1];
  assert.equal(clipAfter?.name, "Reply edited");
  assert.equal(clipAfter?.color, undefined);
  assert.deepEqual(clipAfter?.contentBounds, { start: 0, end: 200 });
  commit(ben.dispatch(updated.commands, { history: "ignore" }));
  assert.deepEqual(ben.getSnapshot(), ana.getSnapshot());

  // Removing a selected clip prunes selection and undo restores exact order & fields.
  ana.session.select(["ana-1", "bed"]);
  const removed = commit(ana.dispatch(commands.removeClip({ clipId: "ana-1" })));
  assert.deepEqual(ana.session.getSelection(), ["bed"]);
  assert.deepEqual(
    ana.getSnapshot().clips.map((c) => c.id),
    ["line", "bed"],
  );
  commit(ben.dispatch(removed.commands, { history: "ignore" }));
  assert.deepEqual(ben.getSnapshot(), ana.getSnapshot());

  const undoneRemove = commit(ana.history.undo());
  assert.deepEqual(
    ana.getSnapshot().clips.map((c) => c.id),
    ["line", "ana-1", "bed"],
  );
  assert.equal(ana.getSnapshot().clips[1]?.name, "Reply edited");
  commit(ben.dispatch(undoneRemove.commands, { history: "ignore" }));
  assert.deepEqual(ben.getSnapshot(), ana.getSnapshot());

  commit(ana.history.redo());
  assert.deepEqual(
    ana.getSnapshot().clips.map((c) => c.id),
    ["line", "bed"],
  );
  commit(ana.history.undo());
  commit(ana.history.undo());
  commit(ana.history.undo());
  assert.deepEqual(
    ana.getSnapshot().clips.map((c) => c.id),
    ["line", "bed"],
  );
});

test("addClip and removeClip in one transaction cancel out cleanly and validate constraints", () => {
  const e = createEditor({ project: project(), actor: "ana" });
  assert.equal(
    pass(
      e.dispatch([
        commands.addClip({
          clip: { id: "tmp", trackId: "music", kind: "audio", start: 0, duration: 50 },
        }),
        commands.removeClip({ clipId: "tmp" }),
      ]),
    ).unchanged,
    true,
  );
  assert.equal(
    codeOf(
      e.dispatch(
        commands.addClip({
          clip: { trackId: "voice", kind: "video", start: 400, duration: 50 },
        }),
      ),
    ),
    "incompatible-kind",
  );
  assert.equal(
    codeOf(
      e.dispatch(
        commands.addClip({
          clip: { trackId: "voice", kind: "audio", start: 150, duration: 50 },
        }),
      ),
    ),
    "overlap",
  );
  assert.equal(
    codeOf(
      e.dispatch(
        commands.updateClip({
          clipId: "line",
          contentBounds: { start: 50, end: 100 },
        }),
      ),
    ),
    "source-bounds",
  );
});

test("track CRUD, mix updates, reorder and atomic track+clip creation/removal undo cleanly", () => {
  const ana = createEditor({ project: project(), actor: "ana" });
  const ben = createEditor({ project: project(), actor: "ben" });

  // Add a track and place a clip on it in one atomic transaction.
  const added = commit(
    ana.dispatch([
      commands.addTrack({
        after: "voice",
        track: { name: "SFX", color: "#ff8844", gain: 0.8 },
      }),
      commands.addClip({
        clip: { id: "whoosh", trackId: "ana-1", kind: "audio", start: 50, duration: 100 },
      }),
    ]),
  );
  assert.equal(added.trackPatches.length, 1);
  assert.equal(added.trackPatches[0]?.id, "ana-1");
  assert.deepEqual(
    ana.getSnapshot().tracks.map((t) => t.id),
    ["voice", "ana-1", "music"],
  );
  assert.equal(ana.read().clipsIn({ start: 0, end: 200 }, { trackIds: ["ana-1"] }).length, 1);
  commit(ben.dispatch(added.commands, { history: "ignore" }));
  assert.deepEqual(ben.getSnapshot(), ana.getSnapshot());

  // Update track mix settings and lock/unlock.
  const mixed = commit(
    ana.dispatch(
      commands.updateTrack({
        trackId: "music",
        mute: true,
        solo: false,
        gain: 0.25,
        name: "Music Bed",
        color: "#44cc88",
      }),
    ),
  );
  const music = ana.getSnapshot().tracks.find((t) => t.id === "music");
  assert.equal(music?.mute, true);
  assert.equal(music?.gain, 0.25);
  assert.equal(music?.name, "Music Bed");
  assert.equal(music?.color, "#44cc88");
  commit(ben.dispatch(mixed.commands, { history: "ignore" }));
  assert.deepEqual(ben.getSnapshot(), ana.getSnapshot());

  // Reorder tracks and verify read().clipsIn preserves new track order.
  const reordered = commit(
    ana.dispatch(commands.reorderTracks({ trackIds: ["music", "voice", "ana-1"] })),
  );
  assert.deepEqual(
    ana.getSnapshot().tracks.map((t) => t.id),
    ["music", "voice", "ana-1"],
  );
  assert.deepEqual(
    ana
      .read()
      .clipsIn({ start: 0, end: 1000 })
      .map((c) => c.id),
    ["bed", "line", "whoosh"],
  );
  commit(ben.dispatch(reordered.commands, { history: "ignore" }));
  assert.deepEqual(ben.getSnapshot(), ana.getSnapshot());

  // Removing a non-empty track without removeClips fails cleanly.
  assert.equal(codeOf(ana.dispatch(commands.removeTrack({ trackId: "ana-1" }))), "track-not-empty");

  // Removing with removeClips removes the track and its clips together, and undo restores both.
  const removed = commit(
    ana.dispatch(commands.removeTrack({ trackId: "ana-1", removeClips: true })),
  );
  assert.deepEqual(
    ana.getSnapshot().tracks.map((t) => t.id),
    ["music", "voice"],
  );
  assert.equal(
    ana.getSnapshot().clips.find((c) => c.id === "whoosh"),
    undefined,
  );
  commit(ben.dispatch(removed.commands, { history: "ignore" }));
  assert.deepEqual(ben.getSnapshot(), ana.getSnapshot());

  const undone = commit(ana.history.undo());
  assert.deepEqual(
    ana.getSnapshot().tracks.map((t) => t.id),
    ["music", "voice", "ana-1"],
  );
  assert.ok(ana.getSnapshot().clips.find((c) => c.id === "whoosh"));
  commit(ben.dispatch(undone.commands, { history: "ignore" }));
  assert.deepEqual(ben.getSnapshot(), ana.getSnapshot());

  // Undo reorder restores previous track order.
  commit(ana.history.undo());
  assert.deepEqual(
    ana.getSnapshot().tracks.map((t) => t.id),
    ["voice", "ana-1", "music"],
  );
});

test("updateTrack validates existing clips against tightened overlap and accepts rules", () => {
  const e = createEditor({ project: project() });
  commit(
    e.dispatch(
      commands.addClip({
        clip: { id: "overlap-bed", trackId: "music", kind: "video", start: 100, duration: 100 },
      }),
    ),
  );
  assert.equal(
    codeOf(e.dispatch(commands.updateTrack({ trackId: "music", overlap: "exclusive" }))),
    "overlap",
  );
  assert.equal(
    codeOf(e.dispatch(commands.updateTrack({ trackId: "music", accepts: ["audio"] }))),
    "incompatible-kind",
  );
});

test("replace() adopts track changes cleanly and reports trackPatches", () => {
  const ana = createEditor({ project: project(), actor: "ana" });
  const ben = createEditor({ project: project(), actor: "ben" });
  commit(
    ben.dispatch([
      commands.addTrack({ track: { id: "fx", name: "FX" } }),
      commands.updateTrack({ trackId: "music", mute: true }),
    ]),
  );
  const replaced = commit(ana.replace(ben.getSnapshot()));
  assert.equal(replaced.history, "replace");
  assert.deepEqual(
    replaced.trackPatches.map((p) => p.id),
    ["music", "fx"],
  );
  assert.deepEqual(
    ana.getSnapshot().tracks.map((t) => [t.id, t.mute ?? false]),
    [
      ["voice", false],
      ["music", true],
      ["fx", false],
    ],
  );
});

test("region markers validate bounds, extend implicit sequence duration and query via regionsIn", () => {
  const p = project();
  delete p.duration;
  const e = createEditor({ project: p });
  commit(
    e.dispatch([
      commands.addMarker({ id: "point", start: 100, label: "Cue" }),
      commands.addMarker({ id: "ch1", start: 50, duration: 400, label: "Chapter 1" }),
      commands.addMarker({ id: "outro", start: 950, duration: 300, label: "Outro" }),
    ]),
  );
  assert.equal(sequenceDuration(e.getSnapshot()), 1250);
  // Query window [200, 300) intersects ch1 [50, 450) even though ch1 starts before 200.
  assert.deepEqual(
    e
      .read()
      .markersIn({ start: 200, end: 300 })
      .map((m) => m.id),
    [],
  );
  assert.deepEqual(
    e
      .read()
      .regionsIn({ start: 200, end: 300 })
      .map((m) => m.id),
    ["ch1"],
  );
  assert.deepEqual(
    e
      .read()
      .regionsIn({ start: 100, end: 101 })
      .map((m) => m.id),
    ["ch1", "point"],
  );
  // Update region duration and clear it back to a point marker with null.
  commit(e.dispatch(commands.updateMarker({ markerId: "ch1", duration: 200, color: "#99ddff" })));
  assert.equal(e.getSnapshot().markers?.find((m) => m.id === "ch1")?.duration, 200);
  commit(e.dispatch(commands.updateMarker({ markerId: "ch1", duration: null, color: null })));
  const updated = e.getSnapshot().markers?.find((m) => m.id === "ch1");
  assert.equal(updated?.duration, undefined);
  assert.equal(updated?.color, undefined);
  // Reject non-positive region duration.
  assert.equal(codeOf(e.dispatch(commands.addMarker({ start: 10, duration: 0 }))), "invalid-range");
});

test("definePlugin validates extensions and governs split behavior while unknown plugins block split", () => {
  const review = definePlugin({
    namespace: "studio.review",
    version: 1,
    validate({ value }) {
      const status =
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? Reflect.get(value, "status")
          : undefined;
      if (status !== "pending" && status !== "approved")
        return "Review status must be pending or approved";
      return undefined;
    },
    onSplit({ value }) {
      return {
        left: { status: "pending", from: value },
        right: { status: "pending" },
      };
    },
  });

  // Invalid initial extension is rejected on load.
  const bad = project();
  bad.clips[0] = {
    ...bad.clips[0],
    extensions: { "studio.review": { status: "invalid" } },
  };
  assert.throws(
    () => createEditor({ project: bad, plugins: [review] }),
    (error) => error instanceof EditError && error.code === "invalid-extension",
  );

  // Valid plugin extension splits deterministically and survives undo/redo.
  const p = project();
  p.clips[0] = {
    ...p.clips[0],
    extensions: { "studio.review": { status: "approved" } },
  };
  const editor = createEditor({ project: p, plugins: [review], actor: "ana" });
  const split = commit(editor.dispatch(commands.splitClip({ clipId: "line", at: 200 })));
  const [left, right] = [
    editor.getSnapshot().clips.find((c) => c.id === "line"),
    editor.getSnapshot().clips.find((c) => c.id === split.createdIds[0]),
  ];
  assert.deepEqual(left?.extensions, {
    "studio.review": { status: "pending", from: { status: "approved" } },
  });
  assert.deepEqual(right?.extensions, { "studio.review": { status: "pending" } });
  commit(editor.history.undo());
  assert.deepEqual(editor.getSnapshot().clips[0]?.extensions, {
    "studio.review": { status: "approved" },
  });

  // Without the plugin, loading and moving still round-trip the opaque extension,
  // while splitting is safely blocked with split-policy-required.
  const withoutPlugin = createEditor({ project: p });
  assert.equal(
    codeOf(withoutPlugin.dispatch(commands.splitClip({ clipId: "line", at: 200 }))),
    "split-policy-required",
  );
  commit(withoutPlugin.dispatch(commands.moveClips({ clipIds: ["line"], delta: 20 })));
  assert.deepEqual(withoutPlugin.getSnapshot().clips[0]?.extensions, {
    "studio.review": { status: "approved" },
  });
});

test("direct clip.source plans audio spans without requiring Take records", () => {
  const rate = 48000;
  const e = createEditor({
    project: {
      schemaVersion: 1,
      tracks: [{ id: "music", gain: 0.75 }],
      clips: [
        {
          id: "bed",
          trackId: "music",
          kind: "audio",
          start: 0,
          duration: 4 * hz,
          contentIn: hz,
          source: { assetId: "bed-file", streamId: "stereo", sourceAtContentZero: 0 },
        },
      ],
    },
  });
  const catalog: StreamCatalog = {
    version: 1,
    streams: {
      "bed-file": {
        stereo: {
          assetVersion: "v1",
          sampleRate: rate,
          availableStart: 0,
          availableEnd: rate * 10,
        },
      },
    },
  };
  const plan = e.read().planAudio({ start: 0, end: 2 * hz }, catalog);
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.spans.length, 1);
  assert.equal(plan.spans[0]?.takeId, null);
  assert.equal(plan.spans[0]?.assetId, "bed-file");
  assert.equal(plan.spans[0]?.gain, 0.75);
  assert.deepEqual(plan.spans[0]?.window, {
    start: 0,
    end: 2 * hz,
    sourceStart: rate,
    sourceEnd: 3 * rate,
  });
});
