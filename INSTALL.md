# INSTALL.md — for an LLM agent setting up titan-harness

You are an agent (Claude Code, Codex, Pi, Cursor, or similar) installing this
package for a human. Follow the numbered steps in order. Every command is
non-interactive unless marked **(browser)**. Never paste API keys into files
inside this repository; they go into the shell environment or the host's secret
store.

## 0. Preconditions

- Node.js 22+ on PATH (`node --version`).
- Pi coding agent 0.85+ (`pi --version`). If Pi is missing, install it from
  https://pi.dev and run `pi` once so `~/.pi/agent` exists.
- `git`, and for the Python bridge `uv` (https://docs.astral.sh/uv/).

## 1. Install the Pi package

```bash
pi install git:github.com/ahuserious/titan-harness
pi list                    # must show titan-harness and print its install directory
```

Pi clones git packages but does not run npm for them, so install the one
runtime dependency (`yaml`) inside the cloned directory printed by `pi list`:

```bash
cd "<install directory from pi list>" && npm install --omit=dev
```

This registers the extensions (`/titan-*`, `/ctx`, `/stack`) and the skill pack
(`skills/`). Companion packages the stack expects, install if absent:

```bash
pi install npm:pi-mcp-adapter@2.33.0
pi install npm:@quintinshaw/pi-dynamic-workflows@3.10.1
pi install npm:pi-subagents
pi install npm:pi-exa@0.6.1                # Exa web search, no key needed
pi install npm:pi-antigravity@0.7.2        # Gemini via Google Antigravity OAuth (optional)
```

Keep `pi-dynamic-workflows` pinned at 3.10.1 (3.11.0 fails to load on Pi 0.85).

Verify the load without a TUI (stdin must be closed when run from a tool):

```bash
PI_OFFLINE=1 pi -p "reply with the single word pong" --no-session --thinking off --mode json < /dev/null
```

Expect a JSON stream whose `turn_end` carries `pong` and no line containing
`Extension error`.

## 2. Install the MCP catalog

```bash
cd "$(pi list | grep -A1 titan-harness | tail -1 | tr -d ' ')"   # the installed package dir
node scripts/install-mcp.mjs            # → ~/.config/mcp/mcp.json (user-global)
# or: node scripts/install-mcp.mjs --project   → ./.mcp.json for one repo
```

The merge never overwrites existing servers (use `--force` to replace) and
prints which servers need OAuth and which env vars are unset.

### 2a. OAuth servers **(browser)**

Inside Pi run `/mcp`, pick each of `relume`, `brandfetch`, `higgsfield`,
`macro`, `testmu` and complete the browser sign-in. The human must do this;
tell them the list and wait.

`figma` (remote) may reject dynamic client registration for generic clients.
If `/mcp` reports HTTP 403 on registration: either ask the human for a Figma
OAuth app client id and add `"oauth": {"clientId": "<id>"}` to the `figma`
entry, or enable the desktop server instead (Figma desktop → Preferences →
enable Dev Mode MCP server) and set `"disabled": false` on `figma-desktop`.

### 2b. Env-var servers

```bash
export MOMENTIC_API_KEY=...            # from momentic.ai
export MOMENTIC_CONFIG=/abs/path/momentic.config.yaml
export FRAMER_MCP_URL='https://...'    # from the Framer marketplace "MCP" plugin (optional)
```

Then set `"disabled": false` on `momentic` / `framer-mcp-plugin` in
`~/.config/mcp/mcp.json`. Put the exports in the human's shell profile, not in
this repo.

### 2c. Framer, official path (no MCP)

```bash
npx @framer/agent setup      # (browser) grants the agent access to a Framer project
```

Then use `/framer` in the agent. The `framer-agent` skill explains the workflow.

### 2d. Kane CLI (TestMu AI browser runs)

```bash
npm install -g @testmuai/kane-cli
kane-cli doctor --install
npx @testmuai/kane-cli-skill          # vendor skill for coding agents
```

## 3. Using the skills

Pi discovers `skills/*/SKILL.md` automatically from the package. For other
hosts copy the folders:

- Claude Code: `cp -r skills/* ~/.claude/skills/`
- Codex: `cp -r skills/* ~/.codex/skills/`

Each skill states its server, auth, playbook, and guardrails. Combo skills:
`design-to-code-pipeline`, `brand-launch-kit`, `ship-and-verify`.

## 4. Calling MCP servers from bash (token-light)

Use this in scripts, fan-out children, or when the host has no MCP client.

### mcp2cli (Python)

```bash
uv tool install mcp2cli          # or: uvx mcp2cli --help
# remote server, list tools
mcp2cli --mcp https://mcp.brandfetch.io/mcp --auth-header "Authorization:env:BRANDFETCH_MCP_TOKEN" --list
# call a tool (name/args come from --list)
mcp2cli --mcp https://mcp.brandfetch.io/mcp --auth-header "Authorization:env:BRANDFETCH_MCP_TOKEN" <tool> --<arg> <value>
# stdio server
mcp2cli --mcp-stdio "npx -y shadcn@latest mcp" --list
mcp2cli --mcp-stdio "npx -y momentic mcp --config $MOMENTIC_CONFIG" --env MOMENTIC_API_KEY=env:MOMENTIC_API_KEY --list
```

`env:` and `file:` prefixes keep secrets out of process listings.

### mcporter (TypeScript variant)

```bash
npx mcporter list https://relume-library-mcp.relume.io/mcp --brief
npx mcporter call https://relume-library-mcp.relume.io/mcp.<tool> --<arg> <value>
npx mcporter list ~/.config/mcp/mcp.json     # reads the same mcpServers shape
```

OAuth-only servers need a bearer token the host already obtained (complete
`/mcp` auth in Pi first, or use the vendor CLI); pass it with `--auth-header`.

## 5. Verify

```bash
pi list                                        # package + companions present
node scripts/install-mcp.mjs --dry-run | tail -5
PI_OFFLINE=1 pi -p "reply with the single word pong" --no-session --mode json < /dev/null | grep -c pong
```

In a TUI session: `/stack status` (settings), `/titan` (command index + model bar),
`/mcp` (server status), `/workflows` (dynamic-workflows menu with the stack's
subagent-tools and fan-out toggles).

## 6. What this package changes on the machine

- `~/.pi/agent/settings.json` packages entry (via `pi install`).
- `~/.pi/agent/titan-harness.json` (created on first `/stack` change).
- `~/.config/mcp/mcp.json` (only when you run `scripts/install-mcp.mjs`).
- `~/.pi/workflows/settings.json` `excludeSubagentTools` / `defaultConcurrency`
  (only when `/stack tools off` or `/stack fanout N` is used).
- One documented patch to pi-dynamic-workflows' `dist/workflow-commands.js`
  (bare `/workflows` menu hook). Without it the stock navigator opens; the
  toggles remain reachable through `/stack`.

## 7. Subagent model (pi-subagents) and Cerebras

`/stack` writes the subagent model into Pi's `settings.json` under `subagents`
(`defaultModel`, `defaultProvider`, `defaultThinking`). The shipped default is
`cerebras/qwen-3.8-27b` at `high`; the `⇢ SUBAGENT` row in the model bar stays amber
until Cerebras is authed:

```bash
export CEREBRAS_API_KEY=...      # or, in Pi: /login cerebras
```

`qwen-3.8-27b` is a custom entry on Pi's built-in Cerebras provider; if a fresh
machine lacks it, add to `~/.pi/agent/models.json`:

```json
{ "providers": { "cerebras": { "models": [ { "id": "qwen-3.8-27b", "name": "Qwen 3.8 27B",
  "reasoning": true, "input": ["text", "image"], "contextWindow": 131072, "maxTokens": 40960,
  "cost": { "input": 0.99, "output": 1.49, "cacheRead": 0, "cacheWrite": 0 } } ] } } }
```

`/stack subagent-model <provider/id> [thinking]` accepts any catalog model, authed or
not; the interactive picker lists ★ favorites, Cerebras, the full OpenRouter catalog,
then every provider. OpenRouter and Cerebras models appear once those providers are
authed (`/login openrouter`, `/login cerebras`).

## 8. Shape, auditors, hotkeys (0.2.0)

Stacks are `~/.pi/titan-harness/model-stack-<codename>.yaml` (copy the package's
`.pi/titan-harness/*.yaml` there). `/titan-shape list` shows them; `/titan-shape next`
cycles, skipping any stack with an unauthed slot. Persisted in
`~/.pi/agent/titan-harness.json` (`shape`, `builderFanOut`, `subagentFanOut`, `auditor`,
`auditorModel`, `auditorThinking`, `auditRounds`, `anonymize`).

Hotkeys need the Kitty keyboard protocol for the Ctrl variants (Kitty, Ghostty, WezTerm,
foot); the Alt variants work in every terminal:

| Action | Ctrl form | Alt form | Command |
|---|---|---|---|
| cycle shape | Ctrl+Tab | Alt+H | `/titan-shape next` |
| builders 1→4 | Ctrl+Shift+N | Alt+N | `/titan-n [1-4]` |
| subagent cap 0/2/4/6/8 | Ctrl+Shift+S | Alt+S | `/titan-s [0-16]` |
| auditors on/off | Ctrl+Shift+A | Alt+A | `/titan-audit [on|off]` |

The auditor needs a usable cross-family model: with Antigravity and xAI authed the
auto rule picks Claude Opus 4.6, Gemini 3.8 Flash, or Grok 4.6 depending on the builder.
`/stack auditor-model <provider/id>` pins one. The subagent cap is also written to
`~/.pi/agent/extensions/subagent/config.json` (`globalConcurrencyLimit`).
