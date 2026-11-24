// Smooth following for views that track playback: the dialogue list and the timeline.
//
// Playback can move the thing to follow many times a second, as when several lines overlap.
// Two layers keep the view calm:
//
// - A buffer (`createBuffer`) holds a new goal until requests stop changing for a moment, and
//   never longer than a set wait, so a burst of changes becomes one move. A goal that is out of
//   sight altogether skips the wait.
// - A glide (`createGlide`) moves toward the goal along a critically damped spring. A new goal
//   in mid-move bends the path without a jolt: position and speed carry over, so the view never
//   stops dead or turns back sharply. Speed is capped.
//
// Following also gives way to the person: a wheel, touch or scrollbar drag holds it off for a
// few seconds. All of it is skipped when the system asks for reduced motion.

/** One scrollable position, in CSS pixels. */
export interface Axis {
  read(): number;
  write(position: number): void;
  /** The furthest the position can go. */
  limit(): number;
}

export interface GlideOptions {
  /** Roughly how long a move takes to settle, in seconds. */
  readonly period?: number;
  /** The fastest the view moves, in pixels a second. */
  readonly maxSpeed?: number;
}

export interface Glide {
  /** Heads for `goal`. A new goal while moving bends the path instead of restarting it. */
  to(goal: number): void;
  /** Where the glide is heading, or where it rests. */
  goal(): number;
  readonly moving: () => boolean;
  stop(): void;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

const stillness = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

export function createGlide(axis: Axis, options: GlideOptions = {}): Glide {
  const omega = (2 * Math.PI) / (options.period ?? 0.8);
  const maxSpeed = options.maxSpeed ?? 2400;
  let position = axis.read();
  let velocity = 0;
  let goal = position;
  let frame = 0;
  let last = 0;
  // What this glide last wrote, to tell its own moves from anyone else's.
  let written = position;

  const step = (now: number): void => {
    const dt = Math.min(0.034, last ? (now - last) / 1000 : 1 / 60);
    last = now;
    const actual = axis.read();
    // Someone else moved the view (a scrollbar, a resize): carry on from where it is.
    if (Math.abs(actual - written) > 3) position = actual;
    const target = clamp(goal, 0, axis.limit());
    // Critically damped: the fastest approach that never overshoots.
    const pull = omega * omega * (target - position) - 2 * omega * velocity;
    velocity = clamp(velocity + pull * dt, -maxSpeed, maxSpeed);
    position += velocity * dt;
    if (Math.abs(target - position) < 0.5 && Math.abs(velocity) < 8) {
      position = target;
      velocity = 0;
      frame = 0;
    } else {
      frame = requestAnimationFrame(step);
    }
    written = position;
    axis.write(position);
  };

  return {
    to(next) {
      goal = clamp(next, 0, axis.limit());
      if (stillness()) {
        cancelAnimationFrame(frame);
        frame = 0;
        position = written = goal;
        velocity = 0;
        axis.write(goal);
        return;
      }
      if (frame) return;
      position = written = axis.read();
      last = 0;
      frame = requestAnimationFrame(step);
    },
    goal: () => (frame ? goal : axis.read()),
    moving: () => frame !== 0,
    stop() {
      cancelAnimationFrame(frame);
      frame = 0;
      velocity = 0;
    },
  };
}

export interface BufferOptions {
  /** How long requests must stop changing before one is applied, in milliseconds. */
  readonly settle?: number;
  /** The longest a request waits however often they change, in milliseconds. */
  readonly maxWait?: number;
}

export interface Buffer {
  /** Asks for `goal`; `urgent` applies it at once. */
  push(goal: number, urgent?: boolean): void;
  cancel(): void;
}

/**
 * Debounces goals, with a ceiling: a request is applied once requests have held still for
 * `settle`, or `maxWait` after the first of a burst. Goals within a few pixels of the pending
 * one count as the same.
 */
export function createBuffer(apply: (goal: number) => void, options: BufferOptions = {}): Buffer {
  const settle = options.settle ?? 200;
  const maxWait = options.maxWait ?? 650;
  let pending: number | null = null;
  let first = 0;
  let timer = 0;
  const flush = (): void => {
    window.clearTimeout(timer);
    timer = 0;
    const goal = pending;
    pending = null;
    if (goal !== null) apply(goal);
  };
  return {
    push(goal, urgent = false) {
      if (urgent) {
        pending = goal;
        flush();
        return;
      }
      const now = performance.now();
      if (pending !== null && Math.abs(goal - pending) < 4) return;
      if (pending === null) first = now;
      pending = goal;
      window.clearTimeout(timer);
      const left = maxWait - (now - first);
      if (left <= 0) flush();
      else timer = window.setTimeout(flush, Math.min(settle, left));
    },
    cancel() {
      window.clearTimeout(timer);
      timer = 0;
      pending = null;
    },
  };
}

/** A stretch of the scrolled content, in pixels from its top (or left). */
export interface Span {
  readonly start: number;
  readonly end: number;
}

export interface FollowerOptions extends GlideOptions, BufferOptions {
  /** Where a followed span is held, as a share of the view from its start. */
  readonly anchor?: number;
  /** The most that share can be, in pixels. */
  readonly anchorMax?: number;
  /** A span inside this share of the view, measured from its start, is left where it is. */
  readonly comfort?: number;
  /** Room kept between a span and the view's edges, in pixels. */
  readonly margin?: number;
  /** How long a wheel, touch or scrollbar drag holds following off, in milliseconds. */
  readonly hold?: number;
  /**
   * Whether any press inside `element` holds following off, as on a timeline where a press
   * starts an edit. By default only a press on the element itself, its scrollbar, does.
   */
  readonly holdOnPress?: boolean;
}

export interface Follower {
  /**
   * Keeps what playback is on in view. `span` covers everything playing now; `lead` is the
   * part that matters most, and moving to it is urgent once it is out of sight.
   */
  follow(span: Span, lead: Span): void;
  /** Brings a span into view by the least movement, at once: for moves a person asked for. */
  reveal(span: Span): void;
  /** Where the view is heading, or where it rests. */
  goal(): number;
  dispose(): void;
}

/**
 * Follows playback along one axis. `size` is the length of the visible part. `element`, when
 * given, is watched for the person's own scrolling.
 */
export function createFollower(
  axis: Axis,
  size: () => number,
  element: HTMLElement | null,
  options: FollowerOptions = {},
): Follower {
  const anchor = options.anchor ?? 0.22;
  const anchorMax = options.anchorMax ?? 90;
  const comfort = options.comfort ?? 0.62;
  const margin = options.margin ?? 6;
  const holdFor = options.hold ?? 2500;
  const glide = createGlide(axis, options);
  const buffer = createBuffer((goal) => glide.to(goal), options);
  let heldUntil = 0;

  const hold = (): void => {
    heldUntil = performance.now() + holdFor;
    buffer.cancel();
    glide.stop();
  };
  // A press on the element itself, not on its content, is a press on its scrollbar.
  const press = (event: PointerEvent): void => {
    if (options.holdOnPress === true || event.target === element) hold();
  };
  element?.addEventListener("wheel", hold, { passive: true });
  element?.addEventListener("touchstart", hold, { passive: true });
  element?.addEventListener("pointerdown", press);

  return {
    follow(span, lead) {
      if (performance.now() < heldUntil) return;
      const view = size();
      const at = glide.goal();
      // Inside the comfortable part of the view: stay put. This is what lets a run of
      // overlapping lines pass without a move for each.
      if (span.start >= at + margin && span.start <= at + view * comfort && span.end <= at + view)
        return;
      const offset = Math.min(view * anchor, anchorMax);
      const tall = span.end - span.start > view - offset - margin;
      const goal = tall ? span.start - margin : span.start - offset;
      const unseen = lead.end <= at || lead.start >= at + view;
      buffer.push(goal, unseen);
    },
    reveal(span) {
      buffer.cancel();
      const view = size();
      const at = glide.goal();
      if (span.start < at + margin) glide.to(span.start - margin);
      else if (span.end > at + view - margin)
        glide.to(Math.min(span.start - margin, span.end - view + margin));
    },
    goal: () => glide.goal(),
    dispose() {
      buffer.cancel();
      glide.stop();
      element?.removeEventListener("wheel", hold);
      element?.removeEventListener("touchstart", hold);
      element?.removeEventListener("pointerdown", press);
    },
  };
}

/** The scroll position of an element as an axis. */
export const scrollAxis = (element: HTMLElement): Axis => ({
  read: () => element.scrollTop,
  write: (position) => {
    element.scrollTop = position;
  },
  limit: () => Math.max(0, element.scrollHeight - element.clientHeight),
});
