import type { AddMarkerCommand, Editor, EditorOptions, MoveMarkerCommand, MoveCommand, RemoveDataCommand, RemoveMarkerCommand, SetDataCommand, SplitCommand, TrimCommand, UpdateMarkerCommand } from "./types.ts";
type Arguments<C> = Omit<C, "type">;
export interface Commands {
    addMarker(args: Arguments<AddMarkerCommand>): AddMarkerCommand;
    moveMarker(args: Arguments<MoveMarkerCommand>): MoveMarkerCommand;
    updateMarker(args: Arguments<UpdateMarkerCommand>): UpdateMarkerCommand;
    removeMarker(args: Arguments<RemoveMarkerCommand>): RemoveMarkerCommand;
    moveClips(args: Arguments<MoveCommand>): MoveCommand;
    trimClip(args: Arguments<TrimCommand>): TrimCommand;
    splitClip(args: Arguments<SplitCommand>): SplitCommand;
    setEntityData(args: Arguments<SetDataCommand>): SetDataCommand;
    removeEntityData(args: Arguments<RemoveDataCommand>): RemoveDataCommand;
}
export declare const commands: Readonly<Commands>;
export declare function createEditor({ project, history: limits }: EditorOptions): Editor;
export {};
