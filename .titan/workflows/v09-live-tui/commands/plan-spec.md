Read $inputs.prd (docs/PRD-v0.9-live-tui.md) and examine the repository architecture.

Map each requirement (R1 through R5) and Acceptance criteria (1 through 6) to:
1. Target files in the repository:
   - R1 (Live status line & bar repaint): `extensions/titan-harness/titan-harness.ts`, `extensions/titan-harness/modules/tui.ts`, `extensions/titan-harness/modules/monitor/`.
   - R2 (Shift+Tab preset cycling 0→3→0 & keybindings rebind): `scripts/keybindings-rebind.mjs`, `extensions/titan-harness/titan-harness.ts`, `extensions/titan-harness/modules/levels.ts`, `extensions/titan-harness/modules/doctor.ts`.
   - R3 (Ctrl+W workflow progress sidebar overlay): `extensions/titan-harness/modules/monitor/sidebar.ts`, `extensions/titan-harness/modules/monitor/state.ts`, `extensions/titan-harness/titan-harness.ts`.
   - R4 (Settings panel hotkey, MCP toggles, quick configs): `extensions/titan-harness/modules/settings-panel.ts`, `extensions/stack-settings.ts`, `extensions/titan-harness/titan-harness.ts`.
   - R5 (scripts/mcp2cli.mjs): `scripts/mcp2cli.mjs`, `extensions/titan-harness/modules/mcp-client.ts`, `extensions/titan-harness/modules/doctor.ts`.
2. Bun unit test matrix:
   - `extensions/titan-harness/tests/live-tui.test.ts`
   - `extensions/titan-harness/tests/keybindings-rebind.test.ts`
   - `extensions/titan-harness/tests/sidebar.test.ts`
   - `extensions/titan-harness/tests/settings-panel.test.ts`
   - `extensions/titan-harness/tests/mcp2cli.test.ts`
3. TUI PTY smoke scenarios:
   - `scripts/pty-smoke-acceptance.sh` covering Acceptance items 1, 2, 3, 4, and 5.

Write your full detailed architectural specification and breakdown to `$ARTIFACTS_DIR/spec-map.md`.

Call submit_result exactly once with the final answer; after it, stop.
