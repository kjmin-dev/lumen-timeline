import { EditError } from "@lumen-timeline/core";
import type { Clip, Editor, PlanOptions, Tick, TickRange, Unsubscribe } from "@lumen-timeline/core";
import type { Audition, AuditionMode, AuditionRequest } from "./types.ts";

/** A validated audition request and the plan options that play it. */
export interface AuditionPlan {
  readonly clipId: string;
  readonly takeId: string | null;
  readonly mode: AuditionMode;
  readonly range: TickRange;
  readonly options: PlanOptions;
}

const modes: readonly unknown[] = ["mix", "isolated"];

/**
 * Checks a request against the editor's current snapshot. Throws an `EditError`
 * for an unknown clip or a take the clip does not list, and a `TypeError` for
 * a malformed request.
 */
export function planAudition(editor: Editor, request: AuditionRequest): AuditionPlan {
  if (typeof request !== "object" || request === null)
    throw new TypeError("Expected an audition request");
  const { clipId, takeId } = request;
  const mode = request.mode ?? "mix";
  if (!modes.includes(mode)) throw new TypeError("Expected audition mode mix or isolated");
  // Throws missing-clip for an unknown clip.
  const takes = editor.read().takesOf(clipId);
  if (takeId !== null && !takes.some((take) => take.id === takeId))
    throw new EditError("missing-take", takeId, "The take is not a candidate of this clip");
  const clip = editor.getSnapshot().clips.find((c) => c.id === clipId);
  // Unreachable: takesOf found the clip in the same snapshot.
  if (!clip) throw new EditError("missing-clip", clipId, "Clip does not exist");
  return Object.freeze({
    clipId,
    takeId,
    mode,
    range: Object.freeze({ start: clip.start, end: clip.start + clip.duration }),
    options: Object.freeze({
      takeOverrides: Object.freeze({ [clipId]: takeId }),
      ...(mode === "isolated" ? { isolate: clipId } : {}),
    }),
  });
}

export function auditionState(plan: AuditionPlan, returnTick: Tick): Audition {
  return Object.freeze({
    clipId: plan.clipId,
    takeId: plan.takeId,
    mode: plan.mode,
    range: plan.range,
    returnTick,
  });
}

/** Whether the clip can still play the audition as it was planned. */
function holds(plan: AuditionPlan, clip: Clip | undefined): boolean {
  return (
    clip !== undefined &&
    clip.start === plan.range.start &&
    clip.start + clip.duration === plan.range.end &&
    (plan.takeId === null || (clip.takeIds ?? []).includes(plan.takeId))
  );
}

/**
 * Calls `lost` once when an edit removes the clip, moves either of its edges
 * or stops listing the auditioned take.
 */
export function watchAudition(editor: Editor, plan: AuditionPlan, lost: () => void): Unsubscribe {
  // The listener runs only after a later commit, once `off` is assigned.
  const off = editor.subscribe(
    (snapshot) => snapshot.clips.find((clip) => clip.id === plan.clipId),
    (clip) => {
      if (holds(plan, clip)) return;
      off();
      lost();
    },
  );
  return off;
}
