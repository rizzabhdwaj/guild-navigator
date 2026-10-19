import { JSDOM, VirtualConsole } from "jsdom";
import type { ElementRef, PageSnapshot } from "../src/messages";

// Shared jsdom harness for the extractor tests. snapshot.ts reads the DOM
// through globals, so we install a fresh window/document before each scan.
// jsdom has no layout engine, so tests stub getBoundingClientRect.

const GLOBAL_KEYS = [
  "window", "document", "location", "navigator", "NodeFilter", "Node", "Element",
  "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement",
  "HTMLButtonElement", "HTMLAnchorElement", "HTMLAreaElement", "HTMLOptionElement",
  "HTMLFormElement", "HTMLTableCellElement", "HTMLImageElement", "Event", "MouseEvent",
] as const;

export function setup(body: string, url = "https://example.com/page"): void {
  const dom = new JSDOM(`<!doctype html><html lang="en"><head><title>Test</title></head><body>${body}</body></html>`, {
    url,
    virtualConsole: new VirtualConsole(), // keep jsdom's "not implemented" noise out
  });
  const w = dom.window as unknown as Record<string, unknown>;
  for (const key of GLOBAL_KEYS) {
    // defineProperty: some Node globals (e.g. navigator) are getter-only.
    Object.defineProperty(globalThis, key, { value: w[key], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, "getComputedStyle", {
    value: (dom.window.getComputedStyle as (el: Element) => CSSStyleDeclaration).bind(dom.window),
    configurable: true,
    writable: true,
  });
}

/** Give an element a visible, non-zero box (jsdom has no layout engine). */
export function box(
  el: Element | null,
  r: { x?: number; y?: number; width?: number; height?: number } = {},
): Element {
  if (!el) throw new Error("box() needs an element");
  const x = r.x ?? 0;
  const y = r.y ?? 0;
  const width = r.width ?? 100;
  const height = r.height ?? 20;
  const rect = { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height };
  (el as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => ({
    ...rect,
    toJSON: () => rect,
  });
  (el as unknown as { getClientRects: () => unknown }).getClientRects = () => [rect];
  return el;
}

export function previewAll(): void {
  for (const el of document.querySelectorAll("*")) box(el);
}

export function find(snapshot: PageSnapshot, pred: (e: ElementRef) => boolean): ElementRef {
  const ref = snapshot.elements.find(pred);
  if (!ref) throw new Error("element not found in snapshot");
  return ref;
}

export const byTag = (tag: string) => (e: ElementRef) => e.tag === tag;
export const byName = (name: string) => (e: ElementRef) => e.name === name;
