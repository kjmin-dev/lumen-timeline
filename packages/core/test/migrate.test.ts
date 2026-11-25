import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  commands,
  createEditor,
  EditError,
  MAX_CLIP_GAIN,
  migrateProject,
  SCHEMA_VERSION,
  clipFieldChanges,
  TICKS_PER_SECOND as hz,
} from "@lumen-timeline/core";
import type {
  JsonValue,
  Project,
  ProjectSnapshot,
  StreamCatalog,
  TimelinePlugin,
} from "@lumen-timeline/core";
import { codeOf, commit, pass } from "./support.ts";
import type { Draft } from "./support.ts";

const fixture = (name: string): Draft<Project> => {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8"),
  );
  assert.ok(typeof parsed === "object" && parsed !== null);
  // The fixtures are project JSON as a host would load it from a file.
  return Object.assign({ schemaVersion: 0, tracks: [], clips: [] }, parsed);
};

/** A saved file: what a host writes and reads back. */
const save = (snapshot: ProjectSnapshot): Draft<Project> => {
  const parsed: unknown = JSON.parse(JSON.stringify(snapshot));
  assert.ok(typeof parsed === "object" && parsed !== null);
  return Object.assign({ schemaVersion: 0, tracks: [], clips: [] }, parsed);
};

const statusOf = (value: JsonValue | undefined): string | undefined => {
  const state: unknown =
    typeof value === "object" && value !== null ? Reflect.get(value, "state") : undefined;
  return typeof state === "string" ? state : undefined;
};

// Version 1 stored a bare state string; version 2 stores { state }.
const statusV1: TimelinePlugin = {
  namespace: "app.status",
  version: 1,
  validate: ({ value }) =>
    value === "draft" || value === "final" ? undefined : "Expected draft or final",
  onSplit: () => ({ left: "draft", right: "draft" }),
};
const migrations: { target: string; id: string; from: number }[] = [];
const statusV2: TimelinePlugin = {
  namespace: "app.status",
  version: 2,
  validate: ({ value }) => {
    const state = statusOf(value);
    return state === "draft" || state === "final" ? undefined : "Expected { state }";
  },
  onSplit: () => ({ left: { state: "draft" }, right: { state: "draft" } }),
  migrate: ({ target, id, value, from }) => {
    migrations.push({ target, id, from });
    return { state: typeof value === "string" ? value : "draft" };
  },
};
const statusV3: TimelinePlugin = {
  namespace: "app.status",
  version: 3,
  validate: ({ value }) => (Array.isArray(value) ? undefined : "Expected a state history"),
  onSplit: ({ value }) => ({ left: value, right: value }),
};

test("a schema-1 project migrates to the golden schema-2 project, and reopening it changes nothing", () => {
  const original = fixture("schema-1.json");
  const written = JSON.stringify(original);
  migrations.length = 0;
  const migration = migrateProject(original, { plugins: [statusV2] });
  assert.equal(SCHEMA_VERSION, 2);
  assert.equal(migration.from, 1);
  assert.equal(migration.readOnly, null);
  assert.equal(migration.upgraded, true);
  assert.deepEqual(migration.extensions, [{ namespace: "app.status", from: 1, to: 2 }]);
  assert.deepEqual(migration.unread, []);
  // Each payload migrated once, track, clip, marker and take alike.
  assert.deepEqual(migrations, [
    { target: "track", id: "voice", from: 1 },
    { target: "clip", id: "line-1", from: 1 },
    { target: "clip", id: "line-2", from: 1 },
    { target: "marker", id: "m-1", from: 1 },
    { target: "take", id: "take-b", from: 1 },
  ]);
  assert.deepEqual(save(migration.project), fixture("schema-2.json"));
  // The input is the host's, unchanged.
  assert.equal(JSON.stringify(original), written);

  // The golden file is current: it opens as written.
  migrations.length = 0;
  const again = migrateProject(fixture("schema-2.json"), { plugins: [statusV2] });
  assert.equal(again.from, 2);
  assert.equal(again.upgraded, false);
  assert.deepEqual(again.extensions, []);
  assert.deepEqual(migrations, []);
  assert.deepEqual(save(again.project), fixture("schema-2.json"));
});

