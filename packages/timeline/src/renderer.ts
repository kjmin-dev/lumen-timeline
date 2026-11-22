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

/** A drawing backend. It owns its canvas and draws only what the layout lists. */
export interface Renderer {
  readonly backend: RendererBackend;
  readonly canvas: HTMLCanvasElement;
  /** Geometry buffers uploaded to the GPU. Canvas 2D uploads none. */
  readonly uploads: number;
  draw(frame: Frame): void;
  dispose(): void;
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
          ctx.fillRect(x, y, w, h);
        }
      }
    },
    dispose(): void {
      canvas.width = canvas.height = 1;
    },
  };
}
