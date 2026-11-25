import type {
  Clip,
  JsonObject,
  JsonValue,
  Tick,
  TimelinePlugin,
  ValidateExtensionContext,
} from "./types.ts";
import { freezeJson, isArray, isRecord, requireEdit, validId } from "./validation.ts";

/** Validates and freezes a domain plugin definition. */
export function definePlugin(plugin: TimelinePlugin): TimelinePlugin {
  requireEdit(
    typeof plugin === "object" && plugin !== null && !isArray(plugin),
    "invalid-extension",
    null,
    "Expected a plugin definition object",
  );
  requireEdit(
    validId(plugin.namespace),
    "invalid-extension",
    plugin.namespace,
    "A plugin requires a nonempty namespace",
  );
  requireEdit(
    typeof plugin.version === "number" &&
      Number.isSafeInteger(plugin.version) &&
      plugin.version > 0,
    "invalid-extension",
    plugin.namespace,
    "A plugin version must be a positive safe integer",
  );
  requireEdit(
    plugin.validate === undefined || typeof plugin.validate === "function",
    "invalid-extension",
    plugin.namespace,
    "Plugin validate must be a function",
  );
  requireEdit(
    plugin.onSplit === undefined || typeof plugin.onSplit === "function",
    "invalid-extension",
    plugin.namespace,
    "Plugin onSplit must be a function",
  );
  requireEdit(
    plugin.migrate === undefined || typeof plugin.migrate === "function",
    "invalid-extension",
    plugin.namespace,
    "Plugin migrate must be a function",
  );
  return Object.freeze({
    namespace: plugin.namespace,
    version: plugin.version,
    ...(plugin.validate === undefined ? {} : { validate: plugin.validate }),
    ...(plugin.onSplit === undefined ? {} : { onSplit: plugin.onSplit }),
    ...(plugin.migrate === undefined ? {} : { migrate: plugin.migrate }),
  });
}

export interface PluginRegistry {
  readonly hasPlugins: boolean;
  validate(
    target: ValidateExtensionContext["target"],
    id: string,
    extensions: JsonObject | undefined,
  ): void;
  split(
    clip: Clip,
    left: Clip,
    right: Clip,
    at: Tick,
  ): { readonly left: JsonObject | undefined; readonly right: JsonObject | undefined };
}

const emptyRegistry: PluginRegistry = Object.freeze<PluginRegistry>({
  hasPlugins: false,
  validate() {},
  split(clip) {
    requireEdit(
      !Object.keys(clip.extensions ?? {}).length,
      "split-policy-required",
      clip.id,
      "A split policy is required for this clip extension",
    );
    return { left: undefined, right: undefined };
  },
});

/**
 * Registers domain plugins for an editor. Rejects duplicate namespaces.
 * `unread` names namespaces a later plugin version wrote, which the editor
 * keeps without reading.
 */
export function createPluginRegistry(
  plugins: readonly TimelinePlugin[] | undefined,
  unread: readonly string[] = [],
): PluginRegistry {
  if ((!plugins || plugins.length === 0) && !unread.length) return emptyRegistry;
  plugins ??= [];
  requireEdit(isArray(plugins), "invalid-extension", null, "Expected an array of plugins");
  const byNamespace = new Map<string, TimelinePlugin>();
  for (const raw of plugins) {
    const plugin = definePlugin(raw);
    requireEdit(
      !byNamespace.has(plugin.namespace),
      "invalid-extension",
      plugin.namespace,
      "Duplicate plugin namespace: " + plugin.namespace,
    );
    byNamespace.set(plugin.namespace, plugin);
  }

  function validateNamespace(
    target: ValidateExtensionContext["target"],
    id: string,
    namespace: string,
    value: JsonValue,
  ): void {
    const plugin = byNamespace.get(namespace);
    if (!plugin?.validate) return;
    const reason = plugin.validate(Object.freeze({ target, id, value }));
    requireEdit(
      reason === undefined || reason === "",
      "invalid-extension",
      id,
      typeof reason === "string" ? reason : "Extension validation failed: " + namespace,
    );
  }

  return Object.freeze<PluginRegistry>({
    hasPlugins: true,
    validate(target, id, extensions) {
      if (!extensions) return;
      for (const [namespace, value] of Object.entries(extensions)) {
        validateNamespace(target, id, namespace, value);
      }
    },
    split(clip, left, right, at) {
      const extensions = clip.extensions;
      if (!extensions) return { left: undefined, right: undefined };
      const entries = Object.entries(extensions);
      if (!entries.length) return { left: undefined, right: undefined };
      const leftEntries: [string, JsonValue][] = [];
      const rightEntries: [string, JsonValue][] = [];
      for (const [namespace, value] of entries) {
        const plugin = byNamespace.get(namespace);
        requireEdit(
          plugin?.onSplit,
          "split-policy-required",
          clip.id,
          unread.includes(namespace)
            ? "A later version of the " + namespace + " plugin wrote this clip's payload"
            : "A split policy is required for this clip extension: " + namespace,
        );
        const result: unknown = plugin.onSplit(Object.freeze({ clip, left, right, at, value }));
        requireEdit(
          typeof result === "object" && result !== null && !isArray(result),
          "invalid-extension",
          clip.id,
          "Plugin onSplit must return { left, right } for " + namespace,
        );
        const leftRaw: unknown = Reflect.get(result, "left");
        const rightRaw: unknown = Reflect.get(result, "right");
        if (leftRaw !== undefined) {
          const frozen = freezeJson(leftRaw);
          validateNamespace("clip", left.id, namespace, frozen);
          leftEntries.push([namespace, frozen]);
        }
        if (rightRaw !== undefined) {
          const frozen = freezeJson(rightRaw);
          validateNamespace("clip", right.id, namespace, frozen);
          rightEntries.push([namespace, frozen]);
        }
      }
      const make = (list: [string, JsonValue][]): JsonObject | undefined => {
        if (!list.length) return undefined;
        const record: JsonValue = Object.freeze(Object.fromEntries(list));
        return isRecord(record) ? record : undefined;
      };
      return { left: make(leftEntries), right: make(rightEntries) };
    },
  });
}
