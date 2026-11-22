import { TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import { lines } from "./generation.mjs";

const seconds = (tick) => (tick / hz).toFixed(1);

/**
 * The placed script: every clip that carries a line, in timeline order. The
 * clip's track is the speaker. A split line shows each part. Clicking a row
 * selects its clip and reveals it in the timeline; the take and line panels
 * follow the selection. Play line seeks to the clip and stops at its end.
 */
export function placedLines(snapshot) {
  const records = snapshot.entityData?.[lines] ?? {};
  const tracks = new Map(snapshot.tracks.map((t) => [t.id, t.name ?? t.id]));
  const placed = snapshot.clips
    .filter((clip) => clip.lineId && records[clip.lineId])
    .toSorted((a, b) => a.start - b.start || a.trackId.localeCompare(b.trackId));
  const parts = new Map();
  for (const clip of placed) parts.set(clip.lineId, (parts.get(clip.lineId) ?? 0) + 1);
  const seen = new Map();
  return placed.map((clip) => {
    const part = (seen.get(clip.lineId) ?? 0) + 1;
    seen.set(clip.lineId, part);
    const take = snapshot.takes?.find((t) => t.id === clip.activeTakeId);
    return {
      clipId: clip.id,
      lineId: clip.lineId,
      speaker: tracks.get(clip.trackId),
      start: clip.start,
      end: clip.start + clip.duration,
      range: seconds(clip.start) + "–" + seconds(clip.start + clip.duration) + " s",
      part: parts.get(clip.lineId) > 1 ? part + " of " + parts.get(clip.lineId) : "",
      take: take ? (take.label ?? take.id) : null,
      source: records[clip.lineId].source ?? "",
      text: records[clip.lineId].text ?? "",
    };
  });
}

export function mountLineList(container, { editor, transport, view, words, report }) {
  const doc = container.ownerDocument;
  const events = new AbortController();
  const root = doc.createElement("div");
  root.innerHTML = `
    <div class="panel-head">Lines <small class="line-count"></small></div>
    <ol class="line-rows" aria-label="Lines"></ol>`;
  container.append(root);
  const count = root.querySelector(".line-count");
  const list = root.querySelector("ol");
  let shown = [];
  let playing = null;

  function render() {
    shown = placedLines(editor.getSnapshot());
    count.textContent = shown.length === 1 ? "1 line" : shown.length + " lines";
    list.replaceChildren(
      ...shown.map((line) => {
        const row = doc.createElement("li");
        row.dataset.clip = line.clipId;
        const name = line.speaker + ", " + line.range;
        const pick = doc.createElement("button");
        pick.type = "button";
        pick.className = "line-pick";
        pick.setAttribute("aria-label", "Select " + name);
        const meta = doc.createElement("span");
        meta.className = "line-meta";
        const speaker = doc.createElement("strong");
        speaker.textContent = line.speaker;
        meta.append(
          speaker,
          " · " + line.range,
          line.part ? " · part " + line.part : "",
          " · " + (line.take ?? words.none),
        );
        const source = doc.createElement("span");
        source.className = "line-text";
        source.lang = "fr";
        source.textContent = line.source;
        const text = doc.createElement("span");
        text.className = "line-text";
        text.lang = "en";
        text.textContent = line.text;
        pick.append(meta, source, text);
        const state = doc.createElement("small");
        state.className = "line-state";
        const play = doc.createElement("button");
        play.type = "button";
        play.className = "line-play";
        play.textContent = "Play line";
        play.setAttribute("aria-label", "Play " + name);
        row.append(pick, state, play);
        return row;
      }),
    );
    mark();
    highlight(transport.snapshot());
  }
  // The selected clip's row, scrolled into view inside the list only, so a
  // selection made in the timeline never scrolls the page under the pointer.
  function mark() {
    const id = editor.session.getSelection().at(-1);
    let current;
    for (const row of list.children) {
      const selected = row.dataset.clip === id;
      if (selected) {
        row.setAttribute("aria-current", "true");
        current = row;
      } else row.removeAttribute("aria-current");
    }
    if (!current) return;
    const top = current.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + current.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = top + current.offsetHeight - list.clientHeight;
  }
  // The line under the playhead while playing, independent of selection and focus.
  function highlight(state) {
    const tick = state.requestedTick ?? state.presentedTick;
    const line = state.playing
      ? shown.find((l) => l.start <= tick && tick < l.end && !state.audition)
      : undefined;
    const next = line?.clipId ?? null;
    if (next === playing) return;
    playing = next;
    for (const row of list.children) {
      const on = row.dataset.clip === playing;
      row.classList.toggle("playing", on);
      row.querySelector(".line-state").textContent = on ? "Playing" : "";
    }
  }
  async function playLine(clipId) {
    const line = shown.find((l) => l.clipId === clipId);
    if (!line) return;
    try {
      await transport.seek(line.start);
      await transport.play({ until: line.end });
      report("");
    } catch (error) {
      report(error.message);
    }
  }
  list.addEventListener(
    "click",
    (event) => {
      const button = event.target.closest("button");
      const clipId = button?.closest("li")?.dataset.clip;
      if (!clipId) return;
      editor.session.select([clipId]);
      view.reveal(clipId);
      if (button.classList.contains("line-play")) void playLine(clipId);
    },
    { signal: events.signal },
  );
  // The rows follow every placed line's clip, text and active take label.
  const offDoc = editor.subscribe((s) => JSON.stringify(placedLines(s)), render);
  const offSelection = editor.session.subscribeSelection(mark);
  const offTransport = transport.subscribe(highlight);
  render();
  return () => {
    events.abort();
    offDoc();
    offSelection();
    offTransport();
    root.remove();
  };
}
