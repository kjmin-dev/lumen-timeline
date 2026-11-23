// Unstable helpers for this repository's tests. Not part of the public API.
export { hit, pack, pixelAt, rectangle, tickAt, viewport, zoomAt } from "./geometry.ts";
export type { Box, Packed, Span } from "./geometry.ts";
export { handleAt, snapDelta } from "./gestures.ts";
export type { SnapHold, SnapRead } from "./gestures.ts";
export { activeTake, captionWords, takeCaption } from "./captions.ts";
export { placeWaveform, unit } from "./waveforms.ts";
export type { PlacedWaveform } from "./waveforms.ts";
export { isImage, labelInset, labelTop, layoutRow, QuadList, quadFloats, rgba } from "./layout.ts";
export type { LabelSlot, LabelSource, LayoutRow, RowLayout } from "./layout.ts";
export { readPixels } from "./probe.ts";
export type { PixelRect, Pixels } from "./renderer.ts";