test("a previous-schema project round-trips through editing, saving and reopening", () => {
  const original = fixture("schema-1.json");
  const editor = createEditor({ project: original, plugins: [statusV2], actor: "ana" });
  const opened = editor.getSnapshot();
  assert.equal(opened.schemaVersion, 2);
  assert.deepEqual(opened.extensionVersions, { "app.status": 2 });
  assert.equal(editor.readOnly, null);
  // The plugin's split policy runs on migrated payloads. line-1 also carries a
  // namespace no plugin owns, so it cannot be split.
  assert.equal(
    codeOf(editor.dispatch(commands.splitClip({ clipId: "line-1", at: 3000 }))),
    "split-policy-required",
  );
  commit(editor.dispatch(commands.updateClip({ clipId: "line-2", gain: 0.25 })));
  const [right] = commit(
    editor.dispatch(commands.splitClip({ clipId: "line-2", at: 7000 })),
  ).createdIds;
  commit(
    editor.dispatch(
      commands.updateClip({ clipId: "bed", extensions: { "app.status": { state: "final" } } }),
    ),
  );
  assert.equal(
    codeOf(
      editor.dispatch(
        commands.updateClip({ clipId: "bed", extensions: { "app.status": "final" } }),
      ),
    ),
    "invalid-extension",
  );
  const edited = editor.getSnapshot();
  const halves = edited.clips.filter((clip) => clip.id === "line-2" || clip.id === right);
  assert.deepEqual(
    halves.map((clip) => [clip.id, clip.extensions, clip.gain, clip.rate]),
    [
      ["line-2", { "app.status": { state: "draft" } }, 0.25, 1.5],
      [right, { "app.status": { state: "draft" } }, 0.25, 1.5],
    ],
  );

  const file = save(edited);
  migrations.length = 0;
  const reopened = createEditor({ project: file, plugins: [statusV2] });
  assert.deepEqual(migrations, []);
  assert.deepEqual(reopened.getSnapshot(), edited);
  assert.deepEqual(save(reopened.getSnapshot()), file);

  // Undo still walks back to the migrated project, not the file as written.
  pass(editor.history.undo());
  pass(editor.history.undo());
  pass(editor.history.undo());
  assert.deepEqual(editor.getSnapshot().clips, opened.clips);
  assert.equal(editor.history.canUndo, false);
});

test("a project round-trips through an editor that lacks its plugin", () => {
  const file = save(
    createEditor({ project: fixture("schema-1.json"), plugins: [statusV2] }).getSnapshot(),
  );
  const bare = createEditor({ project: file, actor: "bo" });
  const migration = migrateProject(file);
  assert.equal(migration.upgraded, false);
  assert.deepEqual(migration.unread, []);
  // Payloads it cannot read stay exactly as written, through every edit it can make.
  commit(bare.dispatch(commands.moveClips({ clipIds: ["line-2"], delta: 500 })));
  commit(bare.dispatch(commands.trimClip({ clipId: "line-1", edge: "right", delta: -500 })));
  commit(bare.dispatch(commands.updateClip({ clipId: "line-1", gain: 2, name: "Line one" })));
  commit(bare.dispatch(commands.moveMarker({ markerId: "m-1", delta: 100 })));
  commit(bare.dispatch(commands.updateTrack({ trackId: "voice", name: "Dialogue" })));
  // Splitting needs the plugin's semantics, so it is refused without changing anything.
  const before = bare.getSnapshot();
  const refused = bare.dispatch(commands.splitClip({ clipId: "line-2", at: 8000 }));
  assert.equal(codeOf(refused), "split-policy-required");
  assert.equal(bare.getSnapshot(), before);
  // A clip without the payload still splits.
  const [piece] = commit(
    bare.dispatch(commands.splitClip({ clipId: "bed", at: 10000 })),
  ).createdIds;
  const edited = bare.getSnapshot();
  assert.deepEqual(edited.extensionVersions, { "app.status": 2 });
  const payloads = (snapshot: ProjectSnapshot): unknown => ({
    tracks: snapshot.tracks.map((track) => track.extensions),
    clips: snapshot.clips.map((clip) => [clip.id, clip.extensions]),
    markers: (snapshot.markers ?? []).map((marker) => marker.extensions),
    takes: (snapshot.takes ?? []).map((take) => take.extensions),
  });
  const written = createEditor({ project: file }).getSnapshot();
  assert.deepEqual(payloads(edited), {
    tracks: written.tracks.map((track) => track.extensions),
    clips: [...written.clips.map((clip) => [clip.id, clip.extensions]), [piece, undefined]],
    markers: (written.markers ?? []).map((marker) => marker.extensions),
    takes: (written.takes ?? []).map((take) => take.extensions),
  });

  // Reopened with the plugin, the payloads validate and the split works again.
  const saved = save(edited);
  const full = createEditor({ project: saved, plugins: [statusV2], actor: "cy" });
  assert.deepEqual(full.getSnapshot(), edited);
  const [half] = commit(
    full.dispatch(commands.splitClip({ clipId: "line-2", at: 8000 })),
  ).createdIds;
  assert.deepEqual(full.getSnapshot().clips.find((clip) => clip.id === half)?.extensions, {
    "app.status": { state: "draft" },
  });
});

