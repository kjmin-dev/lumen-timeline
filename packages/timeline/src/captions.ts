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

/** The take a clip plays, among the takes it lists. */
export function activeTake(clip: Clip, takes: readonly Take[]): Take | undefined {
  const id = clip.activeTakeId;
  if (typeof id !== "string") return undefined;
  for (const take of takes) if (take.id === id) return take;
  return undefined;
}

/**
 * The caption of a clip that lists candidates: the label of `active`, its
 * active take, or the word for none, and the candidate count. `undefined` for
 * a clip without any.
 */
export function takeCaption(
  clip: Clip,
  active: Take | undefined,
  words: CaptionWords,
): string | undefined {
  const count = clip.takeIds?.length ?? 0;
  if (!count) return undefined;
  const name = active ? (active.label ?? active.id) : words.none;
  return name + " · " + count + " " + (count === 1 ? words.take : words.takes);
}
