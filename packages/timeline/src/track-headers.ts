import { commands } from "@lumen-timeline/core";
import type { EditResult, Editor, Track } from "@lumen-timeline/core";
import type { ResolvedChrome, ResolvedUiLabels } from "./config.ts";
import type { TrackHeaderRenderer } from "./types.ts";

/** A track row as the header list needs it, in content CSS pixels. */
export interface HeaderRow {
  readonly track: Track;
  readonly index: number;
  readonly top: number;
  readonly height: number;
  /** The row's height without the take lanes under it. Defaults to `height`. */
  readonly base?: number | undefined;
}

/** A track's gain as a decibel readout, such as "−6.0 dB". */
export function gainText(gain: number | undefined): string {
  const value = gain ?? 1;
  if (!(value > 0)) return "−∞ dB";
  const db = 20 * Math.log10(value);
  const text = Math.abs(db).toFixed(1);
  return (db < 0 && text !== "0.0" ? "−" : "") + text + " dB";
}

/**
 * The gap between rows that a pointer at content height `y` points to: `0`
 * above the first row's middle, `rows.length` below the last row's middle.
 */
export function dropSlot(
  rows: readonly { readonly top: number; readonly height: number }[],
  y: number,
): number {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row && y < row.top + row.height / 2) return i;
  }
  return rows.length;
}

/**
 * The order after moving the ID at `from` into gap `slot`, where gap `i` lies
 * before `ids[i]`. `null` when the move leaves the order as it is.
 */
export function moveToSlot(
  ids: readonly string[],
  from: number,
  slot: number,
): readonly string[] | null {
  const id = ids[from];
  if (id === undefined) return null;
  const to = Math.max(0, Math.min(ids.length - 1, slot > from ? slot - 1 : slot));
  if (to === from) return null;
  const next = ids.filter((_, index) => index !== from);
  next.splice(to, 0, id);
  return next;
}

/**
 * The name a rename commits, or `undefined` when the draft changes nothing:
 * blank after trimming, or the name the header already shows.
 */
export function renamedTo(draft: string, track: Track): string | undefined {
  const name = draft.trim();
  return name && name !== (track.name ?? track.id) ? name : undefined;
}

/** Replaces `{key}` placeholders that `values` names, and leaves others as written. */
export function fillTemplate(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : whole,
  );
}

const isElement = (node: unknown): node is Element =>
  typeof node === "object" && node !== null && Reflect.get(node, "nodeType") === 1;

/** The marked part of a header under an event target, if any. */
function partOf(target: EventTarget | null, selector: string, header: Element): Element | null {
  const found = isElement(target) ? target.closest(selector) : null;
  return found && header.contains(found) ? found : null;
}

export interface TrackHeaderOptions {
  readonly root: HTMLElement;
  /** The scrolled list the headers live in. */
  readonly list: HTMLElement;
  /** The visible window over the rows, which holds the drag ghost and drop line. */
  readonly pin: HTMLElement;
  readonly scroll: HTMLElement;
  readonly editor: Editor;
  readonly signal: AbortSignal;
  /** Every track row, in order. */
  readonly rows: () => readonly HeaderRow[];
  readonly viewportHeight: () => number;
  readonly scrollTop: () => number;
  readonly accent: (row: HeaderRow) => string;
  readonly chrome: () => ResolvedChrome;
  readonly readOnly: () => boolean;
  readonly shortcuts: () => boolean;
  readonly uiLabels: () => ResolvedUiLabels;
  readonly renderer: () => TrackHeaderRenderer | undefined;
  readonly scrollToTrack: (trackId: string) => void;
  readonly report: (result: EditResult) => void;
}

export interface TrackHeaders {
  /** Shows a header for each visible row and removes the others. */
  place(visible: readonly HeaderRow[]): void;
  /** Applies changed chrome, labels or read-only state; the next `place` draws them. */
  sync(): void;
  /** Starts renaming a track in its header. */
  rename(trackId: string): boolean;
  dispose(): void;
}

interface Header {
  readonly element: HTMLElement;
  key: string;
  track: Track | undefined;
  renderer: TrackHeaderRenderer | undefined;
  color: string;
}

