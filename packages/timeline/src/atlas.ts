import { labelBaseline, labelHeight } from "./layout.ts";
import type { LabelSlot } from "./layout.ts";

const nameFont = "500 12px system-ui, sans-serif";
const captionFont = "11px system-ui, sans-serif";
const nameColor = "#faf6e9";
/** Labels wider than this, in CSS pixels, are cut. */
const maxLabelWidth = 480;

/**
 * Clip labels rasterized once at the device pixel ratio, in rows of equal
 * height. When the atlas is full it reports so; the view clears it and lays out
 * again, so it only ever holds the labels of one paint.
 */
export interface LabelAtlas {
  readonly canvas: HTMLCanvasElement;
  readonly size: number;
  /** Increases whenever the atlas's pixels change. */
  readonly version: number;
  /** Whether a label did not fit since the last `clear`. */
  readonly full: boolean;
  /** Labels drawn into the atlas since it was made. */
  readonly rasterized: number;
  slot(name: string, caption: string | undefined, captionColor: string): LabelSlot | null;
  clear(): void;
  dispose(): void;
}

export function createLabelAtlas(doc: Document, dpr: number, size = 2048): LabelAtlas {
  const canvas = doc.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable");
  const ctx = context;
  const rowHeight = Math.ceil(labelHeight * dpr);
  const slots = new Map<string, LabelSlot>();
  let x = 0;
  let y = 0;
  const state = { version: 0, full: false, rasterized: 0 };
  function clear(): void {
    slots.clear();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    x = y = 0;
    state.full = false;
    state.version++;
  }
  return {
    canvas,
    size,
    get version() {
      return state.version;
    },
    get full() {
      return state.full;
    },
    get rasterized() {
      return state.rasterized;
    },
    slot(name, caption, captionColor) {
      const key = name + "\u0000" + (caption ?? "") + "\u0000" + captionColor;
      const found = slots.get(key);
      if (found) return found;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.font = nameFont;
      const nameWidth = ctx.measureText(name).width;
      let width = nameWidth;
      if (caption) {
        ctx.font = captionFont;
        width += 10 + ctx.measureText(caption).width;
      }
      width = Math.min(maxLabelWidth, Math.ceil(width) + 1);
      const w = Math.ceil(width * dpr) + 1;
      if (x + w > size) {
        x = 0;
        y += rowHeight;
      }
      if (y + rowHeight > size) {
        state.full = true;
        return null;
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, rowHeight);
      ctx.clip();
      ctx.setTransform(dpr, 0, 0, dpr, x, y);
      ctx.font = nameFont;
      ctx.fillStyle = nameColor;
      ctx.fillText(name, 0, labelBaseline);
      if (caption) {
        ctx.font = captionFont;
        ctx.fillStyle = captionColor;
        ctx.fillText(caption, nameWidth + 10, labelBaseline);
      }
      ctx.restore();
      const slot: LabelSlot = Object.freeze({
        u0: x / size,
        v0: y / size,
        u1: (x + width * dpr) / size,
        v1: (y + labelHeight * dpr) / size,
        width,
        height: labelHeight,
      });
      slots.set(key, slot);
      x += w;
      state.version++;
      state.rasterized++;
      return slot;
    },
    clear,
    dispose() {
      slots.clear();
      canvas.width = canvas.height = 0;
    },
  };
}
