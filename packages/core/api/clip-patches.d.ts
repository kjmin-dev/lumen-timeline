import type { Clip, ClipFieldChanges, ClipPatch } from "./types.ts";
export declare function sameFields(a: Clip, b: Clip): boolean;
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
 * Replays an edit of a candidate list onto the current list. The edit owns the
 * elements it added, removed or moved; every other element stays where it is
 * now. A removed element that is already gone stays gone. An owned element
 * goes after its nearest predecessor in the edit's result that the list holds,
 * or first.
 */
export declare function mergeList(found: readonly string[], before: readonly string[], after: readonly string[]): readonly string[];
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
