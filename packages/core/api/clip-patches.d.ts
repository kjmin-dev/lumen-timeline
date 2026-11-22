import type { Clip, ClipFieldChanges, ClipPatch } from "./types.ts";
/** What a clip patch changed, field by field, with placement in content space. */
export declare function clipFieldChanges(patch: ClipPatch): ClipFieldChanges;
export declare function inverse(patches: readonly ClipPatch[]): readonly ClipPatch[];
export declare class ClipDraft {
    readonly clips: readonly Clip[];
    readonly positions: ReadonlyMap<string, number>;
    readonly edited: Map<string, Clip>;
    readonly owners: Map<string, number>;
    readonly groups: Map<number, Clip[]>;
    constructor(clips: readonly Clip[], positions: ReadonlyMap<string, number>);
    get(id: string): Clip | undefined;
    /** Each clip this transaction touched so far, with the clips that now stand in its place. */
    changes(): Iterable<readonly [Clip, readonly Clip[]]>;
    replace(clip: Clip, after: readonly Clip[]): void;
    patches(): readonly ClipPatch[];
}
/**
 * Maps recorded clip patches onto the current clips by ID. An addition needs a
 * free ID. A removal needs the whole recorded clip. An update is merged field
 * by field. `validate` checks each resulting clip.
 */
export declare function rebase(patches: readonly ClipPatch[], clips: readonly Clip[], positions: ReadonlyMap<string, number>, validate: (clip: Clip) => void): readonly ClipPatch[];
/**
 * Applies patches whose `before` states match the clips. A new clip goes after
 * the clip it follows, or to the end when that clip is absent.
 */
export declare function applyClips(clips: readonly Clip[], patches: readonly ClipPatch[]): readonly Clip[];
