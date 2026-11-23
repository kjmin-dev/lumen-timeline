import type { Clip, Take, Track } from "@lumen-timeline/core";
import { activeTake, takeCaption } from "./captions.ts";
import type { CaptionWords } from "./captions.ts";
import { rectangle } from "./geometry.ts";
import type { Box, Packed, Viewport } from "./geometry.ts";
import { placeWaveform } from "./waveforms.ts";
import type { WaveformRequest } from "./types.ts";

// One CPU layout feeds every drawing backend. A row's layout is a list of quads
// in stacking order, in CSS pixels relative to the viewport origin: the row's
// background, grid lines, then each clip's fill, stripe, waveform columns and
// label. A label quad crops a region of the label atlas.

/** Floats per quad: x, y, width, height, then the atlas region u0, v0, u1, v1. */
export const quadFloats = 8;

/** A packed color: red in the lowest byte, alpha in the highest, as GPUs read RGBA8. */
export type Rgba = number;

export function rgba(hex: string, alpha = 255): Rgba {
  const value = Number.parseInt(hex.slice(1, 7), 16);
  return (((alpha & 255) << 24) | ((value & 255) << 16) | (value & 0xff00) | (value >>> 16)) >>> 0;
}

/** The quads of one row, reused from paint to paint. */
export class QuadList {
  count = 0;
  data: Float32Array<ArrayBuffer> = new Float32Array(64 * quadFloats);
  colors: Uint32Array<ArrayBuffer> = new Uint32Array(64);

  clear(): void {
    this.count = 0;
  }
  private reserve(): number {
    if (this.count === this.colors.length) {
      const data = new Float32Array(this.data.length * 2);
      data.set(this.data);
      const colors = new Uint32Array(this.colors.length * 2);
      colors.set(this.colors);
      this.data = data;
      this.colors = colors;
    }
    return this.count++;
  }
  /** A solid rectangle. Its atlas region is empty. */
  rect(x: number, y: number, w: number, h: number, color: Rgba): void {
    const i = this.reserve();
    const at = i * quadFloats;
    this.data[at] = x;
    this.data[at + 1] = y;
    this.data[at + 2] = w;
    this.data[at + 3] = h;
    this.data[at + 4] = this.data[at + 5] = this.data[at + 6] = this.data[at + 7] = 0;
    this.colors[i] = color;
  }
  /** A crop of the label atlas, drawn unchanged. */
  image(
    x: number,
    y: number,
    w: number,
    h: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
  ): void {
    const i = this.reserve();
    const at = i * quadFloats;
    this.data[at] = x;
    this.data[at + 1] = y;
    this.data[at + 2] = w;
    this.data[at + 3] = h;
    this.data[at + 4] = u0;
    this.data[at + 5] = v0;
    this.data[at + 6] = u1;
    this.data[at + 7] = v1;
    this.colors[i] = 0xffffffff;
  }
}

/** Whether quad `i` crops the atlas rather than filling a color. */
export const isImage = (list: QuadList, i: number): boolean =>
  (list.data[i * quadFloats + 6] ?? 0) > (list.data[i * quadFloats + 4] ?? 0);

/** A label rasterized in the atlas, in normalized atlas coordinates and CSS pixels. */
export interface LabelSlot {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
  readonly width: number;
  readonly height: number;
}

/** Rasterizes a clip's name and caption, or returns `null` when the atlas is full. */
export type LabelSource = (
  name: string,
  caption: string | undefined,
  captionColor: string,
) => LabelSlot | null;

/** A track row as the view lays it out. */
export interface LayoutRow extends Packed {
  readonly track: Track;
  readonly index: number;
  /** Top in the scrolled content, in CSS pixels. */
  readonly top: number;
}

export interface RowLayout {
  readonly view: Viewport;
  readonly width: number;
  /** The row's top relative to the viewport. */
  readonly top: number;
  readonly dpr: number;
  /** Grid line positions across the viewport. */
  readonly grid: readonly number[];
  readonly words: CaptionWords;
  readonly takesOf: (clipId: string) => readonly Take[];
  peaks?: ((request: WaveformRequest) => ArrayLike<number> | null) | undefined;
  readonly label: LabelSource;
  /** Collects the assets whose waveforms the row asked for. */
  readonly assets?: Set<string> | undefined;
}

