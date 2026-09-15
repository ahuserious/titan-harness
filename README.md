# titan-harness

Dan's Pi package. One install replaces `pi-titan-harness-v2` plus the loose
`~/.pi/agent/extensions/ctx-picker.ts`.

## What is in it

| Extension | Commands | Notes |
|---|---|---|
| `extensions/titan-harness/` | `/titan`, `/titan-opinion`, `/titan-debate`, `/titan-fusion`, `/titan-collaborate`, `/titan-auto-validate`, `/titan-only`, `/titan-model`, `/titan-system-prompt`, `/titan-reset`, `/titan-shape`, `/titan-n`, `/titan-s`, `/titan-audit`, `/titan-level`, `/titan-doctor` | disler/fusion-harness v2, edited: children load the host's extensions (no `--no-extensions`), no panels/grids/banner, plain markdown results, one status line while agents run, model bar ON by default with Σ TOTALS, LEVEL and FAN-OUT rows |
| `extensions/ctx-picker.ts` | `/ctx [272k\|828k\|1m]`, `/titan-ctx` | Codex 272k / 828k-compact / OpenRouter 1M context presets (hardened: nothing is written unless the model is in the catalog and authed) |
| `extensions/stack-settings.ts` | `/stack`, `/stack-settings` | subagent tools on/off (harness children + dynamic-workflows agents), subagent model and cap, exa, workflow fan-out, model bar, harness level, child concurrency cap, run budget, watchdog, doctor, opens the workflows navigator |

Command index (what bare `/titan` prints):

| Command | Does | Hotkey |
|---|---|---|
| `/titan-opinion <prompt>` | every agent answers read-only | |
| `/titan-fusion "<prompt>" "<fusion>"` | parallel research, one writer, all ACK | |
| `/titan-debate [--rounds N] <prompt>` | all-to-all debate, no judge | |
| `/titan-collaborate <prompt>` | agents plan, architect delegates, parallel build | |
| `/titan-only [slot] [prompt]` | route one prompt to one agent | |
| `/titan-model` | pick slot, model, thinking | |
| `/ctx` | 272k / 828k / OpenRouter 1M context | |
| `/stack` | settings menu and verbs (below) | |
| `/titan-auto-validate [--max-validations N] <prompt>` | gate written first, build until green | |
| `/titan-system-prompt` | every slot's effective system prompt | |
| `/titan-reset` | full reset, host and slots | |
| `/titan-shape [next\|name]` | cycle stack YAML | Ctrl+Tab · Alt+H |
| `/titan-n [1-4]` | builder fan-out | Ctrl+Shift+N · Alt+N |
| `/titan-s [0-16]` | subagent cap per child | Ctrl+Shift+S · Alt+S |
| `/titan-audit [on\|off]` | auditors per builder | Ctrl+Shift+A · Alt+A |
| `/titan-level [0-3\|next\|status\|--claim-shift-tab]` | harness level 0-3 | Ctrl+Shift+L · Alt+L · Shift+Tab after the rebind |
| `/titan-doctor [--json\|--import-infranodus-key]` | models, credentials, tools, pins, decisions | |
| `/titan [on\|off\|toggle]` | this list; model bar on/off (alias `/fh`) | |

Settings: `~/.pi/agent/titan-harness.json` (`subagentTools`, `modelBar`, the shape keys,
and since 0.3.0 `harnessLevel`, the lane pools `workerFanOut` / `watchdogFanOut` /
`verifierFanOut` / `exaFanOut`, `maxConcurrentChildren`, `budgetUsd`, `watchdog`, `store`,
`monitor`). Workflow fan-out and the tool exclusion list live where pi-dynamic-workflows
reads them, `~/.pi/workflows/settings.json` (`defaultConcurrency`, `excludeSubagentTools`).

## Model bar (the "existing tps graphic")

