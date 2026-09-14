---
name: mcp-cli-bridges
description: Call any MCP server from bash with mcp2cli (Python) or mcporter (TypeScript) instead of loading tool schemas into context; list tools, pass args, handle auth headers. Use in fan-out children, scripts, or when the adapter's proxy tool is unavailable.
---

# mcp-cli-bridges
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
```
Reads the same `mcp.json` shape for configured servers; good for scripts inside Node projects.

## Rules
- OAuth-only servers (Figma, Higgsfield, Macro, TestMu, Relume) need a token the host obtained; complete OAuth in Pi (`/mcp`) or the vendor CLI first, then pass the bearer via `--auth-header`.
- Prefer the bridge in harness children and workflow agents; keep the interactive host on pi-mcp-adapter's proxy tool.
