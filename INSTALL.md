# INSTALL.md — for an LLM agent setting up titan-harness

You are an agent (Claude Code, Codex, Pi, Cursor, or similar) installing this
package for a human. Follow the numbered steps in order. Every command is
non-interactive unless marked **(browser)**. Never paste API keys into files
inside this repository; they go into the shell environment or the host's secret
store. Nothing in this package installs a third-party CLI: the tools in
`docs/named-links.md` (Kane CLI, `npx @framer/agent`, `@higgsfield/cli`, the two
`mcp2cli` binaries, mcporter, mcp-to-cli) are documented, not installed, not on
PATH, and you never claim one is present unless `command -v <tool>` proves it.

## 0. Preconditions

- Node.js 22+ on PATH (`node --version`).
- Pi coding agent 0.85+ (`pi --version`). If Pi is missing, install it from
  https://pi.dev and run `pi` once so `~/.pi/agent` exists.
- `git`, and for the Python bridge `uv` (https://docs.astral.sh/uv/).
- Optional, only for `script:` workflow nodes: bun (`~/.bun/bin/bun` or on PATH) and
  uv (`~/.local/bin/uv` or on PATH). Nothing else needs them.

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

This registers the extensions (`/titan-*`, `/ctx`, `/stack`), the skill pack
(`skills/`) and, through the `pi.mcp` manifest key, the MCP catalog (`mcp/mcp.json`,
see step 2). Companion packages the stack expects, pinned to the versions this
package is verified against (`extensions/titan-harness/modules/pins.ts` checks them at
session start and reports drift; it never upgrades anything):

```bash
pi install npm:pi-mcp-adapter@2.33.0
pi install npm:@quintinshaw/pi-dynamic-workflows@3.10.1
pi install npm:pi-subagents@0.67.0
pi install npm:pi-exa@0.6.1                          # Exa web search, no key needed
pi install npm:pi-antigravity@0.7.2                  # Gemini via Google Antigravity OAuth (optional)
pi install npm:@raindrop-ai/pi-agent@0.2.1           # tracing (optional)
pi install npm:@signalridge/pi-codex-compact@1.3.1   # Codex compaction (optional)
```

Keep `pi-dynamic-workflows` pinned at 3.10.1 (3.11.0 fails to load on Pi 0.85).
After installing or reinstalling it, re-apply the documented `/workflows` menu-hook
patch; the script refuses any version but 3.10.x and keeps a `.orig` backup:

```bash
node scripts/apply-dw-patch.mjs --check    # exit 0 = applied, 2 = pristine, 1 = error
node scripts/apply-dw-patch.mjs            # apply (idempotent); --restore copies .orig back
```

Verify the load without a TUI (stdin must be closed when run from a tool):

```bash
PI_OFFLINE=1 pi -p "reply with the single word pong" --no-session --thinking off --mode json < /dev/null
```

Expect a JSON stream whose `turn_end` carries `pong` and no line containing
`Extension error`.

### 1a. Shape files: levels 0–3 and the fusion roster

`/titan-shape` and `/titan-level` read `~/.pi/titan-harness/model-stack-<codename>.yaml`.
Copy the package's shapes there once (from the installed package dir):

```bash
mkdir -p ~/.pi/titan-harness
cp .pi/titan-harness/model-stack-*.yaml ~/.pi/titan-harness/
```

The five 0.3.0 files are `model-stack-level-0.yaml` … `model-stack-level-3.yaml` and
`model-stack-ultraplan.yaml`; without the level files `/titan-level` answers
`no level shapes in ~/.pi/titan-harness`. Same-named copies are overwritten, so a
customized stack keeps its own codename.

### 1b. Shift+Tab for level cycling (optional rebind, ask the human first)

Pi reserves `shift+tab` for `app.thinking.cycle` and silently drops extension bindings
on it, so titan binds Shift+Tab only when `~/.pi/agent/keybindings.json` maps that
action elsewhere. Alt+L (Ctrl+Shift+L on Kitty-protocol terminals) and `/titan-level`
work without any rebind. The rebind changes how the human cycles thinking levels
(to `alt+t`), so confirm before running it:

```bash
node scripts/keybindings-rebind.mjs --check      # prints "free" (exit 0) or "reserved" (exit 2)
node scripts/keybindings-rebind.mjs --dry-run    # prints the would-be keybindings.json, writes nothing
node scripts/keybindings-rebind.mjs              # app.thinking.cycle → alt+t (backup keybindings.json.bak); --to <key> for another chord
node scripts/keybindings-rebind.mjs --restore    # put the backup back
```

Inside Pi the same edit is `/titan-level --claim-shift-tab` (confirm dialog, backup
kept). Either way run `/reload`; titan binds Shift+Tab at the next session start and
the model bar's LEVEL row switches from `alt+l · /titan-level` to `shift+tab · alt+l`.

## 2. Install the MCP catalog

### 2.0 Pi: automatic through the package manifest, nothing to run

`package.json` declares `"pi": { "mcp": "./mcp/mcp.json" }`. pi-mcp-adapter 2.33.0
loads that catalog from every package listed in Pi's `settings.json` `packages`
(`pi install` adds this one; the adapter never scans `node_modules`) and registers the
servers as `titan-harness__<server>`; in tool namespaces hyphens become underscores, so
tools read `titan_harness__<server>…` (`titan_harness__higgsfield`,
`titan_harness__infranodus`, …). Only server entries are read from the file. A user,
global or project MCP config (`~/.config/mcp/mcp.json`, `.mcp.json`, `.pi/mcp.json`)
has higher precedence: a same-named entry there wins, and `/mcp enable <server>` /
`/mcp disable <server>` persist only the flag into the project's `.pi/mcp.json`. In a
TUI, `/mcp` lists the package servers after `/reload` or a restart (the headless
`pi -p "/mcp"` form prints nothing). Check without a TUI (2.33.0 internal path):

```bash
node -e 'import(process.env.HOME + "/.pi/agent/npm/node_modules/pi-mcp-adapter/dist/package-mcp-loader.js").then(m => console.log(Object.keys(m.loadPackageMcpConfigs().mcpServers).join("\n")))'
```

Expect `titan-harness__figma` … `titan-harness__infranodus` (eleven names).

### 2.1 Manual merge (other hosts, or plain names in Pi)

```bash
cd "$(pi list | grep -A1 titan-harness | tail -1 | tr -d ' ')"   # the installed package dir
node scripts/install-mcp.mjs            # → ~/.config/mcp/mcp.json (user-global)
# or: node scripts/install-mcp.mjs --project   → ./.mcp.json for one repo
```

The merge never overwrites existing servers (use `--force` to replace) and
prints which servers need OAuth and which env vars are unset. Claude Code, Cursor
and Codex read that file; in Pi a merged copy outranks the package copy and appears
under its plain name.

### 2a. OAuth servers **(browser)**

Inside Pi run `/mcp`, pick each of `relume`, `brandfetch`, `higgsfield`,
`macro`, `testmu` (as `titan-harness__<name>` when loaded from the package) and
complete the browser sign-in. The human must do this; tell them the list and wait.

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
export INFRANODUS_API_KEY=...          # from the human's InfraNodus account; enables `infranodus`
export BRANDFETCH_MCP_TOKEN=...        # bf1… token, only for the bash bridges (the host uses OAuth)
export CURSOR_API_KEY=...              # Cursor cloud-agent verify lane (optional; vacant without it)
```

Then set `"disabled": false` on `momentic` / `framer-mcp-plugin` / `infranodus`
(in Pi: `/mcp enable <server>` then `/reload`; elsewhere edit the merged
`mcp.json`). `.env.example` lists every name with an empty value; real values go
in the human's shell profile, never in this repo.

`infranodus` is InfraNodus's own MCP server (`npx -y infranodus-mcp-server`):
knowledge graphs, ontology graphs, topical clusters, content gaps, research
questions, contextual hints and cross-run memory relations, which is the
reasoning-ontology stage of the workflow plan. It ships `"disabled": true` until
`INFRANODUS_API_KEY` exists; without the key nothing tries to start it.

Two routes for the InfraNodus key:

- **In Pi:** `/titan-doctor --import-infranodus-key`. After a confirm it copies an
  existing key from the environment, a local `mcp-server-infranodus/.env` or
  `~/.claude.json` into `~/.config/mcp/mcp.json` (`mcpServers.infranodus.env.INFRANODUS_API_KEY`,
  `disabled: false`, file mode 0600), never prints the value, and asks for `/reload`.
  That user-level entry outranks the package catalog's disabled copy. With no key
  anywhere it says so and points at https://infranodus.com/api-access.
- **Manual:** `export INFRANODUS_API_KEY=...` before launching Pi (the package entry
  still needs `/mcp enable infranodus`), or write the key into that same user-config
  entry by hand.

`/titan-doctor` shows the result as `InfraNodus MCP (user config)` ready or vacant.

### 2c. Framer, official path (no MCP)

```bash
npx @framer/agent setup      # (browser) grants the agent access to a Framer project
```

Then use `/framer` in the agent. The `framer-agent` skill explains the workflow.
`@framer/agent` is documented, not installed, not on PATH: `npx` fetches it per use.

### 2d. Kane CLI (TestMu AI browser runs)

```bash
npm install -g @testmuai/kane-cli
kane-cli doctor --install
npx @testmuai/kane-cli-skill          # vendor skill for coding agents
kane-cli login --username <user> --access-key <key>    # or: kane-cli login --oauth
```

Kane CLI is documented, not installed, not on PATH, and it is a CLI, not an MCP
server (Kane-as-MCP is a non-goal). The human runs the install; you run
`command -v kane-cli` before relying on it.

### 2e. Higgsfield CLI, as-is

```bash
npm i -g @higgsfield/cli && higgsfield auth login     # or: npx @higgsfield/cli
```

Documented, not installed, not wrapped. The hosted MCP (`higgsfield`) is the primary
path; the studio rules in `skills/higgsfield-media` apply to both: first-party only,
no OpenRouter; 5–8 s looping Framer heroes, not films; credit cost before any video
batch.

## 3. Using the skills

Pi discovers `skills/*/SKILL.md` automatically from the package. For other
hosts copy the folders:

- Claude Code: `cp -r skills/* ~/.claude/skills/`
- Codex: `cp -r skills/* ~/.codex/skills/`

18 skills (`skills/README.md`). Each states its server, auth, playbook, and
guardrails. Combo skills: `design-to-code-pipeline`, `brand-launch-kit`,
`ship-and-verify`; harness skills: `titan-orchestration`, `titan-auditor`,
`titan-workflow-authoring` (how to write, validate and run a `/workflow` YAML DAG);
bridge: `mcp-cli-bridges`; reference: `divmagic-raw` (DivMagic is a
Chrome extension, not MCP). The one-stack rule the combos share: Tailwind + shadcn +
tokens; Relume / Untitled UI for Framer clients; DivMagic + Brandfetch feed RAW; shadcn
is what we ship.

## 4. Calling MCP servers from bash (token-light)

Use this in scripts, fan-out children, or when the host has no MCP client. Two
different binaries are called `mcp2cli`; never treat them as one tool:

- **Pi / titan-harness (this package):** the **Python** mcp2cli (knowsuchagency/mcp2cli,
  `uvx mcp2cli` or `uv tool install mcp2cli`) plus **mcporter** (TypeScript).
- **Grok / triarc-creative-stack:** the **Rust** mcp2cli (mcp2cli.dev,
  `curl -fsSL https://mcp2cli.dev/install.sh | sh`, `mcp2cli config init --name …`,
  `mcp2cli link create --name …`) plus **mcp-to-cli** (Smithery).

If a `mcp2cli` is already on PATH, `mcp2cli --help` tells you which one it is. Prefer a
named link per server (`higgsfield`, `figma`, `relume`, `brandfetch`, `macro`, `testmu`)
so bash looks like a CLI, and keep native MCP in the interactive host. All of these
are documented, not installed, not on PATH: `docs/named-links.md`.

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
npx mcporter list ~/.config/mcp/mcp.json     # reads the same mcpServers shape; server names are the links
```

OAuth-only servers need a bearer token the host already obtained (complete
`/mcp` auth in Pi first, or use the vendor CLI); pass it with `--auth-header`.

## 5. Verify

```bash
pi list                                        # package + companions present
node scripts/apply-dw-patch.mjs --check        # 0 = menu-hook patch applied
node scripts/keybindings-rebind.mjs --check    # "free" or "reserved" (reserved is fine: Alt+L works)
ls ~/.pi/titan-harness/model-stack-level-*.yaml   # the four level shapes are in place
node scripts/install-mcp.mjs --dry-run | tail -5
PI_OFFLINE=1 pi -p "reply with the single word pong" --no-session --mode json < /dev/null | grep -c pong
node -e 'JSON.parse(require("fs").readFileSync("mcp/mcp.json","utf8")); console.log("catalog ok")'
node scripts/verify-ledger.mjs ~/.pi/titan-harness/runs/<projectSlug>/<runId>   # after a first session: "chain intact"
```

In a TUI session: `/titan-doctor` (every item `ready` or `vacant`, none `unknown`),
`/titan-level status` (the live level or `shape-driven`, and the shift+tab state),
`/workflow list` (shows `classify-and-fix` and `proto-analytics-dashboard` with source
`package`, plus any project or user workflows), `/workflow validate classify-and-fix`
(`✓ classify-and-fix is valid`, no errors), `/stack status` (settings), `/titan`
(command index + model bar), `/mcp` (server status, including the `titan-harness__*`
package servers), `/workflows` (dynamic-workflows menu with the stack's subagent-tools
and fan-out toggles).

## 6. What this package changes on the machine

- `~/.pi/agent/settings.json` packages entry (via `pi install`).
- `~/.pi/agent/titan-harness.json` (created on first `/stack` or `/titan-level` change).
- `~/.pi/titan-harness/model-stack-*.yaml` (only when you copy them, step 1a).
- `~/.pi/titan-harness/runs/` — the run store (one directory per run, hash-chained
  JSONL, files 0600 / directories 0700), created at the first session; `settings.store.root`
  moves it. A `/workflow run` gets its own run directory and adds `<runDir>/sessions`
  (one Pi session per node, so `context: shared` / `{resume}` can re-enter it) and
  `<runDir>/tmp` (inline `script:` text). bun (`~/.bun/bin/bun` or PATH) and uv
  (`~/.local/bin/uv` or PATH) are needed only for `script:` nodes; a missing runtime
  fails that node with exit 127 (`bun not found on PATH …`), nothing else.
- `~/.pi/agent/keybindings.json` (only via the Shift+Tab rebind, step 1b; backup
  `keybindings.json.bak`).
- `~/.config/mcp/mcp.json` (only when you run `scripts/install-mcp.mjs` or
  `/titan-doctor --import-infranodus-key`; the `pi.mcp` catalog itself is registered in
  memory and writes no file).
- `~/.pi/workflows/settings.json` `excludeSubagentTools` / `defaultConcurrency`
  (only when `/stack tools off` or `/stack fanout N` is used).
- One documented patch to pi-dynamic-workflows' `dist/workflow-commands.js`
  (bare `/workflows` menu hook), applied and reverted only by
  `scripts/apply-dw-patch.mjs`, with the pristine file kept as
  `workflow-commands.js.orig`. Without it the stock navigator opens; the
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
`auditorModel`, `auditorThinking`, `auditRounds`, `anonymize`; since 0.3.0 also
`harnessLevel`, `workerFanOut`, `watchdogFanOut`, `verifierFanOut`, `exaFanOut`,
`maxConcurrentChildren`, `budgetUsd`, `watchdog`, `store`, `monitor`).

Hotkeys need the Kitty keyboard protocol for the Ctrl variants (Kitty, Ghostty, WezTerm,
foot); the Alt variants work in every terminal:

| Action | Ctrl form | Alt form | Command |
|---|---|---|---|
| cycle shape | Ctrl+Tab | Alt+H | `/titan-shape next` |
| builders 1→4 | Ctrl+Shift+N | Alt+N | `/titan-n [1-4]` |
| subagent cap 0/2/4/6/8 | Ctrl+Shift+S | Alt+S | `/titan-s [0-16]` |
| auditors on/off | Ctrl+Shift+A | Alt+A | `/titan-audit [on\|off]` |
| cycle level 0→3 | Ctrl+Shift+L (and Shift+Tab after the rebind, step 1b) | Alt+L | `/titan-level next` |

The auditor needs a usable cross-family model: with Antigravity and xAI authed the
auto rule picks Claude Opus 4.6, Gemini 3.8 Flash, or Grok 4.6 depending on the builder.
`/stack auditor-model <provider/id>` pins one. The subagent cap is also written to
`~/.pi/agent/extensions/subagent/config.json` (`globalConcurrencyLimit`).

## 8b. Levels, doctor, run store (0.3.0)

`/titan-level [0-3|next|status|--claim-shift-tab]` applies one of the level shapes
from step 1a (`README.md` has the per-level model table): it writes the level, the
shape codename and the lane pools to `titan-harness.json`, switches the host chat to
the level's primary seat, and announces the fan-out plus every fallback it had to
take. Fan-out numbers are pool sizes; `/stack concurrency <1-16>` (default 8) is the
one cap on live children, `/stack budget <usd|off>` refuses children past a spend,
`/stack watchdog on|off` toggles the titan-native watchdog, `/stack level` and
`/stack doctor` forward to the two commands. `/titan-doctor` reports models + auth,
credential names, tools on PATH, the shift+tab rebind, package pins, the patch, the
run-store root and the recorded decisions, each `ready`, `vacant`, `warn` or
`unknown`; `--json` writes `doctor.json` under `/tmp/titan-harness-*/`. Every session
writes a hash-chained run under `~/.pi/titan-harness/runs/<projectSlug>/<runId>/`
(`run.json`, `events.jsonl`, `ledger.jsonl`, `provenance.jsonl`, `agents/`, `evidence/`,
`artifacts/nodes/`, `blobs/`); `node scripts/verify-ledger.mjs <runDir>` checks the
chains (exit 0 intact, 1 broken).

**Runnable today.** `/titan-doctor` decides, and a lane it reports vacant is never
described as runnable. On a machine with only Antigravity, xAI and Cerebras authed:
levels 0 and 1 run as declared; the level 2 and 3 architect (`openai-codex/gpt-6-astra`)
runs on its declared fallback `xai/grok-4.6` until `/login openai-codex`; every Fable 5.1
slot (level-3 builders, the ultraplan seat `quill` and fuser `loom`) runs on its
declared fallback `antigravity/claude-opus-4-6` until Anthropic credentials (API key or
Pi login) or an OpenRouter key exist in Pi; the Muse Spark seat (`optional`) stays
vacant until `OPENROUTER_API_KEY`; Gemini 3.8 Flash and Qwen 3.8 27B accept at most
`high`, so an `xhigh` request shows as `xhigh↘high`. The level announcement and the
model bar name every substitution.

## 9. Non-goals

titan-harness is gap-fill inside one package: one catalog, one skill pack per host,
mcp2cli/mcporter named links, first-party CLIs used as-is. It will not become:

- a mega-CLI that fronts every server;
- a custom JSON-RPC MCP client (pi-mcp-adapter and the bridges are the clients);
- a Fusion Drive merge;
- a neuro-quant dump;
- Kane-as-MCP (Kane CLI stays a CLI);
- a Higgsfield marketing-skill dump (its 27–35 marketing skills are not imported);
- Grok Imagine as a pack server;
- an OpenRouter video server of any kind (Higgsfield is first-party only).
