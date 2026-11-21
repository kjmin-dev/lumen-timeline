import type { Clip, EditErrorCode, JsonValue, ProjectSnapshot, Tick, Track } from "./types.ts";
export declare class EditError extends Error {
    readonly code: EditErrorCode;
    /** The rejected ID or value as supplied, which may be invalid input. */
    readonly target: unknown;
    constructor(code: EditErrorCode, target: unknown, message: string);
}
export declare function requireEdit(condition: unknown, code: EditErrorCode, target: unknown, reason: string): asserts condition;
/** `Array.isArray`, typed so that a successful check does not introduce `any`. */
export declare const isArray: (value: unknown) => value is readonly unknown[];
export declare function validId(id: unknown): id is string;
/** Validation rules shared by project loading and every staged clip. */
export interface Rules {
    readonly tracks: ReadonlyMap<string, Track>;
    readonly duration: Tick;
    readonly minimum: Tick;
}
/** Start-ordered clips per track ID. The editor replaces arrays it changes. */
export type TrackLayout = Map<string, Clip[]>;
export interface OpenedProject {
    readonly snapshot: ProjectSnapshot;
    readonly rules: Rules;
    readonly byTrack: TrackLayout;
}
export declare function freezeJson(value: unknown, ancestors?: Set<unknown>): JsonValue;
export declare function openProject(input: unknown): OpenedProject;
export declare function validateClip(clip: Clip, { tracks, duration, minimum }: Rules): void;
export declare function orderTrack(clips: Clip[], track: Track): void;
