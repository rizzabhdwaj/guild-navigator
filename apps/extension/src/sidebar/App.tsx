import { useState } from "react";
import type { PageSnapshot, Req, Res } from "../messages";

// SIDEBAR — a normal React app. It has no access to web pages; it only talks
// to the content script by messages.

// Send a message to the content script in the active tab. If the content
// script isn't there yet (page was open before install), inject it and retry.
async function sendToPage(req: Req): Promise<Res> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { kind: "error", error: "No active tab." };
  try {
    return await browser.tabs.sendMessage(tab.id, req);
  } catch {
    await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    return await browser.tabs.sendMessage(tab.id, req);
  }
}

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
  const [status, setStatus] = useState("Click the button to capture the current page.");
  const [snapshot, setSnapshot] = useState<PageSnapshot | null>(null);

  const capture = async () => {
    const res = await sendToPage({ type: "SCAN_PAGE" });
    if (res.kind === "snapshot") {
      setSnapshot(res.snapshot);
      downloadJson(res.snapshot, `page-snapshot-${Date.now()}.json`);
      setStatus(`Saved ${res.snapshot.elements.length} elements to a JSON file.`);
    } else {
      setStatus(res.error);
    }
  };

  return (
    <div style={{ padding: 10 }}>
      <h3 style={{ margin: "0 0 8px" }}>Guild Navigator</h3>
      <button onClick={capture}>Get page snapshot</button>
      <p style={{ fontSize: 11, color: "#666" }}>{status}</p>
      {snapshot && (
        <pre style={{ fontSize: 11, background: "#f8fafc", padding: 8, overflow: "auto" }}>
          {JSON.stringify(snapshot, null, 2)}
        </pre>
      )}
    </div>
  );
}
