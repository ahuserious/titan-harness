# titan-harness status report — 2026-09-15

Repo: `/home/danbot/Dev Tools/pi-extensions/titan-harness` (GitHub `ahuserious/titan-harness`, branch `main`, head `26570da` = 0.8.1). Plan: `docs/ultraplan-v0.3-integration.md` (confirmed 2026-09-15, "confirmed - execute"). Phase contracts the builders followed: `docs/contracts/p3–p9-contracts.md`. Next-phase spec: `docs/PRD-v0.9-live-tui.md`.

## 1. Summary

Every phase of the confirmed plan (P1–P9) is built, unit-tested, smoke-tested in a live Pi 0.85.1 TUI, committed and pushed: 0.2.1 → 0.8.1 in eight commits, 935 passing tests across 46 files, 25 skills, and the Grok plugin mirror at 1.1.0. The harness now has levels 0–3, a hash-chained run store, a YAML DAG workflow engine with verification tiers and fail-closed runner adapters, review-before-report with an escalation ladder, a titan-native watchdog with compaction handling, a store-driven monitor, plan mode + `/ultraplan`, `/create-workflow`, a stdio MCP bridge, `/terraform`, `/local-dev-verify` (headless Chromium over CDP) and `/cloud-simulated-users`. What remains is operator-side (credentials, Kane, ffmpeg) plus the UX items Dan raised today, captured in the v0.9 PRD.

## 2. Shipped per version

| Version | Commit | Phase | Headline features | Files / tests added |
|---|---|---|---|---|
| 0.2.1 | a7f4a0d | P1 | Higgsfield studio guardrails, mcp2cli Python-vs-Rust disambiguation, named-link docs, `divmagic-raw` skill, `pi.mcp` catalog auto-load, `infranodus` entry (disabled until keyed), dynamic-workflows patch script + pins; Grok plugin 1.0.1 (d45f426) | 20 files, +870; 1 test file (pins) |
| 0.3.0 | be7e1ad | P2 | Shape schema v2 + level shapes 0–3, `/titan-level` (Alt+L, Shift+Tab after rebind), `/titan-doctor`, hash-chained run store (events / ledger / provenance JSONL), session ledger, Σ TOTALS and ⟁ LEVEL bar rows, `DynamicSemaphore` child cap, `levelRestore`, `scripts/verify-ledger.mjs`, `scripts/keybindings-rebind.mjs` | 35 files, +5,113; 10 test files |
| 0.4.0 | a07b2dc, 236b876 | P3 | YAML DAG engine (`modules/workflow/`: schema, validator, loader, scheduler, substitution, structured output v1, executor, 9 node types), `/workflow run\|validate\|list\|status\|stop\|graph`, narrow child-hooks extension (`titan-child-hooks.ts`), `workflow-runtime.ts` bridge, `titan-workflow-authoring` skill, two shipped workflows | 44 files, +8,471; 9 test files (+ docs commit) |
| 0.5.0 | ae331c6 | P4 | Evidence schema v1 + six tiers as data, fail-closed runners (bash, kane, testmu, momentic, cursor-cloud, orca-browser, verifier), review frames and `done-verified` rule, escalation report + `reauthored` freeze, mechanical ladder, `titan.budget.max_concurrent_children`, best_of / interleave / hypothesis, content presets + approval receipts | 50 files, +4,990; 7 test files |
| 0.7.0 | 9283823 | P5, P6, P7, part of P8/P9 (0.6.0 and 0.6.1 folded in) | Watchdog state machine + compaction handlers + child pre-emption + stalemate, `/titan-watchdog`, ⌗ WATCHDOG row; monitor rows/frames, `/workflow-monitor` overlay/list/--split, ◫ MONITOR row, `scripts/titan-monitor.mjs`; `/plan`, `/todos`, `/ultraplan`; stdio MCP client + InfraNodus stage; `/create-workflow`, personas + mimeographs, structured output v2 (`submit_result`); `/cloud-simulated-users`; triggers (cron/every, locks, scheduler, Orca recipe), `graph.html`, `/workflow export --dw` | 118 files, +14,642; 15 test files |
| 0.8.0 | 068a3d4 | P8 | `/terraform` (shipped `terraform` workflow, Sources tables, `harness_defaults` consumed at level 2, connectors + automation recipes), `/local-dev-verify` (app recipes, probe, Kane → CDP → unavailable), `modules/cdp-browser.ts` + `scripts/cdp-browser.mjs`, `scripts/stitch-video.mjs`, `cdp-browser` runner; every P7/P8 command wired in the host | 28 files, +4,669; 5 test files |
| 0.8.1 | 26570da | P9 docs | README sections for 0.5.0–0.8.0, INSTALL verify steps + machine changes, `skills/README` (24 rows), `mcp/README` bridge section, `docs/README.md`, 13 analyst reports under `docs/analyst-reports/`; Grok plugin 1.1.0 mirror (5e53787, pushed) | 20 files, +3,602 |

