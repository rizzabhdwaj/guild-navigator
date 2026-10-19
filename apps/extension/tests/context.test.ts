import { test } from "node:test";
import assert from "node:assert/strict";
import type { ComponentContext, RowContext } from "../src/messages";
import {
  extractPageSnapshot,
  getComponent,
  getComponentChildren,
  getComponentElements,
  getComponentParent,
  getElementComponent,
  getElementRef,
  getNearbyText,
  getRowContext,
  readContext,
  resolveElement,
} from "../src/snapshot";
import { box, byName, find, previewAll, setup } from "./harness";

// Component-aware context tests. These exercise the three-layer snapshot:
// page -> components (shared context) -> elements (references).

function componentOf(elementId: string): ComponentContext {
  const component = getElementComponent(elementId);
  if (!component) throw new Error("element has no component");
  return component;
}

test("an element inside a named section inherits that section context", () => {
  setup(`<section aria-label="Billing">
           <h2>Billing</h2>
           <button id="b">View all</button>
         </section>`);
  box(document.getElementById("b"));
  const ref = find(extractPageSnapshot(), byName("View all"));

  const component = componentOf(ref.id);
  assert.equal(component.kind, "section");
  assert.equal(component.name, "Billing");
  assert.equal(component.heading, "Billing");
  assert.equal(ref.componentId, component.id);
  assert.equal(ref.sectionHeading, "Billing");
});

test("identical labels in repeated cards resolve to distinct components", () => {
  setup(`<div>
           <article><h3>Alpha</h3><button id="a">Open</button></article>
           <article><h3>Beta</h3><button id="b">Open</button></article>
         </div>`);
  box(document.getElementById("a"));
  box(document.getElementById("b"));
  const snap = extractPageSnapshot();
  const [first, second] = snap.elements.filter(byName("Open"));

  assert.ok(first.componentId);
  assert.ok(second.componentId);
  assert.notEqual(first.componentId, second.componentId);
  assert.equal(first.sectionHeading, "Alpha");
  assert.equal(second.sectionHeading, "Beta");
  assert.equal(componentOf(first.id).kind, "card");
});

test("repeated controls are not mistaken for cards", () => {
  setup(`<nav aria-label="Main"><a href="/a">A</a><a href="/b">B</a></nav>
         <div id="row"><button>Yes</button><button>No</button></div>`);
  box(document.querySelector('[href="/a"]'));
  box(document.querySelector('[href="/b"]'));
  box(document.querySelector("#row button"));
  const snap = extractPageSnapshot();

  const nav = snap.components.find((c) => c.kind === "nav");
  assert.ok(nav);
  assert.deepEqual(nav.childComponentIds, []);
  assert.equal(
    snap.components.some((c) => c.kind === "card"),
    false,
  );
});

test("an action inside a table row carries its column values", () => {
  setup(`<table>
           <thead><tr><th>Invoice</th><th>Amount</th></tr></thead>
           <tbody><tr><td>INV-1</td><td>$10</td><td><button id="p">Pay</button></td></tr></tbody>
         </table>`);
  box(document.getElementById("p"));
  const ref = find(extractPageSnapshot(), byName("Pay"));

  assert.deepEqual(ref.rowContext, {
    Invoice: "INV-1",
    Amount: "$10",
    col3: "Pay",
  } satisfies RowContext);
  assert.deepEqual(getRowContext(ref.id), ref.rowContext);
  assert.equal(componentOf(ref.id).kind, "table-row");
});

test("form fields share one component whether labelled or not", () => {
  setup(`<form aria-label="Signup">
           <label for="e">Email</label><input id="e">
           <input id="p" placeholder="Phone">
         </form>`);
  box(document.getElementById("e"));
  box(document.getElementById("p"));
  const snap = extractPageSnapshot();
  const email = find(snap, byName("Email"));
  const phone = find(snap, byName("Phone"));

  assert.ok(email.componentId);
  assert.equal(phone.componentId, email.componentId);
  assert.equal(componentOf(email.id).kind, "form");
  assert.equal(componentOf(email.id).name, "Signup");
  assert.equal(email.label, "Email");
  assert.equal(phone.label, null);
  assert.equal(getComponentElements(email.componentId!).length, 2);
});

test("dialog controls are grouped under the dialog component", () => {
  setup(`<div role="dialog" aria-label="Confirm">
           <h2>Delete item</h2>
           <p>This cannot be undone.</p>
           <button id="c">Cancel</button>
           <button id="d">Delete</button>
         </div>`);
  box(document.getElementById("c"));
  box(document.getElementById("d"));
  box(document.querySelector('[role="dialog"]'));
  const snap = extractPageSnapshot();
  const cancel = find(snap, byName("Cancel"));
  const remove = find(snap, byName("Delete"));

  const dialog = componentOf(cancel.id);
  assert.equal(dialog.kind, "dialog");
  assert.equal(dialog.name, "Confirm");
  assert.equal(dialog.heading, "Delete item");
  assert.equal(remove.componentId, cancel.componentId);
  assert.equal(dialog.state?.open, true);
  assert.equal(getComponentElements(dialog.id).length, 2);
});

test("nested components keep their own heading and a parent link", () => {
  setup(`<section aria-label="Outer">
           <h2>Outer</h2>
           <article><h3>Inner</h3><button id="a">Act</button></article>
         </section>`);
  box(document.getElementById("a"));
  const ref = find(extractPageSnapshot(), byName("Act"));

  const inner = componentOf(ref.id);
  const outer = getComponentParent(inner.id);
  assert.ok(outer);
  assert.equal(inner.heading, "Inner");
  assert.equal(ref.sectionHeading, "Inner");
  assert.equal(outer.kind, "section");
  assert.equal(outer.heading, "Outer");
  assert.deepEqual(getComponentChildren(outer.id).map((c) => c.id), [inner.id]);
});

