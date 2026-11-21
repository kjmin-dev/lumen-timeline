/**
 * Returns a value that the surrounding code guarantees to exist. A missing value
 * means a broken internal invariant, which is reported instead of propagating
 * `undefined` into the audio graph.
 */
export function defined<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error("Lumen Timeline invariant failed: " + what);
  return value;
}
