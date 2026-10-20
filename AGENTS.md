# Agent notes

Read `README.md` first. It documents the architecture, file map, commands, and known
gaps.

## Working directory

All commands run from `apps/extension`. There is no root `package.json`.

```bash
cd apps/extension
npm ci
npm test          # required before finishing a change
npm run build     # tsc --noEmit + esbuild into dist/
```

## Rules for changes

- Keep the `messages.ts` request/response contract JSON-serializable. The side panel
  and content script run in different JavaScript contexts.
- The model may only act through `src/tools.ts`. Do not add direct DOM access or
  arbitrary code execution to the agent/model layer.
- Preserve the snapshot invariants in `src/snapshot.ts`: stable IDs within a scan,
  separate rendered/inViewport/obscured facts, no sensitive field values, bounded
  output.
- Any action result must remain `{ success, message, pageChanged }`.
- Do not print, log, or return field values or secrets.
- Do not add a real API key anywhere. Use `apps/extension/.env.example` as the
  template; `.env` is ignored and must never be committed or archived.
- Do not commit, stage, or push unless the user explicitly asks.
- Prefer the existing structure and TypeScript/React/esbuild setup over new tooling.

## Verification

`npm test` currently runs 59 tests. `npm run build` must pass with strict TypeScript
(`noUnusedLocals`, `noUnusedParameters`). Add or update tests for behavior changes.
