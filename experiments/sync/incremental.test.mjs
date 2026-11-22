import test from "node:test";
import assert from "node:assert/strict";
import { commands, createEditor, TICKS_PER_SECOND as hz } from "@lumen-timeline/core";
import { VideoTransport } from "./transport.mjs";

const rate = 48000;
const tick = (s) => Math.round(s * hz);
const clip = (id, start, end, trackId, take = id) => ({
  id,
  trackId,
  activeTakeId: take,
  kind: "audio",
  start: tick(start),
  duration: tick(end - start),
  contentIn: 0,
});
const move = (id, delta) => commands.moveClips({ clipIds: [id], delta: tick(delta) });
const buffer = { sampleRate: rate, length: rate * 30 };
const binding = (assetId) => ({
  assetId,
  streamId: "s",
  assetVersion: 1,
  sampleRate: rate,
  availableStart: 0,
  availableEnd: buffer.length,
  sourceAtContentZero: 0,
});
function pass(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
}

function fixture(
  clips,
  resolver = () => buffer,
  tracks = ["music", "voice"].map((id) => ({ id })),
) {
  const editor = createEditor({ project: { schemaVersion: 1, tracks, clips } });
  const catalog = {
    version: 1,
    takes: Object.fromEntries(clips.map((c) => [c.activeTakeId, binding(c.activeTakeId)])),
  };
  const player = Object.assign(new EventTarget(), {
    duration: 30,
    readyState: 4,
    paused: false,
    requestVideoFrameCallback(fn) {
      this.frame = fn;
      return 1;
    },
    cancelVideoFrameCallback() {},
  });
  const nodes = [],
    errors = [];
  const ctx = {
    currentTime: 0,
    sampleRate: rate,
    getOutputTimestamp() {
      return { contextTime: this.currentTime, performanceTime: 1000 };
    },
    createGain() {
      return { gain: { value: 1 }, connect() {}, disconnect() {} };
    },
    createBufferSource() {
      const node = {
        playbackRate: { value: 1 },
        stops: [],
        connect() {},
        disconnect() {},
        start(when, offset) {
          this.when = when;
          this.offset = offset;
        },
        stop(at) {
          this.stops.push(at);
        },
      };
      nodes.push(node);
      return node;
    },
  };
  const transport = new VideoTransport(
    player,
    ctx,
    {},
    { editor, catalog, resolveBuffer: resolver, onError: (e) => errors.push(e) },
  );
  player.dispatchEvent(new Event("playing"));
  return {
    editor,
    transport,
    player,
    nodes,
    errors,
    catalog,
    ctx,
    frame(media, audio = media) {
      ctx.currentTime = audio;
      player.frame(1000, { mediaTime: media, expectedDisplayTime: 1000 });
    },
    close() {
      transport.dispose();
      editor.dispose();
    },
  };
}

test("dialogue move, undo, redo and metadata preserve the music node, end reservation and clock", () => {
  const f = fixture([
    clip("bed", 0, 20, "music"),
    clip("line", 0, 8, "voice"),
    clip("later", 9, 10, "voice"),
  ]);
  try {
    f.frame(2);
    const bed = f.transport.voices.get("bed"),
      original = f.transport.voices.get("line");
    const generation = f.transport.generation,
      anchor = f.transport.anchor;
    assert.equal(original.node.offset, 2);
    assert.equal(bed.node.stops[0], 20);
    pass(f.editor.dispatch(move("line", 3)));
    assert.equal(f.transport.voices.has("line"), false);
    assert.deepEqual(original.node.stops, [8, 2]);
    pass(f.editor.history.undo());
    assert.equal(f.transport.voices.get("line").node.offset, 2);
    pass(f.editor.history.redo());
    pass(f.editor.dispatch(move("later", -7), { history: "ignore" }));
    assert.equal(f.transport.voices.get("later").node.offset, 0);
    const count = f.nodes.length;
    pass(
      f.editor.dispatch(
        commands.setEntityData({ scope: "take", id: "line", key: "ready", value: true }),
        {
          history: "ignore",
        },
      ),
    );
    f.transport.setCatalog({ ...f.catalog, version: 2 });
    assert.equal(f.nodes.length, count);
    assert.equal(f.transport.generation, generation);
    assert.equal(f.transport.anchor, anchor);
    assert.equal(f.transport.voices.get("bed"), bed);
    assert.deepEqual(bed.node.stops, [20]);
  } finally {
    f.close();
  }
});

