# Workflow terminal observer

The native `/workflow-sidebar` and standalone terminal observer consume the same read-only workflow projection as the GUI. Neither dispatches models nor changes routing. Execution completion remains separate from acceptance, which legacy records cannot establish authoritatively.

- `/workflow-sidebar` opens the right-side overlay while the editor keeps input.
- `/workflow-sidebar focus [runId]` gives the overlay keyboard focus. J/K select a phase, Enter/Space toggle it, `[`/`]` scroll, H shows help. Escape/Q closes the observer.
- `/workflow-sidebar expand`, `collapse`, and `close` retain their existing meaning.

For an independent right-side pane, run the following in that pane (replace paths with the repository and recorded run directory):

```sh
bun /path/to/titan-harness/scripts/titan-workflow-tui.ts --run /path/to/recorded-run
```

With tmux, a manually requested split can use:

```sh
tmux split-window -h 'bun /path/to/titan-harness/scripts/titan-workflow-tui.ts --run /path/to/recorded-run'
```

The standalone observer supports mouse phase expansion, terminal resize, and terminal restoration on Q, Ctrl-C or termination. Closing it does not cancel the run. `--once` prints a single plain ASCII snapshot; redirected output also uses a single snapshot. This is a one-second file observer, not an event-stream resume implementation.

State marks stay fixed: `[>]` active, `[x]` executed, `[!]` failed, `[-]` stopped/cancelled, `[ ]` pending. Configured model names are explicitly labelled configured, not presented as effective dispatch observations. Unknown measured throughput is `--`, and measurement coverage appears in the footer. Warnings remain visible in the scrollable body. Expand an agent's phase to see its state, role, configured model, observed token count, duration and error; narrow panes omit secondary model/usage fields.

The existing native surface remains a right-anchored overlay; it does not reserve chat width. A terminal split is a separate observer process. Stop and transcript actions are not fabricated by the TUI.
