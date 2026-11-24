import type { VideoTransport, VideoTransportOptions } from "./types.ts";
export declare function createVideoTransport({ video, editor, context, output, trackOutput, fadeOutSeconds, catalog, resolveBuffer, stretch, onError, }: VideoTransportOptions): VideoTransport;
