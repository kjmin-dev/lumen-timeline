import type { LabelSlot } from "./layout.ts";
export interface LabelAtlasStyle {
    readonly nameFont?: string | undefined;
    readonly captionFont?: string | undefined;
}
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
    /**
     * The rows of device pixels that changed after `version`: `null` for none,
     * `"all"` when the atlas was cleared since or the change log no longer
     * reaches back that far. GPU backends upload only these rows.
     */
    changes(version: number): {
        readonly y0: number;
        readonly y1: number;
    } | "all" | null;
    slot(name: string, caption: string | undefined, captionColor: string, nameColor: string): LabelSlot | null;
    clear(): void;
    dispose(): void;
}
export declare function createLabelAtlas(doc: Document, dpr: number, size?: number, style?: LabelAtlasStyle): LabelAtlas;
