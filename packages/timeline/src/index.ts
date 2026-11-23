import { createLabelAtlas } from "./atlas.ts";
import type { LabelAtlas } from "./atlas.ts";
import {
  resolveChrome,
  resolveLayout,
  resolveTheme,
  resolveUiLabels,
  sameAtlasTheme,
  sameChrome,
  sameLayout,
  sameTheme,
  sameUiLabels,
} from "./config.ts";
import { bindEditing, handleAt, snapConfig } from "./gestures.ts";
import type { PointerInfo } from "./gestures.ts";
import { layoutRow, QuadList } from "./layout.ts";
import type { RowQuads } from "./renderer.ts";
import { createRendererHost } from "./renderers.ts";
import { registerReader } from "./probe.ts";
import { createTrackHeaders } from "./track-headers.ts";
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
import type { CaptionWords } from "./captions.ts";
import { element } from "./dom.ts";
import type { Listen } from "./dom.ts";
import type { Box, Packed, Viewport } from "./geometry.ts";
import type {
  ClipStyleFn,
  OverlayRenderer,
  SnapConfig,
  TimelineDiagnostics,
  TimelineEvents,
  TimelineHit,
  TimelineOptions,
  TimelineUpdate,
  TimelineView,
  TrackHeaderRenderer,
  TransportState,
  WaveformProvider,
} from "./types.ts";
export type * from "./types.ts";
export type { Viewport } from "./geometry.ts";
import {
  formatTime as defaultFormatTime,
  hit,
  pack,
  pixelAt,
  rectangle,
  tickAt,
  viewport,
  zoomAt,
} from "./geometry.ts";

const maxTick = 7 * 86400 * hz;
const clampTick = (tick: Tick, end: Tick): Tick => Math.max(0, Math.min(end, tick));
const defaultPixelsPerSecond = 48;

const sameSnap = (a: SnapConfig, b: SnapConfig): boolean =>
  a.gridTicks === b.gridTicks &&
  a.tolerancePx === b.tolerancePx &&
  a.neighbors === b.neighbors &&
  a.playhead === b.playhead &&
  a.markers === b.markers;
const sameWords = (a: CaptionWords, b: CaptionWords): boolean =>
  a.take === b.take && a.takes === b.takes && a.none === b.none;

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

