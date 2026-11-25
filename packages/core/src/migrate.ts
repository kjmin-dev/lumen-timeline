import { openProject, parseExtensionVersions, type OpenedProject } from "./document.ts";
import { SCHEMA_VERSION } from "./schema.ts";
import { createPluginRegistry, definePlugin, type PluginRegistry } from "./plugins.ts";
import type { ExtensionUpgrade, JsonObject, JsonValue, TimelinePlugin } from "./types.ts";
import {
  EditError,
  freezeJson,
  isArray,
  isRecord,
  requireEdit,
  safeInteger,
} from "./validation.ts";

type Target = "track" | "clip" | "marker" | "take";

/** The lists whose records carry plugin payloads, and the record each holds. */
const LISTS: readonly (readonly [string, Target])[] = [
  ["tracks", "track"],
  ["clips", "clip"],
  ["markers", "marker"],
  ["takes", "take"],
];

/**
 * One step per schema version, from that version to the next. Each takes a
 * frozen project at its version and returns one at the next.
 *
 * Schema 2 gives two field names a meaning: a clip's `gain` and the project's
 * `extensionVersions`. A schema-1 project carries neither, so its records stay
 * as they are; a schema-1 project that used either name for its own data is
 * read under schema 2's rules and must be valid under them.
 */
const STEPS: ReadonlyMap<number, (project: JsonObject) => JsonObject> = new Map([
  [1, (project: JsonObject): JsonObject => ({ ...project, schemaVersion: 2 })],
]);

/** A project as a migration leaves it, ready to open. */
export interface Migrated {
  /** The input itself when nothing changed, so an issued snapshot opens without a parse. */
  readonly project: unknown;
  readonly from: number;
  readonly extensions: readonly ExtensionUpgrade[];
  readonly unread: readonly string[];
  readonly readOnly: string | null;
  /** The plugins that read the project: those whose payloads it does not hold from a later version. */
  readonly plugins: readonly TimelinePlugin[];
}

/**
 * Brings a project to `SCHEMA_VERSION` and its plugin payloads to the
 * registered plugins' versions, without changing the input. It validates
 * nothing beyond what it reads; opening the result validates it.
 */
