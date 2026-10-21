import type {
  ComponentContext,
  ComponentState,
  ContextRequest,
  ContextValue,
  DialogInfo,
  ElementRef,
  ExtractionLimits,
  FormInfo,
  Heading,
  Landmark,
  PageSnapshot,
  RowContext,
  SelectOption,
} from "./messages";

// SNAPSHOT EXTRACTION
// -------------------
// Pure DOM reading (no browser.* APIs), so it can be unit-tested in jsdom.
// It never clicks, submits, mutates the page, or runs page scripts.
//
// Three layers:
//   A. page context   -> url/title/headings/landmarks/forms/dialogs/summary
//   B. components     -> meaningful regions that organize elements
//   C. elements       -> reference their component instead of repeating it
//
// Reference model: elements and components each get an internal id. The id ->
// node maps are the ONLY way to resolve an id back to a node; we never expose
// or execute selectors. See resolveElement() for the lifecycle rules.

export const DEFAULT_LIMITS: ExtractionLimits = {
  maxElements: 400,
  maxNameLength: 120,
  maxTextLength: 160,
  maxDescriptionLength: 160,
  maxContextLength: 80,
  maxOptions: 30,
  maxHeadings: 60,
  maxLandmarks: 20,
  maxForms: 25,
  maxSummaryLength: 600,
  obscuredCheckLimit: 200,
  maxComponents: 200,
  maxComponentTextLength: 300,
  maxNearbyTextLength: 120,
  maxRowColumns: 8,
};

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export function normalizeSpace(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** innerText reflects rendered text; textContent is the jsdom/fallback path. */
function rawText(el: Element): string {
  const inner = (el as { innerText?: string }).innerText;
  return normalizeSpace(typeof inner === "string" ? inner : el.textContent);
}

// ---------------------------------------------------------------------------
// Element id registry (stable references, never reused)
// ---------------------------------------------------------------------------

let idCounter = 0;
const idByElement = new WeakMap<Element, string>();
const elementById = new Map<string, HTMLElement>();
let lastElements: ElementRef[] = [];

function idFor(el: Element): string {
  let id = idByElement.get(el);
  if (!id) {
    // Monotonic ids are never reused, so a stale id can never point at a
    // different element after a rescan. The WeakMap keeps ids stable for an
    // element across scans while it stays connected.
    id = `e${++idCounter}`;
    idByElement.set(el, id);
  }
  return id;
}

/**
 * Resolve a snapshot id to its DOM node. Returns null if the node is detached
 * (the page changed / navigated), in which case a fresh snapshot is required.
 */
export function resolveElement(id: string): HTMLElement | null {
  const el = elementById.get(id);
  if (!el) return null;
  if (!el.isConnected) {
    elementById.delete(id);
    return null;
  }
  return el;
}

/**
 * Re-check actionability against the LIVE DOM (the last snapshot may be stale).
 * Mirrors the `actionable` flag computed in buildElementRef.
 */
export function isElementActionable(el: HTMLElement): boolean {
  const role = resolveRole(el);
  return isRendered(el) && !isDisabled(el) && !isInert(el) && hasInteraction(el, role);
}

/** Re-check editability against the LIVE DOM (mirrors buildElementRef.editable). */
export function isElementEditable(el: HTMLElement): boolean {
  return isRendered(el) && !isDisabled(el) && !isInert(el) && isEditable(el);
}

/** Retrieve a slice of the most recent full element list (see GET_ELEMENTS). */
export function getStoredElements(
  offset: number,
  limit: number,
): { elements: ElementRef[]; total: number } {
  const start = Math.max(0, offset);
  return {
    elements: lastElements.slice(start, start + Math.max(0, limit)),
    total: lastElements.length,
  };
}

// ---------------------------------------------------------------------------
// Component registry (stable references, never reused)
// ---------------------------------------------------------------------------

let componentCounter = 0;
const componentIdByNode = new WeakMap<Element, string>();
const componentNodeById = new Map<string, HTMLElement>();
let componentsById = new Map<string, ComponentContext>();
let elementsById = new Map<string, ElementRef>();

function idForComponent(el: Element): string {
  let id = componentIdByNode.get(el);
  if (!id) {
    id = `c${++componentCounter}`;
    componentIdByNode.set(el, id);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Per-scan caches / derived maps (avoid repeated DOM work)
// ---------------------------------------------------------------------------

let styleCache = new WeakMap<Element, CSSStyleDeclaration>();
let rectCache = new WeakMap<Element, DOMRect>();
let obscuredChecks = 0;
// node -> component id, for components INCLUDED in the current snapshot only.
let currentComponentIdByNode = new WeakMap<Element, string>();
let currentKindByNode = new WeakMap<Element, string>();
let currentHeadingByComponentId = new Map<string, string>();
let currentVisibleTextByComponentId = new Map<string, string>();
let currentRepeatedCards = new Set<Element>();

function computedStyle(el: Element): CSSStyleDeclaration {
  let s = styleCache.get(el);
  if (!s) {
    s = getComputedStyle(el);
    styleCache.set(el, s);
  }
  return s;
}

function boxOf(el: Element): DOMRect {
  let r = rectCache.get(el);
  if (!r) {
    r = el.getBoundingClientRect();
    rectCache.set(el, r);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

const ACTIONABLE_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "combobox",
  "listbox",
  "option",
  "treeitem",
  "gridcell",
  "textbox",
  "searchbox",
]);

const TEXT_NAME_ROLES = new Set([...ACTIONABLE_ROLES, "heading"]);

function explicitRole(el: Element): string | null {
  const role = el.getAttribute("role");
  if (!role) return null;
  const first = role.trim().split(/\s+/)[0]?.toLowerCase();
  return first || null;
}

function implicitRole(el: HTMLElement): string | null {
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case "a":
    case "area":
      return el.hasAttribute("href") ? "link" : null;
    case "button":
      return "button";
    case "select": {
      const select = el as HTMLSelectElement;
      return select.multiple || select.size > 1 ? "listbox" : "combobox";
    }
    case "textarea":
      return "textbox";
    case "input": {
      switch ((el as HTMLInputElement).type.toLowerCase()) {
        case "checkbox":
          return "checkbox";
        case "radio":
          return "radio";
        case "range":
          return "slider";
        case "number":
          return "spinbutton";
        case "button":
        case "submit":
        case "reset":
        case "image":
          return "button";
        case "search":
          return "searchbox";
        default:
          return "textbox";
      }
    }
    case "summary":
      return "button";
    case "nav":
      return "navigation";
    case "main":
      return "main";
    case "header":
      return "banner";
    case "footer":
      return "contentinfo";
    case "aside":
      return "complementary";
    case "form":
      return "form";
    case "dialog":
      return "dialog";
    case "option":
      return "option";
    case "img":
      return "img";
    case "ul":
    case "ol":
      return "list";
    case "li":
      return "listitem";
    case "table":
      return "table";
    default:
      return /^h[1-6]$/.test(tag) ? "heading" : null;
  }
}

function resolveRole(el: Element): string | null {
  return explicitRole(el) ?? implicitRole(el as HTMLElement);
}

function headingLevel(el: Element): number | null {
  const tag = el.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return Number(tag[1]);
  if (resolveRole(el) === "heading") {
    const level = Number(el.getAttribute("aria-level"));
    return Number.isFinite(level) && level > 0 ? level : 2;
  }
  return null;
}

function isHeading(el: Element): boolean {
  return headingLevel(el) !== null;
}

// ---------------------------------------------------------------------------
// Accessible name / description
// ---------------------------------------------------------------------------

/** Resolve aria-labelledby / aria-describedby. Missing ids are ignored. */
function ariaReferences(el: Element, attr: string): Element[] {
  const ids = el.getAttribute(attr);
  if (!ids) return [];
  const doc = el.ownerDocument;
  const out: Element[] = [];
  for (const id of ids.trim().split(/\s+/)) {
    if (!id) continue;
    const ref = doc.getElementById(id); // getElementById is safe with odd ids
    if (ref) out.push(ref);
  }
  return out;
}

function associatedLabel(el: HTMLElement): string | null {
  const labels = (el as { labels?: NodeListOf<HTMLLabelElement> | null }).labels;
  if (labels && labels.length > 0) {
    const text = normalizeSpace(Array.from(labels, (l) => rawText(l)).join(" "));
    if (text) return text;
  }
  const wrapping = el.closest("label");
  if (wrapping) {
    const text = rawText(wrapping);
    if (text) return text;
  }
  return null;
}

function nativeName(el: HTMLElement): string | null {
  const labelled = associatedLabel(el);
  if (labelled) return labelled;

  const tag = el.tagName.toLowerCase();
  if (tag === "img") {
    const alt = el.getAttribute("alt");
    if (alt && alt.trim()) return normalizeSpace(alt);
  }
  if (tag === "input") {
    const input = el as HTMLInputElement;
    if (["button", "submit", "reset"].includes(input.type.toLowerCase())) {
      const value = normalizeSpace(input.value);
      if (value) return value;
    }
  }
  if (tag === "fieldset") {
    const legend = el.querySelector(":scope > legend");
    if (legend) {
      const text = rawText(legend);
      if (text) return text;
    }
  }
  if (tag === "figure") {
    const caption = el.querySelector(":scope > figcaption");
    if (caption) {
      const text = rawText(caption);
      if (text) return text;
    }
  }
  return null;
}

/** Text fallback that also reads descendant image alt text (icon links). */
function textNameFallback(el: Element): string {
  const direct = rawText(el);
  if (direct) return direct;
  const alts = el.querySelectorAll("img[alt]");
  return normalizeSpace(Array.from(alts, (img) => img.getAttribute("alt") ?? "").join(" "));
}

function accessibleName(
  el: HTMLElement,
  role: string | null,
  limits: ExtractionLimits,
): string | null {
  // 1. aria-labelledby (may reference hidden labels, which is correct)
  const labelledby = normalizeSpace(
    ariaReferences(el, "aria-labelledby").map(rawText).join(" "),
  );
  if (labelledby) return truncate(labelledby, limits.maxNameLength);

  // 2. aria-label
  const aria = el.getAttribute("aria-label");
  if (aria && aria.trim()) return truncate(normalizeSpace(aria), limits.maxNameLength);

  // 3. native association / semantics
  const native = nativeName(el);
  if (native) return truncate(native, limits.maxNameLength);

  // 4. visible text, only for elements whose text IS their name
  const tag = el.tagName.toLowerCase();
  const textNameEligible =
    (role !== null && TEXT_NAME_ROLES.has(role)) ||
    ["a", "button", "summary", "label", "option"].includes(tag);
  if (textNameEligible) {
    const text = textNameFallback(el);
    if (text) return truncate(text, limits.maxNameLength);
  }

  // 5. placeholder is a fallback only, never the primary strategy
  const placeholder = el.getAttribute("placeholder");
  if (placeholder && placeholder.trim()) {
    return truncate(normalizeSpace(placeholder), limits.maxNameLength);
  }
  return null;
}

function accessibleDescription(el: HTMLElement, limits: ExtractionLimits): string | null {
  const describedby = normalizeSpace(
    ariaReferences(el, "aria-describedby").map(rawText).join(" "),
  );
  if (describedby) return truncate(describedby, limits.maxDescriptionLength);
  const title = el.getAttribute("title");
  if (title && title.trim()) return truncate(normalizeSpace(title), limits.maxDescriptionLength);
  return null;
}

// ---------------------------------------------------------------------------
// Visibility / states
// ---------------------------------------------------------------------------

function isCssHidden(el: HTMLElement): boolean {
  let node: HTMLElement | null = el;
  while (node) {
    const cs = computedStyle(node);
    if (
      cs.display === "none" ||
      cs.visibility === "hidden" ||
      cs.visibility === "collapse" ||
      cs.opacity === "0" ||
      node.hasAttribute("hidden")
    ) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

function isRendered(el: HTMLElement): boolean {
  if (!el.isConnected || isCssHidden(el)) return false;
  const details = el.closest("details:not([open])");
  if (details && details !== el && !el.closest("summary")) return false;
  const r = boxOf(el);
  return r.width > 0 || r.height > 0 || el.getClientRects().length > 0;
}

function isInViewport(el: HTMLElement): boolean {
  const r = boxOf(el);
  const vw = window.innerWidth || el.ownerDocument.documentElement.clientWidth || 0;
  const vh = window.innerHeight || el.ownerDocument.documentElement.clientHeight || 0;
  return r.bottom > 0 && r.right > 0 && r.left < vw && r.top < vh;
}

function isObscured(el: HTMLElement, limit: number): boolean | null {
  if (obscuredChecks >= limit) return null;
  obscuredChecks++;
  try {
    const r = boxOf(el);
    const x = Math.min(Math.max(r.left + r.width / 2, 0), Math.max(window.innerWidth - 1, 0));
    const y = Math.min(Math.max(r.top + r.height / 2, 0), Math.max(window.innerHeight - 1, 0));
    const top = el.ownerDocument.elementFromPoint(x, y);
    if (!top) return null;
    return !(top === el || el.contains(top) || top.contains(el));
  } catch {
    return null;
  }
}

function isNativeDisabled(el: HTMLElement): boolean {
  if ("disabled" in el && (el as { disabled?: boolean }).disabled) return true;
  try {
    if (el.matches(":disabled")) return true;
  } catch {
    /* ignore selector support differences */
  }
  const fieldset = el.closest("fieldset[disabled]");
  if (fieldset) {
    const legend = fieldset.querySelector(":scope > legend");
    if (!legend || !legend.contains(el)) return true;
  }
  return false;
}

function isDisabled(el: HTMLElement): boolean {
  return el.getAttribute("aria-disabled") === "true" || isNativeDisabled(el);
}

function isReadonly(el: HTMLElement): boolean {
  if (el.getAttribute("aria-readonly") === "true") return true;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.readOnly;
  return false;
}

function isRequired(el: HTMLElement): boolean {
  if (el.getAttribute("aria-required") === "true") return true;
  return "required" in el && (el as { required?: boolean }).required === true;
}

function isInert(el: HTMLElement): boolean {
  return el.closest("[inert]") !== null;
}

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "submit",
  "reset",
  "checkbox",
  "radio",
  "file",
  "image",
  "range",
  "color",
]);

function isEditable(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement) {
    return !el.readOnly && !el.disabled && !NON_TEXT_INPUT_TYPES.has(el.type.toLowerCase());
  }
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el.isContentEditable || el.getAttribute("contenteditable") === "true" || el.getAttribute("contenteditable") === "") return true;
  if (el.matches("textarea.inputarea, textarea[class*='inputarea'], .cm-content")) return true;
  return false;
}

