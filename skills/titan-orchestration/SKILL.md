---
name: titan-orchestration
description: How Titan Harness's 3-tier hierarchy works (ARCHITECT → BUILDERS → SUBAGENTS, with per-builder AUDITORS), which /titan-* command to use for a task, and the hotkeys that reshape it live. Use when deciding how to fan a request out across models or when a user asks about the harness.
---

# titan-orchestration

## The hierarchy
- **Tier 1 ARCHITECT** (one slot; default the strongest reasoning model at xhigh): plans, delegates a task DAG, arbitrates audits, integrates. Never edits files during planning; never spawns subagents directly.
- **Tier 2 BUILDERS** (n = 1-4; the primary builder is the live host chat): execute delegated tasks inside claimed paths, one write-enabled child at a time (writer lease), verify, report ≤ a few KB. May delegate narrow work to tier 3.
- **Tier 3 SUBAGENTS** (pi-subagents, default `cerebras/qwen-3.8-27b` high, cap per child): stateless search/read/bounded checks/small scoped edits; never spawn subagents, never talk to the architect, auditor, or user.
- **AUDITORS** (one per builder when on; ephemeral per review; cross-family model): review every finished WRITE task before the report reaches the architect. Verdict YAML: PASS, PASS_WITH_WARNINGS, FAIL (→ bounded corrections, then AUDIT_EXHAUSTED for architect arbitration), SAFETY / SCOPE_VIOLATION (fail-closed).
- Agents address each other by **callsign only** (forge, anvil, ward, …); models are shown to the human in the transcript and the model bar, never to other agents.

## Commands
| Need | Command |
|---|---|
| independent opinions, read-only | `/titan-opinion <prompt>` |
| all-to-all debate, no judge | `/titan-debate [--rounds N] <prompt>` |
| parallel research → one writer → ACKs | `/titan-fusion "<prompt>" "<fusion instruction>"` |
| plan → DAG → parallel builders (audited) → architect integration | `/titan-collaborate <prompt>` |
| gate-first build loop | `/titan-auto-validate [--max-validations N] <prompt>` |
| one slot only (builders are audited) | `/titan-only [slot] [prompt]` |
| shape / fan-out / auditors | `/titan-shape [next\|name]`, `/titan-n [1-4]`, `/titan-s [0-16]`, `/titan-audit [on\|off]` |
| everything else | `/stack`, `/titan` |

## Hotkeys
Ctrl+Tab shape · Ctrl+Shift+N builders · Ctrl+Shift+S subagent cap · Ctrl+Shift+A auditors (Kitty-protocol terminals: Kitty, Ghostty, WezTerm, foot). Alt+H / Alt+N / Alt+S / Alt+A work in every terminal. Changes apply at the next command (shape, n) or the next child spawn / audit (s, auditor); a running command is never preempted.

## Defaults (from the design consult in docs/harness-shape-consult.md)
builders 2 · subagent cap 4 · audit rounds 2 · auditor model auto (cross-family) · anonymize on.
