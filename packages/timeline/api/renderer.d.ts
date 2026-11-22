import type { LabelAtlas } from "./atlas.ts";
import type { QuadList } from "./layout.ts";
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
export declare function devicePixels(canvas: HTMLCanvasElement, rect: PixelRect, dpr: number): {
    x: number;
    y: number;
    w: number;
    h: number;
};
/** Sizes a canvas's backing store to the viewport at the device pixel ratio. Returns true when it changed. */
export declare function size(canvas: HTMLCanvasElement, width: number, height: number, dpr: number): boolean;
/**
 * Canvas 2D: fills each rectangle and copies each label from the atlas. Only
 * the rows that changed are cleared and drawn again.
 */
export declare function createCanvas2DRenderer(canvas: HTMLCanvasElement): Renderer;
/** All visible rows' quads in one pair of arrays, top row first, for one GPU upload. */
export declare class Staging {
    count: number;
    data: Float32Array<ArrayBuffer>;
    colors: Uint32Array<ArrayBuffer>;
    gather(rows: readonly RowQuads[]): number;
}
/** How a GPU backend tells the view that its device went away or came back. */
export interface DeviceEvents {
    lost(): void;
    restored(): void;
}
