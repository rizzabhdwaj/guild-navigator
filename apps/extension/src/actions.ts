import type { ActionResult } from "./messages";
import { getElementRef, isElementActionable, isElementEditable, resolveElement } from "./snapshot";

// ACTIONS — run inside the content script. This is the only place that mutates
// the page. The model (later) never touches the DOM directly; it can only ask
// for a named action with an elementId, and this module decides whether that is
// allowed and what actually happened.

/** How long to wait after dispatching a click before re-checking the DOM. */
const SETTLE_MS = 350;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Cheap heuristic signature of the current DOM (structure + visible text size). */
function domFingerprint(): string {
  const elementCount = document.querySelectorAll("*").length;
  const textLength = document.body?.textContent?.length ?? 0;
  return `${document.title}|${elementCount}|${textLength}`;
}

function fail(message: string): ActionResult {
  return { success: false, message, pageChanged: false };
}

/**
 * Press one identified interactive element.
 *
 * The id must come from the most recent snapshot: we resolve it to a live node,
 * re-check that it is still actionable, then dispatch a real click. A returned
 * `success` only means the click was dispatched — the caller must re-observe
 * the page to confirm the outcome.
 */
export async function clickElement(elementId: string): Promise<ActionResult> {
  const ref = getElementRef(elementId);
  if (!ref) return fail(`Unknown elementId "${elementId}". Call read_page first.`);

  const el = resolveElement(elementId);
  if (!el) return fail(`Element "${elementId}" is no longer on the page. Call read_page again.`);

  if (!ref.interactive) return fail(`Element "${elementId}" is not interactive.`);

  if (!isElementActionable(el)) {
    return fail(`Element "${elementId}" is not actionable (hidden, disabled, or inert).`);
  }

  const beforeUrl = location.href;
  const beforeFingerprint = domFingerprint();

  // Bring it into view so handlers that depend on visibility still fire.
  el.scrollIntoView?.({ block: "center", inline: "center" });

  try {
    el.click();
  } catch (error) {
    return fail(`Clicking "${elementId}" threw: ${String(error)}`);
  }

  // Let any synchronous handlers, SPA route changes and micro-updates settle.
  // A full navigation destroys this script before the timer fires; in that case
  // the caller sees the dropped response and treats it as a page change.
  await delay(SETTLE_MS);

  const pageChanged = location.href !== beforeUrl || domFingerprint() !== beforeFingerprint;
  const label = ref.name ?? ref.text ?? elementId;
  return {
    success: true,
    message: `Pressed "${label}".`,
    pageChanged,
  };
}

/** Set a field's value the React-compatible way (native setter + events). */
function setFieldValue(el: HTMLElement, value: string): void {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  } else {
    el.textContent = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Type text into one identified field. The value is intentionally never echoed
 * back in the result: an ActionResult may be logged or shown, and a password
 * must not leak through it.
 */
export async function fillElement(elementId: string, text: string): Promise<ActionResult> {
  const ref = getElementRef(elementId);
  if (!ref) return fail(`Unknown elementId "${elementId}". Call read_page first.`);

  const el = resolveElement(elementId);
  if (!el) return fail(`Element "${elementId}" is no longer on the page. Call read_page again.`);

  if (!ref.editable) return fail(`Element "${elementId}" is not a text field.`);
  if (!isElementEditable(el)) return fail(`Element "${elementId}" is not editable (hidden, disabled, or read-only).`);

  const beforeFingerprint = domFingerprint();
  el.focus?.();
  try {
    setFieldValue(el, text);
  } catch (error) {
    return fail(`Filling "${elementId}" threw: ${String(error)}`);
  }

  await delay(50);
  const label = ref.name ?? ref.placeholder ?? elementId;
  return {
    success: true,
    message: `Filled "${label}".`, // never includes the value
    pageChanged: domFingerprint() !== beforeFingerprint,
  };
}
