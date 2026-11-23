import type { AudioTransport, MediaOptions } from "./types.ts";
export declare function createAudioTransport({ editor, context, output, trackOutput, fadeOutSeconds, catalog, resolveBuffer, onError, }: MediaOptions): AudioTransport;
