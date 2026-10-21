import { useRef, useState } from "react";
import { OPENROUTER_DEBUG, OPENROUTER_KEY, OPENROUTER_MODEL, createOpenRouterModel, runAgent } from "../agent";
import { callPage } from "./page";

// SIDEBAR — a normal React app. It has no access to web pages; it only talks to
// the content script by messages. The agent loop runs here and reaches the page
// exclusively through the validated tool executor (and navigation-aware page
// transport).

type ChatItem = { role: "user" | "assistant" | "reasoning" | "tool" | "observe"; text: string };

export function App() {
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [thinking, setThinking] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const add = (item: ChatItem) => setMessages((previous) => [...previous, item]);

  const send = async () => {
    const goal = input.trim();
    if (!goal || running) return;
    if (!OPENROUTER_KEY) {
      add({ role: "assistant", text: "Missing OPENROUTER_KEY. Add it to apps/extension/.env and rebuild." });
      return;
    }

    setInput("");
    add({ role: "user", text: goal });
    setRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const model = createOpenRouterModel({ apiKey: OPENROUTER_KEY, debug: OPENROUTER_DEBUG });
      const finalText = await runAgent({
        task: goal,
        model,
        callPage,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "thinking") setThinking(event.active);
          else if (event.type === "reasoning") add({ role: "reasoning", text: event.text });
          else if (event.type === "observe") add({ role: "observe", text: event.detail });
          else add({ role: "tool", text: `${event.name}: ${event.detail}` });
        },
      });
      add({ role: "assistant", text: finalText });
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      add({ role: "assistant", text: aborted ? "Stopped." : `Error: ${String(error)}` });
    } finally {
      setThinking(false);
      setRunning(false);
      abortRef.current = null;
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", boxSizing: "border-box" }}>
      <div style={{ padding: "8px 10px", borderBottom: "1px solid #e5e7eb" }}>
        <strong>Guild Navigator</strong>
        <span style={{ fontSize: 10, color: "#999", marginLeft: 6 }}>{OPENROUTER_MODEL}</span>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 10, fontSize: 12 }}>
        {messages.length === 0 && (
          <p style={{ color: "#888" }}>
            Ask for something on the current page, e.g. “click the Contests link,
            then tell me the latest contest”.
          </p>
        )}
        {messages.map((message, index) => {
          const isTool = message.role === "tool";
          const isObserve = message.role === "observe";
          const isReasoning = message.role === "reasoning";
          const label =
            message.role === "user"
              ? "You"
              : isReasoning
                ? "Thinking"
                : isObserve
                  ? "Page"
                  : isTool
                    ? "·"
                    : "Agent";
          const color = isObserve ? "#059669" : isTool ? "#2563eb" : isReasoning ? "#9ca3af" : "#111";
          return (
            <div key={index} style={{ marginBottom: 8 }}>
              <span style={{ color, fontWeight: message.role === "user" ? 600 : 400 }}>{label}</span>{" "}
              <span
                style={{
                  color: isObserve ? "#059669" : isReasoning ? "#9ca3af" : isTool ? "#555" : "#111",
                  fontStyle: isReasoning ? "italic" : "normal",
                  whiteSpace: "pre-wrap",
                }}
              >
                {message.text}
              </span>
            </div>
          );
        })}
        {thinking && (
          <div style={{ color: "#9ca3af", fontStyle: "italic" }}>model is thinking…</div>
        )}
      </div>

      <div style={{ display: "flex", gap: 6, padding: 8, borderTop: "1px solid #e5e7eb" }}>
        <input
          style={{ flex: 1 }}
          value={input}
          placeholder="What should I do on this page?"
          disabled={running}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void send();
          }}
        />
        {running ? (
          <button onClick={() => abortRef.current?.abort()}>Stop</button>
        ) : (
          <button onClick={() => void send()}>Send</button>
        )}
      </div>
    </div>
  );
}