Totals: 46 test files, 936 tests, 25 skill directories (24 indexed in `skills/README.md` plus `titan-workflow-authoring` shipped in 0.4.0 — see §5), package version 0.8.1.

## 3. Verification evidence

**Unit suite** (`~/.bun/bin/bun test extensions/titan-harness/tests`, bun 1.4.2): 935 pass / 1 skip / 0 fail, 936 tests across 46 files, ~110 s. The one skip is `watchdog-limits` when pi-subagents' source is not installed (it is here; the skip guard is for other machines). Acceptance items from plan §7 with a fixture test: every validator rule red+green, the Archon `classify-and-fix` port end to end, architect nodes cannot write, structured output re-ask ≤ 3, deny-matcher hooks, artifact hand-off, H3a–H3f tier fixtures, seeded-defect audit, three mechanical fails → freeze, A4 best-of (all-fail delivers nothing), A10 interleave (no cross-contamination), A11 hypothesis (links only), cursor preflight fails closed without `CURSOR_API_KEY`, momentic skipped unless keyed, every §5.5 watchdog trigger row, the chaos fixture (child dies + compaction → `resuming` with the state block), inspector timeout → `watchdog-failed` without cancelling, monitor frame snapshots per state, ultraplan seats/judge/ACKs, create-workflow persistence + traversal refusal + `--elevate`, personas prompt hashes, CDP driver against a fixture site with a real headless Chromium, terraform docs with Sources tables, cloud-sim probe matrix and recorded cursor run.

**TUI smokes** (a Python pty driver types slash commands into `pi --no-session`; logs in the session scratchpad, `pty-*.log.txt`):

| Log (EDT) | What ran | What it proved |
|---|---|---|
| pty-smoke 00:48 | `/titan-doctor`, `/titan-level status`, `/titan-level 1`, `/titan-only scout …`, `/titan-level 3`, `/titan-shape consult` | doctor panel (24 ready / 10 vacant / 1 warn / 0 unknown), level 1 applied, a real child answered `OK`, one ledger row + two chained events; level 3 initially refused (`ward: auto`) |
| pty-smoke2–4 00:54–00:58 | `/titan-level 3`, `/titan-shape consult` | level 3 loads with `fable-5.1 → claude-opus-4-6 (fallback)` and `ward: auto → gemini-3.8-flash (cross-family auditor)`; leaving the level restores the plain-shape pools (`b2 … exa5`) |
| pty-wf 01:48 | `/workflow graph classify-and-fix`, `/workflow run smoke-two` | a real two-node workflow (bash → qwen prompt) completed in 2.9 s, returns `TITAN-0546`, artifacts with sha256, 10 chained events, 1 ledger row, `verify-ledger.mjs` → chain intact, Σ TOTALS updated |
| pty-wf2–3 01:52–01:53 | `/workflow validate proto-analytics-dashboard`, `/workflow list`, `/workflow status` | both package workflows valid; list shows package + project sources; status shows the events table |
| pty-p56 10:58 | `/titan-watchdog status\|on\|off`, `/workflow-monitor list`, overlay, `/plan`, `/plan off`, `/ultraplan status` | ⌗ WATCHDOG and ◫ MONITOR rows render; watchdog toggles persist; runs table and overlay frame; plan mode on/off; ultraplan responds |
| pty-cloud 11:09 | `/cloud-simulated-users probe` | 0/4 lanes ready with the exact missing names |
| pty-p7 11:13 | `/create-workflow`, `/workflow schedule list`, `/workflow export --dw classify-and-fix`, `/workflow graph … --html` | usage line; scheduler idle; `classify-and-fix.dw.mjs` and `graph-classify-and-fix.html` written under `.titan/plans/` |
| pty-tf 11:20 | `/terraform --dry-run` | 7-node plan, sources, connector table, recipes, nothing spent |
| pty-ldv 11:35 | `/local-dev-verify --url http://127.0.0.1:59999` | UNAVAILABLE panel after the 60 s probe, never a silent pass |
| pty-login 18:17 | `/titan-doctor` (full) | the panel reproduced in §4 |

