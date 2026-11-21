import type { Editor, MarkerCrossing, PresentationSource, Unsubscribe } from "./types.ts";
/**
 * Reports the markers that continuous playback crosses, in `(previous, current]`
 * order. A seek starts a new segment, so a marker at its destination or between
 * the old and new positions is not crossed. Markers are read from the editor's
 * current revision when the source reports progress. Listener errors are
 * reported without ending the watch. Stop the watch before disposing the source.
 */
export declare function watchMarkerCrossings(editor: Editor, source: PresentationSource, listener: (crossing: MarkerCrossing) => void): Unsubscribe;