test("payloads a later plugin version wrote are kept unread, and splitting their clips is refused", () => {
  const newer = save(
    createEditor({ project: fixture("schema-2.json"), plugins: [statusV2] }).getSnapshot(),
  );
  newer.extensionVersions = { "app.status": 3 };
  const line = newer.clips.find((clip) => clip.id === "line-1");
  assert.ok(line);
  // Invalid for version 2: an older plugin must not judge it.
  line.extensions = { "app.status": [{ state: "final", at: "2026-11-25" }] };
  const migration = migrateProject(newer, { plugins: [statusV2] });
  assert.deepEqual(migration.unread, ["app.status"]);
  assert.deepEqual(migration.extensions, []);
  assert.equal(migration.upgraded, false);

  const editor = createEditor({ project: newer, plugins: [statusV2], actor: "di" });
  const refused = editor.dispatch(commands.splitClip({ clipId: "line-1", at: 3000 }));
  assert.equal(codeOf(refused), "split-policy-required");
  assert.match(refused.ok ? "" : refused.reason, /later version of the app\.status plugin/);
  commit(editor.dispatch(commands.updateClip({ clipId: "line-1", gain: 0.5 })));
  const saved = save(editor.getSnapshot());
  assert.deepEqual(saved.extensionVersions, { "app.status": 3 });
  assert.deepEqual(saved.clips.find((clip) => clip.id === "line-1")?.extensions, line.extensions);

  // Version 3 itself would reject the version 2 payloads still in the file,
  // as it should: this fixture mixes versions only to show that 2 leaves 3's alone.
  assert.throws(() => createEditor({ project: saved, plugins: [statusV3] }), EditError);
});

test("a project in a later schema opens read-only and saves as written", () => {
  const later = save(
    createEditor({ project: fixture("schema-2.json"), plugins: [statusV2] }).getSnapshot(),
  );
  later.schemaVersion = 3;
  later["crossfades"] = [{ from: "line-1", to: "line-2", length: 200 }];
  const migration = migrateProject(later, { plugins: [statusV2] });
  assert.equal(migration.readOnly, "newer-schema");
  assert.equal(migration.from, 3);
  assert.equal(migration.upgraded, false);

  const editor = createEditor({ project: later, plugins: [statusV2] });
  assert.equal(editor.readOnly, "newer-schema");
  const snapshot = editor.getSnapshot();
  assert.equal(snapshot.schemaVersion, 3);
  assert.deepEqual(save(snapshot), later);
  for (const result of [
    editor.dispatch(commands.moveClips({ clipIds: ["line-2"], delta: 10 })),
    editor.preview(commands.moveClips({ clipIds: ["line-2"], delta: 10 })),
    editor.history.undo(),
    editor.history.redo(),
    editor.replace(later),
  ]) {
    assert.equal(codeOf(result), "read-only");
    assert.equal(result.ok ? null : result.target, "newer-schema");
  }
  assert.equal(editor.getSnapshot(), snapshot);
  // Reading still works.
  assert.equal(editor.read().clipsIn({ start: 0, end: 100000 }).length, 3);

  // A later schema that does not read under this one's rules is unsupported.
  const unreadable = { ...later, clips: { "line-1": {} } };
  assert.throws(
    // @ts-expect-error -- Clips are a map in this made-up later schema.
    () => createEditor({ project: unreadable }),
    (error: unknown) =>
      error instanceof EditError && error.code === "unsupported-schema" && error.target === 3,
  );
});

