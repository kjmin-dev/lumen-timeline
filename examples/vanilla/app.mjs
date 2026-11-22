import {
  createEditor,
  sequenceDuration,
  TICKS_PER_SECOND as hz,
  watchMarkerCrossings,
} from "@lumen-timeline/core";
import { mountTimeline } from "@lumen-timeline/timeline";
import { createGeneration, mountLinePanel } from "./generation.mjs";
import { attachPlayer } from "./player.mjs";
import { mountTakePanel } from "./takes.mjs";

const video = document.querySelector("video");
const videoProject = {
  schemaVersion: 1,
  duration: 24 * hz,
  tracks: [
    { id: "dialogue", name: "Dialogue", overlap: "exclusive" },
    { id: "music", name: "Music", locked: true },
  ],
  clips: [
    {
      id: "line",
      name: "Tidal contours",
      trackId: "dialogue",
      kind: "audio",
      start: 12 * hz,
      duration: 4 * hz,
      contentIn: hz,
      contentBounds: { start: 0, end: 8 * hz },
      takeIds: ["line", "line-late", "guide"],
      activeTakeId: "line",
      lineId: "line-1",
    },
    {
      id: "return",
      name: "Return cue",
      trackId: "dialogue",
      kind: "audio",
      start: 19 * hz,
      duration: 3 * hz,
      contentIn: hz,
      contentBounds: { start: 0, end: 8 * hz },
      takeIds: ["line"],
      activeTakeId: "line",
      lineId: "line-2",
    },
    {
      id: "bed",
      name: "Low water",
      trackId: "music",
      kind: "audio",
      start: 0,
      duration: 24 * hz,
      contentIn: 0,
      contentBounds: { start: 0, end: 24 * hz },
      takeIds: ["bed"],
      activeTakeId: "bed",
    },
  ],
  // Three candidates for the first line: the recording, the same recording a
  // quarter second later, and a synthesized guide.
  takes: [
    { id: "line", assetId: "line", streamId: "mono", sourceAtContentZero: 0, label: "Dialogue" },
    {
      id: "line-late",
      assetId: "line",
      streamId: "mono",
      sourceAtContentZero: -hz / 4,
      label: "Dialogue, late",
    },
    { id: "guide", assetId: "guide", streamId: "mono", sourceAtContentZero: 0, label: "Guide" },
    { id: "bed", assetId: "bed", streamId: "mono", sourceAtContentZero: 0, label: "Music bed" },
  ],
  markers: [
    { id: "marker-line", start: 12 * hz, label: "Tidal line" },
    { id: "marker-return", start: 19 * hz, label: "Return" },
  ],
  // Each line in the source language and its translation, which generation reads.
  entityData: {
    "studio.line": {
      "line-1": {
        source: "La marée revient. Regarde les courbes dériver sur l'anse.",
        text: "The tide returns. Watch the contour lines drift across the inlet.",
        revision: 0,
      },
      "line-2": {
        source: "Et elle repart.",
        text: "And it leaves again.",
        revision: 0,
      },
    },
  },
};
const audioProject = {
  schemaVersion: 1,
  tracks: videoProject.tracks,
  clips: [
    { ...videoProject.clips[0], name: "Field narration", start: 2 * hz },
    { ...videoProject.clips[2], name: "Low water bed" },
  ],
  takes: videoProject.takes,
  entityData: { "studio.line": { "line-1": videoProject.entityData["studio.line"]["line-1"] } },
  markers: [
    { id: "marker-narration", start: 2 * hz, label: "Narration" },
    { id: "marker-fade", start: 20 * hz, label: "Fade" },
  ],
};
export const project = video ? videoProject : audioProject;
// Each workspace names candidates in its own words: takes for the picture edit,
// versions for the audio-only one.
export const words = video
  ? { take: "take", takes: "takes", none: "No take" }
  : { take: "version", takes: "versions", none: "No version" };
const report = (text) => {
  document.querySelector("#status").textContent = text;
};

