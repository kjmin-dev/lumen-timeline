// What every consumer shares and what runs on a server too: the project, the
// panels' fields, the harness's controls and the counted editors. Nothing here
// touches a browser API; browser.mjs adds the audio, the transports and the
// waveform tiles.
import { commands, createEditor, TICKS_PER_SECOND as hz } from "@lumen-timeline/core";

export { commands, hz };

/** Sample rate of the synthesized sources. */
export const rate = 24000;
/** Seconds of audio in each voice source. */
export const voiceSeconds = 12;

/**
 * Forty seconds, two voice tracks of six lines with three candidate takes
 * each, a music bed and room tone, and two markers. IDs are fixed and the
 * editors' actor is named, so every consumer ends a trace on the same snapshot.
 */
export function project() {
  const tracks = [
    { id: "voice-a", name: "Voice A", overlap: "exclusive" },
    { id: "voice-b", name: "Voice B", overlap: "exclusive" },
    { id: "music", name: "Music" },
    { id: "room", name: "Room tone" },
  ];
  const clips = [];
  const takes = [];
  for (const [t, track] of ["voice-a", "voice-b"].entries())
    for (let k = 0; k < 6; k++) {
      const id = `${track}-${k}`;
      const takeIds = [0, 1, 2].map((n) => `${id}-take-${n}`);
      clips.push({
        id,
        name: `${t ? "Mara" : "Ines"} ${k + 1}`,
        trackId: track,
        kind: "audio",
        start: Math.round((k * 5 + t * 0.5) * hz),
        duration: Math.round(3.5 * hz),
        contentIn: 0,
        takeIds,
        activeTakeId: takeIds[0],
      });
      takeIds.forEach((takeId, n) =>
        takes.push({
          id: takeId,
          label: `Take ${n + 1}`,
          assetId: `${track}-${n}`,
          streamId: "mono",
          sourceAtContentZero: Math.round((k % 3) * 2.5 * hz),
        }),
      );
    }
  clips.push({
    id: "music-0",
    name: "Bed",
    trackId: "music",
    kind: "audio",
    start: 0,
    duration: 30 * hz,
    contentIn: 0,
    takeIds: ["music-take"],
    activeTakeId: "music-take",
  });
  takes.push({ id: "music-take", assetId: "music", streamId: "mono", sourceAtContentZero: 0 });
  for (let k = 0; k < 3; k++) {
    clips.push({
      id: `room-${k}`,
      name: `Room ${k + 1}`,
      trackId: "room",
      kind: "audio",
      start: k * 10 * hz,
      duration: 8 * hz,
      contentIn: 0,
      takeIds: ["room-take"],
      activeTakeId: "room-take",
    });
  }
  takes.push({ id: "room-take", assetId: "room", streamId: "mono", sourceAtContentZero: 0 });
  return {
    schemaVersion: 2,
    duration: 40 * hz,
    tracks,
    clips,
    takes,
    markers: [
      { id: "m-scene", start: 10 * hz, label: "Scene 2" },
      { id: "m-end", start: 30 * hz, label: "Credits" },
    ],
  };
}

/** Seconds of each source, by asset ID. */
export function assetSeconds() {
  const seconds = { music: 30, room: 8 };
  for (const track of ["voice-a", "voice-b"])
    for (let n = 0; n < 3; n++) seconds[`${track}-${n}`] = voiceSeconds;
  return seconds;
}

/** The catalog of every source's mono stream. */
export function catalog() {
  const streams = {};
  for (const [id, seconds] of Object.entries(assetSeconds()))
    streams[id] = {
      mono: { assetVersion: 1, sampleRate: rate, availableStart: 0, availableEnd: seconds * rate },
    };
  return { version: 1, streams };
}

// --- Counting --------------------------------------------------------------
// The editors, transports and waveform provider the consumers receive count
// their active subscriptions by name, so the suite can tell what a mount, a
// panel or an unmount left behind.

export function createCounter() {
  const active = new Map();
  const track = (name, off) => {
    active.set(name, (active.get(name) ?? 0) + 1);
    let on = true;
    return () => {
      if (on) active.set(name, active.get(name) - 1);
      on = false;
      return off();
    };
  };
  return { active, track };
}

