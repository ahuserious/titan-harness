# titan-harness

Dan's Pi package. One install replaces `pi-titan-harness-v2` plus the loose
`~/.pi/agent/extensions/ctx-picker.ts`.

## What is in it

| Extension | Commands | Notes |
|---|---|---|
| `extensions/titan-harness/` | `/titan`, `/titan-opinion`, `/titan-debate`, `/titan-fusion`, `/titan-collaborate`, `/titan-auto-validate`, `/titan-only`, `/titan-model`, `/titan-system-prompt`, `/titan-reset` | disler/fusion-harness v2, edited: children load the host's extensions (no `--no-extensions`), no panels/grids/banner, plain markdown results, one status line while agents run, model bar ON by default with a FAN-OUT row |
| `extensions/ctx-picker.ts` | `/ctx [272k\|828k\|1m]`, `/titan-ctx` | Codex 272k / 828k-compact / OpenRouter 1M context presets (hardened: nothing is written unless the model is in the catalog and authed) |
| `extensions/stack-settings.ts` | `/stack`, `/stack-settings` | subagent tools on/off (harness children + dynamic-workflows agents), workflow fan-out, model bar, opens the workflows navigator |

Settings: `~/.pi/agent/titan-harness.json` (`subagentTools`, `modelBar`). Workflow
fan-out and the tool exclusion list live where pi-dynamic-workflows reads them,
`~/.pi/workflows/settings.json` (`defaultConcurrency`, `excludeSubagentTools`).

## Model bar (the "existing tps graphic")

One row per configured slot: `◆ ROLE | slot | model (thinking) | [██--------] 12% | 87 tps | $0.0123`,
then `⇶ FAN-OUT | 2 running / 3 spawned | stack 3 | /titan-opinion 14s`. The host's own
raw-chat turns are credited to the primary slot, so the tps of the model you are
chatting with is live even outside `/titan-*` commands. `/titan off` or `/stack bar off` hides it.

## Children and extensions

Harness children are `pi --mode json -p` subprocesses that now load every host
extension, so provider extensions (for example `antigravity/*`) resolve inside them.
The recursion guard is the `TITAN_HARNESS_CHILD=1` environment marker: every
extension in this package returns early when it sees it. Skills and context files
stay off in children.

pi-subagents is untouched: its background children already load ambient
extensions; its foreground children take an `extensions` allowlist per agent or
`subagents.defaultExtensions` in Pi settings.

## Version pins

The stack is verified against these companion versions; `modules/pins.ts` reads
`~/.pi/agent/npm/node_modules/<pkg>/package.json` at session start and reports drift
or a missing package as vacant (it never installs or upgrades):

| Package | Pin |
|---|---|
| `pi-mcp-adapter` | 2.33.0 |
| `@quintinshaw/pi-dynamic-workflows` | 3.10.1 (+ the menu-hook patch below) |
| `pi-subagents` | 0.67.0 |
| `pi-exa` | 0.6.1 |
| `pi-antigravity` | 0.7.2 |
| `@raindrop-ai/pi-agent` | 0.2.1 |
| `@signalridge/pi-codex-compact` | 1.3.1 |

Every bump updates `README.md`, `INSTALL.md`, `skills/README.md`, `mcp/README.md`.

## The dynamic-workflows menu hook

`~/.pi/agent/npm/node_modules/@quintinshaw/pi-dynamic-workflows/dist/workflow-commands.js`
carries a small local patch (backup: `workflow-commands.js.orig`): bare `/workflows`
calls `globalThis[Symbol.for("titan-harness:workflows-menu")]` when it exists,
which shows "Open run navigator / Subagent tools / Fan-out / Stack settings". Without
the hook it is the stock navigator. `/workflows ui` always opens the navigator
directly. The package is pinned (`@3.10.1`), so `pi update` keeps the patch.
`scripts/apply-dw-patch.mjs` owns the file: `--check` (exit 0 applied / 2 pristine /
1 error), apply (idempotent, saves `.orig` first, refuses anything but 3.10.x) and
`--restore`; `modules/pins.ts` `dwPatchApplied()` is the boot check. The patch retires
the day upstream ships a menu hook.

## Stacks

`.pi/titan-harness/model-stack-*.yaml` (copied to `~/.pi/titan-harness/` for
`--titan-config`). With children loading extensions, `antigravity/gemini-3.8-flash` and
friends are valid slot models.

## MCP catalog + skill pack

`mcp/mcp.json` holds ten services (Figma, shadcn, Relume, Brandfetch, Higgsfield,
Macro, TestMu AI, Momentic, Framer, InfraNodus) as a standard `mcpServers` file with
OAuth or `${ENV_VAR}` placeholders only. In Pi it loads by itself: `package.json`
declares `"pi": { "mcp": "./mcp/mcp.json" }` and pi-mcp-adapter 2.33.0 registers the
servers as `titan-harness__<server>` (tool namespaces `titan_harness__<server>`), with
user/project MCP config outranking the package copy. `node scripts/install-mcp.mjs`
remains the manual merge into `~/.config/mcp/mcp.json` for Claude Code, Cursor and
Codex (or for plain names in Pi). `momentic`, `framer-mcp-plugin`, `figma-desktop` and
`infranodus` ship disabled until their machine-specific value or key exists
(`.env.example` names them: `INFRANODUS_API_KEY`, `MOMENTIC_API_KEY`, `CURSOR_API_KEY`,
`BRANDFETCH_MCP_TOKEN`).

