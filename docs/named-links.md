# Named links and first-party CLIs

titan-harness ships an MCP catalog (`mcp/mcp.json`) and a skill pack. It does **not**
install any tool listed here: `pi install` alone does not place them on PATH, and no
skill, command, script or status line in this package may assert that one is present.
Check before use (`command -v kane-cli`, `command -v higgsfield`, `command -v mcp2cli`,
`command -v mcporter`, `command -v mcp`), report a missing tool as *vacant*, and ask the
human before installing anything globally. The commands below are for the human to run.

| Tool | What it is | Install / login | Status |
|---|---|---|---|
| Kane CLI (`@testmuai/kane-cli`) | TestMu AI's terminal agent for natural-language browser runs; a CLI, not an MCP server (`kane-cli-browser-runs` skill) | `npm i -g @testmuai/kane-cli`; `kane-cli doctor --install`; vendor skill `npx @testmuai/kane-cli-skill`; login with username + access key (`kane-cli login --username <user> --access-key <key>`) or `kane-cli login --oauth` | separately installed; check local availability |
| Framer agent (`@framer/agent`) | Framer's official agent integration (CLI + skills), the Framer path this package prefers (`framer-agent` skill) | `npx @framer/agent setup` (browser grant), then `/framer` inside the agent | separately installed; check local availability (npx fetches it per use) |
| Higgsfield CLI (`@higgsfield/cli`) | Higgsfield's official CLI, used as-is next to the hosted MCP (`higgsfield-media` skill) | `npm i -g @higgsfield/cli` then `higgsfield auth login` (or `npx @higgsfield/cli`) | separately installed; check local availability, not wrapped |
| mcp2cli, Python (knowsuchagency/mcp2cli) | the bash bridge the Pi/titan skills use (`--mcp`, `--mcp-stdio`, `--auth-header`; `mcp-cli-bridges` skill) | `uvx mcp2cli` or `uv tool install mcp2cli` | separately installed; check local availability |
| mcporter (openclaw/mcporter, TypeScript) | the second Pi/titan bridge; reads the same `mcpServers` shape as `mcp.json` | `npx mcporter …` | separately installed; check local availability |
| mcp2cli, Rust (mcp2cli.dev) | the bash bridge the Grok plugin (`triarc-creative-stack`) uses; a different binary with the same name | `curl -fsSL https://mcp2cli.dev/install.sh \| sh`; `mcp2cli config init --name <link> --transport streamable_http --endpoint <url>`; `mcp2cli link create --name <link>` | separately installed; check local availability |
| mcp-to-cli (Smithery; the `mcp` binary) | the Grok plugin's TypeScript bridge | `npm i -g mcp-to-cli`; `mcp connect <url> --name <link>` | separately installed; check local availability |

## Named links

A named link is a per-server alias so bash reads like a CLI instead of a URL soup:
`higgsfield`, `figma`, `relume`, `brandfetch`, `macro`, `fiber`, `testmu` (the catalog's OAuth
servers; the endpoints are the ones in `mcp/mcp.json`, never retyped from memory).

- Rust mcp2cli (Grok): `mcp2cli config init --name higgsfield --transport streamable_http --endpoint https://mcp.higgsfield.ai/mcp` then `mcp2cli link create --name higgsfield`, after which `higgsfield ls --tools` works.
- mcp-to-cli (Grok): `mcp connect https://mcp.higgsfield.ai/mcp --name higgsfield`, then `mcp higgsfield tools list`.
- mcporter (Pi/titan): the server name in `mcp.json` is the link (`npx mcporter list ~/.config/mcp/mcp.json` shows them).
- Python mcp2cli (Pi/titan): a one-line wrapper script or shell alias that pins `--mcp <url>` and the `--auth-header` under the link name.

Use native MCP in the interactive host (pi-mcp-adapter in Pi, `/mcps` in Grok); the links
are for harness children, scripts and hosts without an MCP client. OAuth tokens come from
the host's own login (`/mcp` in Pi), never from files in a repo.

## Two binaries named mcp2cli

- **Pi / titan-harness:** the **Python** mcp2cli (knowsuchagency/mcp2cli via `uvx mcp2cli` or `uv tool install mcp2cli`) plus **mcporter** (TypeScript).
- **Grok / triarc-creative-stack:** the **Rust** mcp2cli (mcp2cli.dev, `curl -fsSL https://mcp2cli.dev/install.sh | sh`, `mcp2cli config init --name …`, `mcp2cli link create --name …`) plus **mcp-to-cli** (Smithery).
- Two different binaries with the same name: different flags, different config files, no shared state. Never treat them as one tool. If a `mcp2cli` is already on PATH, `mcp2cli --help` tells you which one it is before you script against it.

## What stays outside the links

- Kane CLI is never put behind mcp2cli or mcporter and is not an MCP server (Kane-as-MCP is a non-goal).
- `npx @framer/agent` and `@higgsfield/cli` are first-party CLIs used as-is; nothing wraps them.
- DivMagic is a Chrome extension (`skills/divmagic-raw`), not a CLI and not MCP.
- Higgsfield is first-party only — never route Higgsfield/Seedance/Veo/Kling/Sora/Hailuo/Wan through OpenRouter; there are no OpenRouter video servers in the catalog.
