# PRD v0.9 — live TUI, preset cycling, workflow sidebar, settings panel, mcp2cli

Status: draft from Dan's direction of 2026-09-15 (verbatim intent kept; open questions listed at the end). This PRD is the input for the next `/create-workflow` run; the authored workflow lives under `.titan/workflows/v09-live-tui/`.

## Problems observed (Orca, Pi 0.85.1, titan-harness 0.8.1)

1. **Shift+Tab cycles the reasoning effort of the main model**, not the harness presets. Cause: Pi reserves `shift+tab` for `app.thinking.cycle`; titan only binds it after `~/.pi/agent/keybindings.json` moves that action (`/titan-level --claim-shift-tab`). The rebind has not been applied on this machine.
2. **The TUI needs forced updating.** Bar rows (Σ TOTALS, ◫ MONITOR, ⌗ WATCHDOG, level, shape) repaint only on commands, `announce()` or the footer ticker while a titan command is running; between commands the numbers can be stale (seen after `/local-dev-verify`: the MONITOR row still said `running` after the run had settled).
3. **The status line does not lead with the harness shape.** The shape/preset sits inside the Pi status line after the MCP counter and is truncated (`⬡ shape consult · builders 2 (forge, anvil) · subagents ≤4 · auditor on · cal...`).
4. **The live config is not intuitive.** Settings are spread across `/stack`, `/titan-level`, `/titan-shape`, `/titan-watchdog`, `/mcp` and three JSON files; there is no one place to see and change the harness configuration or to toggle MCP servers.
5. **No mcp2cli in the harness.** The skills document the Python `mcp2cli` (`uvx mcp2cli`) and the Rust one used by the Grok plugin, but neither is installed or wrapped; titan's own stdio bridge (`modules/mcp-client.ts`) exists but has no CLI.

## Requirements

### R1 — Live status line, always current
- The status line and the model bar repaint on a steady tick (≤ 1 s) whenever a run, a child, a workflow or the watchdog is active, and at least every 5 s when idle; every repaint reads fresh data (ledger rows, run.json, agents, watchdog status). No row may show a settled run as `running`.
- A run settling (`run.end`, `workflow.end`, node end, child settle, watchdog transition, compaction) triggers an immediate repaint.
- The first segment of the status line is the **harness shape preset**: `⬡ L3 engineering` (level shapes) or `⬡ consult` (plain shapes), followed by the plan command when the shape names one, then MCP and exa counters. The shape segment is never truncated; the rest is.

### R2 — Shift+Tab cycles the harness presets
- `shift+tab` cycles the level shapes 0→3→0 (the same cycle as `/titan-level next`), with the announcement and the bar refresh, and the status-line shape segment updating live.
- Install path: `/titan-doctor` and `/titan-level status` say when Pi still holds `shift+tab`; `/titan-level --claim-shift-tab` (confirm dialog) or `node scripts/keybindings-rebind.mjs` moves `app.thinking.cycle` to `alt+t`; a `/reload` follows. The next phase applies this on Dan's machine and verifies in a TUI smoke that `shift+tab` changes the shape segment.
- Reasoning-effort cycling stays reachable at `alt+t` and through `/thinking`.

### R3 — Ctrl+W workflow progress sidebar
- `ctrl+w` opens (and closes) a right-anchored overlay sidebar, the "workflow progress monitor": the full phased workflow rendered like a todo list — one line per phase, each phase line coloured by the role that owns it, a role box (`[architect]`, `[builder]`, `[worker]`, `[verifier]`, `[auditor]`, `[watchdog]`, `[fusion]`, `[judge]`, `[fuser]`) and a short description (the phase `detail:` or the first node prompt line).
- Per phase/node state colours (from `modules/monitor/state.ts` where they exist; new ones added there): `working` (dispatched-working blue), `in-review` (amber), `redo 1`, `redo 2`, … (edit-round-n orange with the round number), `review-passed` (done-verified green), `failed` (red), `queued` (grey).
- Done or dormant phases dim after 10 minutes of inactivity (last event ts), and the sidebar closes itself 10 minutes after the run reached a terminal state unless the user interacts.
- The sidebar keeps editor focus (`handle.unfocus()`); `ctrl+w` again or `/workflow-monitor close` closes it; content re-reads the store on the R1 tick.
- Alt twin for terminals that swallow ctrl+w: `alt+w`. Note: many terminals bind ctrl+w to "delete word"; titan must register it through `registerShortcut` and verify it arrives; if Pi's editor consumes it, fall back to `ctrl+shift+w` and document it.

