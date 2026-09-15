---
name: mcp-cli-bridges
description: Call any MCP server from bash with the Python mcp2cli (knowsuchagency) or mcporter (TypeScript) instead of loading tool schemas into context; list tools, pass args, handle auth headers, prefer named links. Use in fan-out children, scripts, or when the adapter's proxy tool is unavailable. Not the Rust mcp2cli the Grok plugin uses.
---

# mcp-cli-bridges
## Two binaries are called `mcp2cli`; this skill is the Python one
- **Pi / titan-harness (this package):** the Python `mcp2cli` (knowsuchagency/mcp2cli, `uvx mcp2cli` or `uv tool install mcp2cli`) plus `mcporter` (TypeScript, openclaw/mcporter).
- **Grok / triarc-creative-stack:** the Rust `mcp2cli` (mcp2cli.dev, `curl -fsSL https://mcp2cli.dev/install.sh | sh`, `mcp2cli config init --name …`, `mcp2cli link create --name …`) plus `mcp-to-cli` (Smithery, the `mcp` binary).
- Two different binaries with the same name: different flags (`--mcp` / `--mcp-stdio` here, `--url` / `--stdio` there), different config, no shared state. Never treat them as one tool; run `mcp2cli --help` to see which one is on PATH before scripting against it.
- Neither is installed by this package: documented, not installed, not on PATH (`docs/named-links.md`).

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
