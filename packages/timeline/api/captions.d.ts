import type { Clip, Take } from "@lumen-timeline/core";
import type { TimelineLabels } from "./types.ts";
/** The words a caption uses, with the defaults filled in. */
export interface CaptionWords {
    readonly take: string;
    readonly takes: string;
    readonly none: string;
}
export declare function captionWords(labels?: TimelineLabels): CaptionWords;
/** The take a clip plays, among the takes it lists. */
export declare function activeTake(clip: Clip, takes: readonly Take[]): Take | undefined;
/**
 * The caption of a clip that lists candidates: the label of `active`, its
 * active take, or the word for none, and the candidate count. `undefined` for
 * a clip without any.
 */
export declare function takeCaption(clip: Clip, active: Take | undefined, words: CaptionWords): string | undefined;
