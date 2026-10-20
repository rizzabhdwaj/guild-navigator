import { test } from "node:test";
import assert from "node:assert/strict";
import { clickElement, fillElement } from "../src/actions";
import { extractPageSnapshot } from "../src/snapshot";
import { box, byName, byTag, find, setup } from "./harness";

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

test("filling a text field sets its value and fires input/change", async () => {
  setup(`<input id="q" aria-label="Query">`);
  box(document.getElementById("q"));
  const ref = find(extractPageSnapshot(), byName("Query"));

  let inputFired = false;
  let changeFired = false;
  const el = document.getElementById("q")!;
  el.addEventListener("input", () => (inputFired = true));
  el.addEventListener("change", () => (changeFired = true));

  const result = await fillElement(ref.id, "hello");
  assert.equal(result.success, true);
  assert.equal((el as HTMLInputElement).value, "hello");
  assert.equal(inputFired, true);
  assert.equal(changeFired, true);
  assert.equal(result.message.includes("hello"), false);
});

test("filling a text field reports the form state change", async () => {
  setup(`<label for="name">Name</label><input id="name">`);
  box(document.getElementById("name"));
  const snapshot = extractPageSnapshot();
  const field = snapshot.elements.find((element) => element.name === "Name");
  assert.ok(field);

  const result = await fillElement(field.id, "Alice");
  assert.equal(result.success, true);
  assert.equal(result.pageChanged, true);
});

test("a password field can be filled but its value is never echoed", async () => {
  setup(`<input id="p" type="password" aria-label="Password">`);
  box(document.getElementById("p"));
  const ref = find(extractPageSnapshot(), byName("Password"));

  const result = await fillElement(ref.id, "s3cret!");
  assert.equal(result.success, true);
  assert.equal((document.getElementById("p") as HTMLInputElement).value, "s3cret!");
  assert.equal(result.message.includes("s3cret!"), false);
});

test("non-text elements are refused by fill_field", async () => {
  setup(`<button id="b">Go</button>`);
  box(document.getElementById("b"));
  const ref = find(extractPageSnapshot(), byTag("button"));

  const result = await fillElement(ref.id, "x");
  assert.equal(result.success, false);
  assert.match(result.message, /not a text field/);
});
