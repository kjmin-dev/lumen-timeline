import type { Clip, Take } from "@lumen-timeline/core";
import type { TimelineLabels } from "./types.ts";

/** The words a caption uses, with the defaults filled in. */
export interface CaptionWords {
  readonly take: string;
  readonly takes: string;
  readonly none: string;
}

export function captionWords(labels: TimelineLabels = {}): CaptionWords {
  const take = labels.take ?? "take";
  return {
    take,
    takes: labels.takes ?? take + "s",
    none: labels.none ?? "No " + take,
  };
}

/**
 * The caption of a clip that lists candidates: the active take's label, or the
 * word for none, and the candidate count. `undefined` for a clip without any.
 */
export function takeCaption(
  clip: Clip,
  takesOf: (clipId: string) => readonly Take[],
  words: CaptionWords,
): string | undefined {
  const count = clip.takeIds?.length ?? 0;
  if (!count) return undefined;
  const active = clip.activeTakeId ?? null;
  const take = active === null ? undefined : takesOf(clip.id).find((t) => t.id === active);
  const name = take ? (take.label ?? take.id) : words.none;
  return name + " · " + count + " " + (count === 1 ? words.take : words.takes);
}
