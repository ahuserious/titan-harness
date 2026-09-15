---
name: titan-ultraplan
description: Plan with the titan-harness fusion team — /ultraplan grills the brief, drafts the plan with anonymous seats, judges, fuses and collects SHA-256 ACKs while writes stay blocked; /plan routes here at level 3.
---

# /ultraplan — plan mode plus the fusion team

Use when a task deserves a real plan before anyone edits a file: a feature spanning several files, a migration, an integration, anything the level-3 harness would run as an authored workflow. The command lives in titan-harness (`extensions/titan-harness/modules/cmd-ultraplan.ts`); the roster is `model-stack-ultraplan.yaml` (`~/.pi/titan-harness/`).

## Flow

1. `/ultraplan <brief>` — enters **plan mode** (edit/write removed from the tools, bash allowlisted, blocked again at `tool_call`), opens `.titan/plans/<planId>/` and a store run (`command: ultraplan`), and runs the **grilling round**: the architect seat asks 3–8 numbered frontier questions, each with a recommendation. Nothing is drafted yet.
2. `/ultraplan answer <n> <text>` — answer a question. Unanswered questions take the recommendation when fusion starts.
3. `/ultraplan fuse` — every live fusion seat drafts the plan concurrently as an anonymous letter (`seats/A.md`, `seats/B.md`, …; fresh read-only sessions; prompts never name a model); the judge ranks the drafts into `judge.yaml`; the fuser merges them into `fused-plan.md`; then every seat receives the fused bytes and must answer `ACK FUSION <runId>` — the SHA-256 and each seat's ACK land in `acks.json` and in the plan's "Seat ACKs" table.
4. `/ultraplan done` — leaves plan mode and points at `/create-workflow --from-plan <planId>` (P7 authoring). `/ultraplan abort` stops the children and leaves plan mode; `/ultraplan status` prints the phase and paths.

## Guarantees

- **Writes blocked** for the whole session: plan mode removes edit/write, and `tool_call` blocks them and any non-allowlisted bash as belt-and-braces. Seats, judge and fuser run with read-only tools; the host writes the artifacts.
- **Anonymity**: seats are letters to the judge and the fuser; no prompt contains a model id. The judge model must differ from the fuser model (refused before spawning otherwise).
- **Minimum three live seats**; with fewer, `/ultraplan` degrades to `/titan-opinion` with a notify. Vacant seats (no usable model and no fallback) are named in the panel.
- Every child is ledgered on the plan run (`origin: fusion | judge | fuser`, the grilling architect as `run`) and on the session ledger, so Σ TOTALS moves.

## `/plan`

Titan registers `/plan`. When the active shape declares `plan_command: /ultraplan` (the level-3 shape), a bare `/plan <brief>` routes to `/ultraplan`; `/plan on|off|toggle` always drives plain plan mode (the port of Pi's plan-mode example: `Plan:` extraction, `[DONE:n]` markers, `/todos`).

## Files

`.titan/plans/<planId>/{brief.md, questions.md, questions.json, answers.md, seats/<letter>.md, judge.yaml, fused-plan.md, acks.json}`; the run under `~/.pi/titan-harness/runs/<project>/<runId>/` carries the events (`ultraplan.start|questions|seats|judge|fused|acks|done`) and the ledger.
