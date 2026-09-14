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

## The dynamic-workflows menu hook

`~/.pi/agent/npm/node_modules/@quintinshaw/pi-dynamic-workflows/dist/workflow-commands.js`
carries a small local patch (backup: `workflow-commands.js.orig`): bare `/workflows`
calls `globalThis[Symbol.for("titan-harness:workflows-menu")]` when it exists,
which shows "Open run navigator / Subagent tools / Fan-out / Stack settings". Without
the hook it is the stock navigator. `/workflows ui` always opens the navigator
directly. The package is pinned (`@3.10.1`), so `pi update` keeps the patch; re-apply
it after a deliberate version bump.

## Stacks

`.pi/titan-harness/model-stack-*.yaml` (copied to `~/.pi/titan-harness/` for
`--titan-config`). With children loading extensions, `antigravity/gemini-3.8-flash` and
friends are valid slot models.

## MCP catalog + skill pack

`mcp/mcp.json` holds nine services (Figma, shadcn, Relume, Brandfetch, Higgsfield,
Macro, TestMu AI, Momentic, Framer) as a standard `mcpServers` file with OAuth or
`${ENV_VAR}` placeholders only. `node scripts/install-mcp.mjs` merges it into
`~/.config/mcp/mcp.json` (Pi via pi-mcp-adapter, Claude Code, Cursor, Codex all read
that shape). `skills/` is the curated pack: one skill per server, three combo
workflows (`design-to-code-pipeline`, `brand-launch-kit`, `ship-and-verify`), and
`mcp-cli-bridges` for calling servers from bash with mcp2cli or mcporter. See
`INSTALL.md` for the agent-facing install steps and `mcp/README.md` for per-server notes.

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
