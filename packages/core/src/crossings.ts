import { reportListenerError } from "./host.ts";
import type {
  Editor,
  MarkerCrossing,
  PresentationSource,
  PresentationState,
  Unsubscribe,
} from "./types.ts";

/**
 * Reports the markers that continuous playback crosses, in `(previous, current]`
 * order. A seek starts a new segment, so a marker at its destination or between
 * the old and new positions is not crossed. Markers are read from the editor's
 * current revision when the source reports progress. Listener errors are
 * reported without ending the watch. Stop the watch before disposing the source.
 */
export function watchMarkerCrossings(
  editor: Editor,
  source: PresentationSource,
  listener: (crossing: MarkerCrossing) => void,
): Unsubscribe {
  let active = true;
  const initial = source.snapshot();
  let segment = initial.segment;
  // The furthest tick presented in this segment. Presentation can report a
  // slightly earlier frame without crossing the same markers twice.
  let reached = initial.presentedTick;

  function observe(state: PresentationState): void {
    if (!active) return;
    if (state.segment !== segment) {
      segment = state.segment;
      reached = state.segmentStart;
    }
    const through = state.presentedTick;
    if (!Number.isSafeInteger(through) || !Number.isSafeInteger(reached) || through <= reached)
      return;
    const after = reached;
    reached = through;
    try {
      const read = editor.read();
      const markers = read.markersIn({ start: after + 1, end: through + 1 });
      if (markers.length)
        listener(Object.freeze({ markers, after, through, revision: read.revision }));
    } catch (error) {
      reportListenerError(error);
    }
  }

  const unsubscribe = source.subscribe(observe);
  return () => {
    if (!active) return false;
    active = false;
    unsubscribe();
    return true;
  };
}
