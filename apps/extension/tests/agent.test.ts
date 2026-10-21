import { test } from "node:test";
import assert from "node:assert/strict";
import type { Req, Res } from "../src/messages";
import type { PageCaller } from "../src/tools";
import {
  type AgentEvent,
  type AgentMessage,
  type AgentModel,
  buildRequestBody,
  createOpenRouterModel,
  extractReasoning,
  parseToolArguments,
  runAgent,
  toProviderMessages,
  toProviderTools,
} from "../src/agent";
import { TOOL_DEFINITIONS } from "../src/tools";

// The loop is provider-agnostic, so we test it with an injected fake model and
// a fake page caller. No network, no browser, no API key.

test("tools are converted to the OpenAI/OpenRouter function schema", () => {
  const tools = toProviderTools(TOOL_DEFINITIONS);
  assert.equal(tools.length, 3);
  assert.deepEqual(
    tools.map((t) => t.function.name),
    ["read_page", "press_button", "fill_field"],
  );
  assert.equal(tools[0].type, "function");
  assert.deepEqual(tools[1].function.parameters, TOOL_DEFINITIONS[1].parameters);
});

test("messages map to provider shape, stringifying tool-call arguments", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
    { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "press_button", arguments: { elementId: "e9" } }] },
    { role: "tool", toolCallId: "c1", content: "{\"ok\":true}" },
    { role: "assistant", content: "done" },
  ];
  const out = toProviderMessages(messages);
  assert.deepEqual(out[0], { role: "system", content: "sys" });
  assert.equal(out[2].tool_calls?.[0].function.name, "press_button");
  assert.equal(out[2].tool_calls?.[0].function.arguments, '{"elementId":"e9"}');
  assert.deepEqual(out[3], { role: "tool", content: '{"ok":true}', tool_call_id: "c1" });
});

test("the request body carries the model, tools, and tool_choice", () => {
  const body = buildRequestBody([{ role: "user", content: "hi" }], TOOL_DEFINITIONS, "deepseek/deepseek-v4.1-flash:free");
  assert.equal(body.model, "deepseek/deepseek-v4.1-flash:free");
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.tools.length, 3);
  assert.deepEqual(body.reasoning, { enabled: true });
});

test("extractReasoning handles a string or reasoning_details", () => {
  assert.equal(extractReasoning({ reasoning: "  step one  " }), "step one");
  assert.equal(
    extractReasoning({ reasoning_details: [{ text: "a" }, { summary: "b" }, { other: 1 }] }),
    "a\nb",
  );
  assert.equal(extractReasoning({}), null);
});

test("malformed tool arguments degrade to an empty object", () => {
  assert.deepEqual(parseToolArguments('{"elementId":"e1"}'), { elementId: "e1" });
  assert.deepEqual(parseToolArguments("{not json"), {});
  assert.deepEqual(parseToolArguments("[1,2]"), {});
  assert.deepEqual(parseToolArguments(42), {});
});

