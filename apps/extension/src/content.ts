import type { Req, Res } from "./messages";
import { extractPageSnapshot, getStoredElements, readContext } from "./snapshot";
import { clickElement } from "./actions";

// CONTENT SCRIPT — injected into every page (see manifest.json).
// It is the extension's "eyes" and "hands": it reads the page's DOM and
// performs permitted actions. It cannot open the sidebar or run browser APIs.

function handle(req: Req): Res | Promise<Res> {
  switch (req.type) {
    case "SCAN_PAGE":
      return { kind: "snapshot", snapshot: extractPageSnapshot(req.limits) };
    case "GET_ELEMENTS": {
      const { elements, total } = getStoredElements(req.offset, req.limit);
      return { kind: "elements", elements, total };
    }
    case "GET_CONTEXT":
      return { kind: "context", value: readContext(req.request) };
    case "CLICK_ELEMENT":
      return clickElement(req.elementId).then((result) => ({ kind: "action", result }));
  }
}

// Guard so we don't register twice if the script is injected more than once.
if (!(window as unknown as { __guildLoaded?: boolean }).__guildLoaded) {
  (window as unknown as { __guildLoaded?: boolean }).__guildLoaded = true;
  browser.runtime.onMessage.addListener((req: Req, _sender, sendResponse) => {
    Promise.resolve()
      .then(() => handle(req))
      .then(sendResponse)
      .catch((error) => sendResponse({ kind: "error", error: String(error) } satisfies Res));
    return true; // keep the message channel open for the async response
  });
}