test("elements outside any component have no fabricated context", () => {
  setup(`<button id="b">Loose</button>`);
  box(document.getElementById("b"));
  const ref = find(extractPageSnapshot(), byName("Loose"));

  assert.equal(ref.componentId, null);
  assert.equal(ref.sectionHeading, null);
  assert.equal(ref.nearbyText, null);
  assert.equal(getElementComponent(ref.id), null);
});

test("hidden components stay represented but expose no visible text", () => {
  setup(`<div role="region" aria-label="Hidden" style="display:none">
           <button id="d">Deep</button>
         </div>
         <details><summary>FAQ</summary><p>Answer</p></details>`);
  const snap = extractPageSnapshot();
  const deep = find(snap, byName("Deep"));

  assert.equal(deep.visibility.rendered, false);
  assert.equal(deep.actionable, false);
  const hidden = componentOf(deep.id);
  assert.equal(hidden.name, "Hidden");
  assert.equal(hidden.visibleText, null);

  const disclosure = snap.components.find((c) => c.kind === "disclosure");
  assert.ok(disclosure);
  assert.equal(disclosure.state?.open, false);
});

test("empty containers and malformed ARIA are handled without crashing", () => {
  setup(`<div role="dialog" aria-labelledby="missing-id"><button id="b">X</button></div>
         <div role="region" aria-label=""></div>`);
  box(document.getElementById("b"));
  const snap = extractPageSnapshot();

  const dialog = componentOf(find(snap, byName("X")).id);
  assert.equal(dialog.kind, "dialog");
  assert.equal(dialog.name, null); // dangling aria-labelledby

  const empty = snap.components.find((c) => c.kind === "section" && c.elementIds.length === 0);
  assert.ok(empty);
  assert.deepEqual(getComponentElements(empty.id), []);
});

test("long component text is truncated to the configured limits", () => {
  setup(`<article>
           <h3>Card</h3>
           <p>${"lorem ipsum ".repeat(50)}</p>
           <button id="b">Go</button>
         </article>`);
  box(document.getElementById("b"));
  const snap = extractPageSnapshot({ maxComponentTextLength: 30, maxNearbyTextLength: 12 });
  const ref = find(snap, byName("Go"));
  const component = componentOf(ref.id);

  assert.ok(component.visibleText);
  assert.ok(component.visibleText.length <= 30);
  assert.ok(ref.nearbyText);
  assert.ok(ref.nearbyText.length <= 12);
  assert.equal(ref.nearbyText, getNearbyText(ref.id));
});

test("component count is capped and omission is reported", () => {
  const cards = Array.from(
    { length: 300 },
    (_, i) => `<article><h3>Card ${i}</h3><button>Open</button></article>`,
  ).join("");
  setup(`<div>${cards}</div>`);
  previewAll();

  const snap = extractPageSnapshot({ maxComponents: 10 });
  assert.equal(snap.stats.componentsIncluded, 10);
  assert.ok(snap.stats.componentsOmitted > 0);
  assert.equal(snap.components.length, 10);
});

test("duplicate labels resolve through readContext to their own component", () => {
  setup(`<section aria-label="Drafts"><button id="a">Save</button></section>
         <section aria-label="Published"><button id="b">Save</button></section>`);
  box(document.getElementById("a"));
  box(document.getElementById("b"));
  const snap = extractPageSnapshot();
  const [a, b] = snap.elements.filter(byName("Save"));

  const viaA = readContext({ scope: "element-component", elementId: a.id }) as ComponentContext;
  const viaB = readContext({ scope: "element-component", elementId: b.id }) as ComponentContext;
  assert.equal(viaA.name, "Drafts");
  assert.equal(viaB.name, "Published");
  assert.notEqual(viaA.id, viaB.id);
});

test("unknown or stale references resolve to null after a rescan", () => {
  setup(`<button id="b">Go</button>`);
  box(document.getElementById("b"));
  const first = find(extractPageSnapshot(), byName("Go"));
  assert.notEqual(resolveElement(first.id), null);

  document.getElementById("b")!.remove();
  extractPageSnapshot(); // rescan purges the detached node

  assert.equal(resolveElement(first.id), null);
  assert.equal(getElementRef(first.id), null);
  assert.equal(getComponent("c-missing"), null);
  assert.equal(getElementComponent("e-missing"), null);
  assert.equal(readContext({ scope: "component", id: "c-missing" }), null);
});

test("sensitive field values are absent from component context too", () => {
  setup(`<form aria-label="Payment">
           <input id="p" type="password" value="hunter2">
           <input id="u" name="username" value="alice">
         </form>`);
  box(document.getElementById("p"));
  box(document.getElementById("u"));
  const snap = extractPageSnapshot();
  const password = find(snap, (e) => e.type === "password");
  const fields = getComponentElements(componentOf(password.id).id);

  assert.equal(fields.find((f) => f.type === "password")?.value, null);
  assert.equal(fields.find((f) => f.domName === "username")?.value, "alice");
});

test("dynamic DOM additions are picked up on the next scan", () => {
  setup(`<section aria-label="A"><button id="one">One</button></section>`);
  box(document.getElementById("one"));
  const first = find(extractPageSnapshot(), byName("One"));

  document.body.insertAdjacentHTML(
    "beforeend",
    `<section aria-label="B"><button id="two">Two</button></section>`,
  );
  box(document.getElementById("two"));
  const next = extractPageSnapshot();

  const one = find(next, byName("One"));
  const two = find(next, byName("Two"));
  assert.equal(one.id, first.id); // stable across scans
  assert.notEqual(two.id, one.id);
  assert.notEqual(two.componentId, one.componentId);
  assert.equal(componentOf(two.id).name, "B");
});