interface Rename {
  readonly trackId: string;
  readonly header: Header;
  readonly input: HTMLInputElement;
  /** The name element the input stands in for. */
  readonly replaced: Element;
}

interface Drag {
  readonly pointerId: number;
  readonly trackId: string;
  readonly name: string;
  readonly color: string;
  readonly x: number;
  readonly y: number;
  /** How far below the header's top the pointer took hold. */
  readonly grab: number;
  readonly height: number;
  clientY: number;
  dragging: boolean;
}

/** Below this distance in CSS pixels a press stays a click or double-click. */
const dragThreshold = 4;
/** The fastest auto-scroll, in CSS pixels per frame. */
const maxScrollStep = 14;

/**
 * The track header list: one virtualized header per visible row, inline rename,
 * and reordering by pointer or keyboard. Headers stay aligned with their rows
 * during a drag; a drop line marks where the track will land.
 */
export function createTrackHeaders(options: TrackHeaderOptions): TrackHeaders {
  const { root, list, pin, scroll, editor, signal } = options;
  const { rows, chrome, readOnly, shortcuts, uiLabels, renderer, report } = options;
  const doc = list.ownerDocument;
  const windowProxy = doc.defaultView;
  if (!windowProxy) throw new Error("Mount the timeline in a document with a window");
  const win = windowProxy;
  // One header per visible row, kept by row index at its place in the scrolled
  // content. A vertical scroll moves the list and changes a header only where a
  // row comes into view or leaves it.
  const headers = new Map<number, Header>();
  const byElement = new Map<Element, Header>();
  // The track whose header takes Tab focus, and follows it through reorders.
  let focusId: string | undefined;
  let renaming: Rename | null = null;
  let drag: Drag | null = null;
  let ghost: HTMLElement | null = null;
  let dropLine: HTMLElement | null = null;
  let scrollStep = 0;
  let scrollFrame = 0;
  let swallowClick = false;
  let refocusing = false;
  const live = doc.createElement("div");
  live.className = "lt-live";
  live.setAttribute("aria-live", "polite");
  live.setAttribute("aria-atomic", "true");
  root.append(live);
  list.setAttribute("role", "list");

  const canRename = (): boolean => {
    const c = chrome();
    return c.trackHeaders && c.trackRename && !readOnly();
  };
  const canReorder = (): boolean => {
    const c = chrome();
    return c.trackHeaders && c.trackReorder && !readOnly();
  };
  const listen = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    fn: (event: HTMLElementEventMap[K]) => void,
    capture = false,
  ): void => target.addEventListener(type, fn, { signal, capture });
  const setAttr = (el: Element, name: string, value: string): void => {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  };

  function headerAt(target: EventTarget | null): Header | undefined {
    for (let node: Element | null = isElement(target) ? target : null; node;) {
      if (node === list) return undefined;
      const header = byElement.get(node);
      if (header) return header;
      node = node.parentElement;
    }
    return undefined;
  }
  function headerOf(trackId: string): Header | undefined {
    for (const header of headers.values()) if (header.track?.id === trackId) return header;
    return undefined;
  }
  const isCustom = (header: Header): boolean => header.renderer !== undefined;

  function shortcutsOf(): string {
    const keys = ["ArrowUp", "ArrowDown", "Home", "End"];
    if (shortcuts() && canRename()) keys.push("Enter", "F2");
    if (shortcuts() && canReorder()) keys.push("Alt+ArrowUp", "Alt+ArrowDown");
    if (shortcuts() && canSwitch()) keys.push("M", "S");
    return keys.join(" ");
  }

  const hasControls = (): boolean => chrome().trackControls;
  const canSwitch = (): boolean => hasControls() && !readOnly();

  // The name is the header's only text: the switches and the gain readout
  // draw theirs from attributes, so the header still reads as the track's name.
  function fillDefault(header: Header, track: Track, name: string): void {
    const make = (tag: "span" | "div" | "button", className: string): HTMLElement => {
      const el = doc.createElement(tag);
      el.className = className;
      return el;
    };
    const grip = make("span", "lt-grip");
    grip.setAttribute("data-lt-track-grip", "");
    grip.setAttribute("aria-hidden", "true");
    grip.title = uiLabels().reorderTrack;
    grip.hidden = !canReorder();
    const dot = make("span", "lt-dot");
    dot.setAttribute("aria-hidden", "true");
    const text = make("span", "lt-name");
    text.setAttribute("data-lt-track-name", "");
    text.textContent = name;
    const line = make("div", "lt-label-line");
    line.append(dot, text);
    const main = make("div", "lt-label-main");
    main.append(line);
    if (hasControls()) {
      const labels = uiLabels();
      if (track.locked === true) {
        const lock = make("span", "lt-lock");
        lock.setAttribute("role", "img");
        lock.setAttribute("aria-label", labels.locked);
        lock.title = labels.locked;
        line.append(lock);
      }
      const controls = make("span", "lt-track-controls");
      for (const [key, label, on] of [
        ["mute", labels.mute, track.mute === true],
        ["solo", labels.solo, track.solo === true],
      ] as const) {
        const button = make("button", "lt-" + key);
        button.setAttribute("type", "button");
        button.setAttribute("data-lt-track-" + key, "");
        button.setAttribute("aria-label", label + " " + name);
        button.setAttribute("aria-pressed", String(on));
        button.setAttribute("tabindex", "-1");
        button.title = label;
        if (!canSwitch()) button.setAttribute("disabled", "");
        controls.append(button);
      }
      line.append(controls);
      const gain = make("div", "lt-gain");
      gain.setAttribute("data-gain", gainText(track.gain));
      gain.setAttribute("aria-hidden", "true");
      const level = Math.max(0, Math.min(1, track.gain ?? 1));
      gain.style.setProperty("--lt-gain", Math.round(level * 100) + "%");
      main.append(gain);
    }
    header.element.replaceChildren(grip, main);
    header.element.title = name;
  }

  function toggle(trackId: string, key: "mute" | "solo"): void {
    if (!canSwitch()) return;
    const track = editor.getSnapshot().tracks.find((t) => t.id === trackId);
    if (!track) return;
    report(
      editor.dispatch(
        key === "mute"
          ? commands.updateTrack({ trackId, mute: track.mute !== true })
          : commands.updateTrack({ trackId, solo: track.solo !== true }),
      ),
    );
  }

  function place(visible: readonly HeaderRow[]): void {
    if (!chrome().trackHeaders) {
      finishRename(false, false);
      finishDrag(false);
      for (const header of headers.values()) header.element.remove();
      headers.clear();
      byElement.clear();
      return;
    }
    // The focused track's header stays while its row is out of view, so a
    // scroll keeps keyboard focus and any rename draft in place.
    const active = doc.activeElement;
    const held =
      focusId !== undefined &&
      active &&
      list.contains(active) &&
      !visible.some((r) => r.track.id === focusId)
        ? rows().find((r) => r.track.id === focusId)
        : undefined;
    const rendered = held ? [...visible, held].sort((a, b) => a.index - b.index) : visible;
    // A draft lives in one header. When its track moves to another row or
    // goes away, the draft is committed as a blur would.
    if (renaming) {
      const { trackId, header } = renaming;
      const row = rendered.find((r) => r.track.id === trackId);
      if (!row || headers.get(row.index) !== header) finishRename(true, false, true);
    }
    const custom = renderer();
    const count = String(rows().length);
    const keys = shortcutsOf();
    const tabbed =
      focusId !== undefined && rendered.some((r) => r.track.id === focusId)
        ? focusId
        : visible[0]?.track.id;
    const lifted = drag?.dragging ? drag.trackId : undefined;
    for (const row of rendered) {
      const accent = options.accent(row);
      let header = headers.get(row.index);
      if (!header) {
        const el = doc.createElement("div");
        el.className = "lt-label";
        el.setAttribute("role", "listitem");
        el.style.setProperty("--track-color", accent);
        // In row order, before the header of the next row down.
        let next: HTMLElement | null = null;
        let nearest = Infinity;
        for (const [index, other] of headers)
          if (index > row.index && index < nearest) {
            nearest = index;
            next = other.element;
          }
        list.insertBefore(el, next);
        header = { element: el, key: "", track: undefined, renderer: undefined, color: accent };
        headers.set(row.index, header);
        byElement.set(el, header);
      }
      const el = header.element;
      const base = (row.base ?? row.height) + "px";
      if (el.style.getPropertyValue("--lt-row-base") !== base)
        el.style.setProperty("--lt-row-base", base);
      if (header.color !== accent) {
        header.color = accent;
        el.style.setProperty("--track-color", accent);
      }
      setAttr(el, "data-track-id", row.track.id);
      setAttr(el, "aria-posinset", String(row.index + 1));
      setAttr(el, "aria-setsize", count);
      setAttr(el, "aria-keyshortcuts", keys);
      setAttr(el, "tabindex", row.track.id === tabbed ? "0" : "-1");
      el.classList.toggle("lt-label-source", row.track.id === lifted);
      if (renaming?.header === header) {
        el.style.top = row.top + "px";
        el.style.height = row.height + "px";
        continue;
      }
      if (custom) {
        const key = [row.top, row.height].join();
        if (header.key === key && header.track === row.track && header.renderer === custom)
          continue;
        header.key = key;
        header.track = row.track;
        header.renderer = custom;
        el.classList.add("lt-label-custom");
        el.removeAttribute("title");
        el.style.top = row.top + "px";
        el.style.height = row.height + "px";
        const content = custom(row.track, {
          element: el,
          track: row.track,
          index: row.index,
          height: row.height,
          editor,
        });
        if (content) el.replaceChildren(content);
      } else {
        const name = row.track.name ?? row.track.id;
        const { locked, mute, solo, gain } = row.track;
        const key = [row.top, row.height, row.track.id, name, locked, mute, solo, gain].join("\n");
        header.track = row.track;
        if (header.key === key && header.renderer === undefined) continue;
        header.key = key;
        header.renderer = undefined;
        el.classList.remove("lt-label-custom");
        el.style.top = row.top + "px";
        el.style.height = row.height + "px";
        fillDefault(header, row.track, name);
      }
    }
    list.style.transform = "translateY(" + -options.scrollTop() + "px)";
    // Focus stays with its track when another track's row takes its header.
    // This runs before stale headers go, so focus never falls to the page.
    const focused = active ? byElement.get(active) : undefined;
    if (focused) {
      const row = rendered.find((r) => r.track.id === focusId);
      const own = row && headers.get(row.index);
      if (!own) focusId = focused.track?.id;
      else if (own !== focused) {
        // Not a reveal: the row is where the edit put it, and a scroll here
        // would place the headers again in the middle of this pass.
        refocusing = true;
        try {
          own.element.focus({ preventScroll: true });
        } finally {
          refocusing = false;
        }
      }
    }
    const shown = new Set(rendered.map((row) => row.index));
    for (const [index, header] of headers)
      if (!shown.has(index)) {
        header.element.remove();
        headers.delete(index);
        byElement.delete(header.element);
      }
  }

  function setTabStop(trackId: string): void {
    focusId = trackId;
    for (const header of headers.values())
      setAttr(header.element, "tabindex", header.track?.id === trackId ? "0" : "-1");
  }

  // A pointer gesture moves focus without the keyboard focus ring.
  function focusTrack(trackId: string, ring = true): void {
    setTabStop(trackId);
    options.scrollToTrack(trackId);
    headerOf(trackId)?.element.focus({ preventScroll: true, focusVisible: ring });
  }

  function announce(text: string): void {
    live.textContent = live.textContent === text ? text + " " : text;
  }

  function reorder(trackId: string, slot: number): boolean {
    const ids = rows().map((row) => row.track.id);
    const next = moveToSlot(ids, ids.indexOf(trackId), slot);
    if (!next) return false;
    const result = editor.dispatch(commands.reorderTracks({ trackIds: next }));
    report(result);
    if (!result.ok) return false;
    const track = editor.getSnapshot().tracks.find((t) => t.id === trackId);
    announce(
      fillTemplate(uiLabels().trackMoved, {
        name: track?.name ?? trackId,
        position: next.indexOf(trackId) + 1,
        count: next.length,
      }),
    );
    return true;
  }

  // Rename ------------------------------------------------------------------

  function startRename(header: Header): boolean {
    const track = header.track;
    if (!canRename() || !track) return false;
    if (renaming?.header === header) {
      renaming.input.focus({ preventScroll: true });
      return true;
    }
    finishRename(true, false);
    const target = header.element.querySelector("[data-lt-track-name]");
    if (!target) return false;
    finishDrag(false);
    const input = doc.createElement("input");
    input.type = "text";
    input.className = "lt-name-input";
    input.value = track.name ?? track.id;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("aria-label", uiLabels().trackName);
    input.setAttribute("enterkeyhint", "done");
    const session: Rename = { trackId: track.id, header, input, replaced: target };
    renaming = session;
    input.addEventListener(
      "keydown",
      (e) => {
        // Enter that ends an IME composition only confirms the composed text.
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key !== "Enter" && e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        if (renaming === session) finishRename(e.key === "Enter", true);
      },
      { signal },
    );
    input.addEventListener(
      "blur",
      () => {
        // Leaving the window keeps the draft; the browser restores focus to it.
        if (renaming === session && doc.hasFocus()) finishRename(true, false);
      },
      { signal },
    );
    target.replaceWith(input);
    header.element.classList.add("lt-label-renaming");
    setTabStop(track.id);
    input.focus({ preventScroll: true });
    input.select();
    return true;
  }

  function finishRename(commit: boolean, refocus: boolean, defer = false): void {
    const session = renaming;
    if (!session) return;
    renaming = null;
    const { trackId, header, input, replaced } = session;
    const draft = input.value;
    header.element.classList.remove("lt-label-renaming");
    // Drawn again at the next place, with whatever name the track has then.
    header.key = "";
    if (input.isConnected) input.replaceWith(replaced);
    if (refocus && header.element.isConnected) header.element.focus({ preventScroll: true });
    if (!commit) return;
    const track = editor.getSnapshot().tracks.find((t) => t.id === trackId);
    const name = track && renamedTo(draft, track);
    if (name === undefined) return;
    const run = (): void => report(editor.dispatch(commands.updateTrack({ trackId, name })));
    if (defer) queueMicrotask(run);
    else run();
  }

  function renameTrack(trackId: string): boolean {
    if (!canRename() || !rows().some((row) => row.track.id === trackId)) return false;
    options.scrollToTrack(trackId);
    const header = headerOf(trackId);
    return header ? startRename(header) : false;
  }

  // Drag --------------------------------------------------------------------

  function boundaryOf(slot: number, all: readonly HeaderRow[]): number {
    const row = all[slot];
    if (row) return row.top;
    const last = all.at(-1);
    return last ? last.top + last.height : 0;
  }

  // Moves the ghost and the drop line to the pointer, and sets the auto-scroll speed.
  function follow(): void {
    if (!drag?.dragging) return;
    const y = drag.clientY - pin.getBoundingClientRect().top;
    const height = options.viewportHeight();
    const top = scroll.scrollTop;
    if (ghost) {
      const at = Math.max(0, Math.min(Math.max(0, height - drag.height), y - drag.grab));
      ghost.style.transform = "translateY(" + at + "px)";
    }
    const all = rows();
    const ids = all.map((row) => row.track.id);
    const slot = dropSlot(all, y + top);
    const moves = moveToSlot(ids, ids.indexOf(drag.trackId), slot) !== null;
    if (dropLine) {
      dropLine.hidden = !moves;
      if (moves) dropLine.style.transform = "translateY(" + (boundaryOf(slot, all) - top) + "px)";
    }
    const edge = Math.min(32, height / 4);
    const depth = y < edge ? y - edge : y > height - edge ? y - (height - edge) : 0;
    scrollStep = edge > 0 ? Math.max(-1, Math.min(1, depth / edge)) * maxScrollStep : 0;
    if (scrollStep && !scrollFrame) scrollFrame = win.requestAnimationFrame(autoScroll);
  }

  function autoScroll(): void {
    scrollFrame = 0;
    if (!drag?.dragging || !scrollStep) return;
    const before = scroll.scrollTop;
    scroll.scrollTop = before + scrollStep;
    // At either end the list cannot scroll further, and waits for the pointer.
    if (scroll.scrollTop === before) return;
    follow();
  }

  function beginDrag(state: Drag): void {
    state.dragging = true;
    finishRename(true, false);
    try {
      list.setPointerCapture(state.pointerId);
    } catch {
      // The pointer is already gone; its pointerup or pointercancel ends the drag.
    }
    root.classList.add("lt-track-dragging");
    const lifted = doc.createElement("div");
    lifted.className = "lt-track-ghost";
    lifted.setAttribute("aria-hidden", "true");
    lifted.style.setProperty("--track-color", state.color);
    lifted.style.height = state.height + "px";
    lifted.textContent = state.name;
    const line = doc.createElement("div");
    line.className = "lt-drop";
    line.setAttribute("aria-hidden", "true");
    line.hidden = true;
    pin.append(lifted, line);
    ghost = lifted;
    dropLine = line;
    headerOf(state.trackId)?.element.classList.add("lt-label-source");
    swallowClick = true;
  }

  function finishDrag(commit: boolean): void {
    const state = drag;
    if (!state) return;
    drag = null;
    scrollStep = 0;
    if (scrollFrame) win.cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    if (!state.dragging) return;
    ghost?.remove();
    dropLine?.remove();
    ghost = dropLine = null;
    root.classList.remove("lt-track-dragging");
    for (const header of headers.values()) header.element.classList.remove("lt-label-source");
    if (list.hasPointerCapture(state.pointerId)) list.releasePointerCapture(state.pointerId);
    // The click that ends a drag is not a click on whatever lies under it.
    win.setTimeout(() => {
      swallowClick = false;
    });
    if (!commit) return;
    // Against the rows as they are now, which a remote edit may have changed.
    const y = state.clientY - pin.getBoundingClientRect().top + scroll.scrollTop;
    reorder(state.trackId, dropSlot(rows(), y));
    if (rows().some((row) => row.track.id === state.trackId)) focusTrack(state.trackId, false);
  }

  // The header a press can drag: a default header anywhere but its rename
  // field, or the grip of any header. A custom header's controls keep their
  // pointer, and touch on a default header's name scrolls the list.
  function draggable(e: PointerEvent | MouseEvent, touch: boolean): Header | undefined {
    if (e.button !== 0 || !canReorder()) return undefined;
    const header = headerAt(e.target);
    if (!header?.track || partOf(e.target, ".lt-name-input", header.element)) return undefined;
    if (partOf(e.target, ".lt-track-controls", header.element)) return undefined;
    const grip = partOf(e.target, "[data-lt-track-grip]", header.element);
    return grip || (!isCustom(header) && !touch) ? header : undefined;
  }

  // Without this, a mouse press would start a text selection, whose native
  // auto-scroll fights the drag's own. Focus moves by hand instead.
  listen(list, "mousedown", (e) => {
    const header = draggable(e, false);
    if (!header) return;
    e.preventDefault();
    if (doc.activeElement !== header.element)
      header.element.focus({ preventScroll: true, focusVisible: false });
  });
  listen(list, "pointerdown", (e) => {
    if (drag || !e.isPrimary) return;
    const header = draggable(e, e.pointerType === "touch");
    const track = header?.track;
    if (!header || !track) return;
    // No native touch gesture starts from a grip.
    if (e.pointerType === "touch") e.preventDefault();
    const box = header.element.getBoundingClientRect();
    drag = {
      pointerId: e.pointerId,
      trackId: track.id,
      name: track.name ?? track.id,
      color: header.color,
      x: e.clientX,
      y: e.clientY,
      grab: e.clientY - box.top,
      height: box.height,
      clientY: e.clientY,
      dragging: false,
    };
  });
  win.addEventListener(
    "pointermove",
    (e) => {
      const state = drag;
      if (!state || e.pointerId !== state.pointerId) return;
      state.clientY = e.clientY;
      if (!state.dragging) {
        if (Math.hypot(e.clientX - state.x, e.clientY - state.y) < dragThreshold) return;
        beginDrag(state);
      }
      e.preventDefault();
      follow();
    },
    { signal },
  );
  win.addEventListener(
    "pointerup",
    (e) => {
      if (drag && e.pointerId === drag.pointerId) finishDrag(true);
    },
    { signal },
  );
  win.addEventListener(
    "pointercancel",
    (e) => {
      if (drag && e.pointerId === drag.pointerId) finishDrag(false);
    },
    { signal },
  );
  win.addEventListener("blur", () => finishDrag(false), { signal });
  win.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !drag?.dragging) return;
      e.preventDefault();
      e.stopPropagation();
      finishDrag(false);
    },
    { signal, capture: true },
  );
  listen(
    list,
    "click",
    (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  listen(list, "click", (e) => {
    const header = headerAt(e.target);
    const trackId = header?.track?.id;
    if (!header || trackId === undefined) return;
    if (partOf(e.target, "[data-lt-track-mute]", header.element)) toggle(trackId, "mute");
    else if (partOf(e.target, "[data-lt-track-solo]", header.element)) toggle(trackId, "solo");
  });

  // Keyboard and focus -------------------------------------------------------

  listen(list, "focusin", (e) => {
    const header = headerAt(e.target);
    const id = header?.track?.id;
    if (!header || id === undefined) return;
    if (id !== focusId) setTabStop(id);
    // The browser cannot scroll a header into view: it sits in the pinned
    // window, not in the scrolled content. Tab focus reveals its row here.
    if (!refocusing && e.target === header.element && header.element.matches(":focus-visible"))
      options.scrollToTrack(id);
  });
  listen(list, "dblclick", (e) => {
    const header = headerAt(e.target);
    if (!header || partOf(e.target, ".lt-name-input", header.element)) return;
    // A custom header renames from its marked name only, not from its controls.
    if (isCustom(header) && !partOf(e.target, "[data-lt-track-name]", header.element)) return;
    if (startRename(header)) e.preventDefault();
  });
  listen(list, "keydown", (e) => {
    if (e.isComposing || e.keyCode === 229 || drag?.dragging) return;
    const header = headerAt(e.target);
    const trackId = header?.track?.id;
    if (!header || trackId === undefined) return;
    const onHeader = e.target === header.element;
    // In a custom header, only the header itself and its grip take these keys.
    if (!onHeader && !partOf(e.target, "[data-lt-track-grip]", header.element)) return;
    const ids = rows().map((row) => row.track.id);
    const from = ids.indexOf(trackId);
    if (from < 0) return;
    const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    const alt = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    const edits = shortcuts() && !readOnly();
    if (plain && onHeader && (e.key === "Enter" || e.key === "F2")) {
      if (edits && startRename(header)) e.preventDefault();
      return;
    }
    const letter = e.key.toLowerCase();
    if (plain && onHeader && edits && !isCustom(header) && (letter === "m" || letter === "s")) {
      if (!canSwitch()) return;
      e.preventDefault();
      toggle(trackId, letter === "m" ? "mute" : "solo");
      return;
    }
    const steps: Record<string, readonly [focus: number, slot: number]> = {
      ArrowUp: [from - 1, from - 1],
      ArrowDown: [from + 1, from + 2],
      Home: [0, 0],
      End: [ids.length - 1, ids.length],
    };
    const step = Object.hasOwn(steps, e.key) ? steps[e.key] : undefined;
    if (!step) return;
    if (plain) {
      const target = ids[Math.max(0, Math.min(ids.length - 1, step[0]))];
      e.preventDefault();
      if (target !== undefined) focusTrack(target);
    } else if (alt && edits && canReorder()) {
      e.preventDefault();
      if (reorder(trackId, step[1])) focusTrack(trackId);
    }
  });

  return {
    place,
    sync() {
      list.setAttribute("aria-label", uiLabels().tracks);
      root.classList.toggle("lt-track-reorder", canReorder());
      if (!canRename()) finishRename(false, false);
      if (!canReorder()) finishDrag(false);
      for (const header of headers.values()) header.key = "";
    },
    rename: renameTrack,
    dispose() {
      finishRename(false, false);
      finishDrag(false);
      for (const header of headers.values()) header.element.remove();
      headers.clear();
      byElement.clear();
      live.remove();
    },
  };
}
