---
name: ship-and-verify
description: Combo workflow: gate a build with TestMu cloud runs, Kane CLI browser flows, and Momentic E2E before merge, wired into /titan-auto-validate. Use for "ship it" requests that need proof.
---

# ship-and-verify
## Steps
1. Choose the gate: unit/lint (local) → Kane CLI flow on the preview URL (`kane-cli-browser-runs`) → Momentic suite if the project has one (`momentic-e2e`) → TestMu SmartUI/Accessibility for UI changes (`testmu-cloud-testing`).
2. Encode the gate as the `/titan-auto-validate` validation script so every builder round runs it; the gate is immutable during the loop.
3. On failure: triage with TestMu Automation logs or Kane proof; fix; re-run only what failed.
4. Report pass/fail per layer with links; do not claim green without artifacts.

## Rules
- Cloud runs cost minutes: scope to changed surfaces while iterating, full suite once at the end.
