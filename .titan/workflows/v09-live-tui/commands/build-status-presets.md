Read $ARTIFACTS_DIR/spec-map.md and the failing tests in `extensions/titan-harness/tests/live-tui.test.ts` and `extensions/titan-harness/tests/keybindings-rebind.test.ts`.

Implement R1 (Live status line & bar repaint) and R2 (Shift+Tab preset cycling):
1. In `extensions/titan-harness/titan-harness.ts` and `modules/tui.ts`:
   - Implement the steady timer tick (≤ 1 s when a run, child, workflow or watchdog is active; ≤ 5 s when idle).
   - Hook run settling events (`run.end`, `workflow.end`, node end, child settle, watchdog transition, compaction) to fire an immediate repaint.
   - Read fresh data on every repaint (ledger rows, run.json, agents, watchdog status). Ensure settled runs never display as `running`.
   - Update the status line renderer so the first segment is always the harness shape preset (`⬡ L3 engineering` or `⬡ consult`), followed by the plan command if declared, then MCP and exa counters. Ensure this leading segment is never truncated.
2. In `extensions/titan-harness/titan-harness.ts`, `modules/levels.ts`, and `scripts/keybindings-rebind.mjs`:
   - Bind `shift+tab` to cycle level shapes 0→3→0 (`/titan-level next`), triggering the announcement, bar refresh, and live status-line segment update.
   - Ensure `scripts/keybindings-rebind.mjs` safely moves `app.thinking.cycle` to `alt+t` and unbinds `shift+tab` in `~/.pi/agent/keybindings.json`.
   - Update `/titan-doctor` and `/titan-level status` to report whether `shift+tab` is held by Pi or claimed by titan.
   - Wire `/titan-level --claim-shift-tab` to run the rebind flow with a user confirmation dialog and prompt for `/reload`.

Run `bun test extensions/titan-harness/tests/live-tui.test.ts extensions/titan-harness/tests/keybindings-rebind.test.ts` and ensure they pass green.
