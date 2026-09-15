# Authoring record — v09-live-tui

- goal: Implement docs/PRD-v0.9-live-tui.md end to end: R1 live status line and bar repaint, R2 shift+tab preset cycling with the keybindings rebind, R3 ctrl+w workflow progress sidebar, R4 settings panel with MCP toggles and quick configs, R5 scripts/mcp2cli.mjs; phases plan → build → verify → audit → report; tier prototype-analytics; builders must add bun tests and TUI pty smokes per acceptance item
- source: goal
- seat: rune · antigravity/gemini-3.8-flash
- thinking: requested xhigh · effective high
- level: shape-driven · shape consult
- context manifest: sha256 a898dcacb6b6abb643e5d04f8819cef31775b41feb0cb4bf36beabe3860cb017 (5 entries, 25413/25413 chars, budget 120000)
- validator rounds: 0 (architect calls 1)
- run: run-20260915T223221Z-cbfa95 (/home/danbot/.pi/titan-harness/runs/ot-Dev-Tools-pi-extensions-titan-harness-a124659662ff/run-20260915T223221Z-cbfa95)
- generated: 2026-09-15T22:35:30.782Z

## Phases

- plan
- build
- verify
- audit
- report

## Notes

Phased architecture rationale:
- Phase 'plan': Architect analyzes PRD v0.9 and repository structure, producing an actionable specification map, Bun test matrix, and PTY smoke scenarios under $ARTIFACTS_DIR/spec-map.md with structured output.
- Phase 'build': Sequential builders prevent file edit collisions. It follows strict TDD by first authoring unit test suites and PTY smokes for Acceptance items 1-6, followed by focused builders for R1+R2 (status line & keybindings), R3 (sidebar), R4 (settings panel), R5 (mcp2cli CLI), and culminates in a bounded 3-iteration CI loop (build-verify-loop) with 'bun test' gate.
- Phase 'verify': Conforms to prototype-analytics tier verifiers (bash, cursor-cloud, kane) generating and requiring hard evidence kinds (test-result, log, screenshot, script, result-card, design-match).
- Phase 'audit': Independent cross-family auditor evaluates evidence packages, unit test logs, and git diff against PRD requirements with trigger_rule: all_done and output_format referencing titan://schemas/audit-verdict.
- Phase 'report': Architect synthesizes the passing audit and evidence digests into a final acceptance report, gated by when: $audit.output.status == 'PASS' || $audit.output.status == 'PASS_WITH_WARNINGS'.
