import type { LabelAtlas } from "./atlas.ts";
import { isImage, quadFloats } from "./layout.ts";
import type { QuadList, Rgba } from "./layout.ts";

/** The drawing backends. */
export type RendererBackend = "webgl2" | "webgpu" | "canvas2d";

/** One visible row's quads and its band in the viewport. */
export interface RowQuads {
  readonly top: number;
  readonly height: number;
  readonly quads: QuadList;
}

/** What a backend draws: every visible row, and which of them changed. */
export interface Frame {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly rows: readonly RowQuads[];
  /** The rows laid out again since the last frame, or `null` for all of them. */
  readonly changed: readonly RowQuads[] | null;
  readonly atlas: LabelAtlas;
}

/** A region of the clip canvas in CSS pixels, and its pixels read back as RGBA bytes. */
export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** A drawing backend. It owns its canvas and draws only what the layout lists. */
export interface Renderer {
  readonly backend: RendererBackend;
  readonly canvas: HTMLCanvasElement;
  /** Geometry buffers uploaded to the GPU. Canvas 2D uploads none. */
  readonly uploads: number;
  /** Bytes of GPU buffers and textures this backend holds. Canvas 2D holds none. */
  readonly gpuBytes: number;
  draw(frame: Frame): void;
  /**
   * Draws `frame` again through this backend's own pipeline and reads a region
   * back, at device pixels. For tests: it reads the backend's drawing without a
   * screenshot of the page.
   */
  read(frame: Frame, rect: PixelRect): Promise<Pixels>;
  dispose(): void;
}

/** A region in device pixels, clamped to the canvas. */
export function devicePixels(
  canvas: HTMLCanvasElement,
  rect: PixelRect,
  dpr: number,
): { x: number; y: number; w: number; h: number } {
  const x = Math.max(0, Math.min(canvas.width - 1, Math.round(rect.x * dpr)));
  const y = Math.max(0, Math.min(canvas.height - 1, Math.round(rect.y * dpr)));
  return {
    x,
    y,
    w: Math.max(1, Math.min(canvas.width - x, Math.round(rect.width * dpr))),
    h: Math.max(1, Math.min(canvas.height - y, Math.round(rect.height * dpr))),
  };
}

/** Sizes a canvas's backing store to the viewport at the device pixel ratio. Returns true when it changed. */
export function size(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  dpr: number,
): boolean {
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  return true;
}

const styles = new Map<Rgba, string>();
function css(color: Rgba): string {
  let style = styles.get(color);
  if (!style) {
    const r = color & 255;
    const g = (color >>> 8) & 255;
    const b = (color >>> 16) & 255;
    const a = (color >>> 24) & 255;
    style = a === 255 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${a / 255})`;
    styles.set(color, style);
  }
  return style;
}

/**
 * Canvas 2D: fills each rectangle and copies each label from the atlas. Only
 * the rows that changed are cleared and drawn again.
 */
export function createCanvas2DRenderer(canvas: HTMLCanvasElement): Renderer {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable");
  const ctx = context;
  return {
    backend: "canvas2d",
    canvas,
    uploads: 0,
    gpuBytes: 0,
    read(frame: Frame, rect: PixelRect): Promise<Pixels> {
      const { x, y, w, h } = devicePixels(canvas, rect, frame.dpr);
      const data = new Uint8Array(ctx.getImageData(x, y, w, h).data.buffer);
      return Promise.resolve({ width: w, height: h, data });
    },
    draw({ width, height, dpr, rows, changed, atlas }: Frame): void {
      const resized = size(canvas, width, height, dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const list = resized || !changed ? rows : changed;
      if (list === rows) ctx.clearRect(0, 0, width, height);
      const scale = atlas.size;
      for (const row of list) {
        ctx.clearRect(0, row.top, width, row.height);
        const { quads } = row;
        let style = -1;
        for (let i = 0; i < quads.count; i++) {
          const at = i * quadFloats;
          const d = quads.data;
          const x = d[at] ?? 0;
          const y = d[at + 1] ?? 0;
          const w = d[at + 2] ?? 0;
          const h = d[at + 3] ?? 0;
          if (isImage(quads, i)) {
            const u0 = d[at + 4] ?? 0;
            const v0 = d[at + 5] ?? 0;
            ctx.drawImage(
              atlas.canvas,
              u0 * scale,
              v0 * scale,
              ((d[at + 6] ?? 0) - u0) * scale,
              ((d[at + 7] ?? 0) - v0) * scale,
              x,
              y,
              w,
              h,
            );
            continue;
          }
          const color = quads.colors[i] ?? 0;
          if (color !== style) {
            ctx.fillStyle = css(color);
            style = color;
          }
          const radius = d[at + 5] ?? 0;
          if (radius > 0) {
            ctx.beginPath();
            ctx.roundRect(x, y, w, h, radius);
            ctx.fill();
          } else ctx.fillRect(x, y, w, h);
        }
      }
    },
    dispose(): void {
      canvas.width = canvas.height = 1;
    },
  };
}

/** All visible rows' quads in one pair of arrays, top row first, for one GPU upload. */
export class Staging {
  count = 0;
  data: Float32Array<ArrayBuffer> = new Float32Array(1024 * quadFloats);
  colors: Uint32Array<ArrayBuffer> = new Uint32Array(1024);

  gather(rows: readonly RowQuads[]): number {
    let total = 0;
    for (const row of rows) total += row.quads.count;
    if (total > this.colors.length) {
      let capacity = this.colors.length;
      while (capacity < total) capacity *= 2;
      this.data = new Float32Array(capacity * quadFloats);
      this.colors = new Uint32Array(capacity);
    }
    let at = 0;
    for (const { quads } of rows) {
      this.data.set(quads.data.subarray(0, quads.count * quadFloats), at * quadFloats);
      this.colors.set(quads.colors.subarray(0, quads.count), at);
      at += quads.count;
    }
    this.count = total;
    return total;
  }
}

/** How a GPU backend tells the view that its device went away or came back. */
export interface DeviceEvents {
  lost(): void;
  restored(): void;
}
