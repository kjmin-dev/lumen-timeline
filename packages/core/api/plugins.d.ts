import type { Clip, JsonObject, Tick, TimelinePlugin, ValidateExtensionContext } from "./types.ts";
/** Validates and freezes a domain plugin definition. */
export declare function definePlugin(plugin: TimelinePlugin): TimelinePlugin;
export interface PluginRegistry {
    readonly hasPlugins: boolean;
    validate(target: ValidateExtensionContext["target"], id: string, extensions: JsonObject | undefined): void;
    split(clip: Clip, left: Clip, right: Clip, at: Tick): {
        readonly left: JsonObject | undefined;
        readonly right: JsonObject | undefined;
    };
}
/** Registers domain plugins for an editor. Rejects duplicate namespaces. */
export declare function createPluginRegistry(plugins: readonly TimelinePlugin[] | undefined): PluginRegistry;
