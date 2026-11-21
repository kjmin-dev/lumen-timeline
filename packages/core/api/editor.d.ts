import type { Editor, EditorOptions, MoveCommand, RemoveDataCommand, SetDataCommand, SplitCommand, TrimCommand } from "./types.ts";
type Arguments<C> = Omit<C, "type">;
export interface Commands {
    moveClips(args: Arguments<MoveCommand>): MoveCommand;
    trimClip(args: Arguments<TrimCommand>): TrimCommand;
    splitClip(args: Arguments<SplitCommand>): SplitCommand;
    setEntityData(args: Arguments<SetDataCommand>): SetDataCommand;
    removeEntityData(args: Arguments<RemoveDataCommand>): RemoveDataCommand;
}
export declare const commands: Readonly<Commands>;
export declare function createEditor({ project, history: limits }: EditorOptions): Editor;
export {};
