import type { VideoTransport, VideoTransportOptions } from "./types.ts";
export declare function createVideoTransport({ video, editor, context, output, catalog, resolveBuffer, onError, }: VideoTransportOptions): VideoTransport;
