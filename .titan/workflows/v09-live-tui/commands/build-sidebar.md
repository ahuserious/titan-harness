Read $ARTIFACTS_DIR/spec-map.md and `extensions/titan-harness/tests/sidebar.test.ts`.

Implement R3 (Ctrl+W workflow progress sidebar):
1. In `extensions/titan-harness/modules/monitor/state.ts`:
   - Add/verify state colors: `working` (blue), `in-review` (amber), `redo N` (orange with round number), `review-passed` (green), `failed` (red), `queued` (grey).
2. Create `extensions/titan-harness/modules/monitor/sidebar.ts`:
   - Render the right-anchored overlay sidebar displaying the running or selected phased workflow like a todo list.
   - Render one line per phase, colored by the role that owns it, featuring a role box (`[architect]`, `[builder]`, `[worker]`, `[verifier]`, `[auditor]`, `[watchdog]`, `[fusion]`, `[judge]`, `[fuser]`) and phase description / detail.
   - Apply dimming to done or dormant phases after 10 minutes of inactivity based on last event timestamp.
   - Automatically close the sidebar 10 minutes after the run reaches a terminal state unless user interaction occurred.
   - Ensure editor focus is preserved using `handle.unfocus()`.
3. In `extensions/titan-harness/titan-harness.ts`:
   - Register `ctrl+w` shortcut (with `alt+w` twin) to toggle the sidebar open and closed.
   - Add `/workflow-monitor close` command.
   - Ensure sidebar contents re-read the run store on the R1 steady tick.

Run `bun test extensions/titan-harness/tests/sidebar.test.ts` and ensure all tests pass green.
