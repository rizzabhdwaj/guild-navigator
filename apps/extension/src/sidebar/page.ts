import type { Req, Res } from "../messages";

// PAGE TRANSPORT — the sidebar's only channel to the page. It talks to the
// content script, and when a click/fill makes the page NAVIGATE, the content
// script is torn down and the reply is lost. In that case we wait for the new
// page to finish loading so the following read_page sees the fresh document
// instead of the old one.

async function injectContentScript(tabId: number): Promise<void> {
  await browser.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

/**
 * Resolve once the tab has navigated and finished loading. Navigation is
 * detected by a URL change OR by a loading -> complete transition (which also
 * covers same-URL reloads). Polling backstops missed onUpdated events.
 */
function waitForTabSettle(tabId: number, beforeUrl: string | undefined, timeoutMs = 12000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let loadingSeen = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      browser.tabs.onUpdated.removeListener(onUpdated);
      if (poll !== undefined) clearInterval(poll);
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };

    const check = async () => {
      try {
        const tab = await browser.tabs.get(tabId);
        const urlChanged = tab.url !== undefined && tab.url !== beforeUrl;
        if (tab.status === "complete" && (loadingSeen || urlChanged)) finish();
      } catch {
        finish(); // tab closed: stop waiting
      }
    };

    const onUpdated = (id: number, info: { status?: string }) => {
      if (id !== tabId) return;
      if (info.status === "loading") loadingSeen = true;
      if (info.status === "complete") setTimeout(() => void check(), 150);
    };

    browser.tabs.onUpdated.addListener(onUpdated);
    poll = setInterval(() => void check(), 300);
    timer = setTimeout(finish, timeoutMs);
    // Navigation may already be underway/completed before we registered.
    setTimeout(() => void check(), 200);
  });
}

// Read-only requests can be retried by injecting the content script; actions
// are not retried blindly because a lost reply during a click means navigation.
const READ_TYPES = new Set(["SCAN_PAGE", "GET_ELEMENTS", "GET_CONTEXT"]);

/** Send a request to the active tab's content script, navigation-aware. */
export async function callPage(req: Req): Promise<Res> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { kind: "error", error: "No active tab." };
  const tabId = tab.id;
  const beforeUrl = tab.url;

  try {
    return await browser.tabs.sendMessage(tabId, req);
  } catch (error) {
    if (READ_TYPES.has(req.type)) {
      // Content script missing (page opened before install): inject and retry.
      await injectContentScript(tabId);
      return await browser.tabs.sendMessage(tabId, req);
    }
    if (req.type === "CLICK_ELEMENT" || req.type === "FILL_FIELD") {
      // The action navigated away; wait for the destination page to settle.
      await waitForTabSettle(tabId, beforeUrl);
      return {
        kind: "action",
        result: {
          success: true,
          message: "Action triggered a page navigation.",
          pageChanged: true,
        },
      };
    }
    throw error;
  }
}
