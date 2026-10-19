import { test } from "node:test";
import assert from "node:assert/strict";
import { clickElement } from "../src/actions";
import { extractPageSnapshot } from "../src/snapshot";
import { box, byTag, find, setup } from "./harness";

// The press_button action runs against a real (jsdom) DOM. Calls resolve an
// elementId, re-check actionability, dispatch a click, then settle briefly.

const flag = () => (window as unknown as { __clicked?: boolean }).__clicked;

test("pressing a button dispatches a real click", async () => {
  setup(`<button id="b">Go</button>`);
  box(document.getElementById("b"));
  const ref = find(extractPageSnapshot(), byTag("button"));
  document.getElementById("b")!.addEventListener("click", () => {
    (window as unknown as { __clicked?: boolean }).__clicked = true;
  });

  const result = await clickElement(ref.id);
  assert.equal(result.success, true);
  assert.equal(result.pageChanged, false);
  assert.equal(flag(), true);
});

test("pageChanged is reported when the click mutates the DOM", async () => {
  setup(`<button id="b">Add</button>`);
  box(document.getElementById("b"));
  const ref = find(extractPageSnapshot(), byTag("button"));
  document.getElementById("b")!.addEventListener("click", () => {
    const span = document.createElement("span");
    span.textContent = "added";
    document.body.appendChild(span);
  });

  const result = await clickElement(ref.id);
  assert.equal(result.success, true);
  assert.equal(result.pageChanged, true);
});

test("unknown element ids are refused", async () => {
  setup(`<button id="b">Go</button>`);
  box(document.getElementById("b"));
  extractPageSnapshot();
  const result = await clickElement("e9999");
  assert.equal(result.success, false);
  assert.match(result.message, /Unknown elementId/);
});

test("stale ids (element removed) are refused", async () => {
  setup(`<button id="b">Go</button>`);
  box(document.getElementById("b"));
  const ref = find(extractPageSnapshot(), byTag("button"));
  document.getElementById("b")!.remove();

  const result = await clickElement(ref.id);
  assert.equal(result.success, false);
  assert.match(result.message, /no longer on the page/);
});

test("non-interactive candidates are refused", async () => {
  setup(`<div id="x" tabindex="0">Just text</div>`);
  box(document.getElementById("x"));
  const ref = find(extractPageSnapshot(), byTag("div"));
  assert.equal(ref.interactive, false);

  const result = await clickElement(ref.id);
  assert.equal(result.success, false);
  assert.match(result.message, /not interactive/);
});

test("disabled controls are refused", async () => {
  setup(`<button id="b" disabled>Save</button>`);
  box(document.getElementById("b"));
  const ref = find(extractPageSnapshot(), byTag("button"));
  assert.equal(ref.interactive, true);
  assert.equal(ref.actionable, false);

  const result = await clickElement(ref.id);
  assert.equal(result.success, false);
  assert.match(result.message, /not actionable/);
});
