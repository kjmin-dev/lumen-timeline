import { createLabelAtlas } from "./atlas.ts";
import type { LabelAtlas } from "./atlas.ts";
import { bindEditing, handleAt, snapConfig } from "./gestures.ts";
import type { PointerInfo } from "./gestures.ts";
import { layoutRow, palette, QuadList } from "./layout.ts";
import type { RowQuads } from "./renderer.ts";
import { createRendererHost } from "./renderers.ts";
import { registerReader } from "./probe.ts";
import { TICKS_PER_SECOND as hz, sequenceDuration } from "@lumen-timeline/core";
import { commands } from "@lumen-timeline/core";
import type {
  Clip,
  EditCommit,
  EditResult,
  Marker,
  ProjectSnapshot,
  Tick,
  Track,
} from "@lumen-timeline/core";
import { captionWords } from "./captions.ts";
import { element } from "./dom.ts";
import type { Listen } from "./dom.ts";
import type { Box, Packed, Viewport } from "./geometry.ts";
import type {
  TimelineDiagnostics,
  TimelineHit,
  TimelineOptions,
  TimelineView,
  TransportState,
} from "./types.ts";
export type * from "./types.ts";
export type { Viewport } from "./geometry.ts";
import {
  formatTime,
  hit,
  laneHeight,
  rowInset,
  pack,
  pixelAt,
  rectangle,
  tickAt,
  viewport,
  zoomAt,
} from "./geometry.ts";

const maxTick = 7 * 86400 * hz;
const clampTick = (tick: Tick, end: Tick): Tick => Math.max(0, Math.min(end, tick));
const markerColor = "#ffd7a4";

interface Row extends Packed {
  readonly track: Track;
  readonly index: number;
  readonly top: number;
}

/** The view keeps its own counters, read through `getDiagnostics`. */
type Counters = {
  -readonly [K in "layoutBuilds" | "staticPaints" | "overlayPaints"]: TimelineDiagnostics[K];
};

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is unavailable");
  return ctx;
}

