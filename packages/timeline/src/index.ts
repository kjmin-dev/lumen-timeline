import { bindEditing, snapConfig } from "./gestures.ts";
import type { PointerInfo } from "./gestures.ts";
import { TICKS_PER_SECOND as hz, sequenceDuration } from "@lumen-timeline/core";
import type { Clip, EditCommit, ProjectSnapshot, Tick, Track } from "@lumen-timeline/core";
import { element } from "./dom.ts";
import type { Listen } from "./dom.ts";
import type { Box, Packed, Viewport } from "./geometry.ts";
import type {
  TimelineDiagnostics,
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
const colors = [
  ["#2b5555", "#87d6cb"],
  ["#604332", "#ffb184"],
  ["#464360", "#c8bbff"],
] as const;
const palette = (index: number): readonly [string, string] =>
  colors[index % colors.length] ?? colors[0];
const clampTick = (tick: Tick, end: Tick): Tick => Math.max(0, Math.min(end, tick));

interface Row extends Packed {
  readonly track: Track;
  readonly index: number;
  readonly top: number;
}

/** The view keeps its own counters, read through `getDiagnostics`. */
type Counters = { -readonly [K in keyof TimelineDiagnostics]: TimelineDiagnostics[K] };

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is unavailable");
  return ctx;
}