`skills/` is the curated pack, 17 skills: one per server, three combo workflows
(`design-to-code-pipeline`, `brand-launch-kit`, `ship-and-verify`), two harness skills,
`mcp-cli-bridges` for calling servers from bash with the Python mcp2cli or mcporter,
and `divmagic-raw` (DivMagic is a Chrome extension, not MCP). Studio rules live in the
skills: Higgsfield is first-party only, no OpenRouter; the win is 5–8 s looping Framer
heroes, not films; credit cost stated before any video batch; one stack (Tailwind +
shadcn + tokens; Relume / Untitled UI for Framer clients; DivMagic + Brandfetch feed
RAW; shadcn is what we ship). First-party CLIs (Kane CLI, `npx @framer/agent`,
`@higgsfield/cli`) and the bridges are documented, not installed, not on PATH:
`docs/named-links.md`, which also explains that the Python `mcp2cli` used here and the
Rust `mcp2cli` used by the Grok plugin are two different binaries. See `INSTALL.md`
for the agent-facing install steps and `mcp/README.md` for per-server notes.

## Non-goals

Gap-fill inside this package, nothing more: no mega-CLI, no custom JSON-RPC MCP
client, no Fusion Drive merge, no neuro-quant dump, no Kane-as-MCP, no Higgsfield
marketing-skill dump, no Grok Imagine as a pack server, no OpenRouter video servers.

## Architect / builder / subagents

A stack is one **ARCHITECT** slot (plans, fuses, validates), one **primary BUILDER**
(the live host chat: raw prompts *are* the builder), and up to three more builders.
Every `/titan-*` command spawns the slots as child `pi --mode json -p` processes with a
role-specific tool contract: research roles (opinion, debate, proposals, the
collaboration coordinator's planning turn) run read-only; builders, the FUSION
merger, and the validator get write tools. Children keep a persistent per-slot
session for the whole Pi launch, so the architect remembers earlier rounds.

Both roles can now **spawn subagents**: children load pi-subagents, and `/stack`'s
"Child subagents" switch adds its `subagent` tool to every child (`all`), to
write-capable children only (`builders`), or to none (`off`). Those workers use the
**subagent model** shown in the model bar (`⇢ SUBAGENT` row), which `/stack` writes
into Pi's `settings.json` as `subagents.defaultModel` / `defaultThinking`. The
default is `cerebras/qwen-3.8-27b` at `high`; the row turns amber with
`/login cerebras` until the provider is authed. The `⌕ EXA` row shows whether
pi-exa's web search is live in the host and whether children get it too.

Picking the subagent model in `/stack` starts from your ★ favorites (Pi's
`enabledModels`), then Cerebras, then the whole OpenRouter catalog, then every
provider Pi knows, authed or not; unauthed picks are allowed and flagged.

## The 3-tier shape (0.2.0)

Design record: `docs/harness-shape-consult.md` (a `/titan-fusion` of Gemini 3.8 Flash,
Grok 4.6 and Claude Opus 4.6 reviewing the proposal). What shipped:

- **Tiers.** ARCHITECT (tier 1) → BUILDERS (tier 2, `n` = 1-4, extra builders come from a
  heterogeneous pool) → SUBAGENTS (tier 3, pi-subagents, capped per child). The cap and
  the "subagents never spawn subagents" rule travel in every child's system prompt and in
  pi-subagents' `globalConcurrencyLimit`.
- **Auditors.** One per builder when on. Every finished WRITE task is reviewed by an
  ephemeral, read-only, cross-family auditor before the report reaches the architect:
  bounded corrections on FAIL, `AUDIT_EXHAUSTED` escalation for the architect to arbitrate,
  `SAFETY` / `SCOPE_VIOLATION` fail-closed. Read-only tasks skip the gate. Verdicts are
  YAML (`prompts/SYSTEM_PROMPT_AUDITOR.md`) and are saved under the run's `audit/` dir.
- **Callsigns only.** Prompts, rosters, and cross-agent packets carry names (forge, anvil,
  ward, …) and "undisclosed model"; the transcript and model bar show the real models.
- **Live reshaping.** `/titan-shape` cycles the `model-stack-*.yaml` files in
  `~/.pi/titan-harness` (unrunnable ones are skipped), `/titan-n` builders, `/titan-s`
  subagent cap, `/titan-audit` auditors. Hotkeys: Ctrl+Tab, Ctrl+Shift+N, Ctrl+Shift+S,
  Ctrl+Shift+A on Kitty-protocol terminals; Alt+H, Alt+N, Alt+S, Alt+A everywhere.
  Changes take effect at the next command or next child spawn; nothing in flight is preempted.
- **Model bar rows.** `⬡ SHAPE | astra-gemini | builders 2 | subagents ≤4 | auditor on | callsigns only`
  and `⚖ AUDITOR | ward · audits forge | claude-opus-4-6 (hi) | idle` per builder.
