# MCP catalog

`mcp.json` is a standard `mcpServers` file. It works unchanged in Pi (via
`pi-mcp-adapter`), Claude Code (`.mcp.json`), Cursor, and Codex. No secrets live here:
every credential is an `${ENV_VAR}` placeholder or a browser OAuth on first use.

Two ways in:

1. **Automatic in Pi (package manifest).** `package.json` declares
   `"pi": { "mcp": "./mcp/mcp.json" }`. pi-mcp-adapter 2.33.0 loads `pi.mcp` catalogs
   from every package listed in Pi's `settings.json` `packages` (it never scans
   `node_modules`) and registers the servers as `titan-harness__<server>`; tool
   namespaces turn the hyphen into an underscore (`titan_harness__higgsfield`,
   `titan_harness__infranodus`, …). Only server entries are read; catalog-level `settings`/`imports` would be ignored. A user, global or project
   MCP config (`~/.config/mcp/mcp.json`, `.mcp.json`, `.pi/mcp.json`) has higher
   precedence, so a same-named entry there overrides the package copy, and `/mcp disable`
   / `/mcp enable` still work per server. `/mcp` in Pi lists the `titan-harness__*` servers
   after `/reload` or a restart.
2. **Manual merge for other hosts** (or for un-namespaced names in Pi):
   `node scripts/install-mcp.mjs` (see `INSTALL.md`). It never overwrites an existing
   server unless `--force`, and prints which servers need OAuth or an env var.

