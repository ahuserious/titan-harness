# docs/

| File | What it is |
|---|---|
| `PRD-v0.9-live-tui.md` | The v0.9 PRD (2026-09-15): live status line and bar, Shift+Tab preset cycling, the Ctrl+W workflow sidebar, the settings panel with MCP toggles and quick configs, `scripts/mcp2cli.mjs`. **Implemented in 0.9.0** except its three open questions (sidebar hotkey twins, MCP toggle scope, dormancy vs auto-close), which shipped with the defaults named in README "What changed in 0.9.0". Its `/create-workflow` output is `.titan/workflows/v09-live-tui/`. |
| `status-report-2026-09-15.md` | Status of the v0.3 plan execution as of 2026-09-15 (before the v0.9 phase): versions shipped, tests and TUI smokes, vacant lanes, open bugs, the PRD. |
| `ultraplan-v0.3-integration.md` | The confirmed v0.3 integration plan (verdict, decisions D1–D15, feature table, YAML schema, levels, verification, data, delivery plan P0–P9, risks, requirements trace, gate appendices). The spec every phase was built against. |
| `contracts/p3-contracts.md` … `p9-contracts.md` | The per-phase build contracts (file ownership, exported APIs, test bars) the builders followed for the workflow engine (P3), verification and patterns (P4), watchdog (P5), monitor (P6), authoring and planning (P7), terraform and simulated users (P8), triggers/graph/export/docs (P9). |
| `analyst-reports/` | The analysts' and fusion panel's working notes that fed the plan (Pi internals, pi-subagents watchdog, model facts, Archon excerpt, seat drafts, judge report). Inputs, not documentation. |
| `harness-shape-consult.md` | The fused `/titan-fusion` design review (2026-09-14) that produced the `consult` shape. |
| `named-links.md` | First-party CLIs and MCP bridges that are documented, not installed: Kane CLI, `npx @framer/agent`, `@higgsfield/cli`, the two `mcp2cli` binaries, mcporter. |
