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

/** A clip's rate as a percentage of normal speed: "125%", "133.3%". */
export function ratePercent(rate: number): string {
  return Math.round(rate * 1000) / 10 + "%";
}

/**
 * The caption beside a clip's name: its takes, as `takeCaption` gives them,
 * then its speed when the clip has a rate. `undefined` when there is neither.
 */
export function clipCaption(
  clip: Clip,
  active: Take | undefined,
  words: CaptionWords,
): string | undefined {
  const takes = takeCaption(clip, active, words);
  const rate = clip.rate === undefined || clip.rate === 1 ? undefined : ratePercent(clip.rate);
  if (rate === undefined) return takes;
  return takes === undefined ? rate : takes + " · " + rate;
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
