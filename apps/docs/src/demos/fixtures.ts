import { TICKS_PER_SECOND as hz, type Project, type StreamCatalog } from "@lumen-timeline/core";
import type {
  AudioBufferLike,
  AudioContextLike,
  BufferSourceLike,
  PeakSource,
  StretchAudio,
} from "@lumen-timeline/media";
import { createSignalsmithStretch } from "@lumen-timeline/media/signalsmith";
import type { SyncMessage, SyncTransport } from "@lumen-timeline/sync";
import type { TimelineTransport, TransportState } from "@lumen-timeline/timeline";

export const DEMO_SAMPLE_RATE = 24000;

const sec = (value: number): number => Math.round(value * hz);

/** 24-second dubbing project for the interactive Studio demo. */
export function createStudioProject(): Project {
  return {
    schemaVersion: 1,
    duration: sec(24),
    tracks: [
      { id: "stem", name: "Reference", locked: true, gain: 0.35 },
      { id: "narrator", name: "Narrator", overlap: "exclusive" },
      { id: "keeper", name: "Keeper", overlap: "exclusive" },
      { id: "music", name: "Music", gain: 0.5 },
    ],
    clips: [
      {
        id: "ref-stem",
        name: "Original dialogue",
        trackId: "stem",
        kind: "audio",
        start: 0,
        duration: sec(24),
        contentIn: 0,
        takeIds: ["take-ref"],
        activeTakeId: "take-ref",
      },
      {
        id: "nar-1",
        name: "Line 1 — Tide",
        trackId: "narrator",
        kind: "audio",
        start: sec(1.5),
        duration: sec(4.5),
        contentIn: 0,
        takeIds: ["nar-1-a", "nar-1-b", "nar-1-c"],
        activeTakeId: "nar-1-a",
      },
      {
        id: "nar-2",
        name: "Line 3 — Contours",
        trackId: "narrator",
        kind: "audio",
        start: sec(11.5),
        duration: sec(5),
        contentIn: 0,
        takeIds: ["nar-2-a", "nar-2-b"],
        activeTakeId: "nar-2-a",
      },
      {
        id: "nar-3",
        name: "Line 5 — Harbor",
        trackId: "narrator",
        kind: "audio",
        start: sec(18.5),
        duration: sec(4),
        contentIn: 0,
        takeIds: ["nar-3-a"],
        activeTakeId: "nar-3-a",
      },
      {
        id: "keep-1",
        name: "Line 2 — Inlet",
        trackId: "keeper",
        kind: "audio",
        start: sec(6.5),
        duration: sec(4.5),
        contentIn: 0,
        takeIds: ["keep-1-a", "keep-1-b"],
        activeTakeId: "keep-1-a",
      },
      {
        id: "keep-2",
        name: "Line 4 — Lantern",
        trackId: "keeper",
        kind: "audio",
        start: sec(15.5),
        duration: sec(3.2),
        contentIn: 0,
        takeIds: ["keep-2-a", "keep-2-b"],
        activeTakeId: "keep-2-a",
      },
      {
        id: "bed-1",
        name: "Ambient bed",
        trackId: "music",
        kind: "audio",
        start: 0,
        duration: sec(22),
        contentIn: 0,
        takeIds: ["take-music"],
        activeTakeId: "take-music",
      },
    ],
    takes: [
      { id: "take-ref", label: "Stem", assetId: "stem", streamId: "mono", sourceAtContentZero: 0 },
      {
        id: "nar-1-a",
        label: "Studio take",
        assetId: "nar-a",
        streamId: "mono",
        sourceAtContentZero: 0,
      },
      {
        id: "nar-1-b",
        label: "Warm alt",
        assetId: "nar-b",
        streamId: "mono",
        sourceAtContentZero: sec(0.3),
      },
      {
        id: "nar-1-c",
        label: "Synth guide",
        assetId: "nar-c",
        streamId: "mono",
        sourceAtContentZero: 0,
      },
      {
        id: "nar-2-a",
        label: "Studio take",
        assetId: "nar-b",
        streamId: "mono",
        sourceAtContentZero: sec(1.2),
      },
      {
        id: "nar-2-b",
        label: "Calm alt",
        assetId: "nar-a",
        streamId: "mono",
        sourceAtContentZero: sec(1.0),
      },
      {
        id: "nar-3-a",
        label: "Studio take",
        assetId: "nar-c",
        streamId: "mono",
        sourceAtContentZero: sec(0.5),
      },
      {
        id: "keep-1-a",
        label: "Studio take",
        assetId: "keep-a",
        streamId: "mono",
        sourceAtContentZero: 0,
      },
      {
        id: "keep-1-b",
        label: "Closer mic",
        assetId: "keep-b",
        streamId: "mono",
        sourceAtContentZero: sec(0.2),
      },
      {
        id: "keep-2-a",
        label: "Studio take",
        assetId: "keep-b",
        streamId: "mono",
        sourceAtContentZero: sec(1.1),
      },
      {
        id: "keep-2-b",
        label: "Soft alt",
        assetId: "keep-a",
        streamId: "mono",
        sourceAtContentZero: sec(1.4),
      },
      {
        id: "take-music",
        label: "Mix stem",
        assetId: "music",
        streamId: "mono",
        sourceAtContentZero: 0,
      },
    ],
    markers: [
      { id: "m-intro", start: sec(1.5), label: "Intro" },
      { id: "m-inlet", start: sec(11.5), label: "Inlet" },
      { id: "m-fade", start: sec(20), label: "Fade" },
    ],
  };
}