test("OpenRouter surfaces provider errors even when the HTTP response is successful", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "No endpoints available" } }), { status: 200 });
  try {
    await assert.rejects(
      createOpenRouterModel({ apiKey: "test" }).respond({ messages: [], tools: [] }),
      /OpenRouter: No endpoints available/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenRouter explains an empty choices response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [] }), { status: 200 });
  try {
    await assert.rejects(
      createOpenRouterModel({ apiKey: "test" }).respond({ messages: [], tools: [] }),
      /no assistant message.*model may be unavailable/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function fakeCallPage(calls: Req[]): PageCaller {
  return async (req): Promise<Res> => {
    calls.push(req);
    if (req.type === "SCAN_PAGE") {
      return {
        kind: "snapshot",
        snapshot: { stats: { included: 7 }, url: "https://x.test", elements: [{ id: "e1" }] },
      } as unknown as Res;
    }
    return { kind: "action", result: { success: true, message: "Pressed \"Contests\".", pageChanged: true } };
  };
}

test("runAgent drives read -> act -> finish and returns the final text", async () => {
  const calls: Req[] = [];
  const responses = [
    { content: null, toolCalls: [{ id: "1", name: "read_page", arguments: {} }] },
    { content: null, toolCalls: [{ id: "2", name: "press_button", arguments: { elementId: "e9" } }] },
    { content: "The latest contest is Weekly Round 900." },
  ];
  const prompts: AgentMessage[][] = [];
  let i = 0;
  const model: AgentModel = {
    respond: async ({ messages }) => {
      prompts.push(messages);
      return responses[i++];
    },
  };

  const events: string[] = [];
  const final = await runAgent({
    task: "find the latest contest",
    model,
    callPage: fakeCallPage(calls),
    autoObserve: false,
    onEvent: (event) => {
      if (event.type === "tool") events.push(`${event.name}:${event.detail}`);
    },
  });

  assert.equal(final, "The latest contest is Weekly Round 900.");
  assert.deepEqual(calls, [{ type: "SCAN_PAGE" }, { type: "CLICK_ELEMENT", elementId: "e9" }]);
  assert.deepEqual(events, ["read_page:read 7 elements", 'press_button:Pressed "Contests".']);

  // The second prompt must include the assistant tool call and its tool result.
  const second = prompts[1];
  assert.ok(second.some((m) => m.role === "assistant" && m.toolCalls?.[0].name === "read_page"));
  assert.ok(second.some((m) => m.role === "tool" && m.toolCallId === "1"));
});

test("runAgent toggles a thinking state and surfaces reasoning", async () => {
  const events: AgentEvent[] = [];
  let i = 0;
  const model: AgentModel = {
    respond: async () =>
      i++ === 0
        ? { content: null, reasoning: "I should look at the page.", toolCalls: [{ id: "1", name: "read_page", arguments: {} }] }
        : { content: "All done." },
  };

  const final = await runAgent({
    task: "look",
    model,
    callPage: fakeCallPage([]),
    autoObserve: false,
    onEvent: (event) => events.push(event),
  });

  assert.equal(final, "All done.");
  assert.deepEqual(events[0], { type: "thinking", active: true });
  assert.ok(events.some((e) => e.type === "reasoning" && e.text === "I should look at the page."));
  assert.ok(events.some((e) => e.type === "thinking" && e.active === false));
});

test("runAgent stops at the step budget", async () => {
  const calls: Req[] = [];
  const model: AgentModel = {
    respond: async () => ({
      content: null,
      toolCalls: [{ id: "x", name: "read_page", arguments: {} }],
    }),
  };
  const final = await runAgent({ task: "loop forever", model, callPage: fakeCallPage(calls), maxSteps: 3, autoObserve: false });
  assert.match(final, /maximum number of steps/);
  assert.equal(calls.length, 3);
});

test("a tool error is fed back to the model instead of throwing", async () => {
  const prompts: AgentMessage[][] = [];
  let i = 0;
  const responses = [
    { content: null, toolCalls: [{ id: "1", name: "press_button", arguments: {} }] }, // invalid args
    { content: "I could not press anything." },
  ];
  const model: AgentModel = {
    respond: async ({ messages }) => {
      prompts.push(messages);
      return responses[i++];
    },
  };
  const final = await runAgent({ task: "go", model, callPage: fakeCallPage([]), autoObserve: false });
  assert.equal(final, "I could not press anything.");
  const toolMessage = prompts[1].find((m) => m.role === "tool");
  assert.ok(toolMessage && toolMessage.role === "tool" && toolMessage.content.includes('"ok":false'));
});

test("autoObserve reads the page up front and re-reads after a page change", async () => {
  const calls: Req[] = [];
  const prompts: AgentMessage[][] = [];
  let i = 0;
  const responses = [
    { content: null, toolCalls: [{ id: "1", name: "press_button", arguments: { elementId: "e9" } }] },
    { content: "I am on the right page now." },
  ];
  const model: AgentModel = {
    respond: async ({ messages }) => {
      prompts.push(messages);
      return responses[i++];
    },
  };

  const events: AgentEvent[] = [];
  const final = await runAgent({
    task: "navigate to contests",
    model,
    callPage: fakeCallPage(calls),
    onEvent: (event) => events.push(event),
  });

  assert.equal(final, "I am on the right page now.");
  // initial read, the click, then an automatic re-read because the page changed
  assert.deepEqual(calls, [
    { type: "SCAN_PAGE" },
    { type: "CLICK_ELEMENT", elementId: "e9" },
    { type: "SCAN_PAGE" },
  ]);
  assert.ok(events.some((e) => e.type === "observe"));

  // The click's tool result must carry the freshly read page.
  const clickTool = prompts[1].find((m) => m.role === "tool" && m.toolCallId === "1");
  assert.ok(clickTool && clickTool.role === "tool" && clickTool.content.includes('"page"'));
});

test("a read_page result does not trigger a redundant re-read", async () => {
  const calls: Req[] = [];
  let i = 0;
  const responses = [
    { content: null, toolCalls: [{ id: "1", name: "read_page", arguments: {} }] },
    { content: "nothing more to do" },
  ];
  const model: AgentModel = { respond: async () => responses[i++] };
  await runAgent({ task: "look", model, callPage: fakeCallPage(calls) });
  // initial auto-read + the model's own read_page, and no extra scan
  assert.equal(calls.filter((c) => c.type === "SCAN_PAGE").length, 2);
});
