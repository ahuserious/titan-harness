# MCP catalog

`mcp.json` is a standard `mcpServers` file. It works unchanged in Pi (via
`pi-mcp-adapter`), Claude Code (`.mcp.json`), Cursor, and Codex. Merge it with
`node scripts/install-mcp.mjs` (see `INSTALL.md`). No secrets live here: every
credential is an `${ENV_VAR}` placeholder or a browser OAuth on first use.

| Server | Transport | Auth | What it gives an agent | Verified source |
|---|---|---|---|---|
| `figma` | remote `https://mcp.figma.com/mcp` | OAuth (all plans). On this machine pi-mcp-adapter's Dynamic Client Registration was rejected (HTTP 403), so a generic client may need a pre-registered Figma OAuth app: add `"oauth": {"clientId": "…"}` to the entry | Dev Mode design context, create/modify frames, components, variables, FigJam | help.figma.com "Guide to the Figma MCP server" |
| `figma-desktop` | local `http://127.0.0.1:3845/mcp` (Figma desktop app → Preferences → enable the Dev Mode MCP server) | none (desktop login); Dev or Full seat on paid plans; shipped `disabled` | same design context without remote OAuth | help.figma.com Dev Mode MCP server |
| `shadcn` | `npx -y shadcn@latest mcp` | none for the public registry; `REGISTRY_TOKEN` for private registries in `components.json` | browse/search/install shadcn/ui components and blocks | ui.shadcn.com/docs/mcp |
| `relume` | remote `https://relume-library-mcp.relume.io/mcp` | Relume account OAuth | 1,000+ real React components fetched by slug, vendored into the project with Tailwind preset + primitives | relume.ai/relume-library-mcp |
| `brandfetch` | remote `https://mcp.brandfetch.io/mcp` | OAuth or `bf1…` MCP token | brand search, brand data by domain/ticker/ISIN, merchant identification, LLM-ready brand context, Logo CDN URLs | github.com/Brandfetch/brandfetch-mcp-server |
| `higgsfield` | remote `https://mcp.higgsfield.ai/mcp` | OAuth (plan credits) | 30+ image and video generation models (Sora, Veo, Kling, …) | higgsfield.ai/mcp |
| `macro` | remote `https://mcp-server.macro.com/mcp` | OAuth | search/read/create Macro docs, email drafts, tasks, channels, calls | macro.com/agents |
| `testmu` | remote `https://mcp.lambdatest.com/mcp` | OAuth (testmuai.com) | HyperExecute, Automation triage, SmartUI visual diff, Accessibility audits, Test Manager | testmuai.com/support/docs/testmu-mcp-server |
| `momentic` | `npx -y momentic mcp --config ${MOMENTIC_CONFIG}` | `MOMENTIC_API_KEY` | AI end-to-end browser and mobile tests from YAML | momentic.ai/docs/integrations/mcp-server |
| `framer-mcp-plugin` | remote `${FRAMER_MCP_URL}` | user-specific URL from the Framer marketplace "MCP" plugin (plugin must stay open) | project structure, node selection, design tokens | framer.com/marketplace/plugins/mcp |

`momentic` and `framer-mcp-plugin` ship `"disabled": true` because they need a
machine-specific value. Set the variable, flip `disabled` to `false`, done.

## Framer, the official way

Framer's own agent integration is a CLI plus skills, not an MCP server:

```
npx @framer/agent setup     # browser grant to the project
/framer                     # inside the agent
```

It edits canvas and components, reads and writes CMS collections, and publishes,
with auto-branching. Use it first; the marketplace MCP plugin is the fallback.

## TestMu's terminal twin: Kane CLI

```
npm install -g @testmuai/kane-cli
kane-cli doctor --install
npx @testmuai/kane-cli-skill   # installs the kane-cli skill for coding agents
```

Natural-language browser flows run in a real Chrome and return pass/fail with
shareable proof. The `kane-cli-browser-runs` skill in this package wraps it.

## Token hygiene

pi-mcp-adapter exposes one proxy tool instead of every server's schema. For
bash-first agents, `mcp2cli` (Python) or `mcporter` (TypeScript) turn any of these
servers into a CLI; see `INSTALL.md` and the `mcp-cli-bridges` skill.