export function mountTimeline(
  container: HTMLElement,
  {
    editor,
    transport,
    pixelsPerSecond = 48,
    startTick = 0,
    snap,
    labels,
    waveforms,
    renderer = "auto",
  }: TimelineOptions,
): TimelineView {
  const config = snapConfig(snap);
  const words = captionWords(labels);
  const doc = container.ownerDocument;
  const windowProxy = doc.defaultView;
  if (!windowProxy) throw new Error("Mount the timeline in a document with a window");
  const win = windowProxy;
  const root = doc.createElement("section");
  root.className = "lt";
  root.setAttribute("aria-label", "Timeline");
  root.innerHTML = `
    <div class="lt-tools">
      <button type="button" data-play>Play</button><output class="lt-time"></output>
      <label>Clip <select aria-label="Clip navigator"></select></label>
      <label>Marker <select aria-label="Marker navigator"></select></label>
      <button type="button" data-marker-add>Add marker</button>
      <span class="lt-spacer"></span><button type="button" data-out aria-label="Zoom out">−</button>
      <button type="button" data-in aria-label="Zoom in">+</button>
    </div>
    <div class="lt-grid"><div class="lt-track-title">Tracks</div>
      <canvas class="lt-ruler" tabindex="0" role="slider" aria-label="Seek" aria-valuemin="0"></canvas></div>
    <div class="lt-scroll"><div class="lt-space"><div class="lt-pin lt-grid">
      <div class="lt-headers"></div><div class="lt-surface" tabindex="0" role="group" aria-label="Timeline clips">
        <canvas class="lt-clips" aria-hidden="true"></canvas><canvas class="lt-selection" aria-hidden="true"></canvas>
        <div class="lt-head" hidden></div>
      </div></div></div></div>
    <label class="lt-pan">Scroll <input type="range" aria-label="Timeline scroll" min="0" step="1" value="0"></label>
    <form class="lt-marker-edit"><label>Marker label <input type="text" aria-label="Marker label"></label>
      <button type="submit" data-marker-rename>Rename marker</button>
      <button type="button" data-marker-remove>Remove marker</button></form>
    <div class="lt-message" role="status"></div>`;
  container.append(root);
  const ruler = element(root, ".lt-ruler", "canvas"),
    surface = element(root, ".lt-surface", "div"),
    scroll = element(root, ".lt-scroll", "div");
  const body = element(root, ".lt-clips", "canvas"),
    overlay = element(root, ".lt-selection", "canvas"),
    head = element(root, ".lt-head", "div");
  const navigator = element(root, "select", "select"),
    pan = element(root, ".lt-pan input", "input"),
    message = element(root, ".lt-message", "div");
  const play = element(root, "[data-play]", "button"),
    time = element(root, ".lt-time", "output");
  const space = element(root, ".lt-space", "div"),
    pin = element(root, ".lt-pin", "div"),
    headerList = element(root, ".lt-headers", "div");
  const zoomIn = element(root, "[data-in]", "button"),
    zoomOut = element(root, "[data-out]", "button");
  const markerNavigator = element(root, "select[aria-label='Marker navigator']", "select"),
    markerAdd = element(root, "[data-marker-add]", "button"),
    markerForm = element(root, ".lt-marker-edit", "form"),
    markerLabel = element(root, ".lt-marker-edit input", "input"),
    markerRename = element(root, "[data-marker-rename]", "button"),
    markerRemove = element(root, "[data-marker-remove]", "button");
  const events = new win.AbortController();
  const listen: Listen = (target, type, fn, options = {}) =>
    target.addEventListener(type, fn, { ...options, signal: events.signal });
  let snapshot = editor.getSnapshot();
  let read = editor.read(snapshot);
  let view = viewport(startTick, pixelsPerSecond, 0, maxTick);
  let duration = 0,
    width = 0,
    height = 0,
    dpr = 0,
    totalHeight = 0;
  // Measured when the mount is, so a paint reads no layout.
  let scrollTop = 0,
    rulerHeight = 0;
  let rows: Row[] = [],
    visible: Row[] = [],
    boxes: Box<Clip>[] = [],
    ghosts: readonly Clip[] = [];
  const packed = new Map<string, Packed>();
  const diagnostics: Counters = {
    layoutBuilds: 0,
    staticPaints: 0,
    overlayPaints: 0,
  };
  let disposed = false;
  // Each visible row's quads, kept between paints so a backend can draw them
  // all, and the assets whose waveforms its clips show.
  const scenes = new Map<number, { readonly quads: QuadList; readonly assets: Set<string> }>();
  const rulerContext = context2d(ruler),
    overlayContext = context2d(overlay);
  let atlas: LabelAtlas | null = null;
  // The clip canvas belongs to the backend, which replaces it when it changes.
  const renderers = createRendererHost(body, renderer, () => {
    if (!disposed) paint();
  });

  function rebuildRows(dirty?: ReadonlySet<string>): void {
    totalHeight = 0;
    rows = snapshot.tracks.map((track, index) => {
      let p = packed.get(track.id);
      if (!p || dirty?.has(track.id)) {
        const clips = read.clipsIn({ start: 0, end: maxTick }, { trackIds: [track.id] });
        p = pack(clips);
        packed.set(track.id, p);
      }
      const row: Row = { track, index, top: totalHeight, ...p };
      totalHeight += p.height;
      return row;
    });
    duration = sequenceDuration(snapshot);
  }

  function setup(ctx: CanvasRenderingContext2D, w: number, h: number): CanvasRenderingContext2D {
    const { canvas } = ctx;
    const bw = Math.max(1, Math.round(w * dpr)),
      bh = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function spacing(): number {
    const ideal = 72 / view.pixelsPerSecond;
    const unit = 10 ** Math.floor(Math.log10(ideal));
    // unit <= ideal < 10 * unit, so the last multiple always qualifies.
    return ([1, 2, 5, 10].find((m) => m * unit >= ideal) ?? 10) * unit;
  }
  function gridLines(callback: (x: number, seconds: number) => void): void {
    const step = spacing();
    const first = Math.ceil(view.startTick / hz / step);
    for (let n = first; ; n++) {
      const x = pixelAt(Math.round(n * step * hz), view);
      if (x > width) break;
      callback(x, n * step);
    }
  }
  function paintRuler(): void {
    const h = rulerHeight;
    const ctx = setup(rulerContext, width, h);
    ctx.clearRect(0, 0, width, h);
    ctx.fillStyle = "#9da9ad";
    ctx.font = "11px ui-monospace, monospace";
    gridLines((x, seconds) => {
      ctx.fillRect(Math.round(x), h - 6, 1, 6);
      ctx.fillText(formatTime(Math.round(seconds * hz)).replace(/\.000$/, ""), x + 4, 17);
    });
    ctx.font = "600 10px system-ui, sans-serif";
    for (const marker of visibleMarkers()) {
      const x = Math.round(pixelAt(marker.start, view));
      const color = marker.color ?? markerColor;
      const text = marker.label ?? marker.id;
      ctx.fillStyle = color;
      ctx.fillRect(x, 0, 1, h);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + 7, 0);
      ctx.lineTo(x, 7);
      ctx.fill();
      // A backing keeps the label legible over tick marks below the time labels.
      ctx.fillStyle = "#14191c";
      ctx.fillRect(x + 2, h - 13, ctx.measureText(text).width + 6, 12);
      ctx.fillStyle = color;
      ctx.fillText(text, x + 5, h - 4);
    }
    ruler.setAttribute("aria-valuemax", String(duration / hz));
  }
  function visibleMarkers(): readonly Marker[] {
    return read.markersIn({
      start: view.startTick,
      end: Math.min(maxTick, tickAt(width, view) + 1),
    });
  }
  function paintOverlay(): void {
    const ctx = setup(overlayContext, width, height);
    ctx.clearRect(0, 0, width, height);
    const selected = new Set(editor.session.getSelection());
    for (const b of boxes)
      if (selected.has(b.clip.id)) {
        ctx.strokeStyle = "#fff3d9";
        ctx.lineWidth = 2;
        ctx.strokeRect(b.x + 1, b.y + 1, Math.max(0, b.endX - b.x - 2), b.height - 2);
        ctx.fillStyle = "#ffddaa";
        for (const x of [b.left, b.right - 3]) {
          if (x >= 0 && x + 3 <= width) ctx.fillRect(x, b.y + 6, 3, b.height - 12);
        }
      }
    ctx.save();
    ctx.setLineDash([5, 3]);
    ctx.lineWidth = 2;
    for (const clip of ghosts) {
      const row = visible.find((r) => r.track.id === clip.trackId);
      if (!row) continue;
      const b = rectangle(clip, row.lanes.get(clip.id) ?? 0, row.top - scrollTop, view, width);
      if (b.endX <= b.x) continue;
      ctx.fillStyle = "#ffe6ab33";
      ctx.fillRect(b.x, b.y, b.endX - b.x, b.height);
      ctx.strokeStyle = "#ffe6ab";
      ctx.strokeRect(b.x + 1, b.y + 1, Math.max(0, b.endX - b.x - 2), b.height - 2);
    }
    ctx.restore();
    // Markers belong to the document and stay put during playback.
    for (const marker of visibleMarkers()) {
      ctx.fillStyle = (marker.color ?? markerColor) + "88";
      ctx.fillRect(Math.round(pixelAt(marker.start, view)), 0, 1, height);
    }
    diagnostics.overlayPaints++;
  }
  function frame(state: TransportState = transport.snapshot()): void {
    const t = state.requestedTick ?? state.presentedTick;
    const x = pixelAt(t, view);
    head.hidden = x < 0 || x >= width;
    head.style.transform = "translateX(" + x + "px)";
    const stamp = formatTime(t),
      label = state.playing ? "Pause" : "Play";
    if (time.textContent !== stamp) time.textContent = stamp;
    if (play.textContent !== label) play.textContent = label;
    ruler.setAttribute("aria-valuenow", String(t / hz));
    ruler.setAttribute("aria-valuetext", formatTime(t));
  }
  // Visible tracks whose last layout asked for a waveform of `assetId`.
  function playing(assetId: string): ReadonlySet<string> {
    const tracks = new Set<string>();
    for (const row of visible)
      if (scenes.get(row.index)?.assets.has(assetId)) tracks.add(row.track.id);
    return tracks;
  }
  let painting = false;
  function paint(dirty?: ReadonlySet<string>): void {
    painting = true;
    try {
      paintClips(dirty);
    } finally {
      painting = false;
    }
  }
  function labelAtlas(): LabelAtlas {
    if (!atlas) atlas = createLabelAtlas(doc, dpr);
    return atlas;
  }
  function paintClips(dirty?: ReadonlySet<string>): void {
    const range = { start: view.startTick, end: Math.min(maxTick, tickAt(width, view) + 1) };
    const grid: number[] = [];
    gridLines((x) => grid.push(x));
    const atlas = labelAtlas();
    if (!dirty) {
      boxes = [];
      for (const index of scenes.keys())
        if (!visible.some((row) => row.index === index)) scenes.delete(index);
    } else boxes = boxes.filter((b) => !dirty.has(b.clip.trackId));
    const changed: RowQuads[] = [];
    for (const row of visible) {
      if (dirty && !dirty.has(row.track.id)) continue;
      let scene = scenes.get(row.index);
      if (!scene) {
        scene = { quads: new QuadList(), assets: new Set() };
        scenes.set(row.index, scene);
      }
      const { quads, assets } = scene;
      assets.clear();
      const top = row.top - scrollTop;
      layoutRow(
        row,
        read.clipsIn(range, { trackIds: [row.track.id] }),
        {
          view,
          width,
          top,
          dpr,
          grid,
          words,
          takesOf: (id) => read.takesOf(id),
          peaks: waveforms && ((request) => waveforms.peaks(request)),
          label: (name, caption, color) => atlas.slot(name, caption, color),
          assets,
        },
        quads,
        boxes,
      );
      changed.push({ top, height: row.height, quads });
    }
    // A full atlas holds only this paint's labels after a clear.
    if (atlas.full && !relaying) {
      atlas.clear();
      relaying = true;
      try {
        return paintClips();
      } finally {
        relaying = false;
      }
    }
    renderers.draw({
      width,
      height,
      dpr,
      rows: visible.flatMap((row) => {
        const scene = scenes.get(row.index);
        return scene ? [{ top: row.top - scrollTop, height: row.height, quads: scene.quads }] : [];
      }),
      changed: dirty ? changed : null,
      atlas,
    });
    if (changed.length || !dirty) {
      diagnostics.staticPaints++;
      diagnostics.layoutBuilds++;
    }
    // The rows laid out now show every peak that has arrived.
    if (dirty) for (const id of dirty) waveTracks.delete(id);
    else waveTracks.clear();
    paintOverlay();
    frame();
  }
  let relaying = false;
  // One header per visible row, kept by row index at its place in the scrolled
  // content. A vertical scroll moves the list and changes a header only where
  // a row comes into view or leaves it.
  const headers = new Map<number, { readonly element: HTMLElement; key: string }>();
  function place(): void {
    visible = rows.filter(
      (row) => row.top < scrollTop + height && row.top + row.height > scrollTop,
    );
    const shown = new Set(visible.map((row) => row.index));
    for (const [index, header] of headers)
      if (!shown.has(index)) {
        header.element.remove();
        headers.delete(index);
      }
    for (const row of visible) {
      let header = headers.get(row.index);
      if (!header) {
        const element = doc.createElement("div");
        element.className = "lt-label";
        element.style.setProperty("--track-color", palette(row.index)[1]);
        // In row order, before the header of the next row down.
        let next: HTMLElement | null = null;
        let nearest = Infinity;
        for (const [index, other] of headers)
          if (index > row.index && index < nearest) {
            nearest = index;
            next = other.element;
          }
        headerList.insertBefore(element, next);
        header = { element, key: "" };
        headers.set(row.index, header);
      }
      const name = row.track.name ?? row.track.id;
      const key = [row.top, row.height, name].join();
      if (header.key === key) continue;
      header.key = key;
      header.element.style.top = row.top + "px";
      header.element.style.height = row.height + "px";
      header.element.textContent = name;
    }
    headerList.style.transform = "translateY(" + -scrollTop + "px)";
  }
  // Measures the mount, places the visible rows' headers, and draws.
  function refresh(): void {
    if (disposed) return;
    width = surface.clientWidth;
    height = scroll.clientHeight;
    const ratio = win.devicePixelRatio || 1;
    if (ratio !== dpr) {
      // Labels are rasterized at the device pixel ratio.
      rasterized += atlas?.rasterized ?? 0;
      atlas?.dispose();
      atlas = null;
      dpr = ratio;
    }
    space.style.height = Math.max(totalHeight, height) + "px";
    pin.style.height = height + "px";
    if (ruler.style.width !== width + "px") ruler.style.width = width + "px";
    // Read after the sizes above are set, which can move the scroll position.
    scrollTop = scroll.scrollTop;
    rulerHeight = ruler.clientHeight;
    place();
    redraw();
  }
  // A vertical scroll moves the rows. The ruler and the pan slider stay as they are.
  function scrolled(): void {
    if (disposed) return;
    scrollTop = scroll.scrollTop;
    place();
    paint();
  }
  // Draws the ruler and clips at the current viewport. A pan or zoom needs no
  // more, and measures no layout.
  function redraw(): void {
    view = viewport(view.startTick, view.pixelsPerSecond, width, duration);
    const max = String(Math.max(0, duration - Math.ceil((width * hz) / view.pixelsPerSecond)));
    const value = String(view.startTick);
    if (pan.max !== max) pan.max = max;
    if (pan.value !== value) pan.value = value;
    paintRuler();
    paint();
  }
  let rasterized = 0;
  function setViewport({
    startTick = view.startTick,
    pixelsPerSecond = view.pixelsPerSecond,
  }: Partial<Viewport>): void {
    view = viewport(startTick, pixelsPerSecond, width, duration);
    if (!disposed) redraw();
  }
  function zoom(x: number, factor: number): void {
    setViewport(zoomAt(view, x, factor, width, duration));
  }
  // One option per clip in project order, kept by clip ID.
  const clipOptions = new Map<string, HTMLOptionElement>();
  function updateNavigator(): void {
    clipOptions.clear();
    const options = doc.createDocumentFragment();
    options.append(new win.Option("Select clip", ""));
    for (const c of snapshot.clips) {
      const option = new win.Option(c.name ?? c.id, c.id);
      clipOptions.set(c.id, option);
      options.append(option);
    }
    navigator.replaceChildren(options);
    navigator.value = editor.session.getSelection().at(-1) ?? "";
  }
  // Updates only the options of patched clips. A new clip takes its place in
  // the project's clip order, before the next clip that was already listed.
  function patchNavigator(change: EditCommit): void {
    const patches = change.clipPatches;
    if (patches.length > 64) return updateNavigator();
    const added: string[] = [];
    let removed = false;
    for (const p of patches) {
      const option = clipOptions.get(p.id);
      if (!p.after) {
        option?.remove();
        clipOptions.delete(p.id);
        removed = true;
      } else if (!option) {
        clipOptions.set(p.id, new win.Option(p.after.name ?? p.after.id, p.id));
        added.push(p.id);
      } else if (option.text !== (p.after.name ?? p.after.id))
        option.text = p.after.name ?? p.after.id;
    }
    if (added.length) {
      const fresh = new Set(added);
      const at = new Map<string, number>();
      snapshot.clips.forEach((c, i) => fresh.has(c.id) && at.set(c.id, i));
      added.sort((a, b) => (at.get(a) ?? 0) - (at.get(b) ?? 0));
      for (const id of added) {
        let next: HTMLOptionElement | null = null;
        for (let i = (at.get(id) ?? 0) + 1; i < snapshot.clips.length && !next; i++) {
          const later = snapshot.clips[i]?.id;
          if (later && !fresh.has(later)) next = clipOptions.get(later) ?? null;
        }
        const option = clipOptions.get(id);
        if (option) navigator.insertBefore(option, next);
      }
    }
    // Only a list that gained or lost an option can show another clip than the
    // selected one. The browser finds a value by walking the options.
    if (added.length || removed) navigator.value = editor.session.getSelection().at(-1) ?? "";
  }
  // Rebuild the marker list, keeping the chosen marker while it exists.
  function updateMarkers(): void {
    const chosen = markerNavigator.value;
    const options = doc.createDocumentFragment();
    options.append(new win.Option("Select marker", ""));
    for (const m of snapshot.markers ?? [])
      options.append(new win.Option((m.label ?? m.id) + " · " + formatTime(m.start), m.id));
    markerNavigator.replaceChildren(options);
    chooseMarker(chosen);
  }
  function chooseMarker(id: string): void {
    const marker = snapshot.markers?.find((m) => m.id === id);
    markerNavigator.value = marker ? marker.id : "";
    markerLabel.value = marker?.label ?? "";
    markerRename.disabled = markerRemove.disabled = !marker;
  }
  function playhead(): Tick {
    return transport.snapshot().requestedTick ?? transport.snapshot().presentedTick;
  }
  function reportEdit(result: EditResult): EditResult {
    message.textContent = result.ok ? "" : result.reason;
    return result;
  }
  function addMarker(): void {
    const count = snapshot.markers?.length ?? 0;
    const result = reportEdit(
      editor.dispatch(
        commands.addMarker({
          start: clampTick(playhead(), duration),
          label: "Marker " + (count + 1),
        }),
      ),
    );
    if (result.ok && !result.unchanged) chooseMarker(result.markerPatches[0]?.id ?? "");
  }
  // `[` and `]` step between markers; `M` adds one at the playhead.
  function markerKey(e: KeyboardEvent): void {
    if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "m") {
      e.preventDefault();
      addMarker();
    } else if (key === "]" || key === "[") {
      e.preventDefault();
      const t = playhead();
      const target = key === "]" ? read.nextMarker(t) : read.previousMarker(t);
      if (target) {
        chooseMarker(target.id);
        seek(target.start);
      }
    }
  }
  function selected(ids: readonly string[]): void {
    navigator.value = ids.at(-1) ?? "";
    paintOverlay();
  }
  function point(event: PointerEvent | WheelEvent): PointerInfo {
    const rect = surface.getBoundingClientRect();
    const x = event.clientX - rect.left,
      y = event.clientY - rect.top;
    const top = y + scrollTop;
    const row = visible.find((r) => y >= 0 && y < height && r.top <= top && top < r.top + r.height);
    return { x, width, tick: tickAt(x, view), box: hit(boxes, x, y), trackId: row?.track.id };
  }
  function seek(tick: Tick): void {
    Promise.resolve(transport.seek(clampTick(tick, duration))).catch((error: unknown) => {
      if (!disposed) message.textContent = errorMessage(error);
    });
  }
  const scrub = (e: PointerEvent): void =>
    seek(tickAt(e.clientX - ruler.getBoundingClientRect().left, view));
  listen(ruler, "pointerdown", (e) => {
    if (e.button === 0) {
      ruler.setPointerCapture(e.pointerId);
      scrub(e);
    }
  });
  listen(ruler, "pointermove", (e) => {
    if (ruler.hasPointerCapture(e.pointerId)) scrub(e);
  });
  listen(ruler, "keydown", markerKey);
  listen(surface, "keydown", markerKey);
  listen(markerNavigator, "change", () => {
    chooseMarker(markerNavigator.value);
    const marker = snapshot.markers?.find((m) => m.id === markerNavigator.value);
    if (marker) seek(marker.start);
  });
  listen(markerAdd, "click", addMarker);
  listen(markerForm, "submit", (event) => {
    event.preventDefault();
    const markerId = markerNavigator.value;
    if (markerId)
      reportEdit(editor.dispatch(commands.updateMarker({ markerId, label: markerLabel.value })));
  });
  listen(markerRemove, "click", () => {
    const markerId = markerNavigator.value;
    if (markerId) reportEdit(editor.dispatch(commands.removeMarker({ markerId })));
  });
  listen(ruler, "keydown", (e) => {
    const t = transport.snapshot().requestedTick ?? transport.snapshot().presentedTick;
    const step = config.gridTicks || 1;
    const targets = new Map([
      ["Home", 0],
      ["End", duration],
      ["ArrowLeft", t - step],
      ["ArrowRight", t + step],
    ]);
    const target = targets.get(e.key);
    if (target !== undefined) {
      e.preventDefault();
      seek(target);
    }
  });
  const stopEditing = bindEditing({
    root,
    surface,
    editor,
    transport,
    listen,
    point,
    getView: () => view,
    setGhost: (next: readonly Clip[]) => {
      ghosts = next;
      paintOverlay();
    },
    message,
    config,
  });
  // Scrolls a clip's lane into view and, when its start is offscreen, pans to it.
  function hitTest({ x, y }: { readonly x: number; readonly y: number }): TimelineHit | null {
    if (disposed || !(x >= 0 && x < width && y >= 0 && y < height)) return null;
    const top = y + scrollTop;
    const row = visible.find((r) => r.top <= top && top < r.top + r.height);
    const box = hit(boxes, x, y);
    return {
      clipId: box?.clip.id ?? null,
      edge: box ? handleAt(box, x, width) : null,
      trackId: row?.track.id ?? null,
      tick: tickAt(x, view),
    };
  }
  function reveal(clipId: string): boolean {
    const clip = snapshot.clips.find((c) => c.id === clipId);
    const row = clip && rows.find((r) => r.track.id === clip.trackId);
    if (!clip || !row || disposed) return false;
    const y = row.top + rowInset + laneHeight * (row.lanes.get(clip.id) ?? 0);
    if (y < scrollTop || y + laneHeight > scrollTop + height) {
      scroll.scrollTop = y;
      scrolled();
    }
    if (clip.start < view.startTick || clip.start >= tickAt(width, view))
      setViewport({ startTick: clip.start });
    return true;
  }
  listen(navigator, "change", () => {
    const clip = snapshot.clips.find((c) => c.id === navigator.value);
    editor.session.select(clip ? [clip.id] : []);
    if (clip) reveal(clip.id);
  });
  listen(play, "click", async () => {
    try {
      if (transport.snapshot().playing) transport.pause();
      else await transport.play();
    } catch (error) {
      message.textContent = errorMessage(error);
    }
  });
  listen(zoomIn, "click", () => zoom(width / 2, 1.5));
  listen(zoomOut, "click", () => zoom(width / 2, 1 / 1.5));
  listen(pan, "input", () => setViewport({ startTick: Number(pan.value) }));
  listen(scroll, "scroll", () => {
    if (scroll.scrollTop !== scrollTop) scrolled();
  });
  listen(
    root,
    "wheel",
    (e) => {
      const x = Math.max(0, Math.min(width, e.clientX - surface.getBoundingClientRect().left));
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoom(x, Math.exp(-Math.sign(e.deltaY) * 0.18));
      } else if (e.shiftKey || e.deltaX) {
        e.preventDefault();
        setViewport({ startTick: tickAt(e.deltaX || e.deltaY, view) });
      }
    },
    { passive: false },
  );

  const offDoc = editor.subscribe(
    (s: ProjectSnapshot) => s,
    (next: ProjectSnapshot, change: EditCommit) => {
      snapshot = next;
      read = editor.read(next);
      if (change.markerPatches.length) updateMarkers();
      // Tracks drawn differently with no clip patch: a relabeled active take, or a
      // take that now plays other media under a waveform.
      const restyled = new Set(relabeled(change));
      if (waveforms && !change.clipPatches.length)
        for (const r of change.affected.after) restyled.add(r.trackId);
      if (!change.clipPatches.length) {
        if (!change.markerPatches.length) {
          if (restyled.size) paint(restyled);
          return;
        }
        // A marker can change an implicit extent; otherwise only markers repaint.
        const oldDuration = duration;
        duration = sequenceDuration(snapshot);
        if (duration !== oldDuration) return refresh();
        paintRuler();
        if (restyled.size) paint(restyled);
        else paintOverlay();
        return;
      }
      const dirty = new Set([
        ...[...change.affected.before, ...change.affected.after].map((r) => r.trackId),
        ...restyled,
      ]);
      const oldRows = rows,
        oldDuration = duration;
      rebuildRows(dirty);
      patchNavigator(change);
      if (duration !== oldDuration || rows.some((r, i) => r.height !== oldRows[i]?.height))
        return refresh();
      if (change.markerPatches.length) paintRuler();
      visible = visible.flatMap((r) => rows[r.index] ?? []);
      const end = tickAt(width, view);
      const intersects = [...change.affected.before, ...change.affected.after].some(
        (r) => r.start < end && r.end > view.startTick,
      );
      // An offscreen overlap can change a visible clip's lane.
      if (
        intersects ||
        restyled.size > 0 ||
        visible.some(
          (r) =>
            dirty.has(r.track.id) &&
            r.lanes.size &&
            (r.height > laneHeight + 2 * rowInset ||
              (oldRows[r.index]?.height ?? 0) > laneHeight + 2 * rowInset),
        )
      )
        paint(dirty);
    },
  );
  // Tracks whose clips show a relabeled take as their active candidate.
  function relabeled(change: EditCommit): ReadonlySet<string> {
    const ids = new Set(
      change.takePatches
        .filter((p) => p.before && p.after && p.before.label !== p.after.label)
        .map((p) => p.id),
    );
    const tracks = new Set<string>();
    if (!ids.size) return tracks;
    for (const clip of snapshot.clips)
      if (typeof clip.activeTakeId === "string" && ids.has(clip.activeTakeId))
        tracks.add(clip.trackId);
    return tracks;
  }
  const offSelection = editor.session.subscribeSelection(selected);
  const offFrame = transport.subscribe(frame);
  // New peaks repaint only the visible tracks that draw them, after any paint in
  // progress. The first notification paints at once; later ones wait for the
  // next frame and paint together.
  const waveTracks = new Set<string>();
  let waveFrame = 0;
  function waveRepaint(): void {
    waveFrame = 0;
    if (disposed || !waveTracks.size) return;
    const tracks = new Set(waveTracks);
    waveTracks.clear();
    paint(tracks);
    waveFrame = win.requestAnimationFrame(waveRepaint);
  }
  const offWaveforms =
    waveforms?.subscribe?.((assetId) => {
      const repaint = (): void => {
        if (disposed) return;
        for (const track of playing(assetId)) waveTracks.add(track);
        if (waveTracks.size && !waveFrame) waveRepaint();
      };
      if (painting) queueMicrotask(repaint);
      else repaint();
    }) ?? (() => {});
  const resize = new win.ResizeObserver(refresh);
  resize.observe(surface);
  resize.observe(scroll);
  resize.observe(ruler);
  let resolution: MediaQueryList | undefined;
  function onResolution(): void {
    resolution?.removeEventListener("change", onResolution);
    resolution = win.matchMedia("(resolution: " + win.devicePixelRatio + "dppx)");
    resolution.addEventListener("change", onResolution, { once: true, signal: events.signal });
    refresh();
  }
  rebuildRows();
  updateNavigator();
  updateMarkers();
  onResolution();
  const mounted: TimelineView = {
    setViewport,
    getViewport: () => ({ ...view }),
    reveal,
    hitTest,
    getDiagnostics: () => ({
      ...diagnostics,
      previewClipCount: ghosts.length,
      backend: renderers.backend,
      renderer,
      fallback: renderers.fallback,
      staticUploads: renderers.uploads,
      deviceLosses: renderers.losses,
      gpuBytes: renderers.gpuBytes,
      visibleClips: boxes.length,
      labelsRasterized: rasterized + (atlas?.rasterized ?? 0),
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      stopEditing();
      events.abort();
      resize.disconnect();
      offDoc();
      offSelection();
      offFrame();
      offWaveforms();
      if (waveFrame) win.cancelAnimationFrame(waveFrame);
      renderers.dispose();
      atlas?.dispose();
      atlas = null;
      scenes.clear();
      headers.clear();
      root.remove();
    },
  };
  registerReader(mounted, (rect) => renderers.read(rect));
  return mounted;
}

// Shows a rejection's message. Like setting textContent to a missing message,
// anything without a string message clears the status line.
function errorMessage(error: unknown): string {
  const text: unknown =
    typeof error === "object" && error !== null ? Reflect.get(error, "message") : undefined;
  return typeof text === "string" ? text : "";
}
