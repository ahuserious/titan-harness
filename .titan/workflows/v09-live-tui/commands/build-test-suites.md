Read the architectural spec at $ARTIFACTS_DIR/spec-map.md and review Acceptance criteria 1 through 6 in docs/PRD-v0.9-live-tui.md.

Author the complete Bun unit test suite and PTY smoke scripts covering all requirements before implementation begins:
1. `extensions/titan-harness/tests/live-tui.test.ts`: Test R1 steady repaint ticker (≤1s active, ≤5s idle), immediate repaint triggers on settle events (`run.end`, `workflow.end`, child settle), and first segment status-line shape preset formatting (`⬡ L3 engineering` or `⬡ consult`) with no truncation.
2. `extensions/titan-harness/tests/keybindings-rebind.test.ts`: Test R2 `scripts/keybindings-rebind.mjs` idempotency, backup creation (`.bak`), rebind of `app.thinking.cycle` to `alt+t`, unbinding `shift+tab`, and `/titan-level --claim-shift-tab` integration.
3. `extensions/titan-harness/tests/sidebar.test.ts`: Test R3 workflow progress sidebar model, role badges (`[architect]`, `[builder]`, etc.), new state colors in `modules/monitor/state.ts` (`working`, `in-review`, `redo N`, `review-passed`, `failed`, `queued`), 10-minute inactivity dimming, and auto-close timer.
4. `extensions/titan-harness/tests/settings-panel.test.ts`: Test R4 settings panel data model, MCP catalog merging (package → user → project), server toggling writing user config (`~/.config/mcp/mcp.json`), credential redaction, and quick config preset save/apply round-trip (`~/.pi/titan-harness/configs/<name>.json`).
5. `extensions/titan-harness/tests/mcp2cli.test.ts`: Test R5 CLI subcommands: `list`, `tools <server>`, `call <server> <tool> [--json | key=value]`, `doctor`, JSON vs text formatting, and exit code non-zero on `isError`.
6. `scripts/pty-smoke-acceptance.sh`: Executable PTY smoke script testing Acceptance items 1 to 5 against Pi TUI.

Run `bun test` to confirm the test suites run and fail as expected (TDD red). Output your test authoring summary and artifact paths.
