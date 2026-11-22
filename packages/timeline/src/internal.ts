// Unstable helpers for this repository's tests. Not part of the public API.
export { hit, pack, pixelAt, rectangle, tickAt, viewport, zoomAt } from "./geometry.ts";
export type { Box, Packed, Span } from "./geometry.ts";
export { handleAt, snapDelta } from "./gestures.ts";
export type { SnapHold, SnapRead } from "./gestures.ts";
export { captionWords, takeCaption } from "./captions.ts";
