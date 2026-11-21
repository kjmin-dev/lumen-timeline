/**
 * Checks an HTML element by namespace and local name. Unlike `instanceof`, this
 * works for nodes from another document or frame.
 */
export declare function isTag<K extends keyof HTMLElementTagNameMap>(node: unknown, tag: K): node is HTMLElementTagNameMap[K];
/** Finds an element of the view's own template, which always contains it. */
export declare function element<K extends keyof HTMLElementTagNameMap>(root: ParentNode, selector: string, tag: K): HTMLElementTagNameMap[K];
/** The upper-case tag name of an event target, or undefined for non-elements. */
export declare function tagName(target: EventTarget | null): unknown;
/** Registers a listener that ends with the view. */
export type Listen = <K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, listener: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions) => void;