function isFocusable(el: HTMLElement): boolean {
  if (isDisabled(el) || isInert(el)) return false;
  if (el.tabIndex >= 0) return true;
  const tag = el.tagName.toLowerCase();
  return ["a", "area", "button", "input", "select", "textarea", "summary"].includes(tag);
}

function hasInteraction(el: HTMLElement, role: string | null): boolean {
  if (isInert(el)) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "a" || tag === "area") return el.hasAttribute("href");
  if (["button", "input", "select", "textarea"].includes(tag)) return true;
  if (el.isContentEditable || el.getAttribute("contenteditable") === "true" || el.getAttribute("contenteditable") === "") return true;
  if (el.matches("textarea.inputarea, textarea[class*='inputarea'], .cm-content")) return true;
  if (role !== null && ACTIONABLE_ROLES.has(role)) return true;
  return el.hasAttribute("onclick");
}

function ariaBool(el: Element, attr: string): boolean | null {
  const value = el.getAttribute(attr);
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function checkedState(el: HTMLElement, role: string | null): boolean | null {
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    return el.checked;
  }
  if (role && ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(role)) {
    return ariaBool(el, "aria-checked");
  }
  return null;
}

function selectedState(el: HTMLElement, role: string | null): boolean | null {
  if (el instanceof HTMLOptionElement) return el.selected;
  if (role && ["option", "tab", "gridcell", "row", "treeitem"].includes(role)) {
    return ariaBool(el, "aria-selected");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sensitive values
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERN =
  /(pass(word|wd)?|secret|token|pin|ssn|social|card|credit|cvv|cvc|security|account|routing|iban|otp|auth)/i;
const SENSITIVE_AUTOCOMPLETE = new Set([
  "current-password",
  "new-password",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "one-time-code",
]);

function isSensitiveField(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement && el.type.toLowerCase() === "password") return true;
  const autocomplete = (el.getAttribute("autocomplete") ?? "").toLowerCase();
  if (SENSITIVE_AUTOCOMPLETE.has(autocomplete)) return true;
  for (const attr of ["name", "id", "placeholder"]) {
    const value = el.getAttribute(attr);
    if (value && SENSITIVE_PATTERN.test(value)) return true;
  }
  return false;
}

function safeValue(el: HTMLElement, limits: ExtractionLimits): { value: string | null; truncated: boolean } {
  if (isSensitiveField(el)) return { value: null, truncated: false };
  if (el instanceof HTMLInputElement) {
    if (["password", "hidden", "file", "checkbox", "radio"].includes(el.type.toLowerCase())) {
      return { value: null, truncated: false };
    }
    const value = normalizeSpace(el.value);
    return { value: value ? truncate(value, limits.maxTextLength) : null, truncated: value.length > limits.maxTextLength };
  }
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const value = normalizeSpace(el.value);
    return { value: value ? truncate(value, limits.maxTextLength) : null, truncated: value.length > limits.maxTextLength };
  }
  return { value: null, truncated: false };
}

