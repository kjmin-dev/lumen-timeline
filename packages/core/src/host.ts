// Optional host capabilities. The core compiles without DOM or Node
// declarations, so it reads them from the global object and checks each one.
export function hostRandomId(): string | undefined {
  const crypto: unknown = Reflect.get(globalThis, "crypto");
  if (typeof crypto !== "object" || crypto === null) return undefined;
  const randomUUID: unknown = Reflect.get(crypto, "randomUUID");
  if (typeof randomUUID !== "function") return undefined;
  const id: unknown = Reflect.apply(randomUUID, crypto, []);
  return typeof id === "string" ? id : undefined;
}

// Report a listener failure without interrupting delivery to other listeners.
export function reportListenerError(error: unknown): void {
  const report: unknown = Reflect.get(globalThis, "reportError");
  if (typeof report === "function") {
    Reflect.apply(report, globalThis, [error]);
    return;
  }
  const queue: unknown = Reflect.get(globalThis, "queueMicrotask");
  if (typeof queue !== "function") throw error;
  Reflect.apply(queue, undefined, [
    () => {
      throw error;
    },
  ]);
}
