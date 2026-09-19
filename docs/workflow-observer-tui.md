# Workflow terminal observer

The native `/workflow-sidebar` and standalone terminal observer consume the same read-only workflow projection as the GUI. Neither dispatches models nor changes routing. Execution completion remains separate from acceptance, which legacy records cannot establish authoritatively.

- `/workflow-sidebar` opens the right-side overlay while the editor keeps input.
- `/workflow-sidebar focus [runId]` gives the overlay keyboard focus. A/R/F select all, running or finished workflows. The observer shows only the selected run; its phase children remain together, including completed and failed agents. Incomplete runs remain in Running with their incomplete status visible. Active phases start expanded. J/K select a phase, Enter/Space toggle it, `[`/`]` scroll, H opens metric details and evidence notes. Escape/Q closes the observer.
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

State marks stay fixed: `[>]` active, `[#]` executed, `[!]` failed, `[-]` stopped/cancelled, `[.]` pending. Configured model names are explicitly labelled configured, not presented as effective dispatch observations. Unknown measured throughput is `--`, and measurement coverage appears in metric details. A compact evidence-note count stays visible; H opens full notes, failed/cancelled/unreviewed totals, measurement coverage, separately labelled estimated rate, and unknown exact-review statistics. The workflow card shows its description when captured, observed agent count, tokens and elapsed time. Phase headers show executed/total counts and wrapping square progress grids; executed does not mean accepted. Expanded phases use aligned Agent, Model, Tokens and Time columns. Narrow panes stack model and usage details. Failed and stopped totals remain visible even when a phase is collapsed. Missing terminal end times remain unknown. Mouse wheel and page keys scroll the same content.

The existing native surface remains a right-anchored overlay; it does not reserve chat width. A terminal split is a separate observer process. Stop and transcript actions are not fabricated by the TUI.
