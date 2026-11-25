import type { Clip, Take, Track } from "@lumen-timeline/core";
import { activeTake, clipCaption } from "./captions.ts";
import type { CaptionWords } from "./captions.ts";
import {
  laneHeight as defaultLaneHeight,
  rectangle,
  rowInset as defaultRowInset,
} from "./geometry.ts";
import type { Box, Packed, Viewport } from "./geometry.ts";
import { placeWaveform } from "./waveforms.ts";
import type { WaveformSource } from "./waveforms.ts";
import type { ClipStyleFn, WaveformRequest } from "./types.ts";

// One CPU layout feeds every drawing backend. A row's layout is a list of quads
// in stacking order, in CSS pixels relative to the viewport origin: the row's
// lane strip, grid lines, the band of its take lanes, then each clip's body,
// waveform bars and label. A label quad crops a region of the label atlas, and
// a solid quad can have rounded corners.

/** Floats per quad: x, y, width, height, then the atlas region u0, v0, u1, v1. */
export const quadFloats = 8;

/** A packed color: red in the lowest byte, alpha in the highest, as GPUs read RGBA8. */
export type Rgba = number;

function parseHexRgb(hex: string): readonly [number, number, number, number] | null {
  if (!hex.startsWith("#")) return null;
  const digits = hex.slice(1);
  if (digits.length === 3) {
    const r = Number.parseInt(digits.charAt(0) + digits.charAt(0), 16);
    const g = Number.parseInt(digits.charAt(1) + digits.charAt(1), 16);
    const b = Number.parseInt(digits.charAt(2) + digits.charAt(2), 16);
    return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : [r, g, b, 255];
  }
  if (digits.length === 6 || digits.length === 8) {
    const r = Number.parseInt(digits.slice(0, 2), 16);
    const g = Number.parseInt(digits.slice(2, 4), 16);
    const b = Number.parseInt(digits.slice(4, 6), 16);
    const a = digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) : 255;
    return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) || Number.isNaN(a)
      ? null
      : [r, g, b, a];
  }
  return null;
}