export function mountTimeline(
  container: HTMLElement,
  { editor, transport, pixelsPerSecond = 48, startTick = 0, snap }: TimelineOptions,
): TimelineView {
  const config = snapConfig(snap);
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
    <label class="lt-pan">Scroll <input type="range" aria-label="Timeline scroll" min="0" value="0"></label>
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
  let rows: Row[] = [],
    visible: Row[] = [],
    boxes: Box<Clip>[] = [],
    ghosts: readonly Clip[] = [];
  const packed = new Map<string, Packed>();
  const diagnostics: Omit<Counters, "previewClipCount"> = {
    layoutBuilds: 0,
    staticPaints: 0,
    overlayPaints: 0,
  };
  let disposed = false;

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

  function setup(canvas: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
    const bw = Math.max(1, Math.round(w * dpr)),
      bh = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    const ctx = context2d(canvas);
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
    ruler.style.width = width + "px";
    const h = ruler.clientHeight;
    const ctx = setup(ruler, width, h);
    ctx.clearRect(0, 0, width, h);
    ctx.fillStyle = "#9da9ad";
    ctx.font = "11px ui-monospace, monospace";
    gridLines((x, seconds) => {
      ctx.fillRect(Math.round(x), h - 6, 1, 6);
      ctx.fillText(formatTime(Math.round(seconds * hz)).replace(/\.000$/, ""), x + 4, 17);
    });
    ruler.setAttribute("aria-valuemax", String(duration / hz));
  }
  function paintOverlay(): void {
    const ctx = setup(overlay, width, height);
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
      const b = rectangle(
        clip,
        row.lanes.get(clip.id) ?? 0,
        row.top - scroll.scrollTop,
        view,
        width,
      );
      if (b.endX <= b.x) continue;
      ctx.fillStyle = "#ffe6ab33";
      ctx.fillRect(b.x, b.y, b.endX - b.x, b.height);
      ctx.strokeStyle = "#ffe6ab";
      ctx.strokeRect(b.x + 1, b.y + 1, Math.max(0, b.endX - b.x - 2), b.height - 2);
    }
    ctx.restore();
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
  function paint(dirty?: ReadonlySet<string>): void {
    const ctx = setup(body, width, height);
    const range = { start: view.startTick, end: Math.min(maxTick, tickAt(width, view) + 1) };
    if (!dirty) {
      ctx.clearRect(0, 0, width, height);
      boxes = [];
    } else boxes = boxes.filter((b) => !dirty.has(b.clip.trackId));
    let count = 0;
    for (const row of visible) {
      if (dirty && !dirty.has(row.track.id)) continue;
      const top = row.top - scroll.scrollTop;
      ctx.clearRect(0, top, width, row.height);
      ctx.fillStyle = row.index % 2 ? "#1b2025" : "#191e22";
      ctx.fillRect(0, top, width, row.height - 1);
      ctx.fillStyle = "#2b3136";
      gridLines((x) => ctx.fillRect(Math.round(x), top, 1, row.height));
      const [fill, stripe] = palette(row.index);
      for (const clip of read.clipsIn(range, { trackIds: [row.track.id] })) {
        // pack() assigned a lane to every clip on this track.
        const b = rectangle(clip, row.lanes.get(clip.id) ?? 0, top, view, width);
        if (b.endX <= b.x) continue;
        boxes.push(b);
        ctx.fillStyle = fill;
        ctx.fillRect(b.x, b.y, b.endX - b.x, b.height);
        ctx.fillStyle = stripe;
        ctx.fillRect(b.x, b.y, b.endX - b.x, 3);
        ctx.save();
        ctx.beginPath();
        ctx.rect(b.x + 3, b.y, Math.max(0, b.endX - b.x - 6), b.height);
        ctx.clip();
        ctx.font = "500 12px system-ui, sans-serif";
        ctx.fillStyle = "#faf6e9";
        ctx.fillText(clip.name ?? clip.id, b.x + 9, b.y + 21);
        ctx.restore();
      }
      count++;
    }
    if (count || !dirty) {
      diagnostics.staticPaints++;
      diagnostics.layoutBuilds++;
    }
    paintOverlay();
    frame();
  }
  function refresh(): void {
    if (disposed) return;
    width = surface.clientWidth;
    height = scroll.clientHeight;
    dpr = win.devicePixelRatio || 1;
    view = viewport(view.startTick, view.pixelsPerSecond, width, duration);
    space.style.height = Math.max(totalHeight, height) + "px";
    pin.style.height = height + "px";
    visible = rows.filter(
      (row) => row.top < scroll.scrollTop + height && row.top + row.height > scroll.scrollTop,
    );
    const headers = visible.map((row) => {
      const label = doc.createElement("div");
      label.className = "lt-label";
      label.style.top = row.top - scroll.scrollTop + "px";
      label.style.height = row.height + "px";
      label.style.setProperty("--track-color", palette(row.index)[1]);
      label.textContent = row.track.name ?? row.track.id;
      return label;
    });
    headerList.replaceChildren(...headers);
    pan.max = String(Math.max(0, duration - Math.ceil((width * hz) / view.pixelsPerSecond)));
    pan.step = "1";
    pan.value = String(view.startTick);
    paintRuler();
    paint();
  }
  function setViewport({
    startTick = view.startTick,
    pixelsPerSecond = view.pixelsPerSecond,
  }: Partial<Viewport>): void {
    view = viewport(startTick, pixelsPerSecond, width, duration);
    refresh();
  }
  function zoom(x: number, factor: number): void {
    setViewport(zoomAt(view, x, factor, width, duration));
  }
  function updateNavigator(): void {
    const options = doc.createDocumentFragment();
    options.append(new win.Option("Select clip", ""));
    for (const c of snapshot.clips) options.append(new win.Option(c.name ?? c.id, c.id));
    navigator.replaceChildren(options);
    navigator.value = editor.session.getSelection().at(-1) ?? "";
  }
  function selected(ids: readonly string[]): void {
    navigator.value = ids.at(-1) ?? "";
    paintOverlay();
  }
  function point(event: PointerEvent | WheelEvent): PointerInfo {
    const rect = surface.getBoundingClientRect();
    const x = event.clientX - rect.left,
      y = event.clientY - rect.top;
    const top = y + scroll.scrollTop;
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
  listen(navigator, "change", () => {
    const clip = snapshot.clips.find((c) => c.id === navigator.value);
    editor.session.select(clip ? [clip.id] : []);
    if (!clip) return;
    const row = rows.find((r) => r.track.id === clip.trackId);
    if (!row) return;
    const y = row.top + rowInset + laneHeight * (row.lanes.get(clip.id) ?? 0);
    if (y < scroll.scrollTop || y + laneHeight > scroll.scrollTop + height) scroll.scrollTop = y;
    if (clip.start < view.startTick || clip.start >= tickAt(width, view))
      setViewport({ startTick: clip.start });
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
  listen(scroll, "scroll", refresh);
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
      if (!change.patches.length) return;
      const dirty = new Set(
        [...change.affected.before, ...change.affected.after].map((r) => r.trackId),
      );
      const oldRows = rows,
        oldDuration = duration;
      rebuildRows(dirty);
      if (change.patches.some((p) => p.before.length !== p.after.length)) updateNavigator();
      if (duration !== oldDuration || rows.some((r, i) => r.height !== oldRows[i]?.height))
        return refresh();
      visible = visible.flatMap((r) => rows[r.index] ?? []);
      const end = tickAt(width, view);
      const intersects = [...change.affected.before, ...change.affected.after].some(
        (r) => r.start < end && r.end > view.startTick,
      );
      // An offscreen overlap can change a visible clip's lane.
      if (
        intersects ||
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
  const offSelection = editor.session.subscribeSelection(selected);
  const offFrame = transport.subscribe(frame);
  const resize = new win.ResizeObserver(refresh);
  resize.observe(surface);
  resize.observe(scroll);
  let resolution: MediaQueryList | undefined;
  function onResolution(): void {
    resolution?.removeEventListener("change", onResolution);
    resolution = win.matchMedia("(resolution: " + win.devicePixelRatio + "dppx)");
    resolution.addEventListener("change", onResolution, { once: true, signal: events.signal });
    refresh();
  }
  rebuildRows();
  updateNavigator();
  onResolution();
  return {
    setViewport,
    getViewport: () => ({ ...view }),
    getDiagnostics: () => ({ ...diagnostics, previewClipCount: ghosts.length }),
    dispose() {
      if (disposed) return;
      disposed = true;
      stopEditing();
      events.abort();
      resize.disconnect();
      offDoc();
      offSelection();
      offFrame();
      root.remove();
    },
  };
}

// Shows a rejection's message. Like setting textContent to a missing message,
// anything without a string message clears the status line.
function errorMessage(error: unknown): string {
  const text: unknown =
    typeof error === "object" && error !== null ? Reflect.get(error, "message") : undefined;
  return typeof text === "string" ? text : "";
}
