import test from "node:test";
import assert from "node:assert/strict";
import {
  unitsToTicks,
  ticksToUnits,
  TICKS_PER_SECOND as hz,
  sourceWindow,
} from "@lumen-timeline/core";
import { splitClip } from "@lumen-timeline/core/internal";

test("native sample and fractional-frame boundaries survive a seven-day round trip", () => {
  for (const [num, den] of [
    [44100, 1],
    [48000, 1],
    [30000, 1001],
    [24000, 1001],
  ]) {
    for (const seconds of [0, 1, 1800, 86400 * 7]) {
      const unit = Math.floor((seconds * num) / den);
      assert.equal(ticksToUnits(unitsToTicks(unit, num, den), num, den), unit);
    }
  }
  assert.equal(unitsToTicks(1, 30000, 1001), 9417408);
  assert.equal(unitsToTicks(-1, 48000), -5880);
  assert.throws(() => unitsToTicks(3, 0), RangeError);
  assert.throws(() => unitsToTicks(Number.MAX_SAFE_INTEGER, 1), RangeError);
});

test("seek into a clip, split its source, switch the right take and restore", () => {
  const clip = { id: "line", start: 12 * hz, duration: 4 * hz, contentIn: hz, take: "A" };
  const a = { sourceAtContentZero: 0, availableStart: 0, availableEnd: 8 * hz };
  const b = { ...a, sourceAtContentZero: -1.5 * hz, availableEnd: 2 * hz };
  const window = sourceWindow(clip, a, 14 * hz, 16 * hz);
  assert.ok(window);
  assert.equal(window.sourceStart, 3 * hz);
  const [left, right] = splitClip(clip, 14 * hz, "right");
  assert.equal(sourceWindow(left, a, 14 * hz, 16 * hz), null);
  assert.deepEqual(sourceWindow(right, b, 0, 16 * hz), {
    start: 14 * hz,
    end: 14.5 * hz,
    sourceStart: 1.5 * hz,
    sourceEnd: 2 * hz,
  });
  assert.deepEqual(
    sourceWindow(right, a, 14 * hz, 16 * hz),
    sourceWindow(clip, a, 14 * hz, 16 * hz),
  );
  assert.throws(() => splitClip(clip, clip.start, "right"), RangeError);
});

test("both conversion directions agree with exact rational rounding, including half ties and overflow", () => {
  function oracle(value: number, multiplier: bigint, divisor: bigint): number {
    const magnitude = (BigInt(Math.abs(value)) * multiplier + divisor / 2n) / divisor;
    return Number(value < 0 ? -magnitude : magnitude);
  }
  for (const value of [0, 1, -1, 2940, -2940, 987654321, -(2 ** 49 + 1), Number.MAX_SAFE_INTEGER]) {
    for (const [num, den] of [
      [48000, 1],
      [30000, 1001],
      [90001, 1],
      [120000001, 123456789],
    ]) {
      const scale = BigInt(hz) * BigInt(den);
      for (const [fn, mul, div] of [
        [unitsToTicks, scale, BigInt(num)],
        [ticksToUnits, BigInt(num), scale],
      ] as const) {
        const expected = oracle(value, mul, div);
        if (Number.isSafeInteger(expected)) assert.equal(fn(value, num, den), expected);
        else assert.throws(() => fn(value, num, den), RangeError);
      }
    }
  }
});

test("fractional frames partition thirty minutes of 44.1 and 48 kHz audio without accumulated drift", () => {
  const frames = Math.floor((1800 * 30000) / 1001);
  for (const rate of [44100, 48000]) {
    let samples = 0;
    for (let frame = 1; frame <= frames; frame++) {
      const boundary = ticksToUnits(unitsToTicks(frame, 30000, 1001), rate);
      const length = boundary - samples;
      assert.ok(
        length === Math.floor((rate * 1001) / 30000) || length === Math.ceil((rate * 1001) / 30000),
      );
      samples += length;
    }
    assert.equal(samples, Math.round((frames * rate * 1001) / 30000));
  }
});
