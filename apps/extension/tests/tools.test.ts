import { test } from "node:test";
import assert from "node:assert/strict";
import type { Req, Res } from "../src/messages";
import { executeTool, getToolDefinition, TOOL_DEFINITIONS } from "../src/tools";

// Pure tests for the skill registry and executor — no DOM, no browser, no LLM.
// `callPage` is faked so we can assert exactly what gets dispatched.

const snapshot = { kind: "snapshot", snapshot: { url: "https://x.test", elements: [] } } as unknown as Res;

test("the registry exposes read_page, press_button and fill_field with schemas", () => {
  assert.deepEqual(
    TOOL_DEFINITIONS.map((t) => t.name),
    ["read_page", "press_button", "fill_field"],
  );
  assert.equal(getToolDefinition("read_page")?.permission, "read");
  assert.equal(getToolDefinition("press_button")?.permission, "interact");
  assert.equal(getToolDefinition("fill_field")?.permission, "interact");
  assert.equal(getToolDefinition("nope"), null);
  assert.ok(getToolDefinition("press_button")!.description.includes("never invent ids"));
});

test("unknown tools are rejected without calling the page", async () => {
  let called = false;
  const result = await executeTool("delete_everything", {}, async () => {
    called = true;
    return snapshot;
  });
  assert.equal(result.ok, false);
  assert.match(result.error!, /Unknown tool/);
  assert.equal(called, false);
});

test("read_page forwards SCAN_PAGE and returns the snapshot", async () => {
  const seen: Req[] = [];
  const result = await executeTool("read_page", {}, async (req) => {
    seen.push(req);
    return snapshot;
  });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, [{ type: "SCAN_PAGE" }]);
  assert.deepEqual(result.data, (snapshot as { snapshot: unknown }).snapshot);
});

test("press_button validates elementId before dispatching", async () => {
  let called = false;
  const callPage = async (): Promise<Res> => {
    called = true;
    return snapshot;
  };
  for (const bad of [{}, { elementId: "" }, { elementId: 42 }, "e1", null]) {
    const result = await executeTool("press_button", bad, callPage);
    assert.equal(result.ok, false);
    assert.match(result.error!, /elementId/);
  }
  assert.equal(called, false);
});

test("press_button trims the id and returns the action result", async () => {
  const seen: Req[] = [];
  const result = await executeTool("press_button", { elementId: " e9 " }, async (req) => {
    seen.push(req);
    return { kind: "action", result: { success: true, message: "Pressed.", pageChanged: true } };
  });
  assert.deepEqual(seen, [{ type: "CLICK_ELEMENT", elementId: "e9" }]);
  assert.equal(result.ok, true);
  assert.equal((result.data as { pageChanged: boolean }).pageChanged, true);
});

test("fill_field validates elementId and text before dispatching", async () => {
  let called = false;
  const callPage = async (): Promise<Res> => {
    called = true;
    return snapshot;
  };
  for (const bad of [{ elementId: "e1" }, { elementId: "e1", text: 5 }, { text: "x" }]) {
    const result = await executeTool("fill_field", bad, callPage);
    assert.equal(result.ok, false);
  }
  assert.equal(called, false);
});

test("fill_field dispatches FILL_FIELD with trimmed id and the text", async () => {
  const seen: Req[] = [];
  const result = await executeTool("fill_field", { elementId: " e4 ", text: "alice" }, async (req) => {
    seen.push(req);
    return { kind: "action", result: { success: true, message: 'Filled "Username".', pageChanged: false } };
  });
  assert.deepEqual(seen, [{ type: "FILL_FIELD", elementId: "e4", text: "alice" }]);
  assert.equal(result.ok, true);
});

test("a refused action becomes a tool error the model can recover from", async () => {
  const result = await executeTool("press_button", { elementId: "e1" }, async () => ({
    kind: "action",
    result: { success: false, message: "Element is not actionable.", pageChanged: false },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "Element is not actionable.");
});

test("a dropped response during navigation is treated as a successful change", async () => {
  const result = await executeTool("press_button", { elementId: "e1" }, async () => {
    throw new Error("Could not establish connection. Receiving end does not exist.");
  });
  assert.equal(result.ok, true);
  assert.equal((result.data as { pageChanged: boolean }).pageChanged, true);
});
