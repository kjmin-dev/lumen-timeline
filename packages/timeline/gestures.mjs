import { commands, TICKS_PER_SECOND as hz } from "@lumen-timeline/core";

export function handleAt(box, x, width) {
  const inside = Math.min(6, (box.right - box.left) / 2);
  if (box.left >= 0 && box.left < width && Math.abs(x - box.left) <= inside) return "left";
  if (box.right > 0 && box.right <= width && Math.abs(x - box.right) <= inside) return "right";
  return "move";
}

export function snapDelta(
  delta,
  clips,
  edge,
  dest,
  { gridTicks, tolerancePx, neighbors = true, playhead: snapToPlayhead = true },
  view,
  read,
  playhead,
  held,
) {
  if (!delta || !tolerancePx) return { delta };
  const tolerance = (tolerancePx * hz) / view.pixelsPerSecond;
  const excluded = new Set(clips.map((c) => c.id));
  let best;
  function offer(correction, priority, target, origin) {
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
      if (snapToPlayhead) offer(playhead - proposed, 0, playhead, origin);
      const near = neighbors
        ? read.clipsIn(
            {
              start: Math.floor(proposed - tolerance) - 1,
              end: Math.ceil(proposed + tolerance) + 1,
            },
            { trackIds: [dest ?? c.trackId] },
          )
        : [];
      for (const n of near)
        if (!excluded.has(n.id)) {
          for (const t of [n.start, n.start + n.duration]) offer(t - proposed, 1, t, origin);
        }
      if (gridTicks) {
        const target = Math.round(proposed / gridTicks) * gridTicks;
        offer(target - proposed, 2, target, origin);
      }
    }
  }
  return best ? { delta: delta + best.correction, held: best } : { delta };
}

const placementMatches = (a, b) =>
  b &&
  a.trackId === b.trackId &&
  a.start === b.start &&
  a.duration === b.duration &&
  a.contentIn === b.contentIn;
const isEntry = (node) =>
  node?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(node?.tagName);

export function snapConfig(snap) {
  const config = { gridTicks: Math.round(hz / 30), tolerancePx: 5, ...snap };
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
}) {
  const toolbar = root.ownerDocument.createElement("form");
  toolbar.className = "lt-edit";
  toolbar.innerHTML = `<label>Operation <select aria-label="Edit operation"><option value="move">Move</option>
    <option value="left">Trim start</option><option value="right">Trim end</option></select></label>
    <label>Delta (s) <input type="number" value="1" step="any" aria-label="Edit delta in seconds"></label>
    <button type="submit" data-apply>Apply</button><button type="button" data-split>Split at playhead</button>
    <span class="lt-spacer"></span><button type="button" data-undo>Undo</button><button type="button" data-redo>Redo</button>`;
  message.before(toolbar);
  const el = (s) => toolbar.querySelector(s);
  let drag = null,
    composing = false;
  const playhead = () => transport.snapshot().requestedTick ?? transport.snapshot().presentedTick;

  function report(result) {
    message.textContent = result.ok ? "" : result.reason;
    return result;
  }
  function buttons() {
    const count = editor.session.getSelection().length;
    el("[data-apply]").disabled = !count || (el("select").value !== "move" && count !== 1);
    el("[data-split]").disabled = count !== 1;
    el("[data-undo]").disabled = !editor.history.canUndo;
    el("[data-redo]").disabled = !editor.history.canRedo;
  }
  function apply(edge, delta) {
    const ids = editor.session.getSelection();
    if (!ids.length || (edge !== "move" && ids.length !== 1)) return;
    const cmd =
      edge === "move"
        ? commands.moveClips({ clipIds: ids, delta })
        : commands.trimClip({ clipId: ids[0], edge, delta });
    report(editor.dispatch(cmd));
  }
  function split() {
    const ids = editor.session.getSelection();
    if (ids.length !== 1) return;
    const result = report(editor.dispatch(commands.splitClip({ clipId: ids[0], at: playhead() })));
    if (result.ok) editor.session.select(result.createdIds);
  }
  function finish() {
    const old = drag;
    drag = null;
    if (old && surface.hasPointerCapture(old.pointer)) surface.releasePointerCapture(old.pointer);
    setGhost([]);
    surface.style.cursor = "";
  }
  function cancel(reason = "") {
    if (!drag) return;
    finish();
    message.textContent = reason;
  }
  function intent(e, commit) {
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
          config,
          getView(),
          editor.read(current),
          playhead(),
          drag.held,
        );
    drag.held = snapped.held;
    const cmd =
      drag.edge === "move"
        ? commands.moveClips({
            clipIds: drag.clips.map((c) => c.id),
            delta: snapped.delta,
            trackId: dest,
          })
        : commands.trimClip({ clipId: drag.clips[0].id, edge: drag.edge, delta: snapped.delta });
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
  for (const type of ["pointercancel", "lostpointercapture"])
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
    if (drag || e.target.tagName === "BUTTON") return;
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
        apply("move", (key === "arrowleft" ? -1 : 1) * (config.gridTicks || 1));
      }
    }
  });
  listen(el("select"), "change", buttons);
  listen(toolbar, "submit", (event) => {
    event.preventDefault();
    if (composing) return;
    const seconds = el("input").valueAsNumber;
    if (!Number.isFinite(seconds)) {
      message.textContent = "Enter a time delta in seconds.";
      return;
    }
    apply(el("select").value, Math.round(seconds * hz));
  });
  listen(el("[data-split]"), "click", split);
  listen(el("[data-undo]"), "click", () => report(editor.history.undo()));
  listen(el("[data-redo]"), "click", () => report(editor.history.redo()));
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
