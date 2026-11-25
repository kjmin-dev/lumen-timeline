# Plugins and persistence

A project is JSON. The core owns its tracks, clips, takes, markers and the fields it gives meaning to; an application's own data rides along in two places. A record's `extensions[namespace]` holds a payload that a plugin can validate, migrate and split. A project's `entityData` holds sparse fields the host reads and writes with `setEntityData`, which the core stores without interpreting ([selective history](selective-history.md#what-history-retains)). This page covers plugins, saving a project, its schema versions and what an editor does with data it cannot read.

## Write a plugin

A plugin owns one namespace of `extensions` on clips, tracks, markers and takes. Name it after the application, such as `app.subtitles`, so two plugins never share one.

```js
import { commands, createEditor, definePlugin } from "@lumen-timeline/core";

// Version 1 stored { text }. Version 2 adds the speaker, unknown for older lines.
const subtitles = definePlugin({
  namespace: "app.subtitles",
  version: 2,
  validate({ value }) {
    if (typeof value?.text !== "string") return "A subtitle needs its text";
    if (value.speaker !== null && typeof value.speaker !== "string")
      return "A subtitle's speaker is a name or null";
  },
  migrate({ value, from }) {
    return from < 2 ? { ...value, speaker: null } : value;
  },
  onSplit({ value }) {
    // Both halves keep the speaker. The text stays with the left half until it is retimed.
    return { left: value, right: { text: "", speaker: value.speaker } };
  },
});

const editor = createEditor({ project, plugins: [subtitles] });
editor.dispatch(
  commands.updateClip({
    clipId: "line-12",
    extensions: { "app.subtitles": { text: "Over here!", speaker: "Mira" } },
  }),
);
```

- **`version`.** The version of the payloads the plugin reads and writes, a positive integer. Raise it when the shape of a payload changes. Once a plugin has opened a project, the project records its version in `extensionVersions`, so the next editor knows which version wrote the payloads. Version 1 is the default and is not recorded.
- **`validate({ target, id, value })`.** Runs on every payload of the namespace when a project opens, after any migration, and on every edit that writes one: adding or updating a clip, track, marker or take, and each half of a split. `target` is `"clip"`, `"track"`, `"marker"` or `"take"`. A nonempty string rejects the load or the edit with `invalid-extension` and that reason.
- **`migrate({ target, id, value, from })`.** Upgrades one payload that version `from` wrote to the plugin's own version. It runs once per payload when a project records an earlier version for the namespace, before validation, on a copy of the project. Return the new payload, or `undefined` to drop the namespace from that record. Without `migrate`, payloads of earlier versions are read as they are: raise the version without one when the new version still reads the old shape. A migration that returns something other than JSON fails with `invalid-extension`.
- **`onSplit({ clip, left, right, at, value })`.** Returns the payload for each half of a split clip, `{ left, right }`, or `undefined` on a side to leave the namespace off it. Both halves are validated. Without it, a clip carrying the namespace cannot be split.
- **Registration.** `createEditor({ project, plugins })` and `migrateProject(project, { plugins })` take the list. Two plugins with one namespace, or a plugin whose fields are not functions, fail with `invalid-extension` before anything opens.

## Save and reopen

`editor.getSnapshot()` is the project, ready for `JSON.stringify`. Pass it, parsed, to `createEditor` to reopen it at the same revision. History stays with the editor, and the selection with its session.

```js
const text = JSON.stringify(editor.getSnapshot());
const reopened = createEditor({ project: JSON.parse(text), plugins: [subtitles] });
```

A host that saves while the user keeps editing saves the latest snapshot once the save in flight lands, rather than one write per edit. Its storage, not the editor, decides whether someone else saved first:

```js
let saving = null;
let dirty = false;

editor.subscribe(
  (snapshot) => snapshot.revision,
  () => void save(),
);

async function save() {
  dirty = true;
  if (saving) return saving;
  saving = (async () => {
    while (dirty) {
      dirty = false;
      const snapshot = editor.getSnapshot();
      // `store` is the host's: a file, IndexedDB or a server that rejects a stale write.
      await store.write(JSON.stringify(snapshot), { revision: snapshot.revision });
    }
  })().finally(() => (saving = null));
  return saving;
}
```

