---
name: titan-auditor
description: The audit contract Titan Harness applies to every builder write task (checklist, YAML verdict, fail-open vs fail-closed rules). Use when reviewing a builder report by hand, when arbitrating an AUDIT_EXHAUSTED escalation as the architect, or when tuning /stack auditor settings.
---

# titan-auditor

## What the auditor receives
Task, acceptance list, the builder's report, and the scoped `git diff` (plus untracked files). Read-only tools. No model identities.

## Checklist (all must PASS)
1. contract_fidelity — every acceptance criterion met, no unrequested refactoring
2. logic_correctness — edge cases, error handling, types, obvious runtime failures
3. scope_compliance — diff ⊆ the task's intended files (otherwise SCOPE_VIOLATION)
4. verification_evidence — checks were run (checked) vs claimed (attested) vs missing
5. diff_hygiene — no secrets, debug prints, orphan files, destructive scripts

## Verdict YAML
`verdict: PASS | PASS_WITH_WARNINGS | FAIL | INCONCLUSIVE | SAFETY | SCOPE_VIOLATION`, `summary`, per-item `checklist`, `evidence_state`, `blocking[]` (file, line_range, rule, issue, remediation), `warnings[]`. Style opinions are warnings, never blocking.

## Lifecycle
FAIL → the builder gets only the blocking items, up to `auditRounds` corrections (default 2), still inside the writer's critical section → re-audit. Exhausted → AUDIT_EXHAUSTED: the report is forwarded with the trail and the ARCHITECT arbitrates (override with rationale, reassign, split the task, or ask the human). SAFETY / SCOPE_VIOLATION → the task is blocked (fail-closed). Read-only tasks are never audited.

## As the architect
Treat `## AUDIT — AUDIT_EXHAUSTED` in a task report as an open decision, not a pass. Never override SAFETY.
