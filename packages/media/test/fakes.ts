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

/** A paused video that counts transport calls and never presents a frame. */
export class FakeVideo extends EventTarget implements VideoElementLike {
  currentTime = 1;
  readonly duration = 12;
  readonly paused = true;
  readonly ended = false;
  readonly seeking = false;
  readonly readyState = 4;
  starts = 0;
  pauses = 0;
  framesCancelled = 0;
  play(): void {
    this.starts++;
  }
  pause(): void {
    this.pauses++;
  }
  requestVideoFrameCallback(
    _callback: (now: number, frame: VideoFrameMetadataLike) => void,
  ): number {
    return 1;
  }
  cancelVideoFrameCallback(): void {
    this.framesCancelled++;
  }
}
