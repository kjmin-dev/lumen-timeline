import assert from "node:assert/strict";
import test from "node:test";
import { VideoTransport, presentationTime } from "./transport.mjs";
import { createEditor } from "../../packages/core/index.mjs";
import { bufferCatalog } from "./buffer-fixture.mjs";
import { TICKS_PER_SECOND as hz } from "../../packages/core/time.mjs";

function makeTransport(player, context, output, clips, takes) {
  const editor = createEditor({
    project: {
      schemaVersion: 1,
      tracks: [{ id: "voice" }],
      clips: clips.map((c) => ({
        ...c,
        id: String(c.id),
        activeTakeId: c.take,
        trackId: "voice",
        kind: "audio",
      })),
    },
  });
  const buffers = Object.fromEntries(
    Object.entries(takes).map(([id, t]) => [
      id,
      {
        buffer: {
          sampleRate: context.sampleRate,
          length: Math.round((t.availableEnd / hz) * context.sampleRate),
        },
      },
    ]),
  );
  return new VideoTransport(player, context, output, {
    editor,
    catalog: bufferCatalog(buffers),
    resolveBuffer: (s) => buffers[s.assetId].buffer,
  });
}

test("a fake clock cancels scheduled sound across a stall, seek and disposal", async () => {
  class Player extends EventTarget {
    duration = 20;
    currentTime = 0;
    readyState = 4;
    requestVideoFrameCallback(callback) {
      this.callback = callback;
      return 1;
    }
    cancelVideoFrameCallback() {}
  }
  const player = new Player();
  const starts = [];
  let stops = 0;
  const context = {
    sampleRate: 48000,
    currentTime: 4,
    getOutputTimestamp: () => ({ contextTime: 4, performanceTime: 4000 }),
    createBufferSource: () => ({
      connect() {},
      disconnect() {},
      start(...args) {
        starts.push(args);
      },
      stop(when) {
        if (when === context.currentTime) stops++;
      },
    }),
  };
  const clip = { id: "line", take: "a", start: 12 * hz, duration: 4 * hz, contentIn: hz };
  const transport = makeTransport(player, context, {}, [clip], {
    a: { availableStart: 0, availableEnd: 10 * hz, sourceAtContentZero: 0 },
  });
  const frame = (mediaTime) => player.callback(4000, { expectedDisplayTime: 4000, mediaTime });
  try {
    player.dispatchEvent(new Event("playing"));
    frame(14);
    assert.deepEqual(starts, [[4, 3]]);
    player.dispatchEvent(new Event("waiting"));
    assert.equal(stops, 1);
    frame(14.5);
    transport.fill();
    assert.equal(starts.length, 1);
    const targets = [13, 14, 15].map((t) => transport.seek(t));
    player.dispatchEvent(new Event("seeked"));
    await Promise.resolve();
    player.dispatchEvent(new Event("seeked"));
    assert.deepEqual(await Promise.all(targets), ["superseded", "superseded", "arrived"]);
    frame(14); // A callback queued before the final seek.
    assert.equal(starts.length, 1);
    frame(15);
    assert.deepEqual(starts.at(-1), [4, 4]);
  } finally {
    transport.dispose();
  }
  assert.equal(stops, 2);
});

test("timestamps from another time origin fall back to the callback estimate", () => {
  assert.equal(presentationTime(5000, 5016), 5016);
  assert.equal(presentationTime(5000, -1630235743), 5000);
  assert.equal(presentationTime(5000, NaN), 5000);
});

test("disposal settles in-flight and queued seek promises", async () => {
  const player = Object.assign(new EventTarget(), {
    duration: 20,
    currentTime: 1,
    readyState: 4,
    requestVideoFrameCallback() {
      return 1;
    },
    cancelVideoFrameCallback() {},
  });
  const transport = makeTransport(player, { getOutputTimestamp() {} }, {}, [], {});
  const inFlight = transport.seek(5);
  const queued = transport.seek(7);
  transport.dispose();
  await assert.rejects(inFlight, /disposed/);
  await assert.rejects(queued, /disposed/);
  await assert.rejects(transport.seek(2), /disposed/);
  assert.equal(transport.running, false);
});

