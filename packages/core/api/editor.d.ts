import type { AddMarkerCommand, AddTakeCommand, Editor, EditorOptions, ExpectClipCommand, ExpectDataCommand, MoveMarkerCommand, MoveCommand, PruneTakesCommand, RemoveDataCommand, RemoveMarkerCommand, RemoveTakeCommand, ReorderTakesCommand, SelectTakeCommand, SetDataCommand, SplitCommand, TrimCommand, UpdateMarkerCommand, UpdateTakeCommand } from "./types.ts";
type Arguments<C> = C extends unknown ? Omit<C, "type"> : never;
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
    addTake(args: Arguments<AddTakeCommand>): AddTakeCommand;
    selectTake(args: Arguments<SelectTakeCommand>): SelectTakeCommand;
    removeTake(args: Arguments<RemoveTakeCommand>): RemoveTakeCommand;
    reorderTakes(args: Arguments<ReorderTakesCommand>): ReorderTakesCommand;
    updateTake(args: Arguments<UpdateTakeCommand>): UpdateTakeCommand;
    pruneTakes(args?: Arguments<PruneTakesCommand>): PruneTakesCommand;
    expectClip(args: Arguments<ExpectClipCommand>): ExpectClipCommand;
    expectData(args: Arguments<ExpectDataCommand>): ExpectDataCommand;
}
export declare const commands: Readonly<Commands>;
export declare function createEditor({ project, history: limits, actor }: EditorOptions): Editor;
export {};
