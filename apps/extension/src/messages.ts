// The message "contract" shared by the sidebar and the content script.
// The browser can only pass JSON between scripts, never live DOM nodes.
//
// The snapshot is deliberately provider-agnostic: plain data an LLM can read
// without any tool-calling format, coordinates, or raw HTML.

export interface SelectOption {
  value: string;
  label: string;
  selected: boolean;
}

/** Visibility, viewport presence and obscuring are three separate facts. */
export interface ElementVisibility {
  /** Connected and CSS-rendered (not display:none / hidden / collapsed). */
  rendered: boolean;
  /** Intersects the current viewport. Off-screen is NOT hidden. */
  inViewport: boolean;
  /** Best-effort pointer hit-test; null when it cannot be determined. */
  obscured: boolean | null;
}

/** Column header -> cell value for the element's table row. */
export type RowContext = Record<string, string>;

/** Reliable component state only (dialog/disclosure open, aria-expanded). */
export type ComponentState = Record<string, boolean | string | null>;

/**
 * A meaningful DOM region that organizes interactive elements. Shared context
 * lives here ONCE; elements point at it via componentId instead of repeating it.
 */
export interface ComponentContext {
  id: string;
  /** dialog | form | fieldgroup | table | table-row | nav | menu | tablist |
   *  tabpanel | disclosure | list | list-item | card | section | landmark */
  kind: string;
  /** Container's own accessible name (aria-label/labelledby/legend/caption). */
  name: string | null;
  /** First heading that belongs to this component (not to a nested one). */
  heading: string | null;
  description: string | null;
  parentId: string | null;
  childComponentIds: string[];
  elementIds: string[];
  /** Bounded, de-duplicated visible text owned by this component. */
  visibleText: string | null;
  state?: ComponentState;
}

export interface ElementRef {
  /** Internal reference, resolve with resolveElement(). Stable within a scan. */
  id: string;
  tag: string;
  /** Resolved ARIA role (explicit role, else implicit/semantic). */
  role: string | null;
  /** Accessible name. */
  name: string | null;
  /** Accessible description (aria-describedby / title). */
  description: string | null;
  /** Associated native <label> text, kept separate from name. */
  label: string | null;
  /** Normalized, truncated visible text. */
  text: string | null;
  /** input type or button type. */
  type: string | null;
  /** Native `name` attribute (not the accessible name). */
  domName: string | null;
  href: string | null;
  placeholder: string | null;
  /** Current value, omitted for sensitive fields. */
  value: string | null;

  required: boolean;
  disabled: boolean;
  readonly: boolean;
  checked: boolean | null;
  selected: boolean | null;
  expanded: boolean | null;
  pressed: boolean | null;

  focusable: boolean;
  editable: boolean;
  /** Has interactive semantics/handlers, even if currently disabled. */
  interactive: boolean;
  /** Rendered, not disabled/inert, and interactive: safe to act on now. */
  actionable: boolean;

  visibility: ElementVisibility;

  /** Nearest meaningful component (the element's purpose lives there). */
  componentId: string | null;
  /** Nearest relevant section heading, from the element's own section only. */
  sectionHeading: string | null;
  /** Short surrounding text from the component, minus the element's own label. */
  nearbyText: string | null;
  /** Table row cells keyed by column header (for actions inside tables). */
  rowContext: RowContext | null;

  formId: string | null;
  landmark: string | null;

  /** Present only for <select>. */
  options: SelectOption[] | null;
  optionsTruncated: boolean;
}

export interface Heading {
  level: number;
  text: string;
  id: string | null;
}

export interface Landmark {
  role: string;
  name: string | null;
  id: string | null;
}

export interface FormInfo {
  id: string | null;
  name: string | null;
  controlIds: string[];
}

export interface DialogInfo {
  id: string;
  name: string | null;
}

export interface SnapshotStats {
  included: number;
  omitted: number;
  truncated: boolean;
  componentsIncluded: number;
  componentsOmitted: number;
}

/** All tunable limits. Truncation is always explicit in `stats`/flags. */
export interface ExtractionLimits {
  maxElements: number;
  maxNameLength: number;
  maxTextLength: number;
  maxDescriptionLength: number;
  maxContextLength: number;
  maxOptions: number;
  maxHeadings: number;
  maxLandmarks: number;
  maxForms: number;
  maxSummaryLength: number;
  obscuredCheckLimit: number;
  maxComponents: number;
  maxComponentTextLength: number;
  maxNearbyTextLength: number;
  maxRowColumns: number;
}

export interface PageSnapshot {
  url: string;
  title: string;
  lang: string | null;
  /** From <meta name="description">, when present. */
  description: string | null;
  capturedAt: number;
  /** Bounded, whitespace-normalized visible text of the main content. */
  summary: string | null;
  headings: Heading[];
  landmarks: Landmark[];
  forms: FormInfo[];
  dialogs: DialogInfo[];
  components: ComponentContext[];
  elements: ElementRef[];
  stats: SnapshotStats;
  limits: ExtractionLimits;
}

/** On-demand context lookups an agent can request after a snapshot. */
export type ContextRequest =
  | { scope: "component"; id: string }
  | { scope: "element-component"; elementId: string }
  | { scope: "component-parent"; id: string }
  | { scope: "component-children"; id: string }
  | { scope: "nearby-text"; elementId: string }
  | { scope: "row-context"; elementId: string }
  | { scope: "form-fields"; id: string };

export type ContextValue =
  | ComponentContext
  | ComponentContext[]
  | ElementRef[]
  | RowContext
  | string
  | null;

/**
 * Outcome of a browser action. `success` means the action was DISPATCHED, not
 * that the user's goal was achieved — the page must be re-observed to verify.
 */
export interface ActionResult {
  success: boolean;
  message: string;
  /** Whether the URL or DOM appears to have changed after the action. */
  pageChanged: boolean;
  requiresUserInput?: boolean;
}

export type Req =
  | { type: "SCAN_PAGE"; limits?: Partial<ExtractionLimits> }
  | { type: "GET_ELEMENTS"; offset: number; limit: number }
  | { type: "GET_CONTEXT"; request: ContextRequest }
  | { type: "CLICK_ELEMENT"; elementId: string };

export type Res =
  | { kind: "snapshot"; snapshot: PageSnapshot }
  | { kind: "elements"; elements: ElementRef[]; total: number }
  | { kind: "context"; value: ContextValue }
  | { kind: "action"; result: ActionResult }
  | { kind: "error"; error: string };