/** 20-second project shared between two editors in the Sync demo. */
export function createSyncProject(): Project {
  return {
    schemaVersion: 1,
    duration: sec(20),
    tracks: [
      { id: "voice", name: "Voice", overlap: "exclusive" },
      { id: "music", name: "Music" },
    ],
    clips: [
      {
        id: "cue-1",
        name: "Intro",
        trackId: "voice",
        kind: "audio",
        start: sec(1),
        duration: sec(4.5),
        contentIn: 0,
        takeIds: ["sync-t1", "sync-t2"],
        activeTakeId: "sync-t1",
      },
      {
        id: "cue-2",
        name: "Bridge",
        trackId: "voice",
        kind: "audio",
        start: sec(7.5),
        duration: sec(4),
        contentIn: 0,
        takeIds: ["sync-t1"],
        activeTakeId: "sync-t1",
      },
      {
        id: "cue-3",
        name: "Outro",
        trackId: "voice",
        kind: "audio",
        start: sec(13.5),
        duration: sec(4),
        contentIn: 0,
        takeIds: ["sync-t2"],
        activeTakeId: "sync-t2",
      },
      {
        id: "bed",
        name: "Score",
        trackId: "music",
        kind: "audio",
        start: 0,
        duration: sec(18),
        contentIn: 0,
        takeIds: ["sync-bed"],
        activeTakeId: "sync-bed",
      },
    ],
    takes: [
      {
        id: "sync-t1",
        label: "Take 1",
        assetId: "nar-a",
        streamId: "mono",
        sourceAtContentZero: 0,
      },
      {
        id: "sync-t2",
        label: "Take 2",
        assetId: "keep-a",
        streamId: "mono",
        sourceAtContentZero: 0,
      },
      { id: "sync-bed", label: "Bed", assetId: "music", streamId: "mono", sourceAtContentZero: 0 },
    ],
    markers: [
      { id: "s-start", start: sec(1), label: "Cue 1" },
      { id: "s-mid", start: sec(11.5), label: "Turn" },
    ],
  };
}

const ASSET_SECONDS: Readonly<Record<string, number>> = {
  stem: 24,
  "nar-a": 8,
  "nar-b": 8,
  "nar-c": 8,
  "keep-a": 8,
  "keep-b": 8,
  music: 22,
};

/** Generates deterministic mono PCM samples for a demo asset (zero network requests). */
export function synthesizePcm(assetId: string, seconds: number): Float32Array {
  const length = Math.round(seconds * DEMO_SAMPLE_RATE);
  const data = new Float32Array(length);
  let seed = 7;
  for (let i = 0; i < assetId.length; i++) {
    seed = (seed * 31 + assetId.charCodeAt(i)) >>> 0;
  }
  const baseHz = assetId === "music" ? 196 : 155 + (seed % 7) * 28;
  for (let i = 0; i < length; i++) {
    const t = i / DEMO_SAMPLE_RATE;
    if (assetId === "music") {
      const swell = 0.45 + 0.55 * Math.sin(Math.PI * Math.min(1, t / seconds));
      data[i] =
        0.16 *
        swell *
        (0.6 * Math.sin(2 * Math.PI * baseHz * t) +
          0.35 * Math.sin(2 * Math.PI * (baseHz * 1.25) * t) +
          0.2 * Math.sin(2 * Math.PI * (baseHz * 1.5) * t));
    } else if (assetId === "stem") {
      const phrase = Math.max(0, Math.sin(Math.PI * ((t * 0.42) % 1)));
      const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 3.1 * t);
      data[i] =
        0.5 *
        phrase *
        syllable *
        (0.7 * Math.sin(2 * Math.PI * 185 * t) + 0.3 * Math.sin(2 * Math.PI * 370 * t));
    } else {
      const phrase = Math.max(0, Math.sin(Math.PI * ((t * 0.65 + (seed % 5) * 0.13) % 1)));
      const contour = 0.6 + 0.4 * Math.sin(2 * Math.PI * (2.5 + (seed % 3)) * t);
      data[i] =
        0.55 *
        phrase *
        contour *
        (0.68 * Math.sin(2 * Math.PI * baseHz * t) +
          0.32 * Math.sin(2 * Math.PI * (baseHz * 1.98) * t));
    }
  }
  return data;
}

