import { hostRandomId } from "./host.ts";
import type { ProjectSnapshot } from "./types.ts";

/** A random actor for a session whose host named none. */
function randomActor(): string {
  const uuid = hostRandomId();
  if (uuid !== undefined) return uuid.replaceAll("-", "").slice(0, 12);
  // Embedded HTTP editors may lack randomUUID.
  let token = "";
  while (token.length < 12) token += Math.floor(Math.random() * 36 ** 6).toString(36);
  return token.slice(0, 12);
}

type Records = readonly { readonly id: string }[] | undefined;

/** The largest counter a list of records already uses under `<actor>-<n>`. */
function lastCounter(prefix: string, items: Records): number {
  let last = 0;
  for (const { id } of items ?? []) {
    if (!id.startsWith(prefix)) continue;
    const digits = id.slice(prefix.length);
    const counter = Number(digits);
    if (Number.isSafeInteger(counter) && String(counter) === digits && counter > last)
      last = counter;
  }
  return last;
}

/** The IDs an editing session generates. */
export interface IdAllocator {
  /** The next unused ID. `taken` rejects an ID that is in use. */
  next(taken: (id: string) => boolean): string;
  /** Moves the counter past every ID of this actor that `project` carries. It never moves back. */
  advance(project: ProjectSnapshot): void;
}

/**
 * Allocates the IDs an editing session generates: `<actor>-<n>`, counting on
 * from the IDs the project already carries for that actor. One counter serves
 * clips, markers and takes.
 */
export function idAllocator(actor: string | undefined, project: ProjectSnapshot): IdAllocator {
  const name = actor ?? randomActor();
  const prefix = name + "-";
  let counter = 0;
  // The lists the counter is already past. Snapshots share the lists an edit
  // left alone, and reading one again would find nothing new.
  const read = new WeakSet<object>();
  function pass(items: Records): void {
    if (!items || read.has(items)) return;
    read.add(items);
    counter = Math.max(counter, lastCounter(prefix, items));
  }
  function advance(next: ProjectSnapshot): void {
    pass(next.clips);
    pass(next.markers);
    pass(next.takes);
  }
  advance(project);
  return {
    next(taken) {
      let id;
      do {
        id = name + "-" + ++counter;
      } while (taken(id));
      return id;
    },
    advance,
  };
}
