import type { MigrateOptions, ProjectMigration } from "./types.ts";
/**
 * Brings a project to the current schema and its plugin payloads to the
 * given plugins' versions, then validates it, as `createEditor` does when it
 * opens one. The input is never changed. Save the result in place of the
 * original only once it has been returned, so a failed migration leaves the
 * original as it was.
 */
export declare function migrateProject(project: unknown, options?: MigrateOptions): ProjectMigration;
