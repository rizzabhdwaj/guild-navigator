# Guild Navigator

**An AI-powered browser agent that helps people navigate complicated websites and complete tasks using natural language.**

> **You give the destination. We navigate.**

## 1. Project introduction

Guild Navigator is a cross-browser extension for Firefox and Chrome that enables users to interact with websites through a conversational interface. Instead of manually searching through menus, locating obscure controls, and navigating complicated forms, users can describe what they want to accomplish in plain English.

Guild Navigator interprets the user's request, analyzes the current webpage, identifies relevant elements, and selects browser actions through structured tool calling. It then executes those actions, observes the resulting page state, and continues until the task is complete or user intervention is required.

The project focuses on three core capabilities:

- **Intelligent element discovery:** Find relevant buttons, download links, form fields, and controls, including elements hidden behind menus, expandable sections, or complicated page layouts.
- **Natural-language browser navigation:** Understand user instructions and navigate multi-step websites, including complex government portals.
- **Assisted form completion:** Fill out forms using information explicitly provided or approved by the user, with review and confirmation before consequential submissions.

The long-term goal is to make the web easier to navigate by allowing people to describe their destination rather than manually figuring out every step required to reach it.

### Design philosophy

Guild Navigator treats browser automation as a perception, reasoning, and execution problem. It combines deterministic DOM inspection with LLM-based interpretation and structured browser tools, rather than relying entirely on screenshots or allowing a model to execute arbitrary code.

The system is designed around three principles: understand the current page, act through controlled tools, and verify the outcome.

Users remain in control of sensitive information and consequential actions.

---

## 2. MVP scope

The first version should support a small set of general browser actions that can be composed into different workflows.

### Feature A — Find hidden or obscure elements

**Example request:** "Find the download button for this document."

The agent examines the page, identifies candidate download links and buttons, expands relevant sections if necessary, and highlights the best match. It should distinguish elements that are merely hidden from elements that are actually inaccessible or unavailable.

A CSS-hidden element is not necessarily actionable. Search visible controls first, then inspect relevant hidden DOM structures and expand menus or sections when appropriate. Do not blindly click hidden elements or trigger arbitrary page event handlers.

### Feature B — Navigate complicated websites

**Example request:** "Find where I can check my application status."

The agent inspects the current page, opens relevant menus, follows appropriate links, and searches subsequent pages until it finds the relevant section. It should explain where it is going and let the user take over when uncertain.

### Feature C — Conversational interface

A side panel where users describe tasks, see the agent's progress, answer clarifying questions, approve actions, and stop execution.

### Feature D — Assisted form filling

**Example request:** "Fill this application using the details I provided."

The agent maps user-approved data to form fields, fills them, and checks validation messages. The user reviews the completed form and explicitly confirms submission.

Treat personal data as sensitive. Minimize what is sent to the model, and don't persist form values by default.

---

## 3. Technical architecture

Build the first version with a browser extension, a TypeScript backend, and the two-stage LLM architecture.

```text
┌──────────────────────────────────┐
│ Extension side panel              │
│ Chat, task status, approvals      │
└────────────────┬─────────────────┘
                 ↕
┌──────────────────────────────────┐
│ Page observer — TypeScript        │
│ DOM extraction, visibility, forms │
└────────────────┬─────────────────┘
                 ↓
┌──────────────────────────────────┐
│ Stage 1 — Page interpreter        │
│ Task-relevant JSON and candidates │
└────────────────┬─────────────────┘
                 ↓
┌──────────────────────────────────┐
│ Stage 2 — Action-taking LLM       │
│ Structured tool calls             │
└────────────────┬─────────────────┘
                 ↓
┌──────────────────────────────────┐
│ Validated action executor         │
│ Resolve, execute, observe results │
└────────────────┬─────────────────┘
                 ↻
     Loop until verified completion,
     failure, or user input
```

### Component responsibilities

| Component | Responsibility |
|---|---|
| Side panel | Chat interface, progress, approval and cancellation |
| Content script | Inspect the current page and interact with its DOM |
| Page interpreter | Produce compact, task-specific representations |
| Action model | Choose the next tool and its arguments |
| Action executor | Validate and execute tool calls |
| Backend | API credentials, model routing, quotas, task orchestration |
| Storage | User-approved profiles, preferences, task history, if enabled |

The page interpreter should not always require an LLM call. A deterministic extractor should handle straightforward buttons, links, and form fields. Use the interpreter when the user's intent requires semantic reasoning.

For the first prototype, most orchestration can remain inside the extension, with the backend used for model inference. This allows the agent to be validated before investing in a larger backend.

---

## 4. Development roadmap

### Phase 1 — Browser extension skeleton

**Goal: foundation**

- Create a Firefox/Chrome-compatible extension with a side panel, a content script, and messaging between them.
- Build the chat interface in React.
- Read the active tab's URL and title.
- Extract buttons, links, inputs, and labels.
- Display extracted elements in a debug panel.

**Definition of done:** Open a supported website and inspect its interactive elements from the extension.

### Phase 2 — Page interpreter

**Goal: perception**