export async function openProject(data) {
  const editor = createEditor({ project: data });
  const playback = await attachPlayer(video, editor, (error) => {
    document.querySelector("#status").textContent = error.message;
  });
  const { transport } = playback;
  const view = mountTimeline(document.querySelector("#timeline"), {
    editor,
    transport,
    snap: { gridTicks: hz / 10 },
    labels: words,
    pixelsPerSecond: Math.max(
      20,
      (document.querySelector("#timeline").clientWidth - 160) /
        Math.max(1, sequenceDuration(editor.getSnapshot()) / hz),
    ),
  });
  function inspector() {
    const snapshot = editor.getSnapshot();
    const c = snapshot.clips.find((clip) => clip.id === editor.session.getSelection().at(-1));
    document.querySelector("#clip-name").textContent = c?.name ?? "No selection";
    document.querySelector("#track").textContent =
      snapshot.tracks.find((t) => t.id === c?.trackId)?.name ?? "—";
    document.querySelector("#range").textContent = c
      ? (c.start / hz).toFixed(3) + " – " + ((c.start + c.duration) / hz).toFixed(3) + " s"
      : "—";
    document.querySelector("#offset").textContent = c ? (c.contentIn / hz).toFixed(3) + " s" : "—";
    const take = c?.activeTakeId
      ? editor
          .read()
          .takesOf(c.id)
          .find((t) => t.id === c.activeTakeId)
      : undefined;
    document.querySelector("#take").textContent = take
      ? (take.label ?? take.id)
      : c?.takeIds
        ? words.none
        : "—";
  }
  let off = () => {};
  function bindInspector() {
    off();
    const id = editor.session.getSelection().at(-1);
    // The inspector shows the clip's fields and its active take's label.
    off = editor.subscribe((s) => {
      const c = s.clips.find((clip) => clip.id === id);
      const take = s.takes?.find((t) => t.id === c?.activeTakeId);
      return c && JSON.stringify([c, take?.label]);
    }, inspector);
    inspector();
  }
  const deselect = editor.session.subscribeSelection(bindInspector);
  bindInspector();
  const offTakes = mountTakePanel(document.querySelector("#take-panel"), {
    editor,
    transport,
    words,
    report,
  });
  const generation = createGeneration({
    editor,
    context: playback.context,
    assets: playback.assets,
    transport,
  });
  const offLines = mountLinePanel(document.querySelector("#line-panel"), {
    editor,
    plugin: generation,
    words,
    report,
  });
  const clockLabel = document.querySelector("#clock-mode");
  function showClock(state) {
    if (!clockLabel) return;
    const label = {
      output: "Output timestamp",
      estimated: "Rendering clock estimate",
      exact: "Stopped position",
    }[state.precision];
    if (label && clockLabel.textContent !== label) clockLabel.textContent = label;
  }
  const offClock = clockLabel ? transport.subscribe(showClock) : () => {};
  showClock(transport.snapshot());
  // Announce the last marker that playback crossed. Seeking past one stays silent.
  const cue = document.querySelector("#marker-cue");
  cue.textContent = "none";
  const offCrossings = watchMarkerCrossings(editor, transport, ({ markers }) => {
    const marker = markers.at(-1);
    cue.textContent = marker.label ?? marker.id;
  });
  return {
    editor,
    view,
    transport,
    generation,
    assets: playback.assets,
    async dispose() {
      off();
      deselect();
      offTakes();
      offLines();
      offClock();
      offCrossings();
      view.dispose();
      await playback.dispose();
      editor.dispose();
    },
  };
}
export let studio;
try {
  studio = await openProject(project);
} catch (error) {
  document.querySelector("#status").textContent = error.message;
  throw error;
}

const storageKey = video ? "lumen-timeline:vanilla:project:v2" : "lumen-timeline:audio:project:v2";
const save = document.querySelector("#save"),
  reopen = document.querySelector("#reopen");
const status = document.querySelector("#status");
try {
  reopen.disabled = !localStorage.getItem(storageKey);
} catch {
  reopen.disabled = true;
}
save.onclick = () => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(studio.editor.getSnapshot()));
    reopen.disabled = false;
    status.textContent = "Project saved.";
  } catch (error) {
    status.textContent = error.message;
  }
};
reopen.onclick = async () => {
  save.disabled = reopen.disabled = true;
  try {
    const restored = JSON.parse(localStorage.getItem(storageKey));
    const next = await openProject(restored);
    const old = studio;
    studio = next;
    await old.dispose();
    await next.transport.seek(0);
    status.textContent = "Saved project reopened.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    save.disabled = reopen.disabled = false;
  }
};