test("pending buffers use the latest offset, survive unrelated revisions, and reject obsolete binding results", async () => {
  const loads = [];
  const f = fixture([clip("line", 0, 10, "voice"), clip("bed", 0, 20, "music")], (span, signal) => {
    if (span.trackId === "music") return buffer;
    return new Promise((resolve) => loads.push({ resolve, signal, span }));
  });
  try {
    f.frame(1);
    const music = f.transport.voices.get("bed").node;
    const replacement = { ...f.catalog.takes.line, assetVersion: 2, streamId: "new" };
    f.transport.setCatalog({ version: 2, takes: { ...f.catalog.takes, line: replacement } });
    assert.equal(loads.length, 2);
    assert.equal(loads[0].signal.aborted, true);
    loads[0].resolve(buffer);
    await Promise.resolve();
    assert.equal(f.nodes.length, 1);
    f.frame(1.25);
    pass(
      f.editor.dispatch(
        commands.setEntityData({ scope: "job", id: "test", key: "percent", value: 80 }),
        {
          history: "ignore",
        },
      ),
    );
    loads[1].resolve(buffer);
    await Promise.resolve();
    const voice = f.transport.voices.get("line");
    assert.equal(voice.node.offset, 1.25);
    assert.equal(voice.span.streamId, "new");
    assert.equal(voice.span.assetVersion, 2);
    assert.equal(f.transport.voices.get("bed").node, music);
    f.transport.setCatalog(f.catalog);
    assert.equal(loads.length, 3);
    f.player.dispatchEvent(new Event("waiting"));
    loads[2].resolve(buffer);
    await Promise.resolve();
    assert.equal(f.nodes.length, 2);
    assert.equal(f.transport.voices.size, 0);
  } finally {
    f.close();
  }
});