test("adjacent clips share an absolute output sample despite jitter in frame observations", () => {
  const player = Object.assign(new EventTarget(), {
    requestVideoFrameCallback(cb) {
      this.cb = cb;
      return 1;
    },
    cancelVideoFrameCallback() {},
  });
  const nodes = [];
  const ctx = {
    currentTime: 0.2,
    sampleRate: 48000,
    getOutputTimestamp() {
      return { contextTime: this.currentTime, performanceTime: 1000 };
    },
    createBufferSource() {
      const node = {
        playbackRate: { value: 1 },
        connect() {},
        disconnect() {},
        start(when) {
          this.startAt = when;
        },
        stop(when) {
          this.stopAt = when;
        },
      };
      nodes.push(node);
      return node;
    },
  };
  const takes = { a: { availableStart: 0, availableEnd: 10 * hz, sourceAtContentZero: 0 } };
  const clips = [0, 1].map((i) => ({
    id: i,
    take: "a",
    start: i * hz,
    duration: hz,
    contentIn: 0,
  }));
  const transport = makeTransport(player, ctx, {}, clips, takes);
  try {
    player.dispatchEvent(new Event("playing"));
    player.cb(1000, { expectedDisplayTime: 1000, mediaTime: 0.2 });
    ctx.currentTime = 0.94;
    player.cb(1000, { expectedDisplayTime: 1000, mediaTime: 0.95 });
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0].stopAt, nodes[1].startAt);
  } finally {
    transport.dispose();
  }
});

test("a stale native seeked event cannot acknowledge a newer target", async () => {
  const player = Object.assign(new EventTarget(), {
    duration: 20,
    currentTime: 0,
    paused: true,
    readyState: 4,
    requestVideoFrameCallback() {
      return 1;
    },
    cancelVideoFrameCallback() {},
  });
  const transport = makeTransport(player, { getOutputTimestamp() {} }, {}, [], {});
  try {
    const pending = transport.seek(12);
    player.currentTime = 3;
    player.dispatchEvent(new Event("seeked"));
    await Promise.resolve();
    assert.equal(transport.seekInFlight, true);
    player.currentTime = 12;
    player.dispatchEvent(new Event("seeked"));
    assert.equal(await pending, "arrived");
  } finally {
    transport.dispose();
  }
});

test("a 100 ppm clock difference across thirty minutes preserves touching samples and bounded phase", () => {
  for (const skew of [1.0001, 0.9999]) {
    const frames = [];
    const player = Object.assign(new EventTarget(), {
      requestVideoFrameCallback(cb) {
        this.cb = cb;
        return 1;
      },
      cancelVideoFrameCallback() {},
    });
    const ctx = {
      currentTime: 0,
      sampleRate: 48000,
      getOutputTimestamp() {
        return { contextTime: this.currentTime, performanceTime: 1000 };
      },
      createBufferSource() {
        const node = {
          playbackRate: { value: 1 },
          connect() {},
          disconnect() {},
          start(when) {
            this.first = when;
          },
          stop(when) {
            this.last = when;
          },
        };
        frames.push(node);
        return node;
      },
    };
    const clips = Array.from({ length: 180 }, (_, i) => ({
      id: i,
      take: "a",
      start: i * 10 * hz,
      duration: 10 * hz,
      contentIn: 0,
    }));
    const takes = { a: { availableStart: 0, availableEnd: 10 * hz, sourceAtContentZero: 0 } };
    const transport = makeTransport(player, ctx, {}, clips, takes);
    try {
      player.dispatchEvent(new Event("playing"));
      for (let i = 0; i < clips.length; i++) {
        const mediaTime = Math.max(0, i * 10 - 0.05);
        ctx.currentTime = mediaTime / skew;
        player.cb(1000, { expectedDisplayTime: 1000, mediaTime });
      }
      assert.equal(frames.length, clips.length);
      for (let i = 1; i < frames.length; i++) {
        assert.equal(frames[i].first, frames[i - 1].last);
        assert.ok(
          Math.abs(frames[i].first - (10 * i) / skew) < 0.002,
          "Clock error accumulated across seams",
        );
        assert.ok(
          Math.abs((frames[i].last - frames[i].first) * frames[i].playbackRate.value - 10) <
            1 / 48000,
        );
      }
    } finally {
      transport.dispose();
    }
  }
});
