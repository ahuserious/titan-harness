# Workflow observer: terminal and chat layout

Titan's native `/workflow-sidebar` and the standalone terminal and browser views use the same versioned, read-only projection of a run directory. The browser arranges recorded task outputs as a conversation with the workflow pane on the right. Its popout is another observer of the same run. It does not start a new conversation or send model requests.

Requires Bun for the standalone commands (the existing deterministic test runner). From the runtime checkout:

```sh
bun run workflow:view --run /absolute/path/to/run-directory
bun run workflow:tui --run /absolute/path/to/run-directory
```

The browser command prints a loopback URL with an observer token in the fragment. Open that URL in your browser. Default port is selected automatically; `--port 4319` selects a port. The API rejects requests without its token and binds only to 127.0.0.1. Keep that URL private like the run itself. Ctrl+C closes the observer server; it does not cancel a workflow. The terminal command can run in a right-side tmux/Orca pane; `--once` prints plain text.

In Pi, `/workflow-sidebar focus` enables keyboard interaction; ordinary `/workflow-sidebar` keeps the chat editor focused. Existing Ctrl+W / Alt+W bindings remain available. Use independent phase expansion and the group/navigation hints shown in the pane.

The browser offers Running/Finished navigation, native accessible buttons for phase expansion, a scoped recorded-output dialog, a separate popout, and a narrow-window layout. The visual vocabulary uses simple tabs, badges, disclosure rows and separators. No external UI dependency or remote font is required. This is a standalone read-only chat layout; it is not yet an embedded K-Dense chat composer or `workflow_ui` event producer.

## Evidence semantics

- `execution_completed` means the recorded execution settled. Legacy `done-verified` does not supply the new independent source-bound acceptance contract. Exact-one-review stays unavailable. No observer issues CompletionRecord.
- Legacy model names are marked **configured**, not effective provider identities. Actual route provenance remains an adapter obligation.
- `avg tok/s` uses only explicitly paired measured generation samples. Legacy response durations are estimated and shown separately; missing measurements remain unknown. Coverage reports measured/total samples. Legacy arithmetic totals elsewhere are unchanged.
- A successful agent return cannot hide a later node failure. A terminal workflow with unresolved tasks is shown as incomplete. Late progress does not reopen a terminal task.
- Snapshot cursors hash captured source bytes. Same cursor is deduplicated; changed or stale cursor receives a replacement snapshot. This is polling snapshot recovery, not a durable event-delta replay service. Re-reading catches changes during observation; the legacy store has no atomic multi-file producer checkpoint.
- Corrupt chains or mismatched identities produce unavailable evidence. Recorded outputs require matching task metadata and content digest. The observer exposes no arbitrary filesystem endpoint.
- Closing a browser, popout or terminal only closes that observer. Cancellation controls are absent until an owned-resource cancellation adapter supplies real receipts. Recorded output is deliberately distinguished from a full session transcript.
- Human telemetry is not emitted as a model tool result. The demonstrated structured watchdog state-block leak is repaired; this does not claim universal redaction of free text, existing transcripts, screenshots or same-user shell access.

Unresolved mode routing, worker counts, compaction targets, live provider authentication, shared budgets, durable recovery, source-bound review authority, and cancellation are not changed by this UI slice.

## Background task presentation

The dark browser pane and terminal observer follow a workflow-card hierarchy: Running and Finished groups contain whole workflows, and each workflow retains all phases and their task rows. A compact card in the chat area opens the right pane. Expand, collapse, resize, close, and popout controls affect the observer only. This single-run observer does not invent other session history or offer unsupported stop, trash, or pin actions.

Phase headers show executed/total task counts and fixed status cells. Grey means executed, blue running, red failed, amber stopped; hollow cells mean pending or unknown. These marks never grant independent acceptance. The terminal uses explicit ASCII symbols and a separate unknown marker. Agent/task, model, token, and elapsed-time columns expand beneath each phase.

Workflow descriptions and declared node metadata are captured in `workflow.start`, so viewing a past run does not load a changed workflow file. Agent counts require unique dispatch events; bookkeeping records are not agent invocations and uncertain legacy counts remain unknown. The producer's `reportedStatus` determines which lifecycle group contains a workflow; an ended workflow with unresolved evidence remains visibly `incomplete`. Recorded output dialogs restore keyboard focus across snapshot updates.
