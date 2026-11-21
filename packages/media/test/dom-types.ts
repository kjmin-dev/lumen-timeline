// Compile-time check: real DOM objects satisfy the structural host interfaces.
import type {
  AudioBufferLike,
  AudioContextLike,
  AudioNodeLike,
  VideoElementLike,
} from "@lumen-timeline/media";

export function hostObjects(
  context: AudioContext,
  video: HTMLVideoElement,
  buffer: AudioBuffer,
): readonly [AudioContextLike, VideoElementLike, AudioNodeLike, AudioBufferLike] {
  return [context, video, context.destination, buffer];
}
