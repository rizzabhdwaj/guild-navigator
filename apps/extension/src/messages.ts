// The message "contract" shared by the sidebar and the content script.
// The browser can only pass JSON between scripts, never live DOM nodes.

export interface ElementInfo {
  id: string; // "el-1" — stable per scan
  tag: string;
  label: string;
  href: string | null;
  visible: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

export interface PageSnapshot {
  url: string;
  title: string;
  capturedAt: number;
  elements: ElementInfo[];
}

export type Req = { type: "SCAN_PAGE" };

export type Res =
  | { kind: "snapshot"; snapshot: PageSnapshot }
  | { kind: "error"; error: string };