/** The sample rate of an asset. The demo's own synthesized audio is at `DEMO_SAMPLE_RATE`. */
export type RateOf = (assetId: string) => number;
const demoRate: RateOf = () => DEMO_SAMPLE_RATE;

/** A catalog with one mono stream per asset, as long as its samples. */
export function catalogFor(
  assets: ReadonlyMap<string, Float32Array>,
  rateOf: RateOf = demoRate,
): StreamCatalog {
  const streams: Record<
    string,
    Record<
      string,
      { assetVersion: number; sampleRate: number; availableStart: number; availableEnd: number }
    >
  > = {};
  for (const [id, pcm] of assets) {
    streams[id] = {
      mono: {
        assetVersion: 1,
        sampleRate: rateOf(id),
        availableStart: 0,
        availableEnd: pcm.length,
      },
    };
  }
  return { version: 1, streams };
}

/** Peak sources that read each asset's samples in place. */
export function peakSourcesFor(
  assets: ReadonlyMap<string, Float32Array>,
  rateOf: RateOf = demoRate,
): Map<string, PeakSource> {
  const map = new Map<string, PeakSource>();
  for (const [id, pcm] of assets) {
    map.set(id, {
      version: 1,
      sampleRate: rateOf(id),
      length: pcm.length,
      read(start, end) {
        return pcm.subarray(start, end);
      },
    });
  }
  return map;
}

function studioAssets(): Map<string, Float32Array> {
  const assets = new Map<string, Float32Array>();
  for (const [id, seconds] of Object.entries(ASSET_SECONDS)) {
    assets.set(id, synthesizePcm(id, seconds));
  }
  return assets;
}

export function createDemoCatalog(): StreamCatalog {
  return catalogFor(studioAssets());
}

export function createPeakSourceMap(): Map<string, PeakSource> {
  return peakSourcesFor(studioAssets());
}

export function createStudioAudioHost(): AudioHost {
  return createAudioHost(studioAssets());
}

export interface AudioHost {
  context: AudioContextLike;
  buffers: ReadonlyMap<string, AudioBufferLike>;
  /** Plays retimed lines at their own pitch, through Signalsmith Stretch. */
  stretch: StretchAudio;
  close: () => void;
}

/**
 * Wraps a browser AudioContext in the structural `AudioContextLike` interface without type
 * assertions, mapping `AudioBufferLike` references back to real `AudioBuffer` instances. The
 * assets are mono, each sampled at `rateOf` its ID.
 */