export function migrate(input: unknown, plugins: readonly TimelinePlugin[] | undefined): Migrated {
  // Rejects malformed and duplicate plugins before anything else.
  createPluginRegistry(plugins);
  const defined = (plugins ?? []).map(definePlugin);
  const schemaVersion: unknown =
    typeof input === "object" && input !== null && !isArray(input)
      ? Reflect.get(input, "schemaVersion")
      : undefined;
  requireEdit(
    safeInteger(schemaVersion) && schemaVersion >= 1,
    "unsupported-schema",
    schemaVersion,
    "Expected a project schema version",
  );
  if (schemaVersion > SCHEMA_VERSION)
    return {
      project: input,
      from: schemaVersion,
      extensions: [],
      unread: [],
      readOnly: "newer-schema",
      plugins: [],
    };

  let project: JsonObject | undefined;
  // Only an earlier schema or a plugin upgrade needs a copy.
  const current = (): JsonObject => {
    if (project) return project;
    const frozen = freezeJson(input);
    requireEdit(isRecord(frozen), "invalid-project", null, "Expected a project object");
    project = frozen;
    return project;
  };
  for (let version = schemaVersion; version < SCHEMA_VERSION; version++) {
    const step = STEPS.get(version);
    requireEdit(step, "unsupported-schema", version, "No migration from schema " + version);
    project = Object.freeze(step(current()));
  }

  const source: unknown = project ?? input;
  const rawVersions: unknown =
    typeof source === "object" && source !== null
      ? Reflect.get(source, "extensionVersions")
      : undefined;
  const written =
    rawVersions === undefined ? undefined : parseExtensionVersions(freezeJson(rawVersions));
  const versions = new Map(Object.entries(written ?? {}));
  const extensions: ExtensionUpgrade[] = [];
  const unread: string[] = [];
  const reading: TimelinePlugin[] = [];
  for (const plugin of [...defined].sort((a, b) => compare(a.namespace, b.namespace))) {
    const from = versions.get(plugin.namespace) ?? 1;
    if (from > plugin.version) {
      unread.push(plugin.namespace);
      continue;
    }
    reading.push(plugin);
    if (from === plugin.version) continue;
    if (plugin.migrate) project = upgrade(current(), plugin, from);
    versions.set(plugin.namespace, plugin.version);
    extensions.push(Object.freeze({ namespace: plugin.namespace, from, to: plugin.version }));
  }
  if (extensions.length) {
    const recorded = Object.fromEntries([...versions].filter(([, version]) => version !== 1));
    const { extensionVersions: _old, ...rest } = current();
    project = Object.freeze(
      Object.keys(recorded).length ? { ...rest, extensionVersions: recorded } : rest,
    );
  }
  // Registration order, as the editor validates and splits in it.
  const order = new Set(reading);
  return {
    project: project ?? input,
    from: schemaVersion,
    extensions: Object.freeze(extensions),
    unread: Object.freeze(unread),
    readOnly: null,
    plugins: defined.filter((plugin) => order.has(plugin)),
  };
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Runs a plugin's migration over every payload of its namespace. */
function upgrade(project: JsonObject, plugin: TimelinePlugin, from: number): JsonObject {
  const migrateValue = plugin.migrate;
  if (!migrateValue) return project;
  const { namespace } = plugin;
  const changed: [string, JsonValue][] = [];
  for (const [field, target] of LISTS) {
    const list = project[field];
    if (!isArray(list)) continue;
    let touched = false;
    const next = list.map((record): JsonValue => {
      if (!isRecord(record)) return record;
      const extensions = record["extensions"];
      if (!isRecord(extensions) || !Object.hasOwn(extensions, namespace)) return record;
      const value = extensions[namespace];
      if (value === undefined) return record;
      const id = record["id"];
      const result: unknown = migrateValue(
        Object.freeze({ target, id: typeof id === "string" ? id : "", value, from }),
      );
      touched = true;
      // The upgraded payload keeps its place among the others.
      const payloads = Object.fromEntries(
        Object.entries(extensions).flatMap(([key, item]): [string, JsonValue][] =>
          key !== namespace
            ? [[key, item]]
            : result === undefined
              ? []
              : [[key, checked(result, plugin, id)]],
        ),
      );
      const { extensions: _ext, ...fields } = record;
      return Object.freeze(
        Object.keys(payloads).length ? { ...fields, extensions: Object.freeze(payloads) } : fields,
      );
    });
    if (touched) changed.push([field, Object.freeze(next)]);
  }
  return changed.length ? Object.freeze({ ...project, ...Object.fromEntries(changed) }) : project;
}

function checked(value: unknown, plugin: TimelinePlugin, id: JsonValue | undefined): JsonValue {
  try {
    return freezeJson(value);
  } catch (error) {
    if (!(error instanceof EditError)) throw error;
    throw new EditError(
      "invalid-extension",
      id,
      "Plugin migrate must return JSON for " + plugin.namespace,
    );
  }
}

/**
 * Opens a migrated project. A later schema that does not read under this
 * one's rules is unsupported.
 */
export function openMigrated(migrated: Migrated, registry: PluginRegistry): OpenedProject {
  if (migrated.readOnly === null) return openProject(migrated.project, registry);
  try {
    return openProject(migrated.project, registry, true);
  } catch (error) {
    if (!(error instanceof EditError)) throw error;
    throw new EditError(
      "unsupported-schema",
      migrated.from,
      "Schema " +
        migrated.from +
        " is newer than " +
        SCHEMA_VERSION +
        " and does not read as it: " +
        error.message,
    );
  }
}
