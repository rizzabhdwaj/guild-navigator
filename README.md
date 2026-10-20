# Guild Navigator

Guild Navigator is a prototype browser extension that lets a user describe a task in
plain English and have an LLM-driven agent inspect and operate the current web page.

The project is currently a **Firefox-first WebExtension (Manifest V3)** with a React
side panel. A Chrome build does not exist yet: `sidebar_action` and the MV3
`background.scripts` entry are Firefox-specific.

Repository status: working prototype, 59 unit tests passing, no backend yet.

## Quick start

Requirements: Node.js 20+ and npm.

```bash
cd apps/extension
npm ci
cp .env.example .env        # then put your OpenRouter key in .env
npm test                    # 59 tests
npm run build               # type-check + bundle into dist/
npm run start:firefox       # build, then launch Firefox with web-ext
```

To load the built extension manually in Firefox:

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on**.
3. Select `apps/extension/dist/manifest.json`.
4. Click the toolbar button to open the side panel.

The build reads `OPENROUTER_KEY` from `apps/extension/.env` and **bakes it into the
sidebar bundle**. This is acceptable only for local prototyping. Never distribute a
build made with a real key.

## What it does

1. The side panel sends a natural-language task to an OpenAI-compatible model through
   OpenRouter.
2. The model can call exactly three tools:
   - `read_page` — return a structured snapshot of the current tab.
   - `press_button` — click one element from the latest snapshot.
   - `fill_field` — type into one field from the latest snapshot.
3. The side panel forwards tool calls to a content script in the active tab.
4. The content script reads the DOM (`snapshot.ts`) and performs validated actions
   (`actions.ts`).
5. After an action reports `pageChanged`, the agent loop automatically re-reads the
   page and feeds the new snapshot back to the model.
6. The loop stops when the model replies without a tool call, when `maxSteps` (12)
   is reached, or when the user presses **Stop**.

## Architecture

```text
side panel (React)                 content script (per tab)
┌────────────────────────┐         ┌──────────────────────────────┐
│ App.tsx                │         │ content.ts                   │
│  runAgent() ───────────┼────────►│  messages.ts contract        │
│   model adapter        │  JSON   │  snapshot.ts  (read DOM)     │
│   tool executor        │◄────────┤  actions.ts   (mutate DOM)   │
│  page.ts transport     │         └──────────────────────────────┘
└───────────┬────────────┘
            │ HTTPS
            ▼
   OpenRouter chat completions
```

Key invariants:

- The model never touches the DOM or executes arbitrary code. It only selects named
  tools with an `elementId` from the most recent snapshot.
- Element IDs are stable only within one page state. Any navigation or DOM change
  invalidates them; the executor re-checks that the referenced element is still live
  and actionable/editable.
- Page text is untrusted input. The system prompt tells the model not to follow
  instructions found on the page.
- Sensitive field values are not included in snapshots, action results, or logs.

## File map

```text
guild_navigator_plan.md              Product/architecture plan and scope
data.json                            Example page snapshot captured from Codeforces
                                     (development sample; not used by tests)
apps/extension/
├── package.json                     Scripts and dependencies
├── package-lock.json                Reproducible dependency lock
├── tsconfig.json                    Strict TypeScript config
├── build.mjs                        esbuild build: sidebar, content, background
├── build-tests.mjs                  Bundles tests to dist-tests/ for node:test
├── public/                          Static extension files
│   ├── manifest.json                MV3 manifest (Firefox sidebar_action)
│   ├── index.html                   Side panel document
│   └── icons/icon.svg
├── src/
│   ├── messages.ts                  Shared request/response + snapshot types
│   ├── snapshot.ts                  DOM extraction, visibility, IDs, truncation
│   ├── actions.ts                   Validated click/fill inside the page
│   ├── content.ts                   Content-script message handler
│   ├── background.ts                Opens the sidebar from the toolbar button
│   ├── tools.ts                     Tool registry, schemas, executor
│   ├── agent.ts                     Model adapter + observe/decide/act loop
│   └── sidebar/
│       ├── main.tsx                 React entry point
│       ├── App.tsx                  Chat UI and agent wiring
│       └── page.ts                  Navigation-aware sidebar ↔ tab transport
└── tests/
    ├── harness.ts                   jsdom setup helpers
    ├── snapshot.test.ts             DOM extraction/visibility/ID tests
    ├── context.test.ts              Component and row context tests
    ├── tools.test.ts                Tool validation/execution tests
    ├── actions.test.ts              Click/fill validation tests
    └── agent.test.ts                Agent loop tests with a fake model
```

## Message flow

`messages.ts` is the contract between the side panel and the content script. It must
remain JSON-serializable because the browser serializes messages.

Request types: `SCAN_PAGE`, `GET_ELEMENTS`, `GET_CONTEXT`, `CLICK_ELEMENT`,
`FILL_FIELD`.

Response kinds: `snapshot`, `elements`, `context`, `action`, `error`.

Actions return `{ success, message, pageChanged }`. A successful click means the click
was dispatched, not that the intended outcome happened; callers must re-read the page.

`page.ts` handles the case where a click navigates and destroys the content script
before it can reply. It waits for the tab to settle (URL change or loading → complete)
and reports a synthetic navigation result. Read-only requests are retried by
re-injecting `content.js` when the content script is missing.

## Agent loop and model

- Provider: OpenRouter, OpenAI-compatible chat completions.
- Model constant: `OPENROUTER_MODEL` in `src/agent.ts`.
- Temperature is 0 and `tool_choice: "auto"`.
- Reasoning text is requested and surfaced in the UI when the provider returns it.
- `AgentModel` is the only seam to the provider, so the loop is tested with a fake
  model and can be moved to a background worker/backend without changing the loop.

## Snapshot extraction

`src/snapshot.ts` is intentionally large and deterministic. It:

- Walks the DOM and emits plain JSON (no coordinates or raw HTML).
- Separates `rendered`, `inViewport`, and `obscured`; off-screen is not "hidden".
- Resolves accessible names, roles, labels, descriptions, and component/row context.
- Tracks dialogs, menus, tabs, forms, tables, and disclosure state.
- Keeps element IDs stable across repeated scans until the node is detached.
- Omits values of sensitive fields (for example password inputs).
- Prioritizes useful elements and truncates large pages, reporting the truncation.

## Testing and verification

```bash
cd apps/extension
npm test
npm run build
```

Tests use `node:test` with jsdom and are bundled by esbuild. `npm run build` runs
`tsc --noEmit` first, so it also type-checks all source.

## Security notes and known gaps

These are honest limitations, useful for the next agent working on the project:

- The OpenRouter key is inlined into `dist/sidebar.js` at build time. Move the model
  call to a backend before any public release.
- Consequential actions (submit, pay, delete, register) are discouraged by the system
  prompt but there is no hard permission gate or confirmation UI yet.
- No Chrome side-panel implementation (`chrome.sidePanel`) and no cross-browser
  adapter, despite the long-term plan.
- No persistence, task history, settings, or profile storage.
- The agent loop is in the side panel; closing the panel stops a run.
- There is no integration/browser automation test suite yet, only unit tests.
- `data.json` is a captured sample, not a fixture used by the test suite.

## Source of truth

`guild_navigator_plan.md` describes the intended product and long-term architecture.
The implementation above is the current state and takes precedence when they differ.
