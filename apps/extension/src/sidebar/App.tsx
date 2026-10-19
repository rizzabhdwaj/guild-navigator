import { useState } from "react";
import type { PageSnapshot, Req, Res } from "../messages";
import { executeTool, type ToolResult } from "../tools";

// SIDEBAR — a normal React app. It has no access to web pages; it only talks
// to the content script by messages. For now it exposes the two skills as
// manual controls so they can be exercised without an LLM.

// Send a message to the content script in the active tab. The content script
// may be missing on a page opened before install, so we inject it and retry —
// but only for read operations. During a click the page may navigate, which
// drops the response; that must surface as-is, not be retried on the new page.
async function sendToPage(req: Req, allowInjectRetry = true): Promise<Res> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { kind: "error", error: "No active tab." };
  try {
    return await browser.tabs.sendMessage(tab.id, req);
  } catch (error) {
    if (!allowInjectRetry) throw error;
    await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    return await browser.tabs.sendMessage(tab.id, req);
  }
}

const callPage = (req: Req) => sendToPage(req, req.type !== "CLICK_ELEMENT");

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function App() {
  const [status, setStatus] = useState("Read the page to see its actionable elements.");
  const [snapshot, setSnapshot] = useState<PageSnapshot | null>(null);

  // read_page
  const scan = async () => {
    const result: ToolResult = await executeTool("read_page", {}, callPage);
    if (!result.ok) {
      setStatus(result.error ?? "read_page failed.");
      return;
    }
    const snap = result.data as PageSnapshot;
    setSnapshot(snap);
    const { included, omitted } = snap.stats;
    setStatus(`Read ${included} elements${omitted ? ` (${omitted} omitted)` : ""}.`);
  };

  // press_button, then re-observe to verify (never trust the click alone).
  const press = async (elementId: string) => {
    const result = await executeTool("press_button", { elementId }, callPage);
    if (!result.ok) {
      setStatus(`press_button failed: ${result.error}`);
      return;
    }
    const action = result.data as { message: string; pageChanged: boolean };
    setStatus(`${action.message}${action.pageChanged ? " Page changed." : " No visible change."}`);
    await scan();
  };

  const interactive = snapshot?.elements.filter((e) => e.interactive) ?? [];

  return (
    <div style={{ padding: 10 }}>
      <h3 style={{ margin: "0 0 8px" }}>Guild Navigator</h3>
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={scan}>read_page</button>
        <button
          disabled={!snapshot}
          onClick={() => snapshot && downloadJson(snapshot, `page-snapshot-${Date.now()}.json`)}
        >
          Save JSON
        </button>
      </div>
      <p style={{ fontSize: 11, color: "#666" }}>{status}</p>

      {snapshot && (
        <ul style={{ listStyle: "none", padding: 0, fontSize: 12 }}>
          {interactive.slice(0, 50).map((el) => (
            <li
              key={el.id}
              style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}
            >
              <code style={{ color: "#888" }}>{el.id}</code>
              <span
                style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {el.name ?? el.text ?? `(${el.role ?? el.tag})`}
              </span>
              <button
                disabled={!el.actionable}
                title={el.actionable ? "press_button" : "not actionable"}
                onClick={() => press(el.id)}
              >
                press
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