/** Where a label starts after its clip's left edge, and its top below the clip's. */
export const labelInset = 9;
export const labelTop = 6;
/**
 * The least room, in CSS pixels, a clip needs for its label. Narrower clips,
 * as when zoomed far out, would show a letter or two, and their labels would
 * crowd the atlas.
 */
export const labelRoom = 24;
/** Label height in CSS pixels, with the text's baseline 15 pixels down. */
export const labelHeight = 20;
export const labelBaseline = 15;

const colors = [
  ["#2b5555", "#87d6cb"],
  ["#604332", "#ffb184"],
  ["#464360", "#c8bbff"],
] as const;
/** A row's fill and stripe colors. */
export const palette = (index: number): readonly [string, string] =>
  colors[index % colors.length] ?? colors[0];
const backgrounds = [rgba("#191e22"), rgba("#1b2025")] as const;
const gridColor = rgba("#2b3136");
const fills = colors.map(([fill, stripe]) => [rgba(fill), rgba(stripe), rgba(stripe, 0x66)]);

/** A peak value clamped to -1 to 1, or `null` for a column with nothing to draw. */
function peak(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(-1, Math.min(1, value))
    : null;
}

/**
 * Lays out one row's visible clips into `quads`, appending their boxes to
 * `boxes` for hit tests. `clips` are the row's clips in the visible range.
 */
export function layoutRow(
  row: LayoutRow,
  clips: readonly Clip[],
  layout: RowLayout,
  quads: QuadList,
  boxes: Box<Clip>[],
): void {
  const { view, width, top, dpr } = layout;
  quads.clear();
  quads.rect(0, top, width, row.height - 1, backgrounds[row.index % 2] ?? 0);
  for (const x of layout.grid) quads.rect(Math.round(x), top, 1, row.height, gridColor);
  const [fill = 0, stripe = 0, ink = 0] = fills[row.index % fills.length] ?? [];
  const stripeText = palette(row.index)[1];
  for (const clip of clips) {
    // pack() assigned a lane to every clip on this track.
    const b = rectangle(clip, row.lanes.get(clip.id) ?? 0, top, view, width);
    if (b.endX <= b.x) continue;
    boxes.push(b);
    quads.rect(b.x, b.y, b.endX - b.x, b.height, fill);
    quads.rect(b.x, b.y, b.endX - b.x, 3, stripe);
    // The clip's takes are read once, for its waveform and its caption.
    const active = clip.takeIds ? activeTake(clip, layout.takesOf(clip.id)) : undefined;
    if (active) waveform(clip, active, b, layout, quads, ink);
    // The label starts on a device pixel and is cropped 3 pixels inside the clip.
    const x = Math.round((b.x + labelInset) * dpr) / dpr;
    const room = b.endX - 3 - x;
    if (room < labelRoom) continue;
    const caption = takeCaption(clip, active, layout.words);
    const slot = layout.label(clip.name ?? clip.id, caption, stripeText);
    if (!slot) continue;
    const w = Math.min(slot.width, room);
    const u1 = slot.u0 + ((slot.u1 - slot.u0) * w) / slot.width;
    quads.image(x, b.y + labelTop, w, slot.height, slot.u0, slot.v0, u1, slot.v1);
  }
}

// The active take's peaks across the clip's visible columns, below its name.
function waveform(
  clip: Clip,
  take: Take,
  b: Box<Clip>,
  layout: RowLayout,
  quads: QuadList,
  color: Rgba,
): void {
  if (!layout.peaks) return;
  const placed = placeWaveform(clip, take, b.x, b.endX, layout.view);
  if (!placed) return;
  layout.assets?.add(take.assetId);
  const { buckets } = placed.request;
  const peaks = layout.peaks(placed.request);
  if (!peaks || peaks.length < 2 * buckets) return;
  // Below the stripe, with the name drawn over it.
  const mid = b.y + 3 + (b.height - 3) / 2;
  const half = (b.height - 7) / 2;
  for (let i = 0; i < buckets; i++) {
    const lo = peak(peaks[2 * i]);
    const hi = peak(peaks[2 * i + 1]);
    if (lo === null || hi === null) continue;
    const y = mid - hi * half;
    quads.rect(placed.x + i, y, 1, Math.max(1, mid - lo * half - y), color);
  }
}