test("an out-of-window edit cancels a pending load, including a late rejection after disposal", async () => {
  let reject, signal;
  const f = fixture([clip("line", 0, 4, "voice")], (_, s) => {
    signal = s;
    return new Promise((_, r) => {
      reject = r;
    });
  });
  f.frame(1);
  pass(f.editor.dispatch(move("line", 5)));
  assert.equal(signal.aborted, true);
  f.close();
  reject(new Error("obsolete"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.nodes, []);
});

test("future seams are scoped to their track and chain and evicted with their producer", () => {
  const f = fixture([clip("a", 0, 1, "voice"), clip("b", 1, 2, "voice"), clip("m", 1, 3, "music")]);
  try {
    f.frame(0.2);
    f.frame(0.95, 0.94);
    const b = f.transport.voices.get("b").node;
    const m = f.transport.voices.get("m").node;
    assert.equal(b.when, 1);
    assert.equal(m.when, 0.99);
    pass(f.editor.dispatch(commands.trimClip({ clipId: "a", edge: "right", delta: -tick(0.3) })));
    const newB = f.transport.voices.get("b").node;
    assert.deepEqual(b.stops, [1.999, 0.94]);
    assert.notEqual(b, newB);
    assert.equal(newB.when, 0.99);
    assert.equal(f.transport.voices.get("m").node, m);
    assert.equal(m.stops.length, 1);
  } finally {
    f.close();
  }
});

test("late predecessor resolution aligns an already booked future without fetching its buffer again", async () => {
  let resolveFirst;
  const loads = [];
  const f = fixture(
    [clip("prev", 0, 1, "voice"), clip("next", 1, 2, "voice"), clip("bed", 1, 4, "music")],
    (span) => {
      loads.push(span.clipId);
      return span.clipId === "prev"
        ? new Promise((resolve) => {
            resolveFirst = resolve;
          })
        : buffer;
    },
  );
  try {
    f.frame(0.95, 0.94);
    const initial = f.transport.voices.get("next").node;
    const music = f.transport.voices.get("bed").node;
    assert.equal(initial.when, 0.99);
    f.frame(0.96, 0.959);
    resolveFirst(buffer);
    await Promise.resolve();
    const predecessor = f.transport.voices.get("prev").node;
    const next = f.transport.voices.get("next").node;
    assert.notEqual(next, initial);
    assert.equal(next.when, predecessor.stops[0]);
    assert.equal(next.when, 0.999);
    initial.onended();
    assert.ok(!f.transport.voices.get("next").ended);
    assert.equal(f.transport.voices.get("bed").node, music);
    assert.equal(loads.filter((id) => id === "next").length, 1);
  } finally {
    f.close();
  }
});

test("voices in separate chains on one mixing track keep independent boundary samples", () => {
  const f = fixture([
    { ...clip("first", 0, 1, "voice"), continuityId: "speaker-a" },
    { ...clip("next", 1, 2, "voice"), continuityId: "speaker-b" },
  ]);
  try {
    f.frame(0.25);
    f.frame(0.95, 0.94);
    assert.equal(f.transport.voices.get("first").endSample, rate);
    assert.equal(f.transport.voices.get("next").startSample, Math.round(0.99 * rate));
  } finally {
    f.close();
  }
});

test("failed or missing bindings leave the guide running and can recover on catalog refresh", () => {
  let available = false;
  const f = fixture([clip("guide", 0, 12, "music"), clip("line", 0, 6, "voice")], (span) =>
    span.clipId === "line" && !available ? { sampleRate: rate, length: 1 } : buffer,
  );
  try {
    f.frame(1);
    assert.equal(f.errors.length, 1);
    const guide = f.transport.voices.get("guide").node;
    assert.throws(() => f.transport.setCatalog({ version: 2, takes: [] }), /catalog/);
    assert.equal(f.transport.catalog, f.catalog);
    const { line, ...remaining } = f.catalog.takes;
    f.transport.setCatalog({ version: 2, takes: remaining });
    assert.equal(f.transport.issues[0].code, "unresolved-take");
    available = true;
    f.transport.setCatalog({ version: 3, takes: { ...remaining, line } });
    assert.equal(f.transport.voices.get("line").node.offset, 1);
    assert.equal(f.transport.voices.get("guide").node, guide);
    assert.deepEqual(guide.stops, [12]);
  } finally {
    f.close();
  }
});

test("a buffer returned after a native seek cannot start at the old position", async () => {
  const loads = [];
  const f = fixture(
    [clip("line", 0, 10, "voice")],
    (_span, signal) => new Promise((resolve) => loads.push({ signal, resolve })),
  );
  try {
    f.frame(1);
    const generation = f.transport.generation;
    const arrival = f.transport.seek(5);
    f.player.dispatchEvent(new Event("seeked"));
    assert.equal(await arrival, "arrived");
    f.frame(5);
    f.frame(5.2);
    assert.ok(f.transport.generation > generation);
    assert.ok(loads[0].signal.aborted);
    loads[0].resolve(buffer);
    await Promise.resolve();
    assert.equal(f.nodes.length, 0);
    loads[1].resolve(buffer);
    await Promise.resolve();
    assert.equal(f.nodes.length, 1);
    assert.equal(f.nodes[0].offset, 5.2);
  } finally {
    f.close();
  }
});

test("isolated timing jitter keeps a voice, sustained output-clock slip reanchors once", () => {
  const f = fixture([clip("bed", 0, 20, "music")]);
  try {
    f.frame(0);
    const first = f.transport.voices.get("bed").node;
    f.frame(0.1, 0.14);
    f.frame(0.2, 0.2);
    assert.equal(f.transport.voices.get("bed").node, first);
    // No individual observation jumps by the discontinuity threshold. The
    // previously booked node eventually differs by more than a frame.
    let resetAt;
    for (let i = 1; i <= 12; i++) {
      const media = 0.2 + i / 10;
      const audio = media + Math.min(0.05, i * 0.008);
      f.frame(media, audio);
      if (!resetAt && f.transport.phaseResets) resetAt = { media, audio };
    }
    assert.equal(f.transport.phaseResets, 1);
    assert.equal(f.transport.generation, 1);
    assert.equal(first.stops.length, 2);
    const replacement = f.transport.voices.get("bed").node;
    assert.notEqual(replacement, first);
    assert.ok(Math.abs(replacement.when - resetAt.audio) < 1 / rate);
    assert.ok(Math.abs(replacement.offset - resetAt.media) < 1 / rate);
  } finally {
    f.close();
  }
});
