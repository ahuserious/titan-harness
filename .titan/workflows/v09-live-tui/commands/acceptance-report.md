Read $audit.output, $ARTIFACTS_DIR/evidence, and git diff.

Author the comprehensive Acceptance Report for PRD v0.9 live TUI:
1. Executive Summary: Verification verdict, overall readiness, and conformance to Dan's direction.
2. Requirements Verification Table (R1 through R5):
   - Requirement title and status (PASS / FAIL).
   - Core files modified or created with sha256 digests.
   - Verification evidence and test logs confirming behavior.
3. Acceptance Criteria Results (Items 1 through 6):
   - Item 1: MONITOR row reads completed within 1s after workflow settling.
   - Item 2: Shift+Tab updates status line segment from L1 to L2.
   - Item 3: Ctrl+W sidebar shows phased workflow with role boxes and state colors; closes on toggle.
   - Item 4: Ctrl+, settings panel MCP toggle persists to `~/.config/mcp/mcp.json`; quick config round-trips.
   - Item 5: `node scripts/mcp2cli.mjs doctor` lists servers; echo call succeeds.
   - Item 6: Bun unit test suite status and test count.
4. Residual Risks, Open Questions & Operator Next Steps:
   - Machine setup notes (running `scripts/keybindings-rebind.mjs` and `/reload`).
   - Terminal compatibility for `ctrl+w` vs `alt+w`.

Write the final acceptance report with sha256 digests of all evidence artifacts.