test("migration rejects what it cannot read and never changes its input", () => {
  for (const schemaVersion of [0, -1, 1.5, "1", undefined]) {
    assert.throws(
      () => migrateProject({ schemaVersion, tracks: [], clips: [] }),
      (error: unknown) => error instanceof EditError && error.code === "unsupported-schema",
    );
  }
  for (const extensionVersions of [[], { a: 0 }, { a: 1.5 }, { "": 2 }, { a: "2" }]) {
    assert.throws(
      () => migrateProject({ schemaVersion: 2, tracks: [], clips: [], extensionVersions }),
      (error: unknown) => error instanceof EditError && error.code === "invalid-project",
    );
  }
  // Canonical versions: sorted, without version 1.
  assert.deepEqual(
    migrateProject({
      schemaVersion: 2,
      tracks: [],
      clips: [],
      extensionVersions: { b: 2, a: 3, c: 1 },
    }).project.extensionVersions,
    { a: 3, b: 2 },
  );
  assert.equal(
    migrateProject({ schemaVersion: 2, tracks: [], clips: [], extensionVersions: { c: 1 } }).project
      .extensionVersions,
    undefined,
  );

  // A migration may drop a payload, and must return JSON.
  const dropping: TimelinePlugin = {
    namespace: "app.status",
    version: 2,
    migrate: () => undefined,
  };
  const dropped = migrateProject(fixture("schema-1.json"), { plugins: [dropping] }).project;
  assert.deepEqual(
    dropped.clips.map((clip) => clip.extensions),
    [{ "host.other": { keep: [1, 2] } }, undefined, undefined],
  );
  assert.equal(dropped.tracks[0]?.extensions, undefined);
  const notJson: TimelinePlugin = {
    namespace: "app.status",
    version: 2,
    // A Map is not JSON; Reflect.construct hides that from the type checker, as plain JS would.
    migrate: (): JsonValue =>
      Reflect.get(Object.create(null, { map: { value: new Map() } }), "map"),
  };
  assert.throws(
    () => migrateProject(fixture("schema-1.json"), { plugins: [notJson] }),
    (error: unknown) => error instanceof EditError && error.code === "invalid-extension",
  );
  // A migrated payload must still validate.
  const invalid: TimelinePlugin = { ...statusV2, migrate: () => ({ state: "lost" }) };
  assert.throws(
    () => createEditor({ project: fixture("schema-1.json"), plugins: [invalid] }),
    (error: unknown) => error instanceof EditError && error.code === "invalid-extension",
  );
  // Without a migration, earlier payloads are read as they are.
  const relabelled = migrateProject(fixture("schema-1.json"), {
    plugins: [{ ...statusV1, version: 2 }],
  });
  assert.deepEqual(relabelled.extensions, [{ namespace: "app.status", from: 1, to: 2 }]);
  assert.equal(relabelled.project.tracks[0]?.extensions?.["app.status"], "draft");
  assert.throws(
    // @ts-expect-error -- Plugins are checked before anything migrates.
    () => migrateProject(fixture("schema-1.json"), { plugins: [{ ...statusV2, migrate: 1 }] }),
    EditError,
  );
});

test("a version 1 plugin records nothing, and a newer editor's snapshot opens without a parse", () => {
  const plain = createEditor({ project: fixture("schema-1.json"), plugins: [statusV1] });
  assert.equal(plain.getSnapshot().extensionVersions, undefined);
  assert.equal(plain.getSnapshot().schemaVersion, 2);
  const a = createEditor({ project: fixture("schema-1.json"), plugins: [statusV2] });
  const b = createEditor({ project: a.getSnapshot(), plugins: [statusV2] });
  assert.equal(b.getSnapshot(), a.getSnapshot());
});

test("replacing with a saved earlier-schema snapshot migrates it first", () => {
  const editor = createEditor({ project: fixture("schema-1.json"), plugins: [statusV2] });
  const before = editor.getSnapshot();
  const older = fixture("schema-1.json");
  const line = older.clips.find((clip) => clip.id === "line-2");
  assert.ok(line);
  line.start = 7000;
  const result = commit(editor.replace(older));
  assert.deepEqual(result.changedIds, ["line-2"]);
  assert.deepEqual(editor.getSnapshot().clips.find((clip) => clip.id === "line-2")?.extensions, {
    "app.status": { state: "draft" },
  });
  assert.deepEqual(editor.getSnapshot().extensionVersions, before.extensionVersions);
  // One that needs a plugin version this editor does not read is refused.
  const newer = save(before);
  newer.extensionVersions = { "app.status": 3 };
  assert.equal(codeOf(editor.replace(newer)), "unsupported-schema");
});