export function createAudioHost(
  assets: ReadonlyMap<string, Float32Array>,
  rateOf: RateOf = demoRate,
): AudioHost {
  const native = new AudioContext({ sampleRate: 48000, latencyHint: "playback" });
  const nativeBuffers = new WeakMap<AudioBufferLike, AudioBuffer>();
  const buffers = new Map<string, AudioBufferLike>();
  for (const [id, pcm] of assets) {
    const audioBuffer = native.createBuffer(1, pcm.length, rateOf(id));
    audioBuffer.getChannelData(0).set(pcm);
    const handle: AudioBufferLike = {
      sampleRate: audioBuffer.sampleRate,
      length: audioBuffer.length,
    };
    nativeBuffers.set(handle, audioBuffer);
    buffers.set(id, handle);
  }
  const nodes = new WeakMap<object, AudioNode>();
  nodes.set(native.destination, native.destination);

  const context: AudioContextLike = {
    get currentTime() {
      return native.currentTime;
    },
    get sampleRate() {
      return native.sampleRate;
    },
    destination: native.destination,
    get state() {
      return native.state;
    },
    createBufferSource(): BufferSourceLike {
      const source = native.createBufferSource();
      let currentBuffer: AudioBufferLike | null = null;
      const wrapper: BufferSourceLike = {
        get buffer() {
          return currentBuffer;
        },
        set buffer(value: AudioBufferLike | null) {
          currentBuffer = value;
          source.buffer = value ? (nativeBuffers.get(value) ?? null) : null;
        },
        playbackRate: source.playbackRate,
        get onended() {
          return source.onended;
        },
        set onended(handler: ((event: Event) => void) | null) {
          source.onended = handler;
        },
        start(when?: number, offset?: number) {
          source.start(when, offset);
        },
        stop(when?: number) {
          source.stop(when);
        },
        connect(destination) {
          const target = nodes.get(destination);
          if (target) source.connect(target);
        },
        disconnect() {
          source.disconnect();
        },
      };
      nodes.set(wrapper, source);
      return wrapper;
    },
    createGain() {
      const gain = native.createGain();
      const wrapper = {
        gain: gain.gain,
        connect(destination: object) {
          const target = nodes.get(destination);
          if (target) gain.connect(target);
        },
        disconnect() {
          gain.disconnect();
        },
      };
      nodes.set(wrapper, gain);
      return wrapper;
    },
    getOutputTimestamp:
      typeof native.getOutputTimestamp === "function"
        ? () => native.getOutputTimestamp()
        : undefined,
    resume: () => native.resume(),
    addEventListener: (type, listener) => native.addEventListener(type, listener),
    removeEventListener: (type, listener) => native.removeEventListener(type, listener),
  };

  // The engine reads and returns real AudioBuffers; the transport sees handles.
  const engine = createSignalsmithStretch();
  const stretch: StretchAudio = (request, signal) => {
    const source = nativeBuffers.get(request.buffer);
    if (!source) return Promise.reject(new Error("Unknown demo buffer"));
    return Promise.resolve(engine.stretch({ ...request, buffer: source }, signal)).then(
      (rendered) => {
        if (!(rendered instanceof AudioBuffer)) throw new Error("Expected a rendered AudioBuffer");
        const handle: AudioBufferLike = {
          sampleRate: rendered.sampleRate,
          length: rendered.length,
        };
        nativeBuffers.set(handle, rendered);
        return handle;
      },
    );
  };

  return {
    context,
    buffers,
    stretch,
    close: () => {
      engine.clear();
      void native.close();
    },
  };
}

/** Lightweight requestAnimationFrame playhead transport for the shared-session demo. */
export function createClockTransport(durationTicks: number): TimelineTransport & {
  dispose(): void;
} {
  let state: TransportState = { playing: false, presentedTick: 0, requestedTick: null };
  let frame = 0;
  let anchorTime = 0;
  let anchorTick = 0;
  const listeners = new Set<(next: TransportState) => void>();

  const emit = (next: TransportState) => {
    state = next;
    for (const listener of listeners) listener(state);
  };

  const step = (now: number) => {
    if (!state.playing) return;
    const elapsedSec = Math.max(0, (now - anchorTime) / 1000);
    const tick = Math.min(durationTicks, anchorTick + Math.round(elapsedSec * hz));
    if (tick >= durationTicks) {
      emit({ playing: false, presentedTick: durationTicks, requestedTick: null });
      return;
    }
    emit({ playing: true, presentedTick: tick, requestedTick: null });
    frame = requestAnimationFrame(step);
  };

  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    play() {
      if (state.playing) return;
      anchorTick = state.presentedTick >= durationTicks ? 0 : state.presentedTick;
      anchorTime = performance.now();
      emit({ playing: true, presentedTick: anchorTick, requestedTick: null });
      frame = requestAnimationFrame(step);
    },
    pause() {
      if (!state.playing) return;
      cancelAnimationFrame(frame);
      emit({ playing: false, presentedTick: state.presentedTick, requestedTick: null });
    },
    seek(tick) {
      const clamped = Math.max(0, Math.min(durationTicks, tick));
      anchorTick = clamped;
      anchorTime = performance.now();
      emit({ playing: state.playing, presentedTick: clamped, requestedTick: null });
    },
    dispose() {
      cancelAnimationFrame(frame);
      listeners.clear();
    },
  };
}

/** Auto-delivering in-memory JSON channel between one editor session and a sequencer. */
export function createDirectChannel(): {
  readonly editor: SyncTransport;
  readonly sequencer: SyncTransport;
} {
  const toEditor = new Set<(message: SyncMessage) => void>();
  const toSequencer = new Set<(message: SyncMessage) => void>();
  const deliver = (targets: ReadonlySet<(message: SyncMessage) => void>, message: SyncMessage) => {
    const copy = structuredClone(message);
    queueMicrotask(() => {
      for (const listener of targets) listener(copy);
    });
  };
  return {
    editor: {
      send(message) {
        deliver(toSequencer, message);
      },
      onMessage(listener) {
        toEditor.add(listener);
        return () => toEditor.delete(listener);
      },
    },
    sequencer: {
      send(message) {
        deliver(toEditor, message);
      },
      onMessage(listener) {
        toSequencer.add(listener);
        return () => toSequencer.delete(listener);
      },
    },
  };
}
