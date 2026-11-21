import type { Clip, Tick } from "./types.ts";
export declare function visitRange(clips: readonly Clip[] | undefined, start: Tick, end: Tick, emit: (clip: Clip) => void): number;
