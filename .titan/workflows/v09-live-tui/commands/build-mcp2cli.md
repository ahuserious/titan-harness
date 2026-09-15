Read $ARTIFACTS_DIR/spec-map.md and `extensions/titan-harness/tests/mcp2cli.test.ts`.

Implement R5 (`scripts/mcp2cli.mjs` in the harness):
1. Create `scripts/mcp2cli.mjs`:
   - Wrap `modules/mcp-client.ts` (titan's stdio JSON-RPC client) as an executable Node/Bun CLI.
   - Subcommands:
     * `mcp2cli list`: List all catalog servers with enabled/disabled/missing env status.
     * `mcp2cli tools <server>`: List exposed tools and parameter schemas for a server.
     * `mcp2cli call <server> <tool> [--json '{...}' | key=value ...]`: Call an MCP tool with parameters; exit non-zero if tool response has `isError: true`.
     * `mcp2cli doctor`: Probe matrix for all servers in the merged catalog.
   - Support both JSON (`--json`) and human-readable text output formats.
   - Never print raw credential values in output or logs.
   - Enable workflow `bash:` nodes to call `node scripts/mcp2cli.mjs`.
2. In `extensions/titan-harness/modules/doctor.ts`:
   - Update `/titan-doctor` to report availability of `scripts/mcp2cli.mjs`, Python `uvx mcp2cli`, and Rust `mcp2cli`.

Run `bun test extensions/titan-harness/tests/mcp2cli.test.ts` and test `node scripts/mcp2cli.mjs doctor` directly.