function selectOptions(
  el: HTMLElement,
  limits: ExtractionLimits,
): { options: SelectOption[] | null; truncated: boolean } {
  if (!(el instanceof HTMLSelectElement)) return { options: null, truncated: false };
  const all: SelectOption[] = Array.from(el.options, (o) => ({
    value: truncate(normalizeSpace(o.value), limits.maxTextLength),
    label: truncate(normalizeSpace(o.textContent), limits.maxNameLength),
    selected: o.selected,
  }));
  if (all.length <= limits.maxOptions) return { options: all, truncated: false };

  // Keep the head of the list plus any selected options so state is never lost.
  const kept = all.slice(0, limits.maxOptions);
  for (const option of all) {
    if (option.selected && !kept.includes(option)) kept.push(option);
  }
  return { options: kept, truncated: true };
}

// ---------------------------------------------------------------------------
// Candidate discovery (single traversal, incl. open shadow roots)
// ---------------------------------------------------------------------------

const STRONG_SELECTOR = [
  "a[href]",
  "area[href]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "[contenteditable='']",
  "[contenteditable='true']",
  "textarea.inputarea",
  ".cm-content",
].join(",");

function collectAllElements(): HTMLElement[] {
  const all: HTMLElement[] = [];
  const visit = (root: ParentNode): void => {
    for (const el of root.querySelectorAll<HTMLElement>("*")) {
      all.push(el);
      // Open shadow roots only; closed roots are not observable (documented).
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(document);
  return all;
}

function isCandidate(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "html" || tag === "body") return false;
  if (el.matches(STRONG_SELECTOR)) return true;
  const role = resolveRole(el);
  if (role !== null && ACTIONABLE_ROLES.has(role)) return true;
  if (el.hasAttribute("onclick")) return true;
  const tabindex = el.getAttribute("tabindex");
  // Keyboard-focusable tabindex. tabindex="-1" is programmatic only, so it is
  // not treated as actionable on its own.
  if (tabindex !== null && Number.isFinite(Number(tabindex)) && Number(tabindex) >= 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Component detection
// ---------------------------------------------------------------------------

const LANDMARK_SELECTOR =
  "main,nav,header,footer,aside,form,[role='main'],[role='navigation'],[role='banner'],[role='contentinfo'],[role='complementary'],[role='search'],[role='region']";
const DIALOG_SELECTOR = "dialog,[role='dialog'],[role='alertdialog']";
const SECTIONING_SELECTOR =
  "article,aside,nav,section,main,[role='main'],[role='region'],[role='navigation'],[role='complementary'],[role='application']";

/** Kinds whose first owned heading is a useful `sectionHeading` for elements. */
const HEADING_COMPONENT_KINDS = new Set([
  "section",
  "card",
  "list-item",
  "table-row",
  "fieldgroup",
  "dialog",
  "disclosure",
  "tabpanel",
]);

/** Kinds that only matter when they actually contain an interactive element. */
const NEEDS_ACTION = new Set(["card", "list-item", "table-row", "list"]);

function componentKind(el: Element): string | null {
  if (el.matches(DIALOG_SELECTOR)) return "dialog";
  if (el.matches("form,[role='form']")) return "form";
  if (el.matches("fieldset,[role='group'],[role='radiogroup']")) return "fieldgroup";
  if (el.matches("details")) return "disclosure";
  if (el.matches("table,[role='table'],[role='grid']")) return "table";
  if (el.matches("tr,[role='row']")) return "table-row";
  if (el.matches("nav,[role='navigation']")) return "nav";
  if (el.matches("menu,[role='menu'],[role='menubar']")) return "menu";
  if (el.matches("[role='tablist']")) return "tablist";
  if (el.matches("[role='tabpanel']")) return "tabpanel";
  if (el.matches("article")) return "card";
  if (el.matches("ul,ol,[role='list']")) return "list";
  if (el.matches("li,[role='listitem']")) return "list-item";
  if (el.matches("section,[role='region']")) return "section";
  if (
    el.matches(
      "main,header,footer,aside,[role='main'],[role='banner'],[role='contentinfo'],[role='complementary'],[role='search']",
    )
  ) {
    return "landmark";
  }
  // Conservative generic "card": only repeated same-tag siblings that each
  // contain interactive content (no arbitrary CSS class inspection).
  if (currentRepeatedCards.has(el)) return "card";
  return null;
}

function ancestorSet(nodes: Element[]): Set<Element> {
  const set = new Set<Element>();
  for (const node of nodes) {
    let parent: Element | null = node;
    while (parent) {
      set.add(parent);
      parent = parent.parentElement;
    }
  }
  return set;
}

/** Direct children sharing a tag where >=2 of them contain interactive content. */
function findRepeatedCards(all: HTMLElement[], withCandidate: Set<Element>): Set<Element> {
  const repeated = new Set<Element>();
  for (const parent of all) {
    const children = Array.from(parent.children);
    if (children.length < 2) continue;
    const byTag = new Map<string, Element[]>();
    for (const child of children) {
      const group = byTag.get(child.tagName) ?? [];
      group.push(child);
      byTag.set(child.tagName, group);
    }
    for (const group of byTag.values()) {
      if (group.length < 2) continue;
      // A card wraps the action; it is not the action itself. Exclude siblings
      // that are already controls (buttons, inputs, links, tabindex elements).
      const interactive = group.filter(
        (child) => withCandidate.has(child) && !isCandidate(child as HTMLElement),
      );
      if (interactive.length < 2) continue;
      for (const child of interactive) repeated.add(child);
    }
  }
  return repeated;
}

function isSectioning(el: Element): boolean {
  return el.matches(SECTIONING_SELECTOR);
}

function nearestComponentId(node: Element | null): string | null {
  let current: Element | null = node;
  while (current) {
    const id = currentComponentIdByNode.get(current);
    if (id) return id;
    current = current.parentElement;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Component metadata
// ---------------------------------------------------------------------------

function componentName(el: HTMLElement, limits: ExtractionLimits): string | null {
  const labelledby = normalizeSpace(
    ariaReferences(el, "aria-labelledby").map(rawText).join(" "),
  );
  if (labelledby) return truncate(labelledby, limits.maxContextLength);
  const aria = el.getAttribute("aria-label");
  if (aria && aria.trim()) return truncate(normalizeSpace(aria), limits.maxContextLength);

  const tag = el.tagName.toLowerCase();
  if (tag === "fieldset") {
    const legend = el.querySelector(":scope > legend");
    if (legend) {
      const text = rawText(legend);
      if (text) return truncate(text, limits.maxContextLength);
    }
  }
  if (tag === "table" || explicitRole(el) === "table") {
    const caption = el.querySelector("caption");
    if (caption) {
      const text = rawText(caption);
      if (text) return truncate(text, limits.maxContextLength);
    }
  }
  return null;
}

function containerDescription(el: HTMLElement, limits: ExtractionLimits): string | null {
  const describedby = normalizeSpace(
    ariaReferences(el, "aria-describedby").map(rawText).join(" "),
  );
  if (describedby) return truncate(describedby, limits.maxDescriptionLength);
  const title = el.getAttribute("title");
  if (title && title.trim()) return truncate(normalizeSpace(title), limits.maxDescriptionLength);
  return null;
}

function componentState(el: HTMLElement, kind: string): ComponentState | undefined {
  if (kind === "dialog") return { open: el.hasAttribute("open") || isRendered(el) };
  if (kind === "disclosure") return { open: el.hasAttribute("open") };
  const expanded = ariaBool(el, "aria-expanded");
  if (expanded !== null) return { expanded };
  return undefined;
}

/**
 * First heading owned by each component (document order). A heading belongs to
 * the nearest component ancestor, so nested components keep their own heading.
 */
function buildHeadingMap(all: HTMLElement[], limits: ExtractionLimits): void {
  for (const el of all) {
    if (!isHeading(el)) continue;
    const id = nearestComponentId(el.parentElement);
    if (id && !currentHeadingByComponentId.has(id)) {
      const text = rawText(el);
      if (text) currentHeadingByComponentId.set(id, truncate(text, limits.maxContextLength));
    }
  }
}

/**
 * Assign each visible text node to its nearest included component (a text node
 * belongs to exactly one component -> no duplication across nested components).
 */
function buildVisibleText(limits: ExtractionLimits): void {
  const used = new Map<string, number>();
  const body = document.body;
  if (!body) return;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const parent = node.parentElement;
    if (
      parent &&
      !isCssHidden(parent) &&
      !parent.closest("script,style,noscript,template") &&
      node.nodeValue
    ) {
      const text = normalizeSpace(node.nodeValue);
      if (text) {
        const id = nearestComponentId(parent);
        if (id && (used.get(id) ?? 0) < limits.maxComponentTextLength) {
          currentVisibleTextByComponentId.set(
            id,
            `${currentVisibleTextByComponentId.get(id) ?? ""} ${text}`,
          );
          used.set(id, (used.get(id) ?? 0) + text.length + 1);
        }
      }
    }
    node = walker.nextNode();
  }
  for (const [id, text] of currentVisibleTextByComponentId) {
    currentVisibleTextByComponentId.set(id, truncate(normalizeSpace(text), limits.maxComponentTextLength));
  }
}

// ---------------------------------------------------------------------------
// Element context association
// ---------------------------------------------------------------------------

function headingTextOf(node: Element): string | null {
  if (isHeading(node)) {
    const text = rawText(node);
    if (text) return text;
  }
  const heading = node.querySelector("h1,h2,h3,h4,h5,h6,[role='heading']");
  if (heading) {
    const text = rawText(heading);
    if (text) return text;
  }
  return null;
}

/**
 * Nearest relevant section heading. First uses a component's owned heading
 * (most specific), then the nearest preceding heading sibling INSIDE the same
 * sectioning container. Sibling scans skip other sectioning containers so a
 * heading from an unrelated sibling section is never inherited.
 */
function sectionHeadingFor(el: HTMLElement, limits: ExtractionLimits): string | null {
  let node: Element | null = el.parentElement;
  while (node && node !== el.ownerDocument.body) {
    const id = currentComponentIdByNode.get(node);
    if (id) {
      const kind = currentKindByNode.get(node);
      if (kind && HEADING_COMPONENT_KINDS.has(kind)) {
        const heading = currentHeadingByComponentId.get(id);
        if (heading) return heading;
      }
    }
    let sibling = node.previousElementSibling;
    while (sibling) {
      if (!isSectioning(sibling) && !currentComponentIdByNode.has(sibling)) {
        const text = headingTextOf(sibling);
        if (text) return truncate(text, limits.maxContextLength);
      }
      sibling = sibling.previousElementSibling;
    }
    if (isSectioning(node)) break;
    node = node.parentElement;
  }
  return null;
}

function nearbyTextFor(componentId: string | null, name: string | null, limits: ExtractionLimits): string | null {
  if (!componentId) return null;
  const text = currentVisibleTextByComponentId.get(componentId);
  if (!text) return null;
  // Avoid repeating the element's own label in its context.
  const withoutLabel = name ? text.split(name).join(" ") : text;
  const normalized = normalizeSpace(withoutLabel);
  return normalized ? truncate(normalized, limits.maxNearbyTextLength) : null;
}

function columnHeaders(table: HTMLTableElement): Array<string | undefined> {
  const headers: Array<string | undefined> = [];
  const headerRow = table.querySelector("thead tr") ?? table.querySelector("tr");
  if (!headerRow) return headers;
  for (const cell of Array.from(headerRow.children)) {
    if (cell.tagName === "TH") {
      const index = (cell as HTMLTableCellElement).cellIndex;
      const text = normalizeSpace(rawText(cell));
      if (text) headers[index] = text;
    }
  }
  return headers;
}

function rowContextOf(el: HTMLElement, limits: ExtractionLimits): RowContext | null {
  const cell = el.closest("th,td");
  if (!cell) return null;
  const row = cell.closest("tr");
  const table = cell.closest("table") as HTMLTableElement | null;
  if (!row || !table) return null;

  const headers = columnHeaders(table);
  const cells = Array.from(row.children).filter(
    (child) => child.tagName === "TD" || child.tagName === "TH",
  );
  const out: RowContext = {};
  for (let i = 0; i < cells.length && Object.keys(out).length < limits.maxRowColumns; i++) {
    const value = normalizeSpace(rawText(cells[i]));
    if (!value) continue;
    const key = headers[i] ?? `col${i + 1}`;
    out[key] = truncate(value, limits.maxContextLength);
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Build one ElementRef
// ---------------------------------------------------------------------------

function buildElementRef(el: HTMLElement, limits: ExtractionLimits): ElementRef {
  const role = resolveRole(el);
  const rendered = isRendered(el);
  const inViewport = rendered && isInViewport(el);
  const disabled = isDisabled(el);
  const inert = isInert(el);
  const interactive = hasInteraction(el, role);
  const { options, truncated } = selectOptions(el, limits);
  const valueInfo = safeValue(el, limits);
  const name = accessibleName(el, role, limits);

  const form = el.closest("form");
  const landmarkEl = el.closest(LANDMARK_SELECTOR);
  const componentId = nearestComponentId(el.parentElement);

  const type =
    el instanceof HTMLInputElement
      ? el.type.toLowerCase()
      : el instanceof HTMLButtonElement
        ? el.type.toLowerCase()
        : null;

  return {
    id: idFor(el),
    tag: el.tagName.toLowerCase(),
    role,
    name,
    description: accessibleDescription(el, limits),
    label: associatedLabel(el),
    text: (() => {
      const text = rawText(el);
      return text ? truncate(text, limits.maxTextLength) : null;
    })(),
    type,
    domName: el.getAttribute("name"),
    href: el instanceof HTMLAnchorElement || el instanceof HTMLAreaElement ? el.href : null,
    placeholder: el.getAttribute("placeholder"),
    value: valueInfo.value,
    valueTruncated: valueInfo.truncated,
    required: isRequired(el),
    disabled,
    readonly: isReadonly(el),
    checked: checkedState(el, role),
    selected: selectedState(el, role),
    expanded: ariaBool(el, "aria-expanded"),
    pressed: ariaBool(el, "aria-pressed"),
    focusable: isFocusable(el),
    editable: isEditable(el),
    interactive,
    actionable: interactive && rendered && !disabled && !inert,
    visibility: {
      rendered,
      inViewport,
      obscured: rendered && inViewport ? isObscured(el, limits.obscuredCheckLimit) : null,
    },
    componentId,
    sectionHeading: sectionHeadingFor(el, limits),
    nearbyText: nearbyTextFor(componentId, name, limits),
    rowContext: rowContextOf(el, limits),
    formId: form?.getAttribute("id") ?? null,
    landmark: landmarkEl
      ? (() => {
          const lmRole = resolveRole(landmarkEl) ?? landmarkEl.tagName.toLowerCase();
          const lmName = regionName(landmarkEl as HTMLElement, limits);
          return truncate(lmName ? `${lmRole}: ${lmName}` : lmRole, limits.maxContextLength);
        })()
      : null,
    options,
    optionsTruncated: truncated,
  };
}

// ---------------------------------------------------------------------------
// Page-level context
// ---------------------------------------------------------------------------

function regionName(el: HTMLElement, limits: ExtractionLimits): string | null {
  const labelledby = normalizeSpace(
    ariaReferences(el, "aria-labelledby").map(rawText).join(" "),
  );
  if (labelledby) return truncate(labelledby, limits.maxContextLength);
  const aria = el.getAttribute("aria-label");
  if (aria && aria.trim()) return truncate(normalizeSpace(aria), limits.maxContextLength);
  const heading = el.querySelector("h1,h2,h3,h4,h5,h6,[role='heading'],legend,caption");
  if (heading) {
    const text = rawText(heading);
    if (text) return truncate(text, limits.maxContextLength);
  }
  const title = el.getAttribute("title");
  if (title && title.trim()) return truncate(normalizeSpace(title), limits.maxContextLength);
  return null;
}

function collectHeadings(limits: ExtractionLimits): Heading[] {
  const out: Heading[] = [];
  for (const el of document.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6,[role='heading']")) {
    if (!isRendered(el)) continue;
    const text = truncate(rawText(el), limits.maxNameLength);
    if (!text) continue;
    out.push({ level: headingLevel(el) ?? 2, text, id: el.id || null });
    if (out.length >= limits.maxHeadings) break;
  }
  return out;
}

function collectLandmarks(limits: ExtractionLimits): Landmark[] {
  const out: Landmark[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(LANDMARK_SELECTOR)) {
    if (!isRendered(el)) continue;
    out.push({
      role: resolveRole(el) ?? el.tagName.toLowerCase(),
      name: regionName(el, limits),
      id: el.id || null,
    });
    if (out.length >= limits.maxLandmarks) break;
  }
  return out;
}

function collectForms(limits: ExtractionLimits): FormInfo[] {
  const out: FormInfo[] = [];
  for (const form of document.querySelectorAll<HTMLFormElement>("form")) {
    if (!isRendered(form)) continue;
    const controlIds: string[] = [];
    for (const control of Array.from(form.elements)) {
      const id = idByElement.get(control);
      if (id) controlIds.push(id);
    }
    out.push({
      id: form.id || null,
      name: regionName(form, limits),
      controlIds,
    });
    if (out.length >= limits.maxForms) break;
  }
  return out;
}

function collectDialogs(limits: ExtractionLimits): DialogInfo[] {
  const out: DialogInfo[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(DIALOG_SELECTOR)) {
    if (!isRendered(el)) continue;
    let id = idByElement.get(el);
    if (!id) {
      // A dialog container is not itself an interactive candidate, but we still
      // need a reference so controls can point back to their dialog.
      id = idFor(el);
      elementById.set(id, el);
    }
    out.push({ id, name: regionName(el, limits) });
  }
  return out;
}

function pageSummary(limit: number): string | null {
  const root = document.querySelector("main") ?? document.body;
  if (!root) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  let length = 0;
  let node = walker.nextNode();
  while (node && length < limit) {
    const parent = node.parentElement;
    if (parent && !isCssHidden(parent)) {
      const text = normalizeSpace(node.nodeValue);
      if (text) {
        parts.push(text);
        length += text.length + 1;
      }
    }
    node = walker.nextNode();
  }
  const joined = normalizeSpace(parts.join(" "));
  return joined ? truncate(joined, limit) : null;
}

function metaDescription(): string | null {
  const meta = document.querySelector('meta[name="description"]');
  const content = meta?.getAttribute("content");
  return content && content.trim() ? normalizeSpace(content) : null;
}

// ---------------------------------------------------------------------------
// Truncation priority
// ---------------------------------------------------------------------------

function elementPriority(el: ElementRef): number {
  let score = 0;
  if (el.visibility.rendered) score += 100;
  if (el.visibility.inViewport) score += 50;
  if (el.actionable) score += 25;
  if (el.componentId) score += 10;
  if (el.name) score += 5;
  return score;
}

function componentPriority(el: Element, withCandidate: Set<Element>): number {
  let score = 0;
  if (withCandidate.has(el)) score += 100;
  if (isRendered(el as HTMLElement)) score += 50;
  return score;
}

// ---------------------------------------------------------------------------
// On-demand context utilities (operate on the most recent snapshot)
// ---------------------------------------------------------------------------

export function getComponent(id: string): ComponentContext | null {
  return componentsById.get(id) ?? null;
}

export function getElementRef(id: string): ElementRef | null {
  return elementsById.get(id) ?? null;
}

export function getElementComponent(elementId: string): ComponentContext | null {
  const ref = elementsById.get(elementId);
  return ref?.componentId ? getComponent(ref.componentId) : null;
}

export function getComponentParent(id: string): ComponentContext | null {
  const component = getComponent(id);
  return component?.parentId ? getComponent(component.parentId) : null;
}

export function getComponentChildren(id: string): ComponentContext[] {
  const component = getComponent(id);
  if (!component) return [];
  return component.childComponentIds
    .map((childId) => getComponent(childId))
    .filter((child): child is ComponentContext => child !== null);
}

export function getNearbyText(elementId: string): string | null {
  return elementsById.get(elementId)?.nearbyText ?? null;
}

export function getRowContext(elementId: string): RowContext | null {
  return elementsById.get(elementId)?.rowContext ?? null;
}

/** All extracted elements that belong to a component (form controls, etc.). */
export function getComponentElements(componentId: string): ElementRef[] {
  const component = getComponent(componentId);
  if (!component) return [];
  return component.elementIds
    .map((id) => elementsById.get(id))
    .filter((ref): ref is ElementRef => ref !== undefined);
}

/** Dispatch a ContextRequest: the transport-agnostic entry point. */
export function readContext(request: ContextRequest): ContextValue {
  switch (request.scope) {
    case "component":
      return getComponent(request.id);
    case "element-component":
      return getElementComponent(request.elementId);
    case "component-parent":
      return getComponentParent(request.id);
    case "component-children":
      return getComponentChildren(request.id);
    case "nearby-text":
      return getNearbyText(request.elementId);
    case "row-context":
      return getRowContext(request.elementId);
    case "form-fields":
      return getComponentElements(request.id);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function extractPageSnapshot(overrides?: Partial<ExtractionLimits>): PageSnapshot {
  const limits: ExtractionLimits = { ...DEFAULT_LIMITS, ...overrides };

  // Fresh per-scan caches.
  styleCache = new WeakMap();
  rectCache = new WeakMap();
  obscuredChecks = 0;
  currentComponentIdByNode = new WeakMap();
  currentKindByNode = new WeakMap();
  currentHeadingByComponentId = new Map();
  currentVisibleTextByComponentId = new Map();
  currentRepeatedCards = new Set();

  // Drop registry entries whose nodes have been detached (SPA navigation etc).
  for (const [id, node] of elementById) {
    if (!node.isConnected) elementById.delete(id);
  }
  for (const [id, node] of componentNodeById) {
    if (!node.isConnected) componentNodeById.delete(id);
  }

  // One traversal for everything.
  const all = collectAllElements();
  const candidateNodes = all.filter(isCandidate);
  const withCandidate = ancestorSet(candidateNodes);
  currentRepeatedCards = findRepeatedCards(all, withCandidate);

  // Detect components, then keep the most useful if over the limit.
  const componentNodes = all.filter((el) => {
    const kind = componentKind(el);
    if (kind === null) return false;
    if (el === document.documentElement || el === document.body) return false;
    if (NEEDS_ACTION.has(kind) && !withCandidate.has(el)) return false;
    return true;
  });
  const includedComponents = [...componentNodes]
    .sort((a, b) => componentPriority(b, withCandidate) - componentPriority(a, withCandidate))
    .slice(0, limits.maxComponents);
  const includedSet = new Set(includedComponents);
  const componentsOmitted = componentNodes.length - includedSet.size;

  // Assign component ids in document order for deterministic references.
  for (const el of all) {
    if (!includedSet.has(el)) continue;
    const id = idForComponent(el);
    currentComponentIdByNode.set(el, id);
    currentKindByNode.set(el, componentKind(el) as string);
    componentNodeById.set(id, el);
  }

  buildHeadingMap(all, limits);
  buildVisibleText(limits);

  // Layer C: elements, each referencing its component.
  const refs = candidateNodes.map((el) => {
    const ref = buildElementRef(el, limits);
    elementById.set(ref.id, el);
    return ref;
  });

  // Layer B: components with their element/child relationships.
  const elementIdsByComponent = new Map<string, string[]>();
  for (const ref of refs) {
    if (!ref.componentId) continue;
    const list = elementIdsByComponent.get(ref.componentId) ?? [];
    list.push(ref.id);
    elementIdsByComponent.set(ref.componentId, list);
  }
  const components: ComponentContext[] = [];
  for (const el of all) {
    const id = currentComponentIdByNode.get(el);
    if (!id) continue;
    const kind = currentKindByNode.get(el) as string;
    const state = componentState(el as HTMLElement, kind);
    components.push({
      id,
      kind,
      name: componentName(el as HTMLElement, limits),
      heading: currentHeadingByComponentId.get(id) ?? null,
      description: containerDescription(el as HTMLElement, limits),
      parentId: nearestComponentId(el.parentElement),
      childComponentIds: [],
      elementIds: elementIdsByComponent.get(id) ?? [],
      visibleText: currentVisibleTextByComponentId.get(id) ?? null,
      ...(state ? { state } : {}),
    });
  }
  componentsById = new Map(components.map((c) => [c.id, c]));
  for (const component of components) {
    if (component.parentId) componentsById.get(component.parentId)?.childComponentIds.push(component.id);
  }

  // Full list retained for GET_ELEMENTS.
  lastElements = [...refs].sort((a, b) => elementPriority(b) - elementPriority(a));
  elementsById = new Map(refs.map((ref) => [ref.id, ref]));

  const included = lastElements.slice(0, limits.maxElements);
  const omitted = Math.max(0, lastElements.length - included.length);

  return {
    url: location.href,
    title: document.title,
    lang: document.documentElement.getAttribute("lang"),
    description: metaDescription(),
    capturedAt: Date.now(),
    summary: pageSummary(limits.maxSummaryLength),
    headings: collectHeadings(limits),
    landmarks: collectLandmarks(limits),
    forms: collectForms(limits),
    dialogs: collectDialogs(limits),
    components,
    elements: included,
    stats: {
      included: included.length,
      omitted,
      truncated: omitted > 0,
      componentsIncluded: components.length,
      componentsOmitted: Math.max(0, componentsOmitted),
    },
    limits,
  };
}