test("clip gain is validated, canonical, edited, split, undone and planned", () => {
  const base = (): Draft<Project> => ({
    schemaVersion: 2,
    tracks: [{ id: "voice", gain: 0.5 }],
    clips: [
      {
        id: "line",
        trackId: "voice",
        kind: "audio",
        start: 0,
        duration: hz,
        contentIn: 0,
        source: { assetId: "line", streamId: "mono" },
      },
    ],
  });
  for (const gain of [-0.1, MAX_CLIP_GAIN + 0.01, "1", null]) {
    const p = base();
    // @ts-expect-error -- An unchecked host may pass anything.
    p.clips[0].gain = gain;
    assert.throws(
      () => createEditor({ project: p }),
      (error: unknown) => error instanceof EditError && error.code === "invalid-gain",
    );
  }
  const unity = base();
  unity.clips[0].gain = 1;
  assert.equal(
    Object.hasOwn(createEditor({ project: unity }).getSnapshot().clips[0] ?? {}, "gain"),
    false,
  );

  const editor = createEditor({ project: base(), actor: "ed" });
  const catalog: StreamCatalog = {
    version: 1,
    streams: {
      line: {
        mono: { assetVersion: 1, sampleRate: 48000, availableStart: 0, availableEnd: 48000 },
      },
    },
  };
  const spanGain = (): number | undefined =>
    editor.read().planAudio({ start: 0, end: hz }, catalog).spans[0]?.gain;
  assert.equal(spanGain(), 0.5);
  const louder = commit(editor.dispatch(commands.updateClip({ clipId: "line", gain: 2 })));
  assert.equal(spanGain(), 1);
  const changes = clipFieldChanges(louder.clipPatches[0] ?? assert.fail());
  assert.deepEqual(changes.fields["gain"], { before: undefined, after: 2 });
  assert.deepEqual(changes.placement, {});
  for (const gain of [-1, MAX_CLIP_GAIN * 2, Number.NaN]) {
    assert.equal(
      codeOf(editor.dispatch(commands.updateClip({ clipId: "line", gain }))),
      "invalid-gain",
    );
  }
  commit(editor.dispatch(commands.splitClip({ clipId: "line", at: 0.4 * hz })));
  assert.deepEqual(
    editor.getSnapshot().clips.map((clip) => clip.gain),
    [2, 2],
  );
  commit(editor.dispatch(commands.updateClip({ clipId: "ed-1", gain: 0 })));
  const plan = editor.read().planAudio({ start: 0, end: hz }, catalog);
  assert.deepEqual(
    plan.spans.map((span) => [span.clipId, span.gain]),
    [["line", 1]],
  );
  commit(editor.dispatch(commands.updateClip({ clipId: "line", gain: null })));
  assert.equal(Object.hasOwn(editor.getSnapshot().clips[0] ?? {}, "gain"), false);
  commit(editor.dispatch(commands.updateClip({ clipId: "ed-1", gain: 1 })));
  assert.equal(Object.hasOwn(editor.getSnapshot().clips[1] ?? {}, "gain"), false);
  commit(
    editor.dispatch(
      commands.addClip({
        clip: {
          id: "new",
          trackId: "voice",
          kind: "audio",
          start: 2 * hz,
          duration: 10,
          gain: 0.25,
        },
      }),
    ),
  );
  assert.equal(editor.getSnapshot().clips.at(-1)?.gain, 0.25);
  assert.equal(
    codeOf(
      editor.dispatch(
        commands.addClip({
          clip: { trackId: "voice", kind: "audio", start: 3 * hz, duration: 10, gain: -2 },
        }),
      ),
    ),
    "invalid-gain",
  );
  for (let i = 0; i < 6; i++) pass(editor.history.undo());
  assert.deepEqual(
    editor.getSnapshot().clips,
    createEditor({ project: base() }).getSnapshot().clips,
  );
});