export function rgba(hex: string, alpha?: number): Rgba {
  const parsed = parseHexRgb(hex);
  if (!parsed) return 0;
  const [r, g, b, parsedAlpha] = parsed;
  const a = alpha === undefined ? parsedAlpha : alpha;
  return (((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;
}

const hexByte = (value: number): string =>
  Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, "0");

/** `from` moved toward `to` by `amount` (0 to 1), as an opaque `#rrggbb`. Unparsable colors stay as given. */
export function mixHex(from: string, to: string, amount: number): string {
  const a = parseHexRgb(from);
  const b = parseHexRgb(to);
  if (!a || !b) return from;
  const mix = (i: 0 | 1 | 2): string => hexByte(a[i] + (b[i] - a[i]) * amount);
  return "#" + mix(0) + mix(1) + mix(2);
}

/** A color's relative luminance, 0 to 1, or 0 for a color that does not parse. */
function luminance(hex: string): number {
  const parsed = parseHexRgb(hex);
  if (!parsed) return 0;
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(parsed[0]) + 0.7152 * linear(parsed[1]) + 0.0722 * linear(parsed[2]);
}

/** The ink that reads on a fill: near black on a light one, near white on a dark one. */
export function inkOn(fill: string): string {
  return luminance(fill) > 0.18 ? "#0c0e11" : "#f4f6f7";
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
    this.round(x, y, w, h, color, 0);
  }
  /**
   * A solid rectangle with rounded corners. The radius rides in the second
   * atlas coordinate, which a solid quad does not otherwise use.
   */
  round(x: number, y: number, w: number, h: number, color: Rgba, radius: number): void {
    const i = this.reserve();
    const at = i * quadFloats;
    this.data[at] = x;
    this.data[at + 1] = y;
    this.data[at + 2] = w;
    this.data[at + 3] = h;
    this.data[at + 4] = this.data[at + 6] = this.data[at + 7] = 0;
    this.data[at + 5] = Math.max(0, Math.min(radius, w / 2, h / 2));
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

/** The corner radius of solid quad `i`, in CSS pixels. */
export const radiusOf = (list: QuadList, i: number): number =>
  isImage(list, i) ? 0 : (list.data[i * quadFloats + 5] ?? 0);

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
  nameColor: string,
) => LabelSlot | null;

/** A track row as the view lays it out. */
export interface LayoutRow extends Packed {
  readonly track: Track;
  readonly index: number;
  /** Top in the scrolled content, in CSS pixels. */
  readonly top: number;
}

/** One palette entry as the layout reads it. */
export interface RowColors {
  readonly stripeHex: string;
  readonly textHex: string;
  readonly fill: Rgba;
  readonly stripe: Rgba;
  readonly waveform: Rgba;
}

export interface RowTheme {
  readonly scheme?: "light" | "dark" | undefined;
  readonly rowEven: Rgba;
  readonly rowOdd: Rgba;
  readonly grid: Rgba;
  readonly drawer?: Rgba | undefined;
  readonly drawerLine?: Rgba | undefined;
  /** One color for every clip name, instead of each entry's own. */
  readonly labelColor?: string | undefined;
  readonly palette: readonly RowColors[];
  /** The colors of a locked track's clips. */
  readonly locked?: RowColors | undefined;
}

/** The candidates a row shows as take lanes under its clip lanes. */
export interface TakeLanes {
  readonly clipId: string;
  readonly takes: readonly Take[];
}

/** A take lane's rectangle in CSS pixels, for hit tests. */
export interface TakeBox {
  readonly clipId: string;
  readonly takeId: string;
  readonly x: number;
  readonly endX: number;
  readonly y: number;
  readonly height: number;
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
  /** Maps a peak, after the clip's gain, to the height drawn. */
  readonly scale?: ((peak: number) => number) | undefined;
  readonly label: LabelSource;
  /** Collects the assets whose waveforms the row asked for. */
  readonly assets?: Set<string> | undefined;
  readonly laneHeight?: number | undefined;
  readonly rowInset?: number | undefined;
  readonly theme?: RowTheme | undefined;
  readonly clipStyle?: ClipStyleFn | undefined;
  /** Take lanes at the bottom of the row; the row's height already holds them. */
  readonly takeLanes?: TakeLanes | undefined;
  /** Collects the take lanes' rectangles. */
  readonly takeBoxes?: TakeBox[] | undefined;
}

/** Where a label starts after its clip's left edge. */
export const labelInset = 8;
/**
 * The least room, in CSS pixels, a clip needs for its label. Narrower clips,
 * as when zoomed far out, would show a letter or two, and their labels would
 * crowd the atlas.
 */
export const labelRoom = 24;
/** Label height in CSS pixels, with the text's baseline 15 pixels down. */
export const labelHeight = 20;
export const labelBaseline = 15;

/** The pitch of a take lane and the height of the lane itself, in CSS pixels. */
export const takeLanePitch = 26;
export const takeLaneHeight = 22;
/** The height `count` take lanes add to a row. */
export const takeLanesHeight = (count: number): number =>
  count > 0 ? count * takeLanePitch + 2 : 0;

/**
 * The height of a clip's name row: the label sits there, above the waveform.
 * A clip too short for both draws its waveform over its full height instead,
 * with the label on top.
 */
export const nameRow = (clipHeight: number): number =>
  clipHeight >= 40 ? 19 : clipHeight >= 30 ? 16 : 0;

/** The gap above a row's lane strip, and its rounding. */
export const stripGap = (inset: number): number => Math.min(2, inset);
const stripRadius = 10;
const clipRadius = 7;
/** A waveform bar and the gap after it, in CSS pixels. */
const barWidth = 2;
const barPitch = 3;

const fallback: RowTheme = {
  scheme: "dark",
  rowEven: rgba("#090a0c"),
  rowOdd: rgba("#090a0c"),
  grid: 0,
  drawer: rgba("#121315"),
  drawerLine: rgba("#27282a"),
  palette: [
    ["#4cd7c8", "#004942"],
    ["#f9a870", "#593215"],
    ["#c3aeff", "#40355e"],
  ].map(([fill = "", wave = ""]) => ({
    stripeHex: fill,
    textHex: "#0c0e11",
    fill: rgba(fill),
    stripe: rgba(fill),
    waveform: rgba(wave),
  })),
  locked: {
    stripeHex: "#999fa6",
    textHex: "#0c0e11",
    fill: rgba("#999fa6"),
    stripe: rgba("#999fa6"),
    waveform: rgba("#3e4349"),
  },
};

/**
 * Clip colors drawn from one accent, a `track.color` or `clip.color`: a vivid
 * body with a dark waveform on the dark scheme, a tinted body with a
 * saturated waveform on the light one.
 */
function fromAccent(accent: string, scheme: "light" | "dark"): RowColors {
  if (scheme === "light") {
    return {
      stripeHex: accent,
      textHex: mixHex(accent, "#000000", 0.62),
      fill: rgba(mixHex(accent, "#ffffff", 0.82)),
      stripe: rgba(accent),
      waveform: rgba(accent),
    };
  }
  return {
    stripeHex: accent,
    textHex: inkOn(accent),
    fill: rgba(accent),
    stripe: rgba(accent),
    waveform: rgba(mixHex(accent, "#000000", 0.68)),
  };
}

const isHex = (color: string | undefined): color is string =>
  color !== undefined && parseHexRgb(color) !== null;

/** A text color at reduced strength, for captions beside a name. */
const soften = (hex: string): string => (parseHexRgb(hex) && hex.length === 7 ? hex + "b8" : hex);

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
  const { view, width, top, dpr, clipStyle } = layout;
  const theme = layout.theme ?? fallback;
  const scheme = theme.scheme ?? "dark";
  const laneH = layout.laneHeight ?? defaultLaneHeight;
  const inset = layout.rowInset ?? defaultRowInset;
  quads.clear();
  const gap = stripGap(inset);
  const lanes = layout.takeLanes;
  const drawerHeight = lanes ? takeLanesHeight(lanes.takes.length) : 0;
  const rowBg = row.index % 2 === 0 ? theme.rowEven : theme.rowOdd;
  // The lane strip: the row without its gaps, rounded at both ends.
  const stripTop = top + gap;
  const stripHeight = Math.max(1, row.height - 3 - 2 * gap);
  quads.round(0, stripTop, width, stripHeight, rowBg, stripRadius);
  if (theme.grid >>> 24)
    for (const x of layout.grid) quads.rect(Math.round(x), stripTop, 1, stripHeight, theme.grid);
  const drawerTop = stripTop + stripHeight - drawerHeight;
  if (lanes && drawerHeight) {
    // Rounded at the strip's bottom corners only: the band starts a radius
    // higher, and the strip's color covers that start again.
    quads.round(
      0,
      drawerTop - stripRadius,
      width,
      drawerHeight + stripRadius,
      theme.drawer ?? rowBg,
      stripRadius,
    );
    quads.rect(0, drawerTop - stripRadius, width, stripRadius, rowBg);
    quads.rect(0, drawerTop, width, 1, theme.drawerLine ?? rowBg);
  }
  const entry = theme.palette[row.index % theme.palette.length] ?? fallback.palette[0];
  const trackColor = isHex(row.track.color) ? row.track.color : undefined;
  const rowColors: RowColors | undefined = trackColor
    ? fromAccent(trackColor, scheme)
    : row.track.locked === true
      ? (theme.locked ?? entry)
      : entry;
  if (!rowColors) return;

  for (const clip of clips) {
    // pack() assigned a lane to every clip on this track.
    const b = rectangle(clip, row.lanes.get(clip.id) ?? 0, top, view, width, laneH, inset);
    if (b.endX <= b.x) continue;
    boxes.push(b);
    const custom = clipStyle?.(clip, row.track, row.index);
    const own = isHex(clip.color) ? fromAccent(clip.color, scheme) : rowColors;
    const fill = isHex(custom?.fill) ? rgba(custom.fill) : own.fill;
    const stripe = isHex(custom?.stripe) ? rgba(custom.stripe) : own.stripe;
    const ink = isHex(custom?.waveform)
      ? rgba(custom.waveform)
      : isHex(custom?.stripe)
        ? rgba(custom.stripe, 0x66)
        : own.waveform;
    const textHex = theme.labelColor ?? (isHex(custom?.fill) ? inkOn(custom.fill) : own.textHex);
    const captionColor = custom?.captionColor ?? soften(textHex);
    // Drawn past the viewport's edges, so a clip cut off there shows no corner.
    const x0 = Math.max(b.left, -2 * clipRadius);
    const x1 = Math.min(b.right, width + 2 * clipRadius);
    quads.round(x0, b.y, x1 - x0, b.height, fill, clipRadius);
    // The clip's takes are read once, for its waveform and its caption.
    const active = clip.takeIds ? activeTake(clip, layout.takesOf(clip.id)) : undefined;
    const mediaSource: WaveformSource | undefined =
      active ?? (!clip.takeIds ? clip.source : undefined);
    const named = nameRow(b.height);
    if (mediaSource) {
      const waveTop = b.y + (named ? named + 1 : 3);
      const waveHeight = b.y + b.height - (named ? 4 : 3) - waveTop;
      bars(clip, mediaSource, b, waveTop, waveHeight, layout, quads, ink);
    }
    if (lanes && lanes.clipId === clip.id)
      takeLanes(clip, lanes, b, drawerTop, { fill, stripe, ink }, theme, rowBg, layout, quads);
    // The label starts on a device pixel and is cropped 3 pixels inside the clip.
    const x = Math.round((b.x + labelInset) * dpr) / dpr;
    const room = b.endX - 3 - x;
    if (room < labelRoom) continue;
    const caption =
      custom?.caption === null
        ? undefined
        : custom?.caption !== undefined
          ? custom.caption
          : clipCaption(clip, active, layout.words);
    const slot = layout.label(
      custom?.label ?? clip.name ?? clip.id,
      caption,
      captionColor,
      textHex,
    );
    if (!slot) continue;
    const w = Math.min(slot.width, room);
    const u1 = slot.u0 + ((slot.u1 - slot.u0) * w) / slot.width;
    const labelY = b.y + (named ? Math.floor((named - labelHeight) / 2) : 5);
    quads.image(x, labelY, w, slot.height, slot.u0, slot.v0, u1, slot.v1);
  }
}

// One lane per candidate under the clip, each with its own waveform. The
// active candidate's lane is filled like the clip; the others are outlined.
function takeLanes(
  clip: Clip,
  lanes: TakeLanes,
  b: Box<Clip>,
  drawerTop: number,
  colors: { readonly fill: Rgba; readonly stripe: Rgba; readonly ink: Rgba },
  theme: RowTheme,
  rowBg: Rgba,
  layout: RowLayout,
  quads: QuadList,
): void {
  const x0 = Math.max(b.left, -2 * clipRadius);
  const x1 = Math.min(b.right, layout.width + 2 * clipRadius);
  const outline = ((colors.stripe & 0xffffff) | (0x8c << 24)) >>> 0;
  const faint = ((colors.stripe & 0xffffff) | (0xb3 << 24)) >>> 0;
  lanes.takes.forEach((take, index) => {
    const y = drawerTop + 2 + index * takeLanePitch;
    if (take.id === clip.activeTakeId) {
      quads.round(x0, y, x1 - x0, takeLaneHeight, colors.fill, 5);
    } else {
      quads.round(x0, y, x1 - x0, takeLaneHeight, outline, 5);
      quads.round(x0 + 1, y + 1, x1 - x0 - 2, takeLaneHeight - 2, theme.drawer ?? rowBg, 4);
    }
    bars(
      clip,
      take,
      b,
      y + 3,
      takeLaneHeight - 6,
      layout,
      quads,
      take.id === clip.activeTakeId ? colors.ink : faint,
    );
    layout.takeBoxes?.push({
      clipId: clip.id,
      takeId: take.id,
      x: b.x,
      endX: b.endX,
      y,
      height: takeLaneHeight,
    });
  });
}

// A source's peaks as bars across the clip's visible columns: each bar spans
// the loudest of the columns it and the gap after it stand for. Bars count from
// the clip's own left edge, so they stay put while the view pans.
function bars(
  clip: Clip,
  source: WaveformSource,
  b: Box<Clip>,
  top: number,
  height: number,
  layout: RowLayout,
  quads: QuadList,
  color: Rgba,
): void {
  if (!layout.peaks || height < 2) return;
  const placed = placeWaveform(clip, source, b.x, b.endX, layout.view);
  if (!placed) return;
  layout.assets?.add(source.assetId);
  const { buckets } = placed.request;
  const peaks = layout.peaks(placed.request);
  if (!peaks || peaks.length < 2 * buckets) return;
  const mid = top + height / 2;
  const half = height / 2;
  const origin = Math.round(b.left);
  // The waveform shows what the clip plays: its peaks at the clip's gain.
  const gain = clip.gain ?? 1;
  const scale = layout.scale;
  const level = (value: number | undefined): number | null => {
    if (typeof value !== "number") return null;
    const gained = value * gain;
    return peak(scale ? scale(gained) : gained);
  };
  let start = 0;
  let lo = 0;
  let hi = 0;
  let any = false;
  const flush = (): void => {
    if (!any) return;
    any = false;
    // No bar at the clip's own ends, where its corners round.
    if (start < b.left + 2 || start + barWidth > b.right - 2) return;
    const x = Math.max(start, placed.x);
    const w = start + barWidth - x;
    if (w > 0) {
      const h = Math.max(1.5, (hi - lo) * half);
      quads.rect(x, mid - ((hi + lo) / 2) * half - h / 2, w, h, color);
    }
  };
  for (let i = 0; i < buckets; i++) {
    const x = placed.x + i;
    const phase = (((x - origin) % barPitch) + barPitch) % barPitch;
    if (phase === 0 || x - phase !== start) {
      flush();
      start = x - phase;
    }
    const low = level(peaks[2 * i]);
    const high = level(peaks[2 * i + 1]);
    if (low === null || high === null) continue;
    lo = any ? Math.min(lo, low) : low;
    hi = any ? Math.max(hi, high) : high;
    any = true;
  }
  flush();
}
