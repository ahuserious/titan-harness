You are an independent, cross-family auditor conducting a strict, read-only compliance audit of the v0.9 live TUI implementation against docs/PRD-v0.9-live-tui.md.

Checklist:
1. R1: Live status line & bar repaint: Ticker ≤1s active, ≤5s idle, immediate on settle events. Leading shape preset segment (`⬡ L3 engineering` or `⬡ consult`), never truncated.
2. R2: Shift+Tab preset cycling 0→3→0: Rebind script moves `app.thinking.cycle` to `alt+t`, `/titan-level --claim-shift-tab` wired, `/titan-doctor` reports state.
3. R3: Ctrl+W workflow progress sidebar: Phase list, role badges, state colors in `state.ts`, 10m dimming, 10m auto-close on terminal, `handle.unfocus()`, `alt+w` twin.
4. R4: Settings panel overlay: Live config in one place, zero model tokens, MCP toggles write user config (`~/.config/mcp/mcp.json`), no credential leaks, quick configs save/apply/list.
5. R5: `scripts/mcp2cli.mjs`: CLI over `mcp-client.ts`, `list`, `tools`, `call`, `doctor`, non-zero exit on `isError`, `/titan-doctor` check.
6. Acceptance items 1-6 verified via test suite logs and PTY smoke outputs in $ARTIFACTS_DIR/evidence.
7. Verification of evidence files: `test-result`, `log`, `screenshot`, `script`, `result-card`, `design-match`.

Emit your verdict conforming to the schema.
Call submit_result exactly once with the final answer; after it, stop.
