# Analyst reports behind the v0.3 integration plan

Verbatim working notes from the analysts and the fusion panel that produced
`docs/ultraplan-v0.3-integration.md` (2026-09-14 → 2026-09-15). They are inputs, not
documentation: every claim in them was true of *this* machine on that date (Pi 0.85.1
snap, pi-subagents 0.67.0, pi-dynamic-workflows 3.10.1, the credentials present then).
Where a note and the shipped code disagree, the code and `README.md` win. No credential
values appear in any file (each was grep-checked for key-like strings before copying).

| File | What it is | Date |
|---|---|---|
| `pi-internals-1-host-events.md` | Pi 0.85.1 extension events and return shapes the plan relies on (`session_before_compact`, `tool_call`, `message_end`, …) with dist line references | 2026-09-14 |
| `pi-internals-2-apis-sessions-usage.md` | read-only `sessionManager`, usage/cost fields, `pi.events`, input hook order, the `--mode json` child stream | 2026-09-14 |
| `pi-internals-3-gaps-and-constraints.md` | what titan lacked before v0.3 (no compaction handling, no stall detector) and the fourteen constraints (shift+tab reserved, no sidebar API, one fan-out knob writes three files, …) | 2026-09-14 |
| `pi-subagents-watchdog-internals.md` | pi-subagents 0.67 watchdog implementation map: files, config namespace and strict parse, triggers, delivery, limits, no exported API | 2026-09-14 |
| `model-provider-facts.md` | providers and auth present in Pi on the machine, thinking-level support per model (the source of `modules/thinking.ts` ceilings) | 2026-09-14 |
| `archon-yaml-spec-excerpt.md` | the Archon YAML DAG vocabulary the `titan.harness/v1` schema keeps (`nodes`, `depends_on`, `when`, `trigger_rule`, `$ARTIFACTS_DIR`, …) | 2026-09-14 |
| `fusion-drive-workflow-report-extract.md` | the claude-fusion-drive `workflow_report` extract (profile subscription-oauth) that gated the plan, config hash included | 2026-09-14 |
| `ultraplan-seat-A-grok-4.6.md` | fusion seat draft A (xai/grok-4.6 xhigh) | 2026-09-14 |
| `ultraplan-seat-B-gemini-3.8-flash.md` | fusion seat draft B (antigravity/gemini-3.8-flash, xhigh↘high) | 2026-09-14 |
| `ultraplan-seat-C-fable-5.1.md` | fusion seat draft C (Claude Fable 5.1, run in-harness because Pi has no Anthropic provider) | 2026-09-14 |
| `ultraplan-seat-D-qwen-3.8-27b.md` | fusion seat draft D (cerebras/qwen-3.8-27b, xhigh↘high) | 2026-09-14 |
| `ultraplan-judge-report.md` | the judge's ranking of the four drafts, disagreements and must-keep items | 2026-09-14 |
| `ultraplan-requirements-trace-section9.md` | the plan's §9 requirements trace (design status vs runnable today) as fused | 2026-09-15 |

The fused plan itself is `../ultraplan-v0.3-integration.md`; the per-phase contracts the
builders followed are `../contracts/p3-contracts.md` … `p9-contracts.md`.