A snapshot is immutable, so the one being written cannot change under the save, and the next one is read only when the write finishes.

## Schema versions

A project's `schemaVersion` is versioned on its own, apart from the packages. An editor writes `SCHEMA_VERSION` and opens every earlier schema by migrating a copy.

| Schema | Changes                                                                                                                                                     |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | The first schema.                                                                                                                                           |
| 2      | A clip's [`gain`](headless-editing.md#clip-gain) and the project's `extensionVersions`. A schema-1 reader would play the one at unity and ignore the other. |

- **Earlier schemas.** `createEditor` migrates a copy, validates it and opens the result. The input is never changed. The snapshot is at the current schema, so saving it writes the upgraded project. A schema-1 project carries neither field, so its records stay as they are; one that used either name for its own data is read under schema 2's rules, and must rename that data first if it means something else there.
- **Later schemas.** A project in a schema the editor does not know opens read-only when it still reads under the current schema's rules. `editor.readOnly` is `"newer-schema"`, and every dispatch, undo, redo, preview and replacement fails with the code `read-only` and that target. A [timeline view](vanilla-timeline.md) mounted on it is read-only unless the host says otherwise. Its snapshot keeps the schema version and every field as written, so nothing is lost if it is saved. One that does not read under the current rules fails to open with `unsupported-schema`.

To migrate a file before opening it, or to keep the original until the upgrade is safe, call `migrateProject`. It does what `createEditor` does when it opens a project and reports what it found:

```js
import { migrateProject, SCHEMA_VERSION } from "@lumen-timeline/core";

const original = JSON.parse(await file.text());
const migration = migrateProject(original, { plugins: [subtitles] });
// { project, from, extensions: [{ namespace, from, to }], unread, readOnly, upgraded }
if (migration.upgraded) {
  await backups.write(file.name, JSON.stringify(original));
  await files.write(file.name, JSON.stringify(migration.project));
}
const editor = createEditor({ project: migration.project, plugins: [subtitles] });
```

`migrateProject` throws an `EditError` for a project it cannot open, before anything is written, so the original stays as it was. `project` is a frozen snapshot that `createEditor` opens without a second migration.

## Missing and newer plugins

An editor keeps every payload it cannot read exactly as written, so a project passes unharmed through an editor that lacks one of its plugins, such as a viewer, a script or an older build.

- **Without the plugin.** The namespace's payloads are not validated. Moves, trims, retimes, gain, take and marker edits, renames and removals keep them unchanged, and saving writes them back. Splitting a clip that carries one fails with `split-policy-required`, because only the plugin knows what each half should hold. The project's recorded version for the namespace stays. Reopened with the plugin, the payloads are validated again and splits work.
- **From a later version.** A project whose `extensionVersions` records a later version than the registered plugin's opens with that namespace unread, as if its plugin were absent: its payloads are kept and not validated, and splitting a clip that carries one fails with `split-policy-required`, naming the later version. `migrateProject(project, { plugins }).unread` lists such namespaces. The recorded version is never lowered.
- **Writing.** An edit that writes a payload for a namespace no registered plugin reads is not checked. Write those only when the host knows the shape.

## Regression checks

`packages/core/test/migrate.test.ts` opens the migration fixtures in `packages/core/test/fixtures`. `schema-1.json` is a schema-1 project with version 1 of a plugin on a track, clips, a marker and a take, beside a payload no plugin owns, entity data and host fields. Migrated with version 2 of the plugin it must equal `schema-2.json` exactly, and the golden file must open unchanged. Then:

- **Previous schema.** The schema-1 project is opened, split, given a gain and a new payload, saved as JSON and reopened to the same snapshot; undo walks back to the migrated project, and the input is unchanged.
- **Missing plugin.** The migrated project is edited by an editor without the plugin, which keeps every payload, refuses to split a clip that carries one and splits one that does not. Saved and reopened with the plugin, it validates and splits again.
- **Later versions.** A payload of version 3 survives an editor with version 2 unread and unvalidated. A schema-3 project opens read-only, refuses every kind of edit and saves as written, and one that does not read as schema 2 fails with `unsupported-schema`.

`npm test` runs it, against the sources and against the build.