| Server | Transport | Auth | What it gives an agent | Verified source |
|---|---|---|---|---|
| `figma` | remote `https://mcp.figma.com/mcp` | OAuth (all plans). On this machine pi-mcp-adapter's Dynamic Client Registration was rejected (HTTP 403), so a generic client may need a pre-registered Figma OAuth app: add `"oauth": {"clientId": "…"}` to the entry | Dev Mode design context, create/modify frames, components, variables, FigJam | help.figma.com "Guide to the Figma MCP server" |
| `figma-desktop` | local `http://127.0.0.1:3845/mcp` (Figma desktop app → Preferences → enable the Dev Mode MCP server) | none (desktop login); Dev or Full seat on paid plans; shipped `disabled` | same design context without remote OAuth | help.figma.com Dev Mode MCP server |
| `shadcn` | `npx -y shadcn@latest mcp` | none for the public registry; `REGISTRY_TOKEN` for private registries in `components.json` | browse/search/install shadcn/ui components and blocks | ui.shadcn.com/docs/mcp |
| `relume` | remote `https://relume-library-mcp.relume.io/mcp` | Relume account OAuth | 1,000+ real React components fetched by slug, vendored into the project with Tailwind preset + primitives | relume.ai/relume-library-mcp |
| `brandfetch` | remote `https://mcp.brandfetch.io/mcp` | OAuth or `bf1…` MCP token (`BRANDFETCH_MCP_TOKEN` for the bash bridges) | brand search, brand data by domain/ticker/ISIN, merchant identification, LLM-ready brand context, Logo CDN URLs | github.com/Brandfetch/brandfetch-mcp-server |
| `higgsfield` | remote `https://mcp.higgsfield.ai/mcp` | OAuth (plan credits) | 30+ image and video generation models (Sora, Veo, Kling, …). Studio rules in `skills/higgsfield-media`: first-party only, no OpenRouter; 5–8 s looping Framer heroes, not films; credit cost before any video batch | higgsfield.ai/mcp |
| `macro` | remote `https://mcp-server.macro.com/mcp` | OAuth | search/read/create Macro docs, email drafts, tasks, channels, calls | macro.com/agents |
| `testmu` | remote `https://mcp.lambdatest.com/mcp` | OAuth (testmuai.com) | HyperExecute, Automation triage, SmartUI visual diff, Accessibility audits, Test Manager | testmuai.com/support/docs/testmu-mcp-server |
| `momentic` | `npx -y momentic mcp --config ${MOMENTIC_CONFIG}` | `MOMENTIC_API_KEY`; shipped `disabled` | AI end-to-end browser and mobile tests from YAML | momentic.ai/docs/integrations/mcp-server |
| `framer-mcp-plugin` | remote `${FRAMER_MCP_URL}` | user-specific URL from the Framer marketplace "MCP" plugin (plugin must stay open); shipped `disabled` | project structure, node selection, design tokens | framer.com/marketplace/plugins/mcp |
| `infranodus` | `npx -y infranodus-mcp-server` | `INFRANODUS_API_KEY`; shipped `disabled` until the key exists | knowledge graphs and text-network analysis: ontology graphs, topical clusters, content gaps, research questions, contextual hints, cross-run memory relations; the reasoning-ontology stage of the workflow plan | npm `infranodus-mcp-server` (InfraNodus's own MCP server) |

`momentic`, `framer-mcp-plugin`, `figma-desktop` and `infranodus` ship `"disabled": true`
because each needs a machine-specific value or key. Set the variable (names in
`.env.example`: `INFRANODUS_API_KEY`, `MOMENTIC_API_KEY`, `CURSOR_API_KEY`,
`BRANDFETCH_MCP_TOKEN`), flip `disabled` to `false` (in Pi: `/mcp enable <server>`, which
writes only the flag into the project's `.pi/mcp.json`), `/reload`, done. Every endpoint
above is the vendor's published one; none is invented and none may be edited to a guess.

## Framer, the official way

Framer's own agent integration is a CLI plus skills, not an MCP server:

```
npx @framer/agent setup     # browser grant to the project
/framer                     # inside the agent
```

It edits canvas and components, reads and writes CMS collections, and publishes,
with auto-branching. Use it first; the marketplace MCP plugin is the fallback.
`@framer/agent` is documented, not installed, not on PATH (`docs/named-links.md`).

## TestMu's terminal twin: Kane CLI

```
npm install -g @testmuai/kane-cli
kane-cli doctor --install
npx @testmuai/kane-cli-skill   # installs the kane-cli skill for coding agents
kane-cli login --username <user> --access-key <key>   # or: kane-cli login --oauth
```

Natural-language browser flows run in a real Chrome and return pass/fail with
shareable proof. The `kane-cli-browser-runs` skill in this package wraps the workflow,
not the binary: Kane CLI is documented, not installed, not on PATH, and it is never
exposed as an MCP server.

## Higgsfield's CLI, as-is

`npm i -g @higgsfield/cli` then `higgsfield auth login` (or `npx @higgsfield/cli`).
Documented, not installed, not wrapped; the hosted MCP above is the primary path.

## Token hygiene and named links

pi-mcp-adapter exposes one proxy tool instead of every server's schema. For
bash-first agents the bridges turn any of these servers into a CLI, ideally through a
**named link** per server (`higgsfield`, `figma`, `relume`, `brandfetch`, `macro`,
`testmu`) so bash looks like a CLI; native MCP stays in the interactive host. Two
different binaries are called `mcp2cli`, never treat them as one tool:

- Pi / titan-harness: the **Python** mcp2cli (knowsuchagency/mcp2cli, `uvx mcp2cli` or `uv tool install mcp2cli`) plus **mcporter** (TypeScript). See `INSTALL.md` §4 and the `mcp-cli-bridges` skill.
- Grok / triarc-creative-stack: the **Rust** mcp2cli (mcp2cli.dev, `curl -fsSL https://mcp2cli.dev/install.sh | sh`, `mcp2cli config init --name …`, `mcp2cli link create --name …`) plus **mcp-to-cli** (Smithery).

All of them are documented, not installed, not on PATH: `docs/named-links.md`.

## Non-goals

This catalog stays a catalog. Not in scope, now or later:

- no mega-CLI that fronts every server;
- no custom JSON-RPC MCP client (pi-mcp-adapter and the bridges are the clients);
- no Fusion Drive merge;
- no neuro-quant dump;
- no Kane-as-MCP (Kane CLI stays a CLI);
- no Higgsfield marketing-skill dump (its 27–35 marketing skills are not imported);
- no Grok Imagine as a pack server;
- no OpenRouter video servers (Higgsfield is first-party only).
