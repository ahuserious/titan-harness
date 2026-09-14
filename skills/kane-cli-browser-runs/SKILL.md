---
name: kane-cli-browser-runs
description: Drive Kane CLI (TestMu AI's KaneAI terminal agent) to run natural-language browser flows in a real Chrome and return pass/fail with shareable proof. Use for quick end-to-end checks of a deployed page or flow from the terminal.
---

# kane-cli-browser-runs
## Setup
```
npm install -g @testmuai/kane-cli
kane-cli doctor --install          # once
npx @testmuai/kane-cli-skill       # installs the vendor skill for coding agents
```
Sign in as prompted by `kane-cli`. Prefer the vendor skill's exact command syntax once installed; this skill covers the workflow.

## Playbook
1. Write the flow as numbered natural-language steps with explicit expected outcomes ("Expect the cart badge to read 1").
2. Run against a stable URL (preview deploy or local tunnel), not a half-built dev server.
3. Treat the result as a gate: pass → continue; fail → open the proof (screens/recording), fix, re-run only the failing flow.
4. Store the flow file next to the feature so the check is reusable; wire it into `ship-and-verify`.

## Guardrails
- Runs touch real sites: use test accounts and non-destructive steps unless the environment is disposable.
