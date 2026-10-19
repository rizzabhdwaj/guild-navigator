import type { ElementInfo, Req, Res } from "./messages";

// CONTENT SCRIPT — injected into every page (see manifest.json).
// It is the extension's "eyes": it reads the page's DOM and reports back.
// It cannot open the sidebar or run browser-level APIs.

const SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "[role='button']",
  "[role='link']",
].join(",");

let counter = 0;

function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
}

function describe(el: HTMLElement): ElementInfo {
  const r = el.getBoundingClientRect();
  const label =
    el.getAttribute("aria-label") ??
    (el instanceof HTMLInputElement ? el.placeholder : el.innerText);
  return {
    id: `el-${++counter}`,
    tag: el.tagName.toLowerCase(),
    label: (label || "").trim().slice(0, 100),
    href: el instanceof HTMLAnchorElement ? el.href : null,
    visible: isVisible(el),
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
  };
}

function scanPage(): Res {
  const found = new Set<HTMLElement>();
  for (const el of document.querySelectorAll<HTMLElement>(SELECTOR)) found.add(el);
  return {
    kind: "snapshot",
    snapshot: {
      url: location.href,
      title: document.title,
      capturedAt: Date.now(),
      elements: [...found].map(describe),
    },
  };
}

// Guard so we don't register twice if the script is injected more than once.
if (!(window as unknown as { __guildLoaded?: boolean }).__guildLoaded) {
  (window as unknown as { __guildLoaded?: boolean }).__guildLoaded = true;
  browser.runtime.onMessage.addListener((req: Req, _sender, sendResponse) => {
    if (req.type === "SCAN_PAGE") sendResponse(scanPage());
    return true;
  });
}
