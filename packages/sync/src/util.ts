import type { SyncMessage } from "./types.ts";

const kinds: ReadonlySet<string> = new Set([
  "hello",
  "snapshot",
  "joined",
  "refused",
  "submit",
  "accepted",
  "rejected",
  "presence",
]);

/** A value that names a known message type. Each handler checks its own fields. */
export function isMessage(value: unknown): value is SyncMessage {
  if (typeof value !== "object" || value === null) return false;
  const type: unknown = Reflect.get(value, "type");
  return typeof type === "string" && kinds.has(type);
}

/** An actor name the core accepts: nonempty, and safe as an ID prefix. */
export function validActor(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._]{1,64}$/.test(value);
}

// The package compiles without DOM or Node declarations, so it reads optional
// host capabilities from the global object and checks each one.
function hostRandomId(): string | undefined {
  const crypto: unknown = Reflect.get(globalThis, "crypto");
  if (typeof crypto !== "object" || crypto === null) return undefined;
  const randomUUID: unknown = Reflect.get(crypto, "randomUUID");
  if (typeof randomUUID !== "function") return undefined;
  const id: unknown = Reflect.apply(randomUUID, crypto, []);
  return typeof id === "string" ? id : undefined;
}

/** A random actor of twelve lowercase letters and digits. */
export function randomActor(): string {
  const uuid = hostRandomId();
  if (uuid) return uuid.replaceAll("-", "").slice(0, 12);
  let token = "";
  while (token.length < 12) token += Math.floor(Math.random() * 36 ** 6).toString(36);
  return token.slice(0, 12);
}

/**
 * Whether two JSON values hold the same data, whatever the order of their
 * keys. Values that are one object are equal without a look inside, which is
 * most of two snapshots that share their records.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) if (!sameJson(a[index], b[index])) return false;
    return true;
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys)
    if (!Object.hasOwn(b, key) || !sameJson(Reflect.get(a, key), Reflect.get(b, key))) return false;
  return true;
}

/** JSON with object keys sorted and undefined fields dropped, for comparing values. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "object" && item !== null && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}
