import type {
  AudioBufferLike,
  AudioContextLike,
  AudioNodeLike,
  AudioParamLike,
  BufferSourceLike,
  GainNodeLike,
  OutputTimestamp,
  VideoElementLike,
  VideoFrameMetadataLike,
} from "@lumen-timeline/media";

/** A node that accepts connections and records nothing. */
export const sink: AudioNodeLike = { connect: () => undefined, disconnect: () => {} };

export class FakeSource implements BufferSourceLike {
  buffer: AudioBufferLike | null = null;
  readonly playbackRate: AudioParamLike = { value: 1 };
  onended: ((event: Event) => void) | null = null;
  readonly stops: number[] = [];
  when = NaN;
  offset = NaN;
  connect(): undefined {
    return undefined;
  }
  disconnect(): void {}
  start(when = NaN, offset = NaN): void {
    this.when = when;
    this.offset = offset;
  }
  stop(when = NaN): void {
    this.stops.push(when);
  }
}

/** A controllable clock with optional output timestamps and replaceable resume. */
export class FakeContext extends EventTarget implements AudioContextLike {
  currentTime = 0;
  outputTime = 0;
  state: AudioContextState;
  readonly sampleRate: number;
  readonly destination: AudioNodeLike = sink;
  readonly nodes: FakeSource[] = [];
  getOutputTimestamp: (() => OutputTimestamp) | undefined = () => ({
    contextTime: this.outputTime,
    performanceTime: 1000,
  });
  resume: () => Promise<void> = () => {
    this.setState("running");
    return Promise.resolve();
  };

  constructor(rate: number, state: AudioContextState = "running") {
    super();
    this.sampleRate = rate;
    this.state = state;
  }
  setState(next: AudioContextState): void {
    this.state = next;
    this.dispatchEvent(new Event("statechange"));
  }
  createBufferSource(): FakeSource {
    const node = new FakeSource();
    this.nodes.push(node);
    return node;
  }
  createGain(): GainNodeLike {
    return { gain: { value: 1 }, connect: () => undefined, disconnect: () => {} };
  }
}

type FrameCallback = (now: number, frame: VideoFrameMetadataLike) => void;

/** A paused video that counts transport calls and presents frames on request. */
export class FakeVideo extends EventTarget implements VideoElementLike {
  currentTime = 1;
  readonly duration = 12;
  readonly paused = true;
  readonly ended = false;
  seeking = false;
  readonly readyState = 4;
  starts = 0;
  pauses = 0;
  framesCancelled = 0;
  private frame: FrameCallback | null = null;
  play(): void {
    this.starts++;
  }
  pause(): void {
    this.pauses++;
  }
  requestVideoFrameCallback(callback: FrameCallback): number {
    this.frame = callback;
    return 1;
  }
  cancelVideoFrameCallback(): void {
    this.framesCancelled++;
    this.frame = null;
  }
  /** Calls the pending frame callback, as the browser does when it presents a frame. */
  present(mediaTime: number): void {
    const callback = this.frame;
    this.frame = null;
    callback?.(1000, { mediaTime });
  }
  /** Starts a seek on the element, as native controls do, and fires its events. */
  nativeSeek(seconds: number): void {
    this.seeking = true;
    this.currentTime = seconds;
    this.dispatchEvent(new Event("seeking"));
  }
  /** Completes the element's current seek. */
  seeked(): void {
    this.seeking = false;
    this.dispatchEvent(new Event("seeked"));
  }
}
