---
name: mcp-cli-bridges
description: Call any MCP server from bash with titan's own mcp2cli (`node scripts/mcp2cli.mjs`, the catalog's stdio servers), the Python mcp2cli (knowsuchagency) or mcporter (TypeScript) instead of loading tool schemas into context; list tools, pass args, handle auth headers, prefer named links. Use in fan-out children, workflow bash nodes, scripts, or when the adapter's proxy tool is unavailable. Not the Rust mcp2cli the Grok plugin uses.
---

# mcp-cli-bridges
## Three binaries are called `mcp2cli`; this skill covers titan's and the Python one
- **titan-harness (this package, shipped):** `node scripts/mcp2cli.mjs` — a CLI over titan's own stdio JSON-RPC client (`extensions/titan-harness/modules/mcp-client.ts`, the bridge workflow `mcp_tool` nodes use). It reads the merged catalog (package `mcp/mcp.json` → user `~/.config/mcp/mcp.json` → project `.mcp.json`), so every catalogued stdio server is already a named link. See the section below.
- **Pi / titan-harness (this package):** the Python `mcp2cli` (knowsuchagency/mcp2cli, `uvx mcp2cli` or `uv tool install mcp2cli`) plus `mcporter` (TypeScript, openclaw/mcporter).
- **Grok / triarc-creative-stack:** the Rust `mcp2cli` (mcp2cli.dev, `curl -fsSL https://mcp2cli.dev/install.sh | sh`, `mcp2cli config init --name …`, `mcp2cli link create --name …`) plus `mcp-to-cli` (Smithery, the `mcp` binary).
- Two different binaries with the same name: different flags (`--mcp` / `--mcp-stdio` here, `--url` / `--stdio` there), different config, no shared state. Never treat them as one tool; run `mcp2cli --help` to see which one is on PATH before scripting against it.
- The Python and Rust binaries are not installed by this package: documented, not installed, not on PATH (`docs/named-links.md`); titan's `scripts/mcp2cli.mjs` ships with the package.

## titan mcp2cli (shipped, `node scripts/mcp2cli.mjs`)
```
node scripts/mcp2cli.mjs list [--json] [--cwd <dir> | --catalog <file>]      # every catalogued server: enabled/disabled + env NAMES
node scripts/mcp2cli.mjs tools <server> [--json] [--timeout <ms>]              # tools/list with descriptions
node scripts/mcp2cli.mjs call <server> <tool> [--json '{…}' | key=value …] [--timeout <ms>] [--text] [--verbose]
node scripts/mcp2cli.mjs doctor [--cwd <dir> | --catalog <file>]              # probe matrix JSON + which of the three mcp2cli flavours exist
```
- Exit codes: 0 ok · 1 the tool returned `isError` (or an RPC error such as an unknown tool) · 2 usage / bad `--json` · 3 server missing, disabled, `url`-only, or failed to start · 4 timeout. Pipe-friendly: results are JSON (`structuredContent`, else the parsed text block); `--text` prints text as-is.
- `key=value` arguments are JSON-parsed when they parse (`n=3`, `flag=true`, `list='[1,2]'`), strings otherwise; `--json '{…}'` supplies the rest. `--verbose` echoes the call to stderr with `key|token|secret|password` values redacted; catalog env values are never printed anywhere (only the variable NAMES an entry references).
- Only stdio servers run here; `url` servers stay with pi-mcp-adapter in the host. A disabled entry (catalog `disabled: true` or a missing `${VAR}`) exits 3 naming the variable.
- Workflow use: a `bash:` node can call `node "$TITAN_PKG/scripts/mcp2cli.mjs" call infranodus generate_ontology_graph --json "$ARGS"`; the runtime bridge and the CLI share the catalog and the client, so what works in one works in the other. The doctor line to expect from `/titan-doctor`: `mcp2cli · titan ✓ · python (uvx) ✓|○ · rust ○`.
- Node ≥ 22.7 with `--experimental-transform-types` (the script re-executes itself with the flag) or bun.

## Named links first
Prefer a named link per server (`higgsfield`, `figma`, `relume`, `brandfetch`, `macro`, `testmu`) so bash looks like a CLI (`higgsfield <tool> --arg value`) instead of a URL soup: with mcporter the server name from `mcp.json` is the link; with the Python mcp2cli a one-line wrapper script or shell alias pins `--mcp <url>` (and the auth header) under that name. Keep native MCP in the interactive host (pi-mcp-adapter's proxy tool); the bridges are for children, scripts and hosts without an MCP client.

## mcp2cli (Python, knowsuchagency/mcp2cli)
```
uv tool install mcp2cli                     # or: uvx mcp2cli --help
mcp2cli --mcp https://mcp.brandfetch.io/mcp --list
mcp2cli --mcp https://mcp.brandfetch.io/mcp --auth-header "Authorization:env:BRANDFETCH_MCP_TOKEN" <tool> --<arg> value
mcp2cli --mcp-stdio "npx -y shadcn@latest mcp" --list
mcp2cli --mcp-stdio "npx -y momentic mcp --config $MOMENTIC_CONFIG" --env MOMENTIC_API_KEY=env:MOMENTIC_API_KEY <tool> ...
```
Use `env:` / `file:` prefixes for secrets so they never appear in process listings.

## mcporter (TypeScript, openclaw/mcporter)
```
npx mcporter list https://relume-library-mcp.relume.io/mcp --brief
npx mcporter call https://relume-library-mcp.relume.io/mcp.<tool> --<arg> value
npx mcporter list ~/.config/mcp/mcp.json     # configured servers double as named links
```
Reads the same `mcp.json` shape for configured servers; good for scripts inside Node projects.

## Rules
- OAuth-only servers (Figma, Higgsfield, Macro, TestMu, Relume) need a token the host obtained; complete OAuth in Pi (`/mcp`) or the vendor CLI first, then pass the bearer via `--auth-header`.
- Prefer the bridge in harness children and workflow agents; keep the interactive host on pi-mcp-adapter's proxy tool.
- First-party CLIs stay as-is and outside the bridges: Kane CLI, `npx @framer/agent` and `@higgsfield/cli` are never wrapped as MCP servers or put behind mcp2cli.
