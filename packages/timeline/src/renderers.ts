import { createCanvas2DRenderer } from "./renderer.ts";
import type { Frame, PixelRect, Pixels, Renderer, RendererBackend } from "./renderer.ts";
import { createWebGL2Renderer } from "./webgl2.ts";
import { createWebGPURenderer, hasWebGPU } from "./webgpu.ts";

/**
 * Which backend a mount asks for. `auto` is WebGL2 on a hardware GPU and Canvas
 * 2D otherwise; `webgl2` and `webgpu` accept a software rasterizer as well.
 */
export type RendererChoice = "auto" | "webgl2" | "webgpu" | "canvas2d";

export interface RendererHost {
  readonly backend: RendererBackend;
  /** Why the backend drawing now is not the one asked for, or `null`. */
  readonly fallback: string | null;
  /** Geometry uploads by every GPU backend this mount used. */
  readonly uploads: number;
  /** Lost WebGL2 contexts and WebGPU devices. */
  readonly losses: number;
  /** GPU buffer and texture bytes the current backend holds. */
  readonly gpuBytes: number;
  draw(frame: Frame): void;
  /** Reads back the last frame through the current backend. */
  read(rect: PixelRect): Promise<Pixels>;
  dispose(): void;
}

/** Attempts at a new WebGPU device after one is lost, before staying on the fallback. */
const gpuRetries = 3;

/**
 * Draws through the chosen backend on the view's clip canvas, and keeps the view
 * drawing when that backend is unavailable or its device is lost. A switch puts
 * a fresh canvas in place and asks the view to `redraw` from its CPU layout.
 * WebGPU starts asynchronously; until its device is ready, and after a loss,
 * the next backend draws.
 */
export function createRendererHost(
  initial: HTMLCanvasElement,
  choice: RendererChoice,
  redraw: () => void,
): RendererHost {
  const doc = initial.ownerDocument;
  let current: Renderer;
  let disposed = false;
  let losses = 0;
  let spent = 0;
  let reason: string | null = null;
  // Renderers that left the canvas but may return: a lost WebGL2 context.
  const parked = new Set<Renderer>();

  const fresh = (): HTMLCanvasElement => {
    const canvas = doc.createElement("canvas");
    canvas.className = initial.className;
    canvas.setAttribute("aria-hidden", "true");
    return canvas;
  };
  function place(next: Renderer, why: string | null): void {
    reason = why;
    if (next === current) return;
    current.canvas.replaceWith(next.canvas);
    if (!parked.has(current)) {
      spent += current.uploads;
      current.dispose();
    }
    current = next;
    if (!disposed) redraw();
  }
  // WebGL2 on a new canvas, or Canvas 2D where it is unavailable. Sets the reason
  // for Canvas 2D.
  function fallback(): Renderer {
    const gl = createWebGL2Renderer(
      fresh(),
      {
        lost() {
          losses++;
          if (typeof gl === "string" || disposed) return;
          parked.add(gl);
          if (current === gl) place(createCanvas2DRenderer(fresh()), "The WebGL2 context was lost");
        },
        restored() {
          if (typeof gl === "string" || !parked.has(gl) || disposed) return;
          parked.delete(gl);
          // A restored context draws again unless WebGPU took over meanwhile.
          if (current.backend === "canvas2d")
            place(gl, choice === "webgpu" ? "The WebGPU device was lost" : null);
          else {
            spent += gl.uploads;
            gl.dispose();
          }
        },
      },
      choice !== "auto",
    );
    if (typeof gl !== "string") return gl;
    reason =
      gl === "software" ? "WebGL2 would run on a software rasterizer" : "WebGL2 is unavailable";
    return createCanvas2DRenderer(fresh());
  }
  // After a lost device, a new one is asked for a few times, a little later
  // each time, as a GPU process that is resetting needs.
  let retries = 0;
  function gpu(): void {
    if (disposed) return;
    let mine: Renderer | null = null;
    const retry = (): void => {
      if (retries && retries <= gpuRetries && !disposed) setTimeout(gpu, 100 * retries++);
    };
    createWebGPURenderer(fresh(), {
      lost() {
        losses++;
        if (disposed || current !== mine) return;
        const next = fallback();
        place(next, "The WebGPU device was lost");
        retries = 1;
        retry();
      },
    }).then((renderer) => {
      mine = renderer;
      if (!renderer) {
        if (!retries) reason = "No WebGPU adapter or device";
        return retry();
      }
      if (disposed) return renderer.dispose();
      retries = 0;
      place(renderer, null);
    }, retry);
  }

  const view = doc.defaultView ?? window;
  let pending: Frame | null = null;
  let last: Frame | null = null;
  let scheduled = 0;
  function submit(): void {
    scheduled = 0;
    const frame = pending;
    pending = null;
    if (frame && !disposed) current.draw(frame);
  }

  if (choice === "canvas2d") current = createCanvas2DRenderer(initial);
  else {
    // The template's canvas holds no context; the first backend gets a fresh one.
    current = fallback();
    initial.replaceWith(current.canvas);
    if (choice === "webgpu") {
      if (hasWebGPU()) {
        reason = "Waiting for a WebGPU device";
        gpu();
      } else reason = "WebGPU is unavailable";
    }
  }
  return {
    get backend() {
      return current.backend;
    },
    get fallback() {
      return reason;
    },
    get uploads() {
      let total = spent + current.uploads;
      for (const r of parked) total += r.uploads;
      return total;
    },
    get losses() {
      return losses;
    },
    get gpuBytes() {
      return current.gpuBytes;
    },
    read(rect: PixelRect): Promise<Pixels> {
      return last ? current.read(last, rect) : Promise.reject(new Error("Nothing drawn yet"));
    },
    draw(frame: Frame): void {
      last = frame;
      // Canvas 2D draws at once. A GPU backend submits once per animation
      // frame, the latest layout, however many paints came before it.
      if (current.backend === "canvas2d") {
        pending = null;
        return current.draw(frame);
      }
      pending = frame;
      if (!scheduled) scheduled = view.requestAnimationFrame(submit);
    },
    dispose(): void {
      disposed = true;
      if (scheduled) view.cancelAnimationFrame(scheduled);
      pending = null;
      current.dispose();
      for (const r of parked) r.dispose();
      parked.clear();
    },
  };
}