/** The editor with its document, selection and history subscriptions counted. */
export function countedEditor(editor, counter, name) {
  const session = Object.create(editor.session, {
    subscribeSelection: {
      value: (listen) =>
        counter.track(name + ".selection", editor.session.subscribeSelection(listen)),
    },
  });
  const history = Object.create(editor.history, {
    subscribe: {
      value: (listen) => counter.track(name + ".history", editor.history.subscribe(listen)),
    },
  });
  return {
    ...editor,
    session,
    history,
    subscribe: (select, listen) =>
      counter.track(name + ".document", editor.subscribe(select, listen)),
  };
}

/** Any object with `subscribe`, with that subscription counted. */
export function countedSource(source, counter, name) {
  return Object.create(source, {
    subscribe: { value: (listener) => counter.track(name, source.subscribe(listener)) },
  });
}

export function editorFor(name) {
  return createEditor({ project: project(), actor: "host-" + name });
}

// --- Panels ----------------------------------------------------------------

/**
 * The take inspector's field: the last selected clip, its active take and its
 * candidates' labels, or `null` with nothing selected.
 */
export function inspectorField(editor) {
  return ({ snapshot, selection }) => {
    const id = selection.at(-1);
    const clip = id === undefined ? undefined : snapshot.clips.find((c) => c.id === id);
    if (!clip) return null;
    const takes = editor
      .read(snapshot)
      .takesOf(clip.id)
      .map((take) => ({ id: take.id, label: take.label ?? take.id }));
    return {
      clipId: clip.id,
      name: clip.name ?? clip.id,
      takeId: clip.activeTakeId ?? null,
      takes,
    };
  };
}

export function sameInspector(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.clipId === b.clipId &&
    a.name === b.name &&
    a.takeId === b.takeId &&
    a.takes.length === b.takes.length &&
    a.takes.every((take, i) => take.id === b.takes[i].id && take.label === b.takes[i].label)
  );
}

/** Chooses a candidate, as the inspector's buttons do. */
export function chooseTake(editor, clipId, takeId) {
  return editor.dispatch(commands.selectTake({ clipId, takeId }));
}

/** The clock's field: the playhead in tenths of a second. */
export const clockField = (state) =>
  Math.floor((state.requestedTick ?? state.presentedTick) / (hz / 10));

export const clockText = (tenths) => (tenths / 10).toFixed(1) + " s";

// --- Harness controls --------------------------------------------------------

/**
 * The state the suite changes and each consumer follows through its own
 * framework: whether the view and the panels are mounted, which editor and
 * transport pair they use, and the view's options.
 */
export function createControls(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch };
      for (const listener of Array.from(listeners)) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function initialControls({ timeline = true, renderer = "auto" } = {}) {
  return {
    timeline,
    panels: true,
    pair: "a",
    renderer,
    options: {
      pixelsPerSecond: 40,
      snap: { gridTicks: hz / 10 },
      labels: { take: "take" },
      waveforms: true,
    },
  };
}

/** The view options of a controls state, with the host's waveform provider. */
export function viewOptions(host, state) {
  const { waveforms, ...options } = state.options;
  return { ...options, waveforms: waveforms ? host.tiles : undefined, renderer: state.renderer };
}

/**
 * A host for a server render: editors and transports that subscribe nothing on
 * their own, and no audio or waveforms.
 */
export function createServerHost() {
  const counter = createCounter();
  const pair = (name) => {
    const editor = editorFor(name);
    editor.session.select(["voice-a-0"]);
    const state = { playing: false, presentedTick: 0, requestedTick: null };
    const transport = {
      snapshot: () => state,
      subscribe: () => () => true,
      play() {},
      pause() {},
      seek() {},
    };
    return {
      editor: countedEditor(editor, counter, name),
      transport: countedSource(transport, counter, name + ".transport"),
    };
  };
  return {
    pairs: { a: pair("a"), b: pair("b") },
    tiles: undefined,
    controls: createControls(initialControls()),
    counts: { inspector: 0, clock: 0 },
    setView() {},
    subscriptions: () => Object.fromEntries(counter.active),
  };
}
