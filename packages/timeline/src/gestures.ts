import { commands, TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import type {
  Clip,
  ClipQueryOptions,
  EditResult,
  Editor,
  PreviewResult,
  Tick,
  TickRange,
} from "@lumen-timeline/core";
import { element, tagName } from "./dom.ts";
import type { Listen } from "./dom.ts";
import type { Box, Span, Viewport } from "./geometry.ts";
import type { SnapConfig, SnapOptions, TimelineTransport } from "./types.ts";

export type Edge = "left" | "right" | "move";

/** The candidate a drag snapped to, kept so a held snap resists jitter. */
export interface SnapHold {
  readonly correction: number;
  readonly priority: number;
  readonly target: Tick;
  readonly origin: Tick;
}

/** The read handle members snapping needs. */
export interface SnapRead {
  clipsIn(range: TickRange, options?: ClipQueryOptions): readonly Span[];
  markersIn(range: TickRange): readonly { readonly start: Tick }[];
}

/** A clip being dragged: its placement and track. */
export type DragClip = Span & { readonly trackId: string };

/** Where a pointer event lands in the view. */
export interface PointerInfo {
  readonly x: number;
  readonly width: number;
  readonly tick: Tick;
  readonly box: Box<Clip> | undefined;
  readonly trackId: string | undefined;
}

export interface EditingOptions {
  readonly root: HTMLElement;
  readonly surface: HTMLElement;
  readonly editor: Editor;
  readonly transport: TimelineTransport;
  readonly listen: Listen;
  readonly point: (event: PointerEvent) => PointerInfo;
  readonly getView: () => Viewport;
  readonly setGhost: (clips: readonly Clip[]) => void;
  readonly message: HTMLElement;
  /** The snap settings now, which the host can change while the view is mounted. */
  readonly config: () => SnapConfig;
}

interface Drag {
  readonly pointer: number;
  readonly x: number;
  readonly y: number;
  readonly tick: Tick;
  readonly edge: Edge;
  revision: number;
  readonly anchorTrack: string;
  readonly anchorId: string;
  readonly clips: readonly Clip[];
  moved: boolean;
  held?: SnapHold | null | undefined;
  dest?: string | undefined;
}

export function handleAt(
  box: { readonly left: number; readonly right: number },
  x: number,
  width: number,
): Edge {
  const inside = Math.min(6, (box.right - box.left) / 2);
  if (box.left >= 0 && box.left < width && Math.abs(x - box.left) <= inside) return "left";
  if (box.right > 0 && box.right <= width && Math.abs(x - box.right) <= inside) return "right";
  return "move";
}

export function snapDelta(
  delta: number,
  clips: readonly DragClip[],
  edge: Edge,
  dest: string | undefined,
  {
    gridTicks,
    tolerancePx,
    neighbors = true,
    playhead: snapToPlayhead = true,
    markers = true,
  }: SnapConfig,
  view: Pick<Viewport, "pixelsPerSecond">,
  read: SnapRead,
  playhead: Tick,
  held?: SnapHold | null,
): { readonly delta: number; readonly held?: SnapHold } {
  if (!delta || !tolerancePx) return { delta };
  const tolerance = (tolerancePx * hz) / view.pixelsPerSecond;
  const excluded = new Set(clips.map((c) => c.id));
  let best: SnapHold | undefined;
  function offer(correction: number, priority: number, target: Tick, origin: Tick): void {
    if (Math.abs(correction) > tolerance) return;
    if (
      !best ||
      Math.abs(correction) < Math.abs(best.correction) ||
      (Math.abs(correction) === Math.abs(best.correction) && priority < best.priority)
    ) {
      best = { correction, priority, target, origin };
    }
  }
  for (const c of clips) {
    const edges =
      edge === "left"
        ? [c.start]
        : edge === "right"
          ? [c.start + c.duration]
          : [c.start, c.start + c.duration];
    for (const origin of edges) {
      const proposed = origin + delta;
      if (held?.origin === origin) {
        const target = held.priority === 0 ? playhead : held.target;
        if (Math.abs(target - proposed) <= tolerance * 1.4) return { delta: target - origin, held };
      }
      // Ties prefer the playhead, then a marker, then a clip edge, then the grid.
      if (snapToPlayhead) offer(playhead - proposed, 0, playhead, origin);
      const nearby = {
        start: Math.floor(proposed - tolerance) - 1,
        end: Math.ceil(proposed + tolerance) + 1,
      };
      if (markers) {
        // markersIn is half-open, so include a marker exactly at the window end.
        for (const m of read.markersIn({ start: nearby.start, end: nearby.end + 1 }))
          offer(m.start - proposed, 1, m.start, origin);
      }
      const near = neighbors ? read.clipsIn(nearby, { trackIds: [dest ?? c.trackId] }) : [];
      for (const n of near)
        if (!excluded.has(n.id)) {
          for (const t of [n.start, n.start + n.duration]) offer(t - proposed, 2, t, origin);
        }
      if (gridTicks) {
        const target = Math.round(proposed / gridTicks) * gridTicks;
        offer(target - proposed, 3, target, origin);
      }
    }
  }
  return best ? { delta: delta + best.correction, held: best } : { delta };
}

const placementMatches = (a: Clip, b: Clip | undefined): boolean =>
  b !== undefined &&
  a.trackId === b.trackId &&
  a.start === b.start &&
  a.duration === b.duration &&
  a.contentIn === b.contentIn;
// Text entry keeps its native shortcuts.
function isEntry(node: EventTarget | null): boolean {
  if (!node) return false;
  const tag = tagName(node);
  return (
    Boolean(Reflect.get(node, "isContentEditable")) ||
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT"
  );
}

export function snapConfig(snap?: SnapOptions): SnapConfig {
  const config: SnapConfig = { gridTicks: Math.round(hz / 30), tolerancePx: 5, ...snap };
  if (
    !Number.isSafeInteger(config.gridTicks) ||
    config.gridTicks < 0 ||
    !Number.isFinite(config.tolerancePx) ||
    config.tolerancePx < 0
  )
    throw new RangeError("Invalid snap configuration");
  return config;
}

export function bindEditing({
  root,
  surface,
  editor,
  transport,
  listen,
  point,
  getView,
  setGhost,
  message,
  config,
}: EditingOptions): () => void {
  const toolbar = root.ownerDocument.createElement("form");
  toolbar.className = "lt-edit";
  toolbar.innerHTML = `<label>Operation <select aria-label="Edit operation"><option value="move">Move</option>
    <option value="left">Trim start</option><option value="right">Trim end</option></select></label>
    <label>Delta (s) <input type="number" value="1" step="any" aria-label="Edit delta in seconds"></label>
    <button type="submit" data-apply>Apply</button><button type="button" data-split>Split at playhead</button>
    <span class="lt-spacer"></span><button type="button" data-undo>Undo</button><button type="button" data-redo>Redo</button>`;
  message.before(toolbar);
  const operation = element(toolbar, "select", "select");
  const deltaInput = element(toolbar, "input", "input");
  const applyButton = element(toolbar, "[data-apply]", "button");
  const splitButton = element(toolbar, "[data-split]", "button");
  const undoButton = element(toolbar, "[data-undo]", "button");
  const redoButton = element(toolbar, "[data-redo]", "button");
  let drag: Drag | null = null,
    composing = false;
  const playhead = (): Tick =>
    transport.snapshot().requestedTick ?? transport.snapshot().presentedTick;

  function report<R extends EditResult | PreviewResult>(result: R): R {
    message.textContent = result.ok ? "" : result.reason;
    return result;
  }
  function buttons(): void {
    const count = editor.session.getSelection().length;
    applyButton.disabled = !count || (operation.value !== "move" && count !== 1);
    splitButton.disabled = count !== 1;
    undoButton.disabled = !editor.history.canUndo;
    redoButton.disabled = !editor.history.canRedo;
  }
  function apply(edge: Edge, delta: number): void {
    const ids = editor.session.getSelection();
    const first = ids[0];
    if (first === undefined || (edge !== "move" && ids.length !== 1)) return;
    const cmd =
      edge === "move"
        ? commands.moveClips({ clipIds: ids, delta })
        : commands.trimClip({ clipId: first, edge, delta });
    report(editor.dispatch(cmd));
  }
  function split(): void {
    const ids = editor.session.getSelection();
    const only = ids[0];
    if (ids.length !== 1 || only === undefined) return;
    const result = report(editor.dispatch(commands.splitClip({ clipId: only, at: playhead() })));
    if (result.ok && !result.unchanged) editor.session.select(result.createdIds);
  }
  function finish(): void {
    const old = drag;
    drag = null;
    if (old && surface.hasPointerCapture(old.pointer)) surface.releasePointerCapture(old.pointer);
    setGhost([]);
    surface.style.cursor = "";
  }
  function cancel(reason = ""): void {
    if (!drag) return;
    finish();
    message.textContent = reason;
  }
  function intent(e: PointerEvent, commit: boolean): void {
    if (!drag || drag.pointer !== e.pointerId) return;
    const p = point(e);
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 3) {
      if (commit) {
        const single = drag.anchorId;
        finish();
        editor.session.select([single]);
      }
      return;
    }
    drag.moved = true;
    const current = editor.getSnapshot();
    if (current.revision !== drag.revision) {
      const live = new Map(current.clips.map((c) => [c.id, c]));
      if (drag.clips.some((c) => !placementMatches(c, live.get(c.id))))
        return cancel("A selected clip changed during the drag.");
      drag.revision = current.revision;
      drag.held = null;
    }
    if (drag.edge === "move" && !p.trackId) {
      setGhost([]);
      message.textContent = "Choose a destination track.";
      if (commit) finish();
      return;
    }
    const dest = drag.edge === "move" && p.trackId !== drag.anchorTrack ? p.trackId : undefined;
    const raw = p.tick - drag.tick;
    if (dest !== drag.dest || e.altKey) drag.held = null;
    drag.dest = dest;
    const snapped = e.altKey
      ? { delta: raw }
      : snapDelta(
          raw,
          drag.clips,
          drag.edge,
          dest,
          config(),
          getView(),
          editor.read(current),
          playhead(),
          drag.held,
        );
    drag.held = snapped.held;
    const anchor = drag.clips[0];
    if (anchor === undefined) return;
    const cmd =
      drag.edge === "move"
        ? commands.moveClips({
            clipIds: drag.clips.map((c) => c.id),
            delta: snapped.delta,
            trackId: dest,
          })
        : commands.trimClip({ clipId: anchor.id, edge: drag.edge, delta: snapped.delta });
    const options = { expectedRevision: current.revision };
    const preview = report(editor.preview(cmd, options));
    if (commit) {
      finish();
      if (preview.ok) report(editor.dispatch(cmd, options));
    } else setGhost(preview.ok ? preview.placements : []);
  }

  listen(surface, "pointerdown", (e) => {
    if (e.button !== 0 || drag) return;
    // Shift-click is an editor selection gesture. Native text selection can
    // otherwise start an HTML drag and cancel the next captured pointer.
    e.preventDefault();
    surface.focus({ preventScroll: true });
    const p = point(e),
      b = p.box;
    if (!b) {
      editor.session.select([]);
      return;
    }
    const selected = editor.session.getSelection();
    if (e.shiftKey) {
      editor.session.select(
        selected.includes(b.clip.id)
          ? selected.filter((id) => id !== b.clip.id)
          : [...selected, b.clip.id],
      );
      return;
    }
    const edge = handleAt(b, p.x, p.width);
    if (!selected.includes(b.clip.id) || edge !== "move") editor.session.select([b.clip.id]);
    const ids = new Set(editor.session.getSelection());
    const doc = editor.getSnapshot();
    drag = {
      pointer: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      tick: p.tick,
      edge,
      revision: doc.revision,
      anchorTrack: b.clip.trackId,
      anchorId: b.clip.id,
      clips: doc.clips.filter((c) => ids.has(c.id)),
      moved: false,
    };
    surface.setPointerCapture(e.pointerId);
    surface.style.cursor = edge === "move" ? "grabbing" : "ew-resize";
  });
  listen(surface, "pointermove", (e) => {
    if (drag) {
      intent(e, false);
      return;
    }
    const p = point(e);
    surface.style.cursor = !p.box
      ? ""
      : handleAt(p.box, p.x, p.width) === "move"
        ? "grab"
        : "ew-resize";
  });
  listen(surface, "pointerup", (e) => intent(e, true));
  for (const type of ["pointercancel", "lostpointercapture"] as const)
    listen(surface, type, (e) => {
      if (drag?.pointer === e.pointerId) cancel();
    });
  listen(root, "compositionstart", () => {
    composing = true;
  });
  listen(root, "compositionend", () => {
    composing = false;
  });
  listen(root, "keydown", (e) => {
    if (composing || e.isComposing || e.keyCode === 229 || isEntry(e.target)) return;
    if (e.key === "Escape") {
      cancel();
      return;
    }
    if (drag || tagName(e.target) === "BUTTON") return;
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && (key === "z" || key === "y")) {
      e.preventDefault();
      report(key === "y" || e.shiftKey ? editor.history.redo() : editor.history.undo());
    } else if (e.target === surface) {
      if (key === "s" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        split();
      }
      if (key === "arrowleft" || key === "arrowright") {
        e.preventDefault();
        apply("move", (key === "arrowleft" ? -1 : 1) * (config().gridTicks || 1));
      }
    }
  });
  listen(operation, "change", buttons);
  listen(toolbar, "submit", (event) => {
    event.preventDefault();
    if (composing) return;
    const seconds = deltaInput.valueAsNumber;
    if (!Number.isFinite(seconds)) {
      message.textContent = "Enter a time delta in seconds.";
      return;
    }
    const edge = operation.value;
    if (edge === "move" || edge === "left" || edge === "right")
      apply(edge, Math.round(seconds * hz));
  });
  listen(splitButton, "click", split);
  listen(undoButton, "click", () => report(editor.history.undo()));
  listen(redoButton, "click", () => report(editor.history.redo()));
  const offSelection = editor.session.subscribeSelection(() => {
    cancel();
    buttons();
  });
  const offDoc = editor.subscribe(
    (s) => s.clips,
    (live, change) => {
      if (!drag || !drag.clips.some((c) => change.changedIds.includes(c.id))) return;
      const placements = new Map(live.map((c) => [c.id, c]));
      if (drag.clips.some((c) => !placementMatches(c, placements.get(c.id))))
        cancel("A selected clip changed during the drag.");
    },
  );
  const offHistory = editor.history.subscribe(buttons);
  buttons();
  return () => {
    finish();
    offSelection();
    offDoc();
    offHistory();
  };
}
