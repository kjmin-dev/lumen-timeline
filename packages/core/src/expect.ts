import type { ClipDraft } from "./clip-patches.ts";
import { jsonEqual } from "./entity-data.ts";
import type { DataDraft } from "./entity-data.ts";
import type { ExpectClipCommand, ExpectDataCommand } from "./types.ts";
import { isArray, requireEdit, validId } from "./validation.ts";

/** Rejects the transaction unless the staged clip has the expected fields. */
export function expectClip({ clipId, fields }: ExpectClipCommand, clips: ClipDraft): void {
  requireEdit(
    validId(clipId) &&
      typeof fields === "object" &&
      fields !== null &&
      !isArray(fields) &&
      Object.keys(fields).every(validId),
    "invalid-expectation",
    clipId,
    "Expected a clip ID and a map of fields",
  );
  const clip = clips.get(clipId);
  requireEdit(clip, "expectation-failed", clipId, "Clip does not exist");
  for (const key of Object.keys(fields)) {
    const actual = Object.hasOwn(clip, key) ? clip[key] : undefined;
    requireEdit(
      jsonEqual(actual, fields[key]),
      "expectation-failed",
      clipId,
      "Clip field changed: " + key,
    );
  }
}

/** Rejects the transaction unless the staged entity field has the expected value. */
export function expectData({ scope, id, key, value }: ExpectDataCommand, data: DataDraft): void {
  requireEdit(
    [scope, id, key].every(validId),
    "invalid-expectation",
    id,
    "Expected nonempty scope, entity ID and field key",
  );
  requireEdit(
    jsonEqual(data.current(scope, id, key), value),
    "expectation-failed",
    id,
    "Entity data changed at " + JSON.stringify([scope, id, key]),
  );
}