- Convert the DOM into a compact representation.
- Pass the task and page information to the interpreter.
- Return relevant elements with stable references for the current page state.
- Compare deterministic extraction with LLM-based compression.

**Definition of done:** A request like "find the certificate download button" returns plausible candidates with evidence.

### Phase 3 — Tool-calling agent

**Goal: execution**

Implement the second LLM and its action tools:

- `click`
- `type`
- `select_option`
- `scroll`
- `navigate`
- `expand_element`
- `extract_text`
- `finish`

Validate every tool call before execution. Re-observe the page after relevant changes.

**Definition of done:** The agent can perform a short sequence of actions and verify that each succeeded.

### Phase 4 — Multi-step navigation

Add planning, progress updates, error recovery, and stopping conditions.

The agent should know when to inspect another page, when to ask the user a question, and when to stop because the desired outcome has been achieved.

### Phase 5 — Form assistance

Add a user-approved profile of reusable information, field-to-value mapping, form validation, and a review screen before submission.

Treat personal data as sensitive. Minimize what is sent to the model, and don't persist form values by default.

### Phase 6 — Reliability and release

Test on real websites, fix cross-browser differences, measure success rates, document limitations, and publish a demonstrable MVP.

---

## 5. Action API

Keep the model-facing API small and predictable.

```ts
type BrowserAction =
  | {
      type: "click";
      elementId: string;
    }
  | {
      type: "type";
      elementId: string;
      text: string;
    }
  | {
      type: "select_option";
      elementId: string;
      value: string;
    }
  | {
      type: "scroll";
      direction: "up" | "down";
    }
  | {
      type: "navigate";
      url: string;
    }
  | {
      type: "expand_element";
      elementId: string;
    }
  | {
      type: "extract_text";
      elementIds: string[];
    }
  | {
      type: "finish";
      summary: string;
    };
```

Each tool should return a structured result:

```ts
type ActionResult = {
  success: boolean;
  message: string;
  pageChanged: boolean;
  requiresUserInput?: boolean;
};
```

Use element IDs that are valid only for a particular observed page state. After navigation or significant DOM changes, regenerate the relevant element map and validate any pending action against it.

Distinguish a normal click from a consequential action. A button that opens a menu is not equivalent to one that submits an application, makes a payment, or deletes information.

---

## 6. Evaluation benchmark

Evaluate Guild Navigator with repeatable tasks, not just demos.

| Test | What success means |
|---|---|
| Find a download | Correct document or download control identified |
| Find a buried setting | Relevant section found through navigation |
| Fill a form | Correct values entered into the intended fields |
| Handle a dynamic page | Correctly recovers after the DOM changes |
| Recover from a failed click | Re-observes the page and chooses a reasonable next step |
| Detect ambiguity | Asks the user rather than guessing |
| Handle malicious page text | Doesn't follow instructions that conflict with the user's task |

Start with around 20–30 tasks and expand the suite as failures are discovered. Record:

- Task success rate
- Incorrect action rate
- Recovery rate
- Latency
- Token usage and cost per completed task

A small, well-documented benchmark is more useful than claiming the agent works on every website.

---

## 7. Suggested repository structure

Use TypeScript throughout the extension and backend initially.

```text
guild-navigator/
├── apps/
│   ├── extension/
│   │   ├── manifest.json
│   │   └── src/
│   │       ├── sidepanel/
│   │       ├── content/
│   │       ├── background/
│   │       └── messaging/
│   └── api/
│       └── src/
│           ├── routes/
│           ├── llm/
│           └── tasks/
├── packages/
│   ├── shared-types/
│   ├── dom-extractor/
│   ├── page-interpreter/
│   ├── action-executor/
│   └── agent-core/
├── tests/
│   ├── fixtures/
│   ├── browser-tasks/
│   └── evaluations/
├── docs/
│   ├── architecture.md
│   └── security.md
└── README.md
```

This is a suggested structure, not something that must be created all at once. Start with the extension and DOM extractor; introduce shared packages as the implementation grows.

For cross-browser compatibility, use WebExtensions APIs and check differences between Chrome Manifest V3 and Firefox's supported extension APIs. Keep browser-specific behavior behind small adapters instead of scattering compatibility checks throughout the code.

---

## 8. Scope exclusions for version one

Deliberately leave these out of the initial release:

- Autonomous purchasing or payment submission
- Automatically solving CAPTCHAs or bypassing access controls
- Background cloud browsers
- A complicated memory system
- Multiple collaborating agents
- A sophisticated billing system before demand is validated

The goal is to get one compelling workflow working end-to-end: the user asks for a document on a complicated portal, the agent finds the relevant section, navigates there, identifies the correct download, and verifies the result.

That workflow will force you to solve the most important engineering problems without drowning in scope.

---

## 9. First milestone

**Open a website, ask Guild Navigator to find a specific button, have it return the correct element, click it through a validated tool call, and verify what happened.**

Once that works reliably, the same architecture can support navigation, extraction, and form filling.

Build the browser layer first, keep the two-stage LLM design modular, and let benchmark results determine how much intelligence each stage actually needs. This gives Guild Navigator a solid foundation as both a useful extension and a serious agent-engineering portfolio project.
