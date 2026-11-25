import { migrate, openMigrated } from "./migrate.ts";
import { createPluginRegistry } from "./plugins.ts";
import { SCHEMA_VERSION } from "./schema.ts";
import type { MigrateOptions, ProjectMigration } from "./types.ts";

/**
 * Brings a project to the current schema and its plugin payloads to the
 * given plugins' versions, then validates it, as `createEditor` does when it
 * opens one. The input is never changed. Save the result in place of the
 * original only once it has been returned, so a failed migration leaves the
 * original as it was.
 */
export function migrateProject(project: unknown, options?: MigrateOptions): ProjectMigration {
  const migrated = migrate(project, options?.plugins);
  const opened = openMigrated(migrated, createPluginRegistry(migrated.plugins, migrated.unread));
  return Object.freeze({
    project: opened.snapshot,
    from: migrated.from,
    extensions: migrated.extensions,
    unread: migrated.unread,
    readOnly: migrated.readOnly,
    upgraded: migrated.from < SCHEMA_VERSION || migrated.extensions.length > 0,
  });
}
