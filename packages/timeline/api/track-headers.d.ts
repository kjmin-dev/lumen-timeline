import type { EditResult, Editor, Track } from "@lumen-timeline/core";
import type { ResolvedChrome, ResolvedUiLabels } from "./config.ts";
import type { TrackHeaderRenderer } from "./types.ts";
/** A track row as the header list needs it, in content CSS pixels. */
export interface HeaderRow {
    readonly track: Track;
    readonly index: number;
    readonly top: number;
    readonly height: number;
}
/**
 * The gap between rows that a pointer at content height `y` points to: `0`
 * above the first row's middle, `rows.length` below the last row's middle.
 */
export declare function dropSlot(rows: readonly {
    readonly top: number;
    readonly height: number;
}[], y: number): number;
/**
 * The order after moving the ID at `from` into gap `slot`, where gap `i` lies
 * before `ids[i]`. `null` when the move leaves the order as it is.
 */
export declare function moveToSlot(ids: readonly string[], from: number, slot: number): readonly string[] | null;
/**
 * The name a rename commits, or `undefined` when the draft changes nothing:
 * blank after trimming, or the name the header already shows.
 */
export declare function renamedTo(draft: string, track: Track): string | undefined;
/** Replaces `{key}` placeholders that `values` names, and leaves others as written. */
export declare function fillTemplate(template: string, values: Readonly<Record<string, string | number>>): string;
export interface TrackHeaderOptions {
    readonly root: HTMLElement;
    /** The scrolled list the headers live in. */
    readonly list: HTMLElement;
    /** The visible window over the rows, which holds the drag ghost and drop line. */
    readonly pin: HTMLElement;
    readonly scroll: HTMLElement;
    readonly editor: Editor;
    readonly signal: AbortSignal;
    /** Every track row, in order. */
    readonly rows: () => readonly HeaderRow[];
    readonly viewportHeight: () => number;
    readonly scrollTop: () => number;
    readonly accent: (row: HeaderRow) => string;
    readonly chrome: () => ResolvedChrome;
    readonly readOnly: () => boolean;
    readonly shortcuts: () => boolean;
    readonly uiLabels: () => ResolvedUiLabels;
    readonly renderer: () => TrackHeaderRenderer | undefined;
    readonly scrollToTrack: (trackId: string) => void;
    readonly report: (result: EditResult) => void;
}
export interface TrackHeaders {
    /** Shows a header for each visible row and removes the others. */
    place(visible: readonly HeaderRow[]): void;
    /** Applies changed chrome, labels or read-only state; the next `place` draws them. */
    sync(): void;
    /** Starts renaming a track in its header. */
    rename(trackId: string): boolean;
    dispose(): void;
}
/**
 * The track header list: one virtualized header per visible row, inline rename,
 * and reordering by pointer or keyboard. Headers stay aligned with their rows
 * during a drag; a drop line marks where the track will land.
 */
export declare function createTrackHeaders(options: TrackHeaderOptions): TrackHeaders;
