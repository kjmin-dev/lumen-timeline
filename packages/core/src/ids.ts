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

/** The largest counter the project already uses under `<actor>-<n>`. */
function lastCounter(actor: string, project: ProjectSnapshot): number {
  const prefix = actor + "-";
  let last = 0;
  const visit = (items: readonly { readonly id: string }[] | undefined): void => {
    for (const { id } of items ?? []) {
      if (!id.startsWith(prefix)) continue;
      const digits = id.slice(prefix.length);
      const counter = Number(digits);
      if (Number.isSafeInteger(counter) && String(counter) === digits && counter > last)
        last = counter;
    }
  };
  visit(project.clips);
  visit(project.markers);
  visit(project.takes);
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
  let counter = lastCounter(name, project);
  return {
    next(taken) {
      let id;
      do {
        id = name + "-" + ++counter;
      } while (taken(id));
      return id;
    },
    advance(next) {
      counter = Math.max(counter, lastCounter(name, next));
    },
  };
}
