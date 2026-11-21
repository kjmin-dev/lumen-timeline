const html = "http://www.w3.org/1999/xhtml";

/**
 * Checks an HTML element by namespace and local name. Unlike `instanceof`, this
 * works for nodes from another document or frame.
 */
export function isTag<K extends keyof HTMLElementTagNameMap>(
  node: unknown,
  tag: K,
): node is HTMLElementTagNameMap[K] {
  return (
    typeof node === "object" &&
    node !== null &&
    Reflect.get(node, "namespaceURI") === html &&
    Reflect.get(node, "localName") === tag
  );
}

/** Finds an element of the view's own template, which always contains it. */
export function element<K extends keyof HTMLElementTagNameMap>(
  root: ParentNode,
  selector: string,
  tag: K,
): HTMLElementTagNameMap[K] {
  const found = root.querySelector(selector);
  if (!isTag(found, tag)) throw new Error("Timeline template is missing " + selector);
  return found;
}

/** The upper-case tag name of an event target, or undefined for non-elements. */
export function tagName(target: EventTarget | null): unknown {
  return target ? Reflect.get(target, "tagName") : undefined;
}

/** Registers a listener that ends with the view. */
export type Listen = <K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  listener: (event: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions,
) => void;