### R4 — Settings panel hotkey with MCP toggles and quick configs
- `ctrl+,` (alt twin `alt+,`) opens a settings panel overlay (custom UI) that shows the live harness config in one place: level/shape, builder/worker/watchdog/verifier/exa pools, concurrency cap, budget, watchdog (on/off, model, thinking, compaction mode), monitor mode, auditor on/off, anonymize, model bar on/off — each editable in place (select/toggle/number), written through `writeStackSettings` and mirrored where `/stack` mirrors today.
- The panel lists every MCP server from the merged catalog (package `mcp/mcp.json` → user `~/.config/mcp/mcp.json` → project `.mcp.json`) with its state (enabled / disabled / missing env NAME) and lets the user toggle enabled/disabled per server; the toggle writes the user-level config (never the package file), never prints a credential value, and asks for `/reload` (pi-mcp-adapter reads the catalog at start).
- "Quick configs": save the current panel state as a named preset under `~/.pi/titan-harness/configs/<name>.json`, list and apply presets from the panel and via `/titan-config save|apply|list <name>`; a preset can also be written as a shape file.
- Opening the panel never spends model tokens.

### R5 — mcp2cli in the harness
- `titan-harness` ships `scripts/mcp2cli.mjs`: a CLI over `modules/mcp-client.ts` (titan's own stdio JSON-RPC client) — `mcp2cli list`, `mcp2cli tools <server>`, `mcp2cli call <server> <tool> [--json '{…}' | key=value …]`, `mcp2cli doctor` (probe matrix: enabled, disabled, missing env names). It reads the same merged catalog as the runtime bridge, prints results as JSON or text, never prints credential values, exits non-zero on tool `isError`.
- The Python `uvx mcp2cli` (knowsuchagency) remains documented as the general-purpose alternative; the Rust `mcp2cli` stays a Grok-plugin concern. `/titan-doctor` reports which of the three are available.
- Workflow `bash:` nodes can call `node <pkg>/scripts/mcp2cli.mjs …` so MCP tools become shell-scriptable inside workflows.

### R6 — Status report, docs, and the next workflow (process)
- A dated status report (`docs/status-report-YYYY-MM-DD.md`): what shipped per version, test counts, TUI smokes, vacant lanes, open bugs, this PRD.
- README/INSTALL/skills docs on GitHub updated for the PRD (roadmap section) and for anything the status report finds stale.
- `/create-workflow` (titan's own authoring pipeline) run on this PRD to produce the v0.9 workflow (`.titan/workflows/v09-live-tui/`), validated with `/workflow validate`, so the next phase starts from an authored, phased YAML with the PRD as its spec.

## Non-goals
- No Pi core changes; everything lives in the extension and its scripts.
- No replacement of pi-mcp-adapter for model-facing tools; the panel toggles its catalog, the CLI uses titan's own bridge.

## Acceptance (measurable)
1. TUI smoke: after `/workflow run smoke-two` settles, the MONITOR row reads `completed` within 1 s with no further input.
2. TUI smoke: `shift+tab` changes the first status-line segment from `⬡ L1 brain-ultrafast` to `⬡ L2 triggered-ops`.
3. TUI smoke: `ctrl+w` shows the sidebar with one coloured line per phase of `proto-analytics-dashboard` (or the running workflow), role boxes and descriptions; `ctrl+w` closes it.
4. TUI smoke: `ctrl+,` opens the settings panel; toggling `momentic` writes `~/.config/mcp/mcp.json` (`disabled: false`) and the panel shows the new state; a quick config saved and applied round-trips.
5. `node scripts/mcp2cli.mjs doctor` lists every catalog server; `call` against the fake MCP fixture returns the echo.
6. Unit tests for the new state colours, the sidebar frame, the settings panel model, the config presets and the CLI.

## Open questions for Dan
- Sidebar hotkey: `ctrl+w` is "delete previous word" in many editors; if Pi's editor keeps it, is `ctrl+shift+w` / `alt+w` acceptable?
- Which MCP catalog should the toggles write: the user file (`~/.config/mcp/mcp.json`, applies to every project) or the project `.mcp.json`? Default here: user file, with a project switch in the panel.
- "Timeout after 10 mins": dim the phase lines (keep the sidebar) or close the sidebar? Default here: dim at 10 min idle, auto-close 10 min after a terminal state.
