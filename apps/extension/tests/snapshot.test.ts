import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPageSnapshot, getStoredElements, resolveElement } from "../src/snapshot";
import { box, byName, byTag, find, previewAll, setup } from "./harness";

// ---------------------------------------------------------------------------

test("accessible name comes from <label>, placeholder stays separate", () => {
  setup(`<label for="q">Search problems</label>
         <input id="q" placeholder="Enter a problem name">`);
  box(document.querySelector("input"));
  const ref = find(extractPageSnapshot(), byTag("input"));
  assert.equal(ref.name, "Search problems"); // label wins
  assert.equal(ref.label, "Search problems"); // explicit label field
  assert.equal(ref.placeholder, "Enter a problem name"); // not collapsed into name
});

test("icon-only controls use aria-label or descendant image alt", () => {
  setup(`<button id="a" aria-label="Close"><svg></svg></button>
         <button id="b"><img alt="Save"></button>`);
  box(document.getElementById("a"));
  box(document.getElementById("b"));
  const snap = extractPageSnapshot();
  assert.equal(find(snap, (e) => e.id && e.name === "Close").name, "Close");
  assert.equal(find(snap, byName("Save")).name, "Save");
});

test("links containing images are named by the image alt text", () => {
  setup(`<a id="l" href="/home"><img alt="Home" src="/home.png"></a>`);
  box(document.getElementById("l"));
  const ref = find(extractPageSnapshot(), byTag("a"));
  assert.equal(ref.name, "Home");
  assert.equal(ref.role, "link");
  assert.equal(ref.href, "https://example.com/home");
});

test("hidden vs off-screen are represented separately", () => {
  setup(`<button id="hidden" style="display:none">Hidden</button>
         <button id="off">Off screen</button>`);
  box(document.getElementById("off"), { y: 5000, height: 20 }); // below the fold
  const snap = extractPageSnapshot();
  const hidden = find(snap, byName("Hidden"));
  const off = find(snap, byName("Off screen"));
  assert.equal(hidden.visibility.rendered, false);
  assert.equal(off.visibility.rendered, true);
  assert.equal(off.visibility.inViewport, false); // off-screen but kept
  assert.equal(off.actionable, true);
});

test("disabled controls and disabled fieldsets are not actionable", () => {
  setup(`<button id="b" disabled>Save</button>
         <fieldset disabled><input id="i" aria-label="Street"></fieldset>`);
  box(document.getElementById("b"));
  box(document.getElementById("i"));
  const snap = extractPageSnapshot();
  const button = find(snap, byName("Save"));
  const input = find(snap, byName("Street"));
  assert.equal(button.disabled, true);
  assert.equal(button.actionable, false);
  assert.equal(input.disabled, true);
});

test("custom ARIA controls expose role and state", () => {
  setup(`<div id="s" role="switch" aria-checked="true" aria-label="Dark mode" tabindex="0"></div>`);
  box(document.getElementById("s"));
  const ref = find(extractPageSnapshot(), byName("Dark mode"));
  assert.equal(ref.role, "switch");
  assert.equal(ref.checked, true);
  assert.equal(ref.interactive, true);
  assert.equal(ref.actionable, true);
  assert.equal(ref.focusable, true);
});

test("code editor surfaces as an editable textbox", () => {
  setup(`<textarea class="inputarea" aria-label="Code editor"></textarea>`);
  box(document.querySelector("textarea"));
  const editor = find(extractPageSnapshot(), byName("Code editor"));
  assert.equal(editor.editable, true);
  assert.equal(editor.interactive, true);
});

test("long field values are marked as previews rather than appearing truncated", () => {
  setup(`<textarea aria-label="Code editor">abcdefghijklmnop</textarea>`);
  box(document.querySelector("textarea"));
  const editor = find(extractPageSnapshot({ maxTextLength: 10 }), byName("Code editor"));
  assert.equal(editor.valueTruncated, true);
  assert.match(editor.value ?? "", /…$/);
});

test("forms, controls and select options are linked", () => {
  setup(`<form id="f" aria-label="Booking">
           <select id="s" aria-label="Room">
             <option value="a">Single</option>
             <option value="b" selected>Double</option>
           </select>
         </form>`);
  box(document.getElementById("s"));
  box(document.getElementById("f"));
  const snap = extractPageSnapshot();
  const select = find(snap, byName("Room"));
  assert.equal(select.role, "combobox");
  assert.equal(select.options?.length, 2);
  assert.deepEqual(select.options?.find((o) => o.value === "b"), {
    value: "b",
    label: "Double",
    selected: true,
  });
  const form = snap.forms[0];
  assert.equal(form.name, "Booking");
  assert.ok(form.controlIds.includes(select.id));
});

