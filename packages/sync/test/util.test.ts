import assert from "node:assert/strict";
import test from "node:test";
import { canonical, sameJson } from "@lumen-timeline/sync/internal";
import { seeded } from "./fixtures.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A small JSON value. Few distinct leaves and keys, so that two often agree. */
function value(random: (n: number) => number, depth: number): Json {
  const kind = random(depth > 0 ? 7 : 4);
  if (kind === 0) return null;
  if (kind === 1) return random(2) === 0;
  if (kind === 2) return [0, -0, 1, 1.5, -2][random(5)] ?? 0;
  if (kind === 3) return ["", "a", "b"][random(3)] ?? "";
  if (kind === 4) return Array.from({ length: random(3) }, () => value(random, depth - 1));
  const object: { [key: string]: Json } = {};
  for (let n = random(4); n > 0; n--)
    object[["id", "start", "takeIds"][random(3)] ?? "id"] = value(random, depth - 1);
  return object;
}

/** The value with one place changed: a leaf, an element or a key, at any depth. */
function altered(json: Json, random: (n: number) => number): Json {
  if (typeof json !== "object" || json === null) return value(random, 0);
  if (Array.isArray(json)) {
    const at = random(json.length + 1);
    // One past the end adds an element; the last place may also lose its element.
    if (at === json.length) return [...json, value(random, 1)];
    if (at === json.length - 1 && random(2)) return json.slice(0, -1);
    return json.map((item, index) => (index === at ? altered(item, random) : item));
  }
  const keys = Object.keys(json);
  const key = keys[random(keys.length + 1)];
  if (key === undefined) return { ...json, extra: value(random, 1) };
  return { ...json, [key]: altered(json[key] ?? null, random) };
}

/** The same value with the keys of every object in another order. */
function reordered(json: Json): Json {
  if (typeof json !== "object" || json === null) return json;
  if (Array.isArray(json)) return json.map(reordered);
  return Object.fromEntries(
    Object.entries(json)
      .toReversed()
      .map(([key, item]) => [key, reordered(item)]),
  );
}

// The session once compared two documents by their canonical JSON text.
test("values hold the same data exactly when their canonical JSON is the same text", () => {
  const random = seeded(7);
  let same = 0;
  let different = 0;
  for (let round = 0; round < 4000; round++) {
    const a = value(random, 3);
    // A quarter differ in key order alone, a quarter in one place, the rest are unrelated.
    const b =
      round % 4 === 0 ? reordered(a) : round % 4 === 1 ? altered(a, random) : value(random, 3);
    const expected = canonical(a) === canonical(b);
    assert.equal(sameJson(a, b), expected, canonical(a) + " against " + canonical(b));
    assert.equal(sameJson(b, a), expected);
    if (expected) same++;
    else different++;
  }
  assert.ok(same > 1000 && different > 1000, `${same} same, ${different} different`);
  // A key the other value only inherits is not a key they share.
  const inherited: Json = JSON.parse('{"__proto__":{}}');
  assert.ok(!sameJson(inherited, { other: 1 }));
  assert.notEqual(canonical(inherited), canonical({ other: 1 }));
});

test("values that are one object are the same without a look inside", () => {
  let reads = 0;
  const watched = new Proxy(
    { id: "clip" },
    {
      ownKeys(target) {
        reads++;
        return Reflect.ownKeys(target);
      },
    },
  );
  assert.ok(sameJson([watched, 1], [watched, 1]));
  assert.equal(reads, 0);
  assert.ok(sameJson([watched], [{ id: "clip" }]));
  assert.ok(reads > 0);
});
