import type { Clip, Take } from "@lumen-timeline/core";
import type { TimelineLabels } from "./types.ts";
/** The words a caption uses, with the defaults filled in. */
export interface CaptionWords {
    readonly take: string;
    readonly takes: string;
    readonly none: string;
}
export declare function captionWords(labels?: TimelineLabels): CaptionWords;
/**
 * The caption of a clip that lists candidates: the active take's label, or the
 * word for none, and the candidate count. `undefined` for a clip without any.
 */
export declare function takeCaption(clip: Clip, takesOf: (clipId: string) => readonly Take[], words: CaptionWords): string | undefined;