test("repeated labels are disambiguated by section and row context", () => {
  setup(`<h2>Invoices</h2>
         <table><thead><tr><th>Amount</th></tr></thead>
           <tbody><tr><td><button id="t">Open</button></td></tr></tbody></table>
         <h2>Messages</h2>
         <p><button id="m">Open</button></p>`);
  box(document.getElementById("t"));
  box(document.getElementById("m"));
  const snap = extractPageSnapshot();
  const opens = snap.elements.filter(byName("Open"));
  assert.equal(opens.length, 2);
  const tableOpen = opens.find((e) => e.rowContext !== null)!;
  const plainOpen = opens.find((e) => e.rowContext === null)!;
  assert.equal(tableOpen.rowContext?.Amount, "Open");
  assert.equal(tableOpen.sectionHeading, "Invoices");
  assert.equal(plainOpen.sectionHeading, "Messages");
});

test("missing or malformed ARIA references fall back gracefully", () => {
  setup(`<button id="b" aria-labelledby="does-not-exist">Real text</button>
         <span id="d1">Extra info</span>
         <input id="i" aria-describedby="d1 also-missing" aria-label="Email">`);
  box(document.getElementById("b"));
  box(document.getElementById("i"));
  const snap = extractPageSnapshot();
  assert.equal(find(snap, byTag("button")).name, "Real text");
  const input = find(snap, byTag("input"));
  assert.equal(input.name, "Email");
  assert.equal(input.description, "Extra info"); // only the resolvable ref
});

test("ids are stable across scans and stale once detached", () => {
  setup(`<button id="b">Go</button>`);
  box(document.getElementById("b"));
  const first = find(extractPageSnapshot(), byTag("button"));
  const second = find(extractPageSnapshot(), byTag("button"));
  assert.equal(first.id, second.id); // stable within the same node
  assert.notEqual(resolveElement(first.id), null);
  document.getElementById("b")!.remove();
  assert.equal(resolveElement(first.id), null); // detached => stale
});

test("sensitive field values are never collected", () => {
  setup(`<input id="p" type="password" value="hunter2">
         <input id="c" name="card_number" value="4111111111111111">
         <input id="a" autocomplete="cc-csc" value="123">
         <input id="u" name="username" value="alice">`);
  for (const id of ["p", "c", "a", "u"]) box(document.getElementById(id));
  const snap = extractPageSnapshot();
  assert.equal(find(snap, (e) => e.type === "password").value, null);
  assert.equal(find(snap, (e) => e.domName === "card_number").value, null);
  assert.equal(find(snap, (e) => e.domName === "username").value, "alice");
});

test("large pages prioritize useful elements and report truncation", () => {
  const buttons = Array.from({ length: 500 }, (_, i) => `<button>Action ${i}</button>`).join("");
  setup(buttons);
  previewAll();

  const snap = extractPageSnapshot({ maxElements: 100 });
  assert.equal(snap.elements.length, 100);
  assert.equal(snap.stats.included, 100);
  assert.equal(snap.stats.omitted, 400);
  assert.equal(snap.stats.truncated, true);

  const page = getStoredElements(0, 10);
  assert.equal(page.total, 500);
  assert.equal(page.elements.length, 10);
});

test("offscreen elements are deprioritized under tight truncation", () => {
  setup(`<button id="far">Far away</button>
         <button id="near1">Near 1</button>
         <button id="near2">Near 2</button>
         <button id="near3">Near 3</button>`);
  box(document.getElementById("far"), { y: 9000 });
  for (const id of ["near1", "near2", "near3"]) box(document.getElementById(id));

  const snap = extractPageSnapshot({ maxElements: 2 });
  assert.equal(snap.stats.omitted, 2);
  assert.ok(snap.elements.every((e) => e.visibility.inViewport));
  assert.equal(snap.elements.some((e) => e.name === "Far away"), false);
});

test("select option lists are truncated but keep the selected option", () => {
  const options = Array.from(
    { length: 40 },
    (_, i) => `<option value="${i}"${i === 39 ? " selected" : ""}>Opt ${i}</option>`,
  ).join("");
  setup(`<select aria-label="Pick" id="s">${options}</select>`);
  box(document.getElementById("s"));
  const select = find(extractPageSnapshot({ maxOptions: 5 }), byName("Pick"));
  assert.equal(select.optionsTruncated, true);
  assert.equal(select.options!.length, 6); // head (5) + preserved selected
  assert.ok(select.options!.some((o) => o.value === "39" && o.selected));
});
