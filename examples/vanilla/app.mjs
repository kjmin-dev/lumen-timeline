import {
  createEditor,
  sequenceDuration,
  TICKS_PER_SECOND as hz,
  watchMarkerCrossings,
} from "@lumen-timeline/core";
import { mountTimeline } from "@lumen-timeline/timeline";
import { attachPlayer } from "./player.mjs";

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
      takeIds: ["line"],
      activeTakeId: "line",
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
  takes: [
    { id: "line", assetId: "line", streamId: "mono", sourceAtContentZero: 0, label: "Dialogue" },
    { id: "bed", assetId: "bed", streamId: "mono", sourceAtContentZero: 0, label: "Music bed" },
  ],
  markers: [
    { id: "marker-line", start: 12 * hz, label: "Tidal line" },
    { id: "marker-return", start: 19 * hz, label: "Return" },
  ],
};
const audioProject = {
  schemaVersion: 1,
  tracks: videoProject.tracks,
  clips: [
    { ...videoProject.clips[0], name: "Field narration", start: 2 * hz },
    { ...videoProject.clips[2], name: "Low water bed" },
  ],
  takes: videoProject.takes,
  markers: [
    { id: "marker-narration", start: 2 * hz, label: "Narration" },
    { id: "marker-fade", start: 20 * hz, label: "Fade" },
  ],
};
export const project = video ? videoProject : audioProject;

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
    document.querySelector("#take").textContent = c?.activeTakeId ?? "—";
  }
  let off = () => {};
  function bindInspector() {
    off();
    const id = editor.session.getSelection().at(-1);
    off = editor.subscribe((s) => s.clips.find((c) => c.id === id), inspector);
    inspector();
  }
  const deselect = editor.session.subscribeSelection(bindInspector);
  bindInspector();
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
    async dispose() {
      off();
      deselect();
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