Top row `Σ TOTALS | 1.24M tok · $3.87 · 41 tps/agent · verified 86 % (12/14)`: the
session ledger — token burn, cost, average tps per agent and completion rate
(done-verified over every settled agent); `no runs yet` before the first ledger row,
accent while a run is live, dim when idle. Then one row per configured slot:
`◆ ROLE | slot | model (thinking) | [██--------] 12% | 87 tps | $0.0123`; a slot whose
requested thinking exceeds its provider's ceiling shows `xhi↘hi`, never a fake xhigh.
Then `⟁ LEVEL | L3 engineering | b3 w5 wd5 v5 exa10 | plan → /ultraplan | shift+tab · alt+l`
(the live level or `shape <codename>`, its lane pools, the plan default and the hotkey
that cycles; amber with `run /terraform` at level 3 without a terraform pack),
`⇶ FAN-OUT | 2 running / 3 spawned | stack 3 | /titan-opinion 14s`, and the SUBAGENT,
EXA, SHAPE and AUDITOR rows. The host's own raw-chat turns are credited to the primary
slot, so the tps of the model you are chatting with is live even outside `/titan-*`
commands. `/titan off` or `/stack bar off` hides it.

## Harness levels (0.3.0)

A level is a schema-v2 shape file `~/.pi/titan-harness/model-stack-level-<n>.yaml`
(copies of the package's `.pi/titan-harness/`, plan §4). Fan-out numbers are **pool
sizes** per lane, not simultaneous children: `maxConcurrentChildren`
(`/stack concurrency`, default 8, ≤ 16) is the only concurrency cap, watchdog and exa
lanes are never counted in the user-facing fan-out, and a lane with `pool: <slot>` draws from
that slot's allowance instead of adding to it. Thinking is stored as requested →
effective: `xhigh` on `antigravity/gemini-3.8-flash` or `cerebras/qwen-3.8-27b` is sent as
`high` (the provider ceiling) and shown as `xhigh↘high`; the request is never lost.

| Level | Label | Architect | Lanes (pool × model (thinking)) | Printed fan-out | Policy |
|---|---|---|---|---|---|
| 0 | ultrafast | `cerebras/qwen-3.8-27b` xhigh↘high | workers 5 × qwen-3.8-27b high (the primary worker is the host seat); exa 5 × qwen-3.8-27b medium | w5 / exa5 | watchdog off; review optional; tier web-general |
| 1 | brain-ultrafast | `antigravity/gemini-3.8-flash` high | workers 5 × qwen-3.8-27b high; exa 5 × qwen-3.8-27b medium | w5 / exa5 | as level 0 |
| 2 | triggered-ops | `openai-codex/gpt-6-astra` high, fallback `xai/grok-4.6` | builders 5 × grok-4.6 xhigh (primary); workers 5 × gemini-3.8-flash high; watchdogs 5 × qwen-3.8-27b medium; exa 5; auditor `auto` high | b5 / w5 / wd5 / exa5 | watchdog on (1 per fan-out, halt-inspect on compaction); review required; tier research-planning; entry: an authored workflow |
| 3 | engineering | `openai-codex/gpt-6-astra` xhigh, fallback `xai/grok-4.6` | builders 3 × `anthropic/claude-fable-5-1` high, fallback `antigravity/claude-opus-4-6` (primary); workers 5 × gemini-3.8-flash high plus a `ledger` lane (2 × grok-4.6 high, db-ops / findings curation) drawn from the worker pool; watchdogs 5 × qwen-3.8-27b medium; verifiers 5 × grok-4.6 xhigh; exa 10; auditor `auto` high | b3 / w5 / wd5 / v5 / exa10 | watchdog on; review required; tier production-swe; plan → `/ultraplan`; requires a terraform pack |

`/titan-level [0-3|next|status|--claim-shift-tab]` (also `/stack level [0-3|next]`, the
`/stack` menu, **Alt+L** in every terminal, **Ctrl+Shift+L** on Kitty-protocol
terminals). Applying a level loads its shape, resolves fallbacks (a slot whose model
is not usable takes its declared `fallback`; an `optional` seat with no usable model is
dropped as vacant), writes `harnessLevel`, `shape`, the five lane pools, `childExa`,
`auditor` (forced on when review is required) and the watchdog default to
`titan-harness.json`, switches the host chat to the level's primary seat, and announces
`titan: L3 engineering · builders 3 · workers 5 · watchdogs 5 · verifiers 5 · exa 10 ·
plan → /ultraplan` plus every substitution (`forge: anthropic/claude-fable-5-1 →
antigravity/claude-opus-4-6 (fallback)`). `next` wraps 3 → 0; a level whose shape is
not runnable is reported (`level N not runnable — …`), never silently skipped; level 3
without `.titan/terraform/entity.md` adds `run /terraform for best results`. `status`
prints the same line plus the shift+tab state. `/ultraplan` and `/terraform` are
later phases: today the level announces the plan default and the bar shows it.
An auditor slot declared `model: auto` (levels 2 and 3, `ward`) is resolved at load
time to a usable model from a different family than the primary builder and the
architect (`ward: auto → antigravity/gemini-3.8-flash (cross-family auditor)`); with
no such model authed the slot is vacant and the per-builder auditors still apply.
Entering a level from a plain shape snapshots the pool sizes, `childExa`, `auditor` and
`watchdog.enabled` it overwrites (`levelRestore` in `titan-harness.json`); loading a
plain shape again (`/titan-shape consult`, `legacy`) ends the level and restores them,
so the LEVEL row goes back to `shape consult | b2 …` instead of keeping level 3's pools.

**Shift+Tab** cycles levels only after a rebind, because Pi reserves it for
`app.thinking.cycle` and silently drops extension bindings on it.
`/titan-level --claim-shift-tab` asks for a confirm, then moves `app.thinking.cycle` to
`alt+t` in `~/.pi/agent/keybindings.json` (backup `keybindings.json.bak`);
`node scripts/keybindings-rebind.mjs` does the same from a shell (`--check` exits 0
free / 2 reserved, `--dry-run`, `--restore`, `--to <key>`). `/reload` afterwards, and
titan binds Shift+Tab at the next session start. Until then Alt+L and `/titan-level`
work, and the LEVEL row says `alt+l · /titan-level`.

`model-stack-ultraplan.yaml` ships the fusion roster for the later `/ultraplan`:
architect gpt-6-astra xhigh (fallback grok-4.6); seats fable-5.1 xhigh (fallback
opus-4-6), grok-4.6 xhigh, gemini-3.8-flash xhigh↘high, muse-spark-1.3 max (`optional`,
vacant until `OPENROUTER_API_KEY`); judge gemini-3.8-flash xhigh↘high; fuser fable-5.1
xhigh (fallback opus-4-6); the judge and the fuser never share a model.

## /titan-doctor and the /stack verbs

`/titan-doctor [--json|--import-infranodus-key]` is the operator gate behind every
"runnable today" claim: one report, no model calls. It lists the seven level/fusion models with their auth state and the
action that unblocks each (`/login openai-codex`, `/login xai`, `/login antigravity`,
`/login cerebras`, Anthropic or OpenRouter credentials), credential **names** present in
the environment (`INFRANODUS_API_KEY`, `CURSOR_API_KEY`, `MOMENTIC_API_KEY`,
`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`; values are never read) and whether the user
MCP config carries a keyed, enabled `infranodus`, optional tools on PATH (`kane-cli`,
`orca`, `tmux`, `ffmpeg`, `uvx`, `gh`), the shift+tab rebind, the seven package pins plus
the dynamic-workflows patch, the run-store root, and the recorded decisions (store,
`maxConcurrentChildren`, budget, monitor, watchdog, level). Every item is `✓ ready`,
`○ vacant`, `△ warn` or `? unknown`; a vacancy is never an error and a lane doctor
reports vacant is never described as runnable. `--json` saves `doctor.json` into a
fresh `/tmp/titan-harness-*/` directory and prints the path. `--import-infranodus-key`
(after a confirm) copies an existing key from the environment, a local
`mcp-server-infranodus/.env` or `~/.claude.json` into the `infranodus` entry of
`~/.config/mcp/mcp.json`, enables it and never shows the value; `/reload` next. Also
reachable as `/stack doctor` and from the `/stack` menu. The session-start pin check
notifies once when a companion package drifts from its pin or the patch is missing.

`/stack` grew five verbs: `concurrency <1-16>` (live titan children at once, read on
every spawn), `budget <usd|off>` (children are refused past it), `watchdog on|off`
(the titan-native watchdog; pi-subagents' own child watchdog stays off), `level
[0-3|next]` and `doctor`. `/stack status` adds the harness level with its lane pools,
the child cap and budget, the watchdog (model, thinking, stalemate repeats, compaction
mode) and the run-store root plus monitor mode. Defaults: cap 8, no budget, watchdog off
on `cerebras/qwen-3.8-27b` medium with `stalemateRepeats` 3, `onCompaction`
`halt-inspect`, children pre-empted at 75 % of their context window.

## Run store

Every session opens one run, and every `/titan-*` command's children plus the host's
own turns land in it as ledger rows — that is what the Σ TOTALS row reads;
`session_shutdown` marks it completed. Runs live under
`~/.pi/titan-harness/runs/<projectSlug>/<runId>/` (`settings.store.root`; `projectSlug`
is the readable tail of the real cwd plus 12 hex of its sha256, `runId` is
`run-<UTC time>-<6 hex>`):

| Path | Content |
|---|---|
| `run.json` | identity, cwd, command, shape, level, tier, status (`pending`, `running`, `paused`, `reauthored`, `completed`, `failed`, `aborted`, `stalemate`), phases, totals, `parentRunId`; atomic temp + rename |
| `events.jsonl` | hash-chained `{seq, ts, runId, agentId?, type, data, prev, hash}` |
| `ledger.jsonl` | hash-chained cost rows: agent, callsign, role, model, provider, thinking `{requested, effective}`, tokens, `costUsd`, `source` (observed / estimated / unmetered / external), `origin` (run, auditor, watchdog, compaction-inspector, verifier, host, …) |
| `provenance.jsonl` | hash-chained tool → file edges hashed at `tool_execution_end`: write/edit/read observed, bash targets inferred, `identityAt: live` |
| `agents/<agentId>.json` | callsign, role, model, thinking, state and state history, usage, tps |
| `artifacts/nodes/<id>.md` + `<id>.meta.json` | node output and its sha256, bytes, timestamp |
| `evidence/<nodeId>/evidence.json` + `.sha256` | canonical-JSON evidence package with a sha256sum-style sidecar |
| `blobs/<sha256>` | content-addressed copies of harvested files |
| `<root>/index.jsonl` | append-only run index (`runId`, `projectSlug`, workflow, `startedAt`) |

Chain rule: `seq` counts from 1, `prev` is the previous row's hash (64 zeros first),
`hash = sha256(canonicalJson(row − hash))` with keys sorted recursively; the host is the
single writer, an append is one `O_APPEND` line, and a torn tail line is refused rather
than chained past. Editing, reordering or removing a row breaks the chain at that `seq`;
truncating the tail is the one edit a chain cannot see, which is why `run.json` carries
totals to cross-check. Files are 0600, directories 0700. Verify any run without the
harness: `node scripts/verify-ledger.mjs <runDir>` walks events, ledger and (when
present) provenance and prints `ok <file> <n> rows` or `broken <file> at seq N …`;
`--json` for machines; exit 0 intact, 1 broken; a single `.jsonl` path works too.

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
`--titan-config`, `/titan-shape` and `/titan-level`): the 0.2 codenames plus
`model-stack-level-{0,1,2,3}.yaml` and `model-stack-ultraplan.yaml` in shape schema v2
(`version: 2`, `level`, `label`, per-slot `role` / `fanout` / `pool` / `counted` /
`fallback` / `optional` / `profile`, and the `exa`, `verification`, `watchdog`,
`plan_command`, `requires` blocks); v1 bare lists still load. With children loading
extensions, `antigravity/gemini-3.8-flash` and friends are valid slot models.

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
`BRANDFETCH_MCP_TOKEN`; `/titan-doctor --import-infranodus-key` is the in-Pi route for
the InfraNodus key).

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
