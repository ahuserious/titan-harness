---
name: titan-watchdog
description: The titan-native watchdog (0.6.0): what it inspects, how it handles host compaction and child pre-emption, the stalemate and held-spend gates, the /titan-watchdog command and its relationship to pi-subagents' own watchdog. Use when a run shows watchdog-failed, stalemate or held-spend, when tuning `watchdog` settings, or when deciding whether to enable pi-subagents' reviewer inside titan children.
---

# titan-watchdog

## What it is
A run-level reviewer that lives in the titan host (`modules/watchdog/`), not in a package with no API. It reads the hash-chained run store, never edits files, and spends only through ledgered inspector children (`origin: watchdog` or `compaction-inspector` rows). States: `idle → armed → inspecting → cleared | steering | resuming | halted-stalemate | failed`, re-armed after every inspection.

## Host compaction (`session_before_compact`)
1. The deterministic **state block** is built synchronously from the store (run id, phase, node states, agents, evidence ids with hashes, open findings, plan digest, last 20 event hashes). It starts with `## titan state block` and its field order never changes.
2. `onCompaction: halt-inspect` (default) runs a bounded inspector on the watchdog model (`inspectorTimeoutMs`, 20 s; a manual `/compact titan:inspector=45000` raises it) over the entries about to be summarized and returns a custom summary = state block + narrative.
3. Inspector timeout or failure → state block only, badge `watchdog-failed`, compaction **never cancelled**. `overflow` compactions and retries get the state block only, no inspector. `summary-only` skips the inspector always; `off` leaves compaction to Pi. When Pi writes the summary, the host posts the state block as a custom message after `session_compact` so it still reaches the context.
4. `session_compact` records `compaction.done` (summary hash) and moves `compacting` agents back to `dispatched-working`.

## Child pre-emption (75 %)
A child at `preemptAtContextFraction` of its model's window (from `usage.totalTokens` on its JSON stream) or showing a `compaction_start` event is halted at its next `tool_execution_end`. An inspector on the **dispatching architect's model** compares the transcript tail with the state block: `clean` → logical clear (fresh checkpoint session, prior transcript flagged `logicalCleared`, bytes kept so the chain stays intact); `loss` or `hallucination` → fresh session on the architect's model with `USER_PROMPT_RESUME.md` (state block + diff + findings + carry) — never a transcript replay; inspector failure → `watchdog-failed`, child stays halted.

## Other triggers
Terminal state without a review frame → `done-unverified` + auditor dispatched · ping with an unreviewed write → queued with `missing-review` · abort/crash/timeout without review → `done-unverified` · review PASS with nothing harvested → forced harvest · identical finding identity ×3 → `stalemate` (turn ends, human gate, run paused) · reviewer model/auth error → `watchdog-failed`, `done-verified` refused · ledger over `budgetUsd` → `held-spend` (no new children) · `subagent_watchdog_warning` cards from a child stream are ingested as findings and count toward stalemate · user input cancels an in-flight inspection.

## Command
`/titan-watchdog [status|on|off|model <provider/id>|thinking <level>|compaction halt-inspect|summary-only|off|resume]` — `status` prints state, inspections, spend, findings and stalemate progress; `resume` is the human gate after a stalemate. Settings live under `watchdog` in `~/.pi/agent/titan-harness.json`: `enabled` (false), `model` (`cerebras/qwen-3.8-27b`), `thinking` (medium), `stalemateRepeats` (3), `onCompaction` (halt-inspect), `inspectorTimeoutMs` (20000), `preemptAtContextFraction` (0.75).

## pi-subagents' watchdog
Stays **off inside titan children** by default (`subagents.watchdog.children.enabled: false`): a titan child never carries a second, unmetered reviewer. If an operator enables it, its cards are ingested and one `source: unmetered` ledger row is written per review. Titan mirrors its proven bounds: stalemate identity ≥ 3, reviewer input ≤ 24,000 chars, cadence ≥ 5 tool calls, 30 s cadence reviews, 20 s compaction inspection, `WATCHDOG.md` ≤ 8 KB (`tests/watchdog-limits.test.ts` checks them against the pinned 0.67.0 package). Titan never writes `subagents.watchdog.*` keys except through merges that preserve unknown keys.

## Reading a run
`watchdog.*`, `compaction.*` and `review.verdict` events in `events.jsonl`; `agents/<id>.json` carries `logicalCleared` after a logical clear; every inspection is a ledger row you can total with `node scripts/verify-ledger.mjs <runDir>`.