Headless load checks (`pi -p --no-session --mode json … </dev/null`) ran after every host-wiring change; the extension loads without errors (the only error in those logs is the host model's invalidated Codex OAuth token, §4).

## 4. Runnable today vs vacant — `/titan-doctor`, 2026-09-15T22:17Z

`ready 24 · vacant 10 · warn 1 · unknown 0`.

| Group | Ready | Vacant / warn |
|---|---|---|
| Models | `xai/grok-4.6`, `antigravity/gemini-3.8-flash`, `antigravity/claude-opus-4-6`, `cerebras/qwen-3.8-27b`; `openai-codex/gpt-6-astra` shows *authed* (credentials configured) but live requests fail with "invalidated oauth token" until `/login openai-codex` completes | `anthropic/claude-fable-5-1` (no Anthropic credentials or OpenRouter key), `openrouter/meta/muse-spark-1.3` (no `OPENROUTER_API_KEY`) |
| Credentials | — | `INFRANODUS_API_KEY`, `CURSOR_API_KEY`, `MOMENTIC_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` absent; no `infranodus` entry in the user MCP config (`/titan-doctor --import-infranodus-key`) |
| Tools | `orca`, `tmux`, `uvx`, `gh` | `kane-cli` not on PATH; `ffmpeg` not on PATH (only the Playwright cache copy, which the video stitcher finds) |
| Keys | — | △ `shift+tab` still Pi's `app.thinking.cycle` (no `keybindings.json`) |
| Pins | all seven pinned, dynamic-workflows menu patch applied | — |
| Store / decisions | JSONL + SHA-256 chain at `~/.pi/titan-harness/runs`, cap 8, no budget, monitor overlay, watchdog off, shape-driven (consult) | — |

Consequences: levels 0–1 run as declared; the level 2/3 architect and the ultraplan architect run on the `xai/grok-4.6` fallback; every Fable seat runs on `antigravity/claude-opus-4-6`; the Muse Spark seat is vacant; the InfraNodus stage degrades to declared confidence; `/local-dev-verify` uses the CDP driver (Chromium from `~/.cache/ms-playwright`, `brave-browser` also present) because this Orca build has no `orca tab goto|screenshot` automation; the four cloud sim-user lanes are vacant.

## 5. Known bugs and gaps

| # | Item | Where | Status |
|---|---|---|---|
| 1 | `shift+tab` cycles Pi's reasoning effort, not the harness presets | Pi keybinding; `/titan-level --claim-shift-tab` not yet applied on this machine | PRD R2 |
| 2 | Bar rows (Σ TOTALS, ◫ MONITOR, ⌗ WATCHDOG) repaint only on commands, `announce()` or the ticker during a run; after `/local-dev-verify` the MONITOR row still read `running` until the next repaint | `titan-harness.ts` renderFooterWidget | PRD R1 |
| 3 | The status line leads with the MCP counter and truncates the shape segment (`⬡ shape consult · builders 2 … cal...`) | `paintShapeStatus` | PRD R1 |
| 4 | Settings scattered over `/stack`, `/titan-level`, `/titan-shape`, `/titan-watchdog`, `/mcp` and three JSON files; no panel, no MCP toggles, no quick configs | — | PRD R4 |
| 5 | No `mcp2cli` in the harness (Python and Rust ones only documented) | — | PRD R5 |
| 6 | In-process trigger scheduler runs only while the session that armed it is open; unattended path = the printed `orca automations create` recipe | `cmd-workflow.ts` | documented |
| 7 | Fusion Drive lifecycle receipts (`plan_confirm`, `goal_record`, execution gates) were never recordable: the plugin had no workflow lifecycle for this run and `TaskCreate` is not exposed in this host | process | recorded, not fixable here |
| 8 | Plan §5.8 `orca-browser` lane cannot run on this Orca build (no tab automation); the runner probes and reports `unavailable`; the CDP driver fills the sim-user lane | runners | documented |
| 9 | Plan versions 0.6.0/0.6.1 were folded into the 0.7.0 commit | history | cosmetic |
| 10 | `titan-workflow-authoring` exists as a skill directory (25 on disk) while `skills/README.md` counts 24 rows — index the 25th | docs | small follow-up |
| 11 | `personas/` at the package root is read by path and not declared under `package.json` `pi.*` | packaging | harmless, note only |
| 12 | Validator `when` grammar is stricter than the scheduler's evaluator (`!` and bare operands rejected at validation) | workflow | by design, documented |
| 13 | `callsign: pool` resolves to the seat's own callsign (docs corrected 236b876) | ai.ts | documented |

## 6. The overnight session-limit incident

At ~02:15 EDT the account hit its session limit (HTTP 429, "resets 3:30am America/New_York"). All seven builders running at that moment (verify-tiers, elevation, patterns done earlier; monitor, watchdog, planning, mcp-bridge, authoring, triggers in flight) were terminated mid-task; the pane-based agent team had already gone stale earlier that night, so builders were running as forks. Their files stayed on disk (743/745 tests green at the time). At 10:45 EDT the lead resumed the five with substantial work by message (each fork keeps its transcript) and re-ran the two that had produced nothing; all reported by 12:05 EDT. Nothing was lost; the sequence of commits after the incident is 0.5.0 → 0.7.0 → 0.8.0 → 0.8.1. The recovery pattern is recorded in the operator's memory notes (resume forks by name, re-check `bun test`, re-run the TUI smoke before each commit).

## 7. Next phase — `docs/PRD-v0.9-live-tui.md`

Requirements R1–R6: live status line and bar (≤ 1 s tick while active, ≤ 5 s idle, repaint on every settle) with the harness shape preset as the first, never-truncated segment; `shift+tab` cycles the presets after the keybinding rebind; `ctrl+w` (alt twin `alt+w`, fallback `ctrl+shift+w`) sidebar showing the phased workflow like a todo list with role-coloured lines, role boxes, descriptions and the state colours working / in-review / redo n / review-passed / failed, dimming after 10 min idle; `ctrl+,` settings panel with every harness setting editable, MCP server toggles that write the user catalog, and named quick configs (`/titan-config save|apply|list`); `scripts/mcp2cli.mjs` over titan's stdio bridge (`list`, `tools`, `call`, `doctor`); this status report, refreshed GitHub docs, and the v0.9 workflow authored by `/create-workflow` from the PRD.

Acceptance (from the PRD): (1) after `/workflow run smoke-two` settles the MONITOR row reads `completed` within 1 s; (2) `shift+tab` changes the first status-line segment between level shapes; (3) `ctrl+w` shows one coloured line per phase with role boxes and closes on the second press; (4) `ctrl+,` opens the panel, toggling `momentic` writes the user MCP config and a quick config round-trips; (5) `node scripts/mcp2cli.mjs doctor` lists every catalog server and `call` returns the fake server's echo; (6) unit tests for the new colours, sidebar frame, settings model, config presets and the CLI. Open questions for Dan are listed at the end of the PRD (sidebar hotkey collision with "delete word", which MCP file the toggles write, dim vs close at 10 minutes).