export function mountTimeline(container: HTMLElement, options: TimelineOptions): TimelineView {
  const { editor, transport, renderer = "auto" } = options;
  const { pixelsPerSecond = defaultPixelsPerSecond, startTick = 0 } = options;
  let config = snapConfig(options.snap);
  let words = captionWords(options.labels);
  let uiLabels = resolveUiLabels(options.labels);
  let chrome = resolveChrome(options.chrome);
  let theme = resolveTheme(options.theme);
  let layoutConfig = resolveLayout(options.layout);
  let readOnly = options.readOnly ?? false;
  let shortcuts = options.shortcuts ?? true;
  let customFormatTime: ((tick: Tick) => string) | undefined = options.formatTime;
  let customGridSpacing: ((pps: number) => Tick) | undefined = options.gridSpacing;
  let clipStyle: ClipStyleFn | undefined = options.clipStyle;
  let renderTrackHeader: TrackHeaderRenderer | undefined = options.renderTrackHeader;
  let renderOverlay: OverlayRenderer | undefined = options.renderOverlay;
  let hostEvents: TimelineEvents | undefined = options.events;
  let waveforms: WaveformProvider | undefined = options.waveforms;
  // The viewport values the host last gave, which `update` compares against.
  let given = { pixelsPerSecond: options.pixelsPerSecond, startTick: options.startTick };
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
      <label data-clip-nav><span data-clip-label>Clip</span> <select aria-label="Clip navigator"></select></label>
      <label data-marker-nav><span data-marker-label>Marker</span> <select aria-label="Marker navigator"></select></label>
      <button type="button" data-marker-add>Add marker</button>
      <span class="lt-spacer"></span><button type="button" data-out aria-label="Zoom out">−</button>
      <button type="button" data-in aria-label="Zoom in">+</button>
    </div>
    <div class="lt-grid" data-ruler-row><div class="lt-track-title">Tracks</div>
      <canvas class="lt-ruler" tabindex="0" role="slider" aria-label="Seek" aria-valuemin="0"></canvas></div>
    <div class="lt-scroll"><div class="lt-space"><div class="lt-pin lt-grid">
      <div class="lt-headers"></div><div class="lt-surface" tabindex="0" role="group" aria-label="Timeline clips">
        <canvas class="lt-clips" aria-hidden="true"></canvas><canvas class="lt-selection" aria-hidden="true"></canvas>
        <div class="lt-head" hidden></div>
      </div></div></div></div>
    <label class="lt-pan"><span data-scroll-label>Scroll</span> <input type="range" aria-label="Timeline scroll" min="0" step="1" value="0"></label>
    <form class="lt-marker-edit"><label><span data-marker-input-label>Marker label</span> <input type="text" aria-label="Marker label"></label>
      <button type="submit" data-marker-rename>Rename marker</button>
      <button type="button" data-marker-remove>Remove marker</button></form>
    <div class="lt-message" role="status"></div>`;
  container.append(root);
  const tools = element(root, ".lt-tools", "div"),
    rulerRow = element(root, "[data-ruler-row]", "div"),
    trackTitle = element(root, ".lt-track-title", "div"),
    clipNavWrap = element(root, "[data-clip-nav]", "label"),
    markerNavWrap = element(root, "[data-marker-nav]", "label"),
    panWrap = element(root, ".lt-pan", "label");
  const clipLabelEl = element(root, "[data-clip-label]", "span"),
    markerLabelHead = element(root, "[data-marker-label]", "span"),
    scrollLabelEl = element(root, "[data-scroll-label]", "span"),
    markerInputLabelEl = element(root, "[data-marker-input-label]", "span");
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
  let prevTracks = snapshot.tracks;
  let read = editor.read(snapshot);
  let view = viewport(startTick, pixelsPerSecond, 0, maxTick);
  let lastNotifiedView: Viewport | null = null;
  let mountedReady = false;
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

  const formatTick = (tick: Tick): string =>
    customFormatTime ? customFormatTime(tick) : defaultFormatTime(tick);

  function applyChrome(): void {
    tools.hidden = !chrome.toolbar;
    clipNavWrap.hidden = !chrome.clipNavigator;
    markerNavWrap.hidden = !chrome.markerNavigator;
    markerAdd.hidden = !chrome.markerNavigator;
    rulerRow.hidden = !chrome.ruler;
    panWrap.hidden = !chrome.scrollBar;
    markerForm.hidden = !chrome.markerEditor;
    message.hidden = !chrome.status;
    root.classList.toggle("lt-no-headers", !chrome.trackHeaders);
  }

  function applyUiLabels(): void {
    trackTitle.textContent = uiLabels.tracks;
    clipLabelEl.textContent = uiLabels.clip;
    markerLabelHead.textContent = uiLabels.marker;
    markerAdd.textContent = uiLabels.addMarker;
    scrollLabelEl.textContent = uiLabels.scroll;
    markerInputLabelEl.textContent = uiLabels.markerLabel;
    markerRename.textContent = uiLabels.renameMarker;
    markerRemove.textContent = uiLabels.removeMarker;
    zoomIn.setAttribute("aria-label", uiLabels.zoomIn);
    zoomOut.setAttribute("aria-label", uiLabels.zoomOut);
    const firstClip = navigator.options[0];
    if (firstClip && firstClip.value === "") firstClip.textContent = uiLabels.selectClip;
    const firstMarker = markerNavigator.options[0];
    if (firstMarker && firstMarker.value === "") firstMarker.textContent = uiLabels.selectMarker;
  }

  function syncMarkerControls(): void {
    const marker = snapshot.markers?.find((m) => m.id === markerNavigator.value);
    markerAdd.disabled = readOnly;
    markerLabel.disabled = readOnly || !marker;
    markerRename.disabled = readOnly || !marker;
    markerRemove.disabled = readOnly || !marker;
  }

  function rebuildRows(dirty?: ReadonlySet<string>): void {
    totalHeight = 0;
    const { laneHeight, rowInset } = layoutConfig;
    rows = snapshot.tracks.map((track, index) => {
      let p = packed.get(track.id);
      if (!p || dirty?.has(track.id)) {
        const clips = read.clipsIn({ start: 0, end: maxTick }, { trackIds: [track.id] });
        p = pack(clips, laneHeight, rowInset);
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
  function gridLines(callback: (x: number, tick: Tick) => void): void {
    if (customGridSpacing) {
      const stepTicks = Math.max(1, Math.round(customGridSpacing(view.pixelsPerSecond)));
      const first = Math.ceil(view.startTick / stepTicks);
      for (let n = first; ; n++) {
        const tick = n * stepTicks;
        const x = pixelAt(tick, view);
        if (x > width) break;
        callback(x, tick);
      }
      return;
    }
    const step = spacing();
    const first = Math.ceil(view.startTick / hz / step);
    for (let n = first; ; n++) {
      const tick = Math.round(n * step * hz);
      const x = pixelAt(tick, view);
      if (x > width) break;
      callback(x, tick);
    }
  }
  function paintRuler(): void {
    if (!chrome.ruler) return;
    const h = rulerHeight;
    const ctx = setup(rulerContext, width, h);
    ctx.clearRect(0, 0, width, h);
    ctx.fillStyle = theme.rulerText;
    ctx.font = "11px ui-monospace, monospace";
    gridLines((x, tick) => {
      ctx.fillRect(Math.round(x), h - 6, 1, 6);
      const label = customFormatTime
        ? customFormatTime(tick)
        : defaultFormatTime(tick).replace(/\.000$/, "");
      ctx.fillText(label, x + 4, 17);
    });
    ctx.font = "600 10px system-ui, sans-serif";
    for (const marker of visibleMarkers()) {
      const color = marker.color ?? theme.marker;
      const text = marker.label ?? marker.id;
      const x = Math.round(pixelAt(marker.start, view));
      if (marker.duration !== undefined && marker.duration > 0) {
        const x0 = Math.max(0, x);
        const x1 = Math.min(width, Math.round(pixelAt(marker.start + marker.duration, view)));
        if (x1 > x0) {
          ctx.fillStyle = color + "33";
          ctx.fillRect(x0, 0, x1 - x0, h);
          ctx.fillStyle = color;
          ctx.fillRect(x0, 0, 2, h);
          if (x1 < width) ctx.fillRect(x1 - 1, 0, 1, h);
          ctx.fillStyle = theme.rulerMarkerBackground;
          ctx.fillRect(x0 + 3, h - 13, Math.min(x1 - x0 - 4, ctx.measureText(text).width + 6), 12);
          ctx.fillStyle = color;
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0 + 2, 0, Math.max(0, x1 - x0 - 4), h);
          ctx.clip();
          ctx.fillText(text, x0 + 6, h - 4);
          ctx.restore();
        }
        continue;
      }
      ctx.fillStyle = color;
      ctx.fillRect(x, 0, 1, h);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + 7, 0);
      ctx.lineTo(x, 7);
      ctx.fill();
      // A backing keeps the label legible over tick marks below the time labels.
      ctx.fillStyle = theme.rulerMarkerBackground;
      ctx.fillRect(x + 2, h - 13, ctx.measureText(text).width + 6, 12);
      ctx.fillStyle = color;
      ctx.fillText(text, x + 5, h - 4);
    }
    ruler.setAttribute("aria-valuemax", String(duration / hz));
  }
  function visibleMarkers(): readonly Marker[] {
    return read.regionsIn({
      start: view.startTick,
      end: Math.min(maxTick, tickAt(width, view) + 1),
    });
  }
  function paintOverlay(): void {
    const ctx = setup(overlayContext, width, height);
    ctx.clearRect(0, 0, width, height);
    const selectionIds = editor.session.getSelection();
    const selected = new Set(selectionIds);
    for (const b of boxes)
      if (selected.has(b.clip.id)) {
        ctx.strokeStyle = theme.selectionStroke;
        ctx.lineWidth = 2;
        ctx.strokeRect(b.x + 1, b.y + 1, Math.max(0, b.endX - b.x - 2), b.height - 2);
        if (!readOnly) {
          ctx.fillStyle = theme.handleFill;
          for (const x of [b.left, b.right - 3]) {
            if (x >= 0 && x + 3 <= width) ctx.fillRect(x, b.y + 6, 3, b.height - 12);
          }
        }
      }
    ctx.save();
    ctx.setLineDash([5, 3]);
    ctx.lineWidth = 2;
    const { laneHeight, rowInset } = layoutConfig;
    for (const clip of ghosts) {
      const row = visible.find((r) => r.track.id === clip.trackId);
      if (!row) continue;
      const b = rectangle(
        clip,
        row.lanes.get(clip.id) ?? 0,
        row.top - scrollTop,
        view,
        width,
        laneHeight,
        rowInset,
      );
      if (b.endX <= b.x) continue;
      ctx.fillStyle = theme.ghostFill;
      ctx.fillRect(b.x, b.y, b.endX - b.x, b.height);
      ctx.strokeStyle = theme.ghostStroke;
      ctx.strokeRect(b.x + 1, b.y + 1, Math.max(0, b.endX - b.x - 2), b.height - 2);
    }
    ctx.restore();
    // Markers belong to the document and stay put during playback.
    for (const marker of visibleMarkers()) {
      const color = marker.color ?? theme.marker;
      if (marker.duration !== undefined && marker.duration > 0) {
        const x0 = Math.max(0, Math.round(pixelAt(marker.start, view)));
        const x1 = Math.min(width, Math.round(pixelAt(marker.start + marker.duration, view)));
        if (x1 > x0) {
          ctx.fillStyle = color + "22";
          ctx.fillRect(x0, 0, x1 - x0, height);
          ctx.fillStyle = color + "88";
          ctx.fillRect(x0, 0, 1, height);
          if (x1 < width) ctx.fillRect(x1 - 1, 0, 1, height);
        }
      } else {
        ctx.fillStyle = color + "88";
        ctx.fillRect(Math.round(pixelAt(marker.start, view)), 0, 1, height);
      }
    }
    if (renderOverlay) {
      let byClip: Map<string, Box<Clip>> | undefined;
      ctx.save();
      renderOverlay({
        ctx,
        width,
        height,
        scrollTop,
        view: { ...view },
        snapshot,
        selection: selectionIds,
        pixelAt: (tick) => pixelAt(tick, view),
        tickAt: (x) => tickAt(x, view),
        boxOf: (clipId) => {
          byClip ??= new Map(boxes.map((b) => [b.clip.id, b]));
          return byClip.get(clipId);
        },
      });
      ctx.restore();
    }
    diagnostics.overlayPaints++;
  }
  function frame(state: TransportState = transport.snapshot()): void {
    const t = state.requestedTick ?? state.presentedTick;
    const x = pixelAt(t, view);
    head.hidden = x < 0 || x >= width;
    head.style.transform = "translateX(" + x + "px)";
    const stamp = formatTick(t),
      label = state.playing ? uiLabels.pause : uiLabels.play;
    if (time.textContent !== stamp) time.textContent = stamp;
    if (play.textContent !== label) play.textContent = label;
    ruler.setAttribute("aria-valuenow", String(t / hz));
    ruler.setAttribute("aria-valuetext", stamp);
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
    if (!atlas)
      atlas = createLabelAtlas(doc, dpr, 2048, {
        nameFont: theme.nameFont,
        captionFont: theme.captionFont,
        nameColor: theme.labelColor,
      });
    return atlas;
  }
  function paintClips(dirty?: ReadonlySet<string>): void {
    const range = { start: view.startTick, end: Math.min(maxTick, tickAt(width, view) + 1) };
    const grid: number[] = [];
    gridLines((x) => grid.push(x));
    const atlas = labelAtlas();
    const provider = waveforms;
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
          peaks: provider && ((request) => provider.peaks(request)),
          label: (name, caption, color) => atlas.slot(name, caption, color),
          assets,
          laneHeight: layoutConfig.laneHeight,
          rowInset: layoutConfig.rowInset,
          theme,
          clipStyle,
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
  function place(): void {
    visible = rows.filter(
      (row) => row.top < scrollTop + height && row.top + row.height > scrollTop,
    );
    trackHeaders.place(visible);
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
    if (chrome.ruler && ruler.style.width !== width + "px") ruler.style.width = width + "px";
    // Read after the sizes above are set, which can move the scroll position.
    scrollTop = scroll.scrollTop;
    rulerHeight = chrome.ruler ? ruler.clientHeight : 0;
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
  function notifyViewport(): void {
    if (!mountedReady) {
      lastNotifiedView = { ...view };
      return;
    }
    if (
      lastNotifiedView &&
      lastNotifiedView.startTick === view.startTick &&
      lastNotifiedView.pixelsPerSecond === view.pixelsPerSecond
    )
      return;
    lastNotifiedView = { ...view };
    hostEvents?.onViewportChange?.({ ...view });
  }
  // Draws the ruler and clips at the current viewport. A pan or zoom needs no
  // more, and measures no layout.
  function redraw(): void {
    view = viewport(view.startTick, view.pixelsPerSecond, width, duration);
    if (chrome.scrollBar) {
      const max = String(Math.max(0, duration - Math.ceil((width * hz) / view.pixelsPerSecond)));
      const value = String(view.startTick);
      if (pan.max !== max) pan.max = max;
      if (pan.value !== value) pan.value = value;
    }
    paintRuler();
    paint();
    notifyViewport();
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
  const clipNavActive = (): boolean => chrome.toolbar && chrome.clipNavigator;
  function updateNavigator(): void {
    clipOptions.clear();
    if (!clipNavActive()) {
      navigator.replaceChildren();
      return;
    }
    const options = doc.createDocumentFragment();
    options.append(new win.Option(uiLabels.selectClip, ""));
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
    if (!clipNavActive()) return;
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
    options.append(new win.Option(uiLabels.selectMarker, ""));
    for (const m of snapshot.markers ?? [])
      options.append(new win.Option((m.label ?? m.id) + " · " + formatTick(m.start), m.id));
    markerNavigator.replaceChildren(options);
    chooseMarker(chosen);
  }
  function chooseMarker(id: string): void {
    const marker = snapshot.markers?.find((m) => m.id === id);
    markerNavigator.value = marker ? marker.id : "";
    markerLabel.value = marker?.label ?? "";
    syncMarkerControls();
  }
  function playhead(): Tick {
    return transport.snapshot().requestedTick ?? transport.snapshot().presentedTick;
  }
  function reportEdit(result: EditResult): EditResult {
    message.textContent = result.ok ? "" : result.reason;
    return result;
  }
  function addMarker(): void {
    if (readOnly) return;
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
    if (!shortcuts || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "m") {
      if (readOnly) return;
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
    if (clipNavActive()) navigator.value = ids.at(-1) ?? "";
    paintOverlay();
  }
  function point(event: MouseEvent | PointerEvent | WheelEvent): PointerInfo {
    const rect = surface.getBoundingClientRect();
    const x = event.clientX - rect.left,
      y = event.clientY - rect.top;
    const top = y + scrollTop;
    const row = visible.find((r) => y >= 0 && y < height && r.top <= top && top < r.top + r.height);
    return { x, y, width, tick: tickAt(x, view), box: hit(boxes, x, y), trackId: row?.track.id };
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
    if (readOnly) return;
    const markerId = markerNavigator.value;
    if (markerId)
      reportEdit(editor.dispatch(commands.updateMarker({ markerId, label: markerLabel.value })));
  });
  listen(markerRemove, "click", () => {
    if (readOnly) return;
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
  const trackHeaders = createTrackHeaders({
    root,
    list: headerList,
    pin,
    scroll,
    editor,
    signal: events.signal,
    rows: () => rows,
    viewportHeight: () => height,
    scrollTop: () => scrollTop,
    accent: (row) =>
      row.track.color ?? theme.palette[row.index % theme.palette.length]?.stripeHex ?? "#87d6cb",
    chrome: () => chrome,
    readOnly: () => readOnly,
    shortcuts: () => shortcuts,
    uiLabels: () => uiLabels,
    renderer: () => renderTrackHeader,
    scrollToTrack: (trackId) => {
      scrollToTrack(trackId);
    },
    report: reportEdit,
  });
  const editing = bindEditing({
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
    config: () => config,
    readOnly: () => readOnly,
    shortcuts: () => shortcuts,
    chrome: () => chrome,
    uiLabels: () => uiLabels,
    events: () => hostEvents,
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
    const { laneHeight, rowInset } = layoutConfig;
    const y = row.top + rowInset + laneHeight * (row.lanes.get(clip.id) ?? 0);
    if (y < scrollTop || y + laneHeight > scrollTop + height) {
      scroll.scrollTop = y;
      scrolled();
    }
    if (clip.start < view.startTick || clip.start >= tickAt(width, view))
      setViewport({ startTick: clip.start });
    return true;
  }
  function scrollToTrack(trackId: string): boolean {
    const row = rows.find((r) => r.track.id === trackId);
    if (!row || disposed) return false;
    if (row.top < scrollTop || row.top + row.height > scrollTop + height) {
      scroll.scrollTop = row.top;
      scrolled();
    }
    return true;
  }
  function repaint(scope: "all" | "overlay" = "all"): void {
    if (disposed) return;
    if (scope === "overlay") paintOverlay();
    else redraw();
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
      const tracksChanged = change.trackPatches.length > 0 || next.tracks !== prevTracks;
      snapshot = next;
      prevTracks = next.tracks;
      read = editor.read(next);
      if (change.markerPatches.length) updateMarkers();
      if (tracksChanged) {
        const liveTracks = new Set(next.tracks.map((t) => t.id));
        for (const id of packed.keys()) if (!liveTracks.has(id)) packed.delete(id);
        for (const patch of change.trackPatches) packed.delete(patch.id);
        scenes.clear();
        rebuildRows();
        if (change.clipPatches.length) patchNavigator(change);
        return refresh();
      }
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
      const { laneHeight, rowInset } = layoutConfig;
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
  function watchWaveforms(provider: WaveformProvider | undefined): () => unknown {
    return (
      provider?.subscribe?.((assetId) => {
        const repaintWave = (): void => {
          if (disposed || provider !== waveforms) return;
          for (const track of playing(assetId)) waveTracks.add(track);
          if (waveTracks.size && !waveFrame) waveRepaint();
        };
        if (painting) queueMicrotask(repaintWave);
        else repaintWave();
      }) ?? (() => {})
    );
  }
  let offWaveforms = watchWaveforms(waveforms);
  function update(next: TimelineUpdate): void {
    if (disposed) return;
    const has = (key: keyof TimelineUpdate): boolean => Object.hasOwn(next, key);
    // Validate everything before changing anything.
    const nextConfig = has("snap") ? snapConfig(next.snap) : config;
    const nextLayout = has("layout") ? resolveLayout(next.layout) : layoutConfig;
    const nextWords = has("labels") ? captionWords(next.labels) : words;
    const nextUiLabels = has("labels") ? resolveUiLabels(next.labels) : uiLabels;
    const nextChrome = has("chrome") ? resolveChrome(next.chrome) : chrome;
    const nextTheme = has("theme") ? resolveTheme(next.theme) : theme;
    const nextReadOnly = has("readOnly") ? (next.readOnly ?? false) : readOnly;
    const nextShortcuts = has("shortcuts") ? (next.shortcuts ?? true) : shortcuts;
    const nextFormatTime = has("formatTime") ? next.formatTime : customFormatTime;
    const nextGridSpacing = has("gridSpacing") ? next.gridSpacing : customGridSpacing;
    const nextClipStyle = has("clipStyle") ? next.clipStyle : clipStyle;
    const nextHeaderRenderer = has("renderTrackHeader")
      ? next.renderTrackHeader
      : renderTrackHeader;
    const nextOverlayRenderer = has("renderOverlay") ? next.renderOverlay : renderOverlay;
    const nextEvents = has("events") ? next.events : hostEvents;
    const nextWaveforms = has("waveforms") ? next.waveforms : waveforms;

    const moved: { pixelsPerSecond?: number; startTick?: Tick } = {};
    if (has("pixelsPerSecond") && next.pixelsPerSecond !== given.pixelsPerSecond)
      moved.pixelsPerSecond = next.pixelsPerSecond ?? defaultPixelsPerSecond;
    if (has("startTick") && next.startTick !== given.startTick)
      moved.startTick = next.startTick ?? 0;
    given = {
      pixelsPerSecond: has("pixelsPerSecond") ? next.pixelsPerSecond : given.pixelsPerSecond,
      startTick: has("startTick") ? next.startTick : given.startTick,
    };

    if (!sameSnap(nextConfig, config)) config = nextConfig;
    const shortcutsChanged = nextShortcuts !== shortcuts;
    shortcuts = nextShortcuts;
    hostEvents = nextEvents;

    let needRefresh = false;
    let needRedraw = false;
    let needClips = false;
    let needOverlay = false;
    let needPlace = false;
    let needEditingSync = false;

    if (!sameChrome(nextChrome, chrome)) {
      const wasClipNav = clipNavActive();
      const hadRuler = chrome.ruler;
      const hadHeaders = chrome.trackHeaders;
      chrome = nextChrome;
      applyChrome();
      if (clipNavActive() !== wasClipNav) updateNavigator();
      if (chrome.ruler !== hadRuler || chrome.trackHeaders !== hadHeaders) needRefresh = true;
      needEditingSync = true;
    }
    if (!sameUiLabels(nextUiLabels, uiLabels)) {
      uiLabels = nextUiLabels;
      applyUiLabels();
      frame();
      needEditingSync = true;
    }
    if (nextReadOnly !== readOnly) {
      readOnly = nextReadOnly;
      syncMarkerControls();
      needOverlay = true;
      needEditingSync = true;
    }
    if (!sameLayout(nextLayout, layoutConfig)) {
      layoutConfig = nextLayout;
      packed.clear();
      rebuildRows();
      needRefresh = true;
    }
    if (!sameTheme(nextTheme, theme)) {
      if (!sameAtlasTheme(nextTheme, theme)) {
        rasterized += atlas?.rasterized ?? 0;
        atlas?.dispose();
        atlas = null;
      }
      theme = nextTheme;
      needPlace = true;
      needRedraw = true;
    }
    if (nextFormatTime !== customFormatTime) {
      customFormatTime = nextFormatTime;
      updateMarkers();
      frame();
      needRedraw = true;
    }
    if (nextGridSpacing !== customGridSpacing) {
      customGridSpacing = nextGridSpacing;
      needRedraw = true;
    }
    if (!sameWords(nextWords, words)) {
      words = nextWords;
      needClips = true;
    }
    if (nextClipStyle !== clipStyle) {
      clipStyle = nextClipStyle;
      needClips = true;
    }
    if (nextHeaderRenderer !== renderTrackHeader) {
      renderTrackHeader = nextHeaderRenderer;
      needPlace = true;
    }
    if (nextOverlayRenderer !== renderOverlay) {
      renderOverlay = nextOverlayRenderer;
      needOverlay = true;
    }
    if (nextWaveforms !== waveforms) {
      offWaveforms();
      waveforms = nextWaveforms;
      offWaveforms = watchWaveforms(waveforms);
      waveTracks.clear();
      needClips = true;
    }

    if (needEditingSync) editing.sync();
    if (needEditingSync || shortcutsChanged) {
      trackHeaders.sync();
      needPlace = true;
    }
    if (moved.pixelsPerSecond !== undefined || moved.startTick !== undefined) {
      view = viewport(
        moved.startTick ?? view.startTick,
        moved.pixelsPerSecond ?? view.pixelsPerSecond,
        width,
        duration,
      );
      needRedraw = true;
    }
    if (needRefresh) refresh();
    else {
      if (needPlace) place();
      if (needRedraw) redraw();
      else if (needClips) paint();
      else if (needOverlay) paintOverlay();
    }
  }
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
  applyChrome();
  applyUiLabels();
  trackHeaders.sync();
  rebuildRows();
  updateNavigator();
  updateMarkers();
  onResolution();
  mountedReady = true;
  const mounted: TimelineView = {
    update,
    setViewport,
    getViewport: () => ({ ...view }),
    reveal,
    scrollToTrack,
    renameTrack: (trackId) => !disposed && trackHeaders.rename(trackId),
    repaint,
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
      editing.dispose();
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
      trackHeaders.dispose();
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
