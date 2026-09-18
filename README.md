# titan-harness

Dan's Pi package. One install replaces `pi-titan-harness-v2` plus the loose
`~/.pi/agent/extensions/ctx-picker.ts`.

## What is in it

| Extension | Commands | Notes |
|---|---|---|
| `extensions/titan-harness/` | `/titan`, `/titan-opinion`, `/titan-debate`, `/titan-fusion`, `/titan-collaborate`, `/titan-auto-validate`, `/titan-only`, `/titan-model`, `/titan-system-prompt`, `/titan-reset`, `/titan-shape`, `/titan-n`, `/titan-s`, `/titan-audit`, `/titan-level`, `/titan-doctor`, `/titan-watchdog`, `/workflow-monitor`, `/workflow-sidebar`, `/titan-config`, `/plan`, `/todos`, `/ultraplan`, `/create-workflow`, `/terraform`, `/local-dev-verify`, `/cloud-simulated-users`, `/workflow` | disler/fusion-harness v2, edited: children load the host's extensions (no `--no-extensions`), no panels/grids/banner, plain markdown results, one status line while agents run, model bar ON by default with Σ TOTALS, LEVEL and FAN-OUT rows |
| `extensions/ctx-picker.ts` | `/ctx [272k\|828k\|1m]`, `/titan-ctx` | Codex 272k / 828k-compact / OpenRouter 1M context presets (hardened: nothing is written unless the model is in the catalog and authed) |
| `extensions/stack-settings.ts` | `/stack`, `/stack-settings` | subagent tools on/off (harness children + dynamic-workflows agents), subagent model and cap, exa, workflow fan-out, model bar, harness level, child concurrency cap, run budget, watchdog, doctor, opens the workflows navigator |
| `extensions/titan-child-hooks.ts` | (none) | the narrow child mode: inside a `pi --mode json -p` workflow child it registers only the `tool_call` / `tool_result` handlers for the node's static hooks (`TITAN_NODE_HOOKS`) and, when `TITAN_NODE_SCHEMA` + `TITAN_NODE_RESULT_PATH` are set, the terminating `submit_result` tool; in the host and in every other child it returns immediately, so the recursion guard holds |

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
| `/workflow run\|validate\|list\|status\|stop\|graph\|schedule\|export <name>` | YAML DAG workflows (`.titan/workflows/<name>/<name>.yaml`); `schedule` arms `trigger:` workflows, `export --dw` emits a pi-dynamic-workflows script, `graph --html` writes the offline inspector | |
| `/workflow-monitor [runId\|list\|--split\|close]` | store-driven run monitor: overlay, runs table, side pane | |
| `/workflow-sidebar [runId\|expand\|collapse\|close]` | phased workflow progress sidebar, coloured by role and state | Ctrl+W · Alt+W · Ctrl+Shift+W |
| `/titan-config [show\|list\|save <name>\|apply <name>\|delete <name>\|mcp <server> on\|off\|panel]` | settings panel with MCP toggles and quick configs | Ctrl+, · Alt+, |
| `/titan-watchdog [status\|on\|off\|model\|thinking\|compaction\|resume]` | titan-native watchdog: compaction state block, child pre-emption, stalemate | |
| `/plan [brief\|on\|off\|toggle]`, `/todos` | read-only plan mode; routes to `/ultraplan` when the shape declares `plan_command` | |
| `/ultraplan <brief> \| answer <n> <text> \| fuse \| done \| abort \| status` | grilling round, anonymous fusion seats, judge, fused plan with ACKs | |
| `/create-workflow <goal> [--name n] [--from-plan id] [--from <report> [--elevate]] [--level 0-3] [--tier t] [--dry-run] [--force]` | clean-context workflow architect authors `.titan/workflows/<name>`; the host persists | |
| `/terraform [--refresh] [--section s] [--dry-run]` | entity, ontology, roadmap, automations, connectors docs under `.titan/terraform` | |
| `/local-dev-verify [--url u] [--start "cmd"] [--flows f] [--workers n] [--no-video]` | sim users against the local app: Kane or headless Chromium (CDP), hashed evidence | |
| `/cloud-simulated-users [probe\|setup <p>\|run <p> --objective "…"\|advice]` | cloud sim-user lanes: probe matrix, setup agent, recorded runs | |
| `/titan [on\|off\|toggle]` | this list; model bar on/off (alias `/fh`) | |

Settings: `~/.pi/agent/titan-harness.json` (`subagentTools`, `modelBar`, the shape keys,
and since 0.3.0 `harnessLevel`, `levelRestore`, the lane pools `workerFanOut` / `watchdogFanOut` /
`verifierFanOut` / `exaFanOut`, `maxConcurrentChildren`, `budgetUsd`, `watchdog`
(`enabled` false, `model` `cerebras/qwen-3.8-27b`, `thinking` medium, `stalemateRepeats` 3,
`onCompaction` halt-inspect, `inspectorTimeoutMs` 20000, `preemptAtContextFraction` 0.75),
`store` (`root`, `sqliteIndex` false), `monitor` (`mode` overlay), `shiftTabHintShown`, and
since 0.7.0 `schedules` — `{ "<workflow>": { "armed": true, "lastRun": "<iso>" } }`, written by
`/workflow schedule arm|disarm`). Defaults are `DEFAULT_STACK_SETTINGS` in
`modules/stack-config.ts`; every key is validated on read and a malformed file falls back to
the defaults without being rewritten. Workflow fan-out and the tool exclusion list live where pi-dynamic-workflows
reads them, `~/.pi/workflows/settings.json` (`defaultConcurrency`, `excludeSubagentTools`).

## What changed in 0.9.0

The v0.9 phase implemented [`docs/PRD-v0.9-live-tui.md`](docs/PRD-v0.9-live-tui.md) (R1–R5);
the state of the work before it is in [`docs/status-report-2026-09-15.md`](docs/status-report-2026-09-15.md).
The workflow that titan's own `/create-workflow` authored from that PRD is checked in as
[`.titan/workflows/v09-live-tui/`](.titan/workflows/v09-live-tui/) (five phases: plan → build →
verify → audit → report; `v09-live-tui.yaml`, `commands/*.md`, `AUTHORING.md`) — it is the
reference example of what the authoring pipeline produces.

**R1 Live status line and bar.** The harness preset is the first segment of Pi's status
line (`⬡ L3 engineering · builders 3 · … · plan → /ultraplan`, then any live counters:
`N running`, `workflow <name>`, `watchdog <state>`, the session cost) — Pi sorts extension
status segments by key, so titan's key is `0-titan`, which sorts before every letter key.
The segment and the model bar repaint on their own tick: every second while a child, a
workflow or a pre-emption is in flight, every 5 s idle, and on every `announce()`. The bar
requests a TUI render on each tick (its rows are computed inside the widget's `render`),
and the ⟁ LEVEL row now sits on top, above Σ TOTALS. `TITAN_DEBUG_LOG=<file>` appends one
line per bar tick and any render error (diagnostics only).

**R2 Shift+Tab cycles the presets.** With `app.thinking.cycle` moved off Shift+Tab in
`~/.pi/agent/keybindings.json` (`/titan-level --claim-shift-tab` after a confirm, or
`node scripts/keybindings-rebind.mjs`; then `/reload`), Shift+Tab walks the level shapes
0 → 1 → 2 → 3 → 0 exactly like `/titan-level next`, with the announcement and the status
segment updating live; reasoning effort moves to Alt+T. Until the rebind, Shift+Tab keeps
cycling Pi's reasoning effort (see "Harness levels").

**R3 Workflow progress sidebar.** `/workflow-sidebar [runId|expand|collapse|close]` and
**Ctrl+W** (Alt+W, Ctrl+Shift+W on terminals that swallow Ctrl+W) toggle a right-anchored
overlay that lists the phased workflow like a todo list: `│ ⠋ [builder]   build — implement
the dashboard (redo 2)`, one line per phase with a `│` bar in the owning role's colour, a
state glyph, the role box and the phase title plus its `detail:` (else the first prompt line);
`expand` adds `  └ <node> · <state>` lines; the editor keeps input. Phases come from the
document's `phases:`, else the run's phases, else one per layer. Terminal phases idle for
10 minutes go **dormant** (dimmed `#475569`), and the sidebar closes itself 10 minutes after
the run reached a terminal state (`ctrl+w close · 10 min idle → dormant · auto-close in N min`).

| Role bar | hex | | Phase state | glyph | hex |
|---|---|---|---|---|---|
| architect | `#7c3aed` | | queued | ○ | `#64748b` |
| builder | `#f59e0b` | | working | spinner | `#2563eb` |
| worker | `#22d3ee` | | in-review (auditor/verifier node running) | ● | `#d97706` |
| verifier | `#16a34a` | | redo n (2nd+ agent call of a node, edit-round-n) | ● `(redo n)` | `#ea580c` |
| auditor | `#d97706` | | review-passed (done-verified / PASS) | ✓ | `#16a34a` |
| watchdog | `#0d9488` | | done (unverified) | ● | `#ca8a04` |
| fusion · judge · fuser | `#f472b6` | | failed | ✗ | `#991b1b` |
| system (bash, script) | `#94a3b8` | | skipped | – | `#6b7280` |

**R4 Settings panel and quick configs.** **Ctrl+,** (Alt+,) or `/titan-config panel` opens
one overlay with every harness setting, editable in place: Harness (level, shape, builder /
worker / watchdog / verifier / exa pools, exa in children, subagents per child, concurrent
children, budget), Watchdog (enabled, model, thinking, on compaction, stalemate repeats),
Monitor (mode), Review (auditors, anonymize, audit rounds), Bar (model bar), MCP servers
(one toggle per server of the merged catalog with its source and reason, e.g. `missing env
INFRANODUS_API_KEY`), Quick configs (save current as…, apply a saved one). Keys: `↑↓ move ·
space/enter toggle-or-edit · ←→ change · s save config · esc close`. Level and shape rows go
through the live loader (`/titan-level` / `/titan-shape` semantics); everything else writes
`~/.pi/agent/titan-harness.json`. An MCP toggle writes the **user** catalog
`~/.config/mcp/mcp.json` (or the project `.mcp.json` with `--project`), copying the package
definition with its `${VAR}` references when the entry is absent, never a credential value,
and asks for `/reload` (pi-mcp-adapter reads the catalog at start). Quick configs are
`~/.pi/titan-harness/configs/<name>.json` (`name`, `savedAt`, `note`, `settings`, `shape`,
`level`, `mcp`), managed by `/titan-config show | list | save <name> [note…] | apply <name> |
delete <name> | mcp <server> on|off [--project] | panel`.

**R5 mcp2cli.** `node scripts/mcp2cli.mjs list | tools <server> | call <server> <tool>
[--json '{…}' | key=value …] [--timeout ms] [--text] [--verbose] | doctor` runs over titan's
own stdio MCP client and the same merged catalog as the runtime bridge (`--cwd <dir>` picks
the project `.mcp.json`, `--catalog <file>` replaces the merge). Exit codes: 0 ok · 1 tool
`isError` or RPC error · 2 usage / bad JSON · 3 server missing, disabled (catalog flag,
missing `${VAR}` named, or `url`-only → pi-mcp-adapter) or failed to start · 4 timeout.
Credential values never leave the process; `--verbose` redacts `key|token|secret|password`
values. Workflow `bash:` nodes can call it. `/titan-doctor` prints the three flavours on one
line — `mcp2cli · titan ✓ <path> · python (uvx) ✓|○ · rust ✓|○` — alongside the Python
`uvx mcp2cli` and the Rust one the Grok plugin uses (`skills/mcp-cli-bridges`).

**Still Dan's call (the PRD's open questions, defaults chosen):** the sidebar hotkey stays
Ctrl+W with Alt+W and Ctrl+Shift+W as twins (Ctrl+W is "delete word" in many editors); MCP
toggles write the user catalog by default with `--project` for the project file; dormancy dims
phase lines at 10 min idle and the sidebar auto-closes 10 min after a terminal state.

## Model bar (the "existing tps graphic")

Top row (since 0.9.0) `⟁ LEVEL | L3 engineering | b3 w5 wd5 v5 exa10 | plan → /ultraplan | shift+tab · alt+l`
(the live level or `shape <codename>`, its lane pools, the plan default and the hotkey
that cycles; amber with `run /terraform` at level 3 without a terraform pack). Then
`Σ TOTALS | 1.24M tok · $3.87 · 41 tps/agent · verified 86 % (12/14)`: the
session ledger — token burn, cost, average tps per agent and completion rate
(done-verified over every settled agent); `no runs yet` before the first ledger row,
accent while a run is live, dim when idle. Then one row per configured slot:
`◆ ROLE | slot | model (thinking) | [██--------] 12% | 87 tps | $0.0123`; a slot whose
requested thinking exceeds its provider's ceiling shows `xhi↘hi`, never a fake xhigh.
Then `◫ MONITOR | smoke-two · running · 1/2 agents working · verified 0/2 · /workflow-monitor`
(the in-flight `/workflow run`, else the newest workflow or command run of this project —
the session run only when nothing else exists; blue while live),
`⌗ WATCHDOG | armed · qwen-3.8-27b · halt-inspect · 2 inspections · $0.0100 · findings 1 · stalemate 0/3`
(only when the watchdog is on; `off · /titan-watchdog on` otherwise; red on a stalemate
or a failed inspector), `⇶ FAN-OUT | 2 running / 3 spawned | stack 3 | /titan-opinion 14s`,
and the SUBAGENT, EXA, SHAPE and AUDITOR rows. The host's own raw-chat turns are credited to the primary
slot, so the tps of the model you are chatting with is live even outside `/titan-*`
commands. The bar and the status segment repaint on a 1 s tick while anything runs and every
5 s idle (0.9.0); `/titan off` or `/stack bar off` hides the bar.

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

**Shift+Tab.** On a machine that has not been rebound, **Shift+Tab cycles Pi's reasoning
effort of the main model** (Pi's `app.thinking.cycle`), not the harness presets: Pi reserves
that chord and silently drops any extension binding on it. To make Shift+Tab cycle the
levels instead, move `app.thinking.cycle` elsewhere and reload:

1. Inside Pi: `/titan-level --claim-shift-tab` (a confirm dialog, then `app.thinking.cycle`
   → `alt+t` in `~/.pi/agent/keybindings.json` with a `keybindings.json.bak` backup), or
   from a shell `node scripts/keybindings-rebind.mjs` (`--check` exits 0 free / 2 reserved,
   `--dry-run`, `--restore`, `--to <key>`).
2. `/reload` (or restart Pi). titan binds Shift+Tab at the next session start.

`/titan-level status` and `/titan-doctor` say which state the machine is in. Until the
rebind, Alt+L (Ctrl+Shift+L on Kitty-protocol terminals) and `/titan-level` cycle the
levels, the LEVEL row says `alt+l · /titan-level`, and reasoning effort stays on
Shift+Tab; after it, reasoning effort moves to Alt+T and the row says `shift+tab · alt+l`.

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
`session_shutdown` marks it completed. A `/workflow run` is a separate run directory
with its own `runId`: the session run aggregates every child this session spent, the
workflow run is canonical for that workflow, their rows carry different `runId`s, and
`verify-ledger.mjs` checks one run directory at a time. Runs live under
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

## Workflows (0.4.0)

`/workflow` runs YAML DAGs (Archon's vocabulary, plan D13) as titan children on the same
shape, ledger and run store as every other command. A workflow is a directory holding
`<name>.yaml`, optional `commands/<name>.md` prompt bodies for `command:` nodes and
`scripts/` for named `script:` files. Resolution: project
`.titan/workflows/<name>/<name>.yaml` › user `~/.pi/titan-harness/workflows/<name>/` ›
the package's `.pi/titan-harness/workflows/`, which ships `classify-and-fix` (the Archon
canonical example ported to Pi: bash → structured classify → `when` fork → `one_success`
join → PR) and `proto-analytics-dashboard` (level 3: spec map → TDD loop → two verifiers
→ cross-family audit → gated report). Authoring is the `titan-workflow-authoring` skill
(`references/schema.md`, `rules.md`, `examples.md`); `/workflow validate <name>` before
`/workflow run`.

| Subcommand | Semantics |
|---|---|
| `/workflow run <name> [--input k=v]... [--args "text"] [--dry-run]` | validate + load, open a run in the store, execute the DAG layer by layer, stream `n/N nodes` to the status line, post the final panel (node table, `returns`, artifacts dir). `--dry-run` prints the layer plan and the Mermaid graph without opening a run. One run per session at a time; bare text after the name is `--args`; validator warnings are shown, never blocking |
| `/workflow validate <name\|path> [--json]` | every validator rule: errors, then warnings |
| `/workflow list` (`ls`) | workflows visible from this project with source (`project` › `user` › `package`) and path |
| `/workflow status [runId]` | `run.json`, ledger totals and the last 20 events of the latest (or named) workflow run for this project; the live run while one is in flight |
| `/workflow stop` | abort the in-flight run: running nodes end `cancelled`, unreached nodes `not reached` |
| `/workflow graph <name\|path>` | Mermaid `flowchart TD`: one node per id with its type glyph, role, `when` and trigger rule, phases as subgraphs, `depends_on` as edges |
| `/workflow help` | the list above |

**Document.** `apiVersion: titan.harness/v1`; `name` equals the directory name; then
`description`, `version`, `inputs` (`$inputs.<key>`; a required input without a default
comes from `--input`), `returns` (the node whose output is the run's result), `phases`,
`provider: pi`, default `model` / `thinking`, `trigger` (parsed only) and a `titan:` block
(`level`, `shape`, `tier`, `modes`, `evidence`, `elevation`, `watchdog`, `budget`,
`personas`, `parent_run`; `budget.max_concurrent_children` (≤ 16) caps that run's layer
parallelism, `min` with `/stack concurrency`, since 0.5.0). Every node has exactly one type key —
`prompt` · `command` · `bash` · `script` (+ `runtime: bun|uv`, `deps`) · `loop` ·
`approval` · `cancel` · `mcp_tool` · `workflow` (a child run, optional `fan_out`) — while
`verify` / `best_of` / `interleave` / `hypothesis` (real since 0.5.0, see "Verification
tiers and evidence" and "Patterns" below). Routing: `depends_on`; `when` (comparisons
`== != < > <= >=` between `$id.output[.field]` and literals, `&&` / `||`, parentheses;
only over nodes with `output_format`; unresolved → false, node skipped); `trigger_rule`
`all_success` (default) · `one_success` · `none_failed_min_one_success` · `all_done`.

**Hand-off and roles.** Nodes never see each other's transcripts: every node's output
lands in `artifacts/nodes/<id>.md` (+ `<id>.meta.json` with sha256, bytes, ts) and
downstream text reads `$<id>.output[.field]` or the file under `$ARTIFACTS_DIR` (bash
substitutions are shell-escaped). `context: fresh` (default) is a new session, `shared`
resumes the previous node's session (rejected in a parallel layer), `{resume: <id>}`
that node's. `role` maps to the live shape's seats: `architect` → the architect seat,
read-only; `builder` / `worker` / `fuser` → the primary builder, the first worker, the
fuser, with full tools; `verifier` / `auditor` / `fusion` / `judge` → read-only seats;
`watchdog` → the model in `settings.watchdog`; reviewer roles (auditor, verifier,
watchdog) take the priority lease so they never queue behind the builders they review.
A node's own `model` / `thinking` / `callsign` / `system_prompt` / `append_system_prompt`
override; `allowed_tools` is an allowlist (`[]` = no tools), `denied_tools` subtracts,
and an architect is read-only by construction (write tools rejected by the validator,
`denied_tools: [write, edit, bash]` injected, write tools dropped in the child).
`output_format` (a JSON schema or `$ref: titan://schemas/audit-verdict`) appends the
schema to the prompt, validates the answer and re-asks at most 3 times before the node
fails (structured output v1, the fallback). Since 0.7.0 the runtime also exports
`TITAN_NODE_SCHEMA` and `TITAN_NODE_RESULT_PATH` for every `output_format` node and adds
`submit_result` to the child's tools, so `titan-child-hooks` registers that terminating
tool and the typed object comes back with zero re-asks (structured output v2).

**Failure.** `retry` (`max_attempts` default 2, `delay_ms` 3000; never on loops,
approvals or cancels) re-runs a failed node. `loop.max_iterations` (≤ 10, with `until`
and/or `until_bash`) is the mechanical budget; `on_fail` then decides: `retry`,
`cancel` (the run ends `cancelled`), or `elevate` / `reauthor`, which write
`artifacts/escalation-report.md` (workflow, run, node, verdict, attempts, error, last
output), log `elevation.report` and end the run `failed` with `elevation: <id> failed N
times` (the elevation ladder itself is 0.5.0). Timeouts: AI nodes 300 s, `bash` /
`script` 120 s (`timeout`); a `script` runtime missing from PATH fails the node with
exit 127.

**Hooks and approvals.** `hooks:` takes static `PreToolUse` / `PostToolUse` / `Stop`
rules (`matcher` = anchored, case-insensitive regex on the tool name; Archon's `Bash`
matches Pi's `bash`), shipped to the child as `TITAN_NODE_HOOKS` and mapped by
`extensions/titan-child-hooks.ts` onto Pi's `tool_call` / `tool_result`:
`permissionDecision: deny` (and `ask`) blocks with the reason, `updatedInput` replaces
the arguments, `additionalContext` / `systemMessage` ride on the tool result as
`[hook] …` lines, `continue: false` terminates; a `Stop` rule with `continue: false` is a
terminating block at the next matching tool call. `approval:` nodes pause on a TUI
confirm plus one free-text reply when `capture_response` or `on_reject` is set (a reply
starting with no / reject / cancel / stop is a rejection); rejected with `on_reject`, the
rework prompt runs with `$REJECTION_REASON` up to `max_attempts` (default 3, ≤ 10) and
the gate is asked again, otherwise the run ends `cancelled`. A headless session rejects
every approval.

**On disk.** A workflow run is its own run directory (`command: workflow`,
`workflow: {name, sha256}`, `parentRunId` on child workflows): `artifacts/nodes/<id>.md`
+ `.meta.json`, `artifacts/escalation-report.md` when elevation fired, `events.jsonl`
(`run.start/end`, `workflow.start/end`, `phase.start`, `node.start/end`,
`agent.start/end`, `elevation.report`), `ledger.jsonl` with one row per agent call
(`origin` by role) and `agents/<nodeId>.json` (`<nodeId>#2` for re-asks and iterations),
`sessions/` (every node's Pi session, so `shared` / `resume` re-enter it) and `tmp/`
(inline `script:` text). Every workflow child also lands in the session ledger, so the
Σ TOTALS row moves while a workflow runs; the workflow run's own ledger is canonical
for that run.

## Verification tiers and evidence (0.5.0)

A workflow (or a node) names a tier in `titan.tier` / `tier:`; the tier is data in
`modules/workflow/tiers.ts` and says which evidence kinds must be *observed* before a
builder's work counts as verified. Hard evidence is `capturedBy: observed` only: the
harness hashed the bytes itself (a runner artifact, a file a tool wrote). `inferred` rows
(bash targets, harvest scans) and `declared` rows (a model sentence) are recorded with
their label and never satisfy a requirement.

| Tier | Required kinds (all observed) | Verifier runners | Review | Sim-user |
|---|---|---|---|---|
| `web-general` | `http-status`, `payload-hash`, `screenshot`, `db-op-log` | `bash`, `orca-browser` | optional | no |
| `research-planning` | `plan-digest`, `source-digests`, `alignment-table` | `verifier` | required | no |
| `prototype-analytics` | `test-result`, `log`, `screenshot`, `script`, `result-card`, `design-match` | `cursor-cloud`, `kane` | required | no |
| `production-swe` | prototype-analytics + `console-log`, `network-log`, `schedule-id`, and `video` or `screenshot` from a sim-user source (`kane`, `momentic`, `orca`, `cdp`) | `kane`, `momentic`, `orca-browser` | required | yes |
| `platform-update` | `diff`, `migration-log`, `coverage-report` (`coverage` 100), `probe`, `rollback-note` | every runner + `approval` | required | yes (1 human approval) |
| `content` | `payload-hash`, `source-digests`, `screenshot`, `approval-receipt` | `approval`, `judge` | required (3 human approvals) | no |

A `verify:` node runs one runner and writes the package: files under
`artifacts/evidence/<nodeId>/`, the canonical `evidence/<nodeId>/evidence.json`
(`schemaVersion` 1, `status` `matched` / `current-unverified` / `unavailable` /
`excluded`, every artifact with `sha256`, `kind`, `capturedBy`, `source`, degradations
`unhashed` / `scan-failed` / `truncated` / `missing`, `checks`, `missingInformation`) and its
`.sha256` sidecar, then logs `evidence.captured`. The node succeeds only when the runner
passed **and** the package is `matched`; `unavailable` is a non-retryable failure, never
a silent pass. Runners and their fail-closed rules (`modules/workflow/runners/`):

| Runner | Drives | Fails closed when |
|---|---|---|
| `bash` | `command` with `EVIDENCE_DIR` / `ARTIFACTS_DIR`; kinds inferred from file names (`db-op-log*.json`, `http-status*`, `payload-hash*`, `screenshot*`/`*.png`, `coverage*.json`, `probe*`, `rollback*`, `diff*`, `migration*`, else `log`); `checks.coverage`, `rowCounts`, `httpStatuses` parsed | non-zero exit or no artifact written |
| `kane` | `kane-cli run "<objective>" --agent --headless [--max-steps N] [--remote --device-name D]` per device, NDJSON `run_end`, `.testmuai/evidence/**` hashed | `kane-cli` not on PATH → unavailable; any device without a passing `run_end` → fail |
| `testmu` | a TestMu MCP tool through titan's MCP bridge, result stored as a `report` | no bridge / server disabled → unavailable |
| `momentic` | Momentic MCP steps, `.momentic-mcp/**` hashed | skipped unless `enabled: true` **and** `MOMENTIC_API_KEY` (or `MOMENTIC_CONFIG`) is set; enabled without a bridge → unavailable |
| `cursor-cloud` | preflight `GET /v1/me` with `CURSOR_API_KEY` (read at call time, never stored), branch on the remote required, idempotent agent id `sha256(run + node)`, polled until finished, artifacts downloaded and hashed | no key → unavailable with zero HTTP calls; 401 → unavailable; missing branch → fail; the key string is asserted absent from every artifact |
| `orca-browser` | probes `orca tab --help` first; drives `orca tab create\|goto\|snapshot\|click\|fill\|screenshot\|eval` only when the usage text has `goto` and `screenshot` | this Orca build has no browser automation (`orca tab` is list/show/create/profile/close) → unavailable after one probe call |
| `cdp-browser` | a headless Chromium over the DevTools protocol (see `/local-dev-verify`) | no Chromium found → unavailable |
| `verifier` | an AI verifier (`prompts/SYSTEM_PROMPT_VERIFIER.md`) with the project's `vision.md`, `intent.md` and `.titan/terraform/*.md`; a deterministic citation check runs first | a cited section that does not exist, an execution claim, or a contradicted row fails the lane even when the model says ok |

## Review-before-report, escalation and the ladder (0.5.0)

No builder output reaches the architect or the summary as *verified* until a review
frame is linked. An auditor-role node's answer (schema `titan://schemas/audit-verdict`;
`status` is accepted as an alias of `verdict`) becomes a `review.verdict` event and
`artifacts/reviews/<reviewedNode>.json`; the reviewed node is the node named by
`reviews:` or the nearest builder/worker ancestor. `done-verified` needs PASS or
PASS_WITH_WARNINGS **and** a `matched` evidence package for the tier's required kinds
**and** a ledger row for the reviewer; PASS without matched evidence stays
`done-unverified`; FAIL, SAFETY or SCOPE_VIOLATION is `failed-review` and fails the
auditor node so `on_fail` applies. The `/workflow` panel shows a `verified` column and
`verified k/n`; unverified builder output is prefixed `[titan] upstream output <id> is
UNVERIFIED (no review frame)` in an architect node's prompt. Control flow, one model
for every tier:

- **Audit loop.** `on_fail: {action: reauthor}` on the auditor: the findings are written to
  `artifacts/escalation-report.md` (verdict, findings table, evidence ids, diff hash,
  attempts, the `/create-workflow --elevate --from <report>` next step), the run freezes
  as `reauthored` (`elevation.freeze` event, the reviewed agent `failed-review`, an
  `architect` pseudo-agent `repairing-workflow`), and a `cancel` node named `reauthor`
  receives the report path as `$REJECTION_REASON`. The builder never resumes on reviewer
  prose. The third failed audit of the same node (`AUDIT_FAILURES_BEFORE_ELEVATION` 3)
  freezes with kind `elevate` even without `on_fail`.
- **Mechanical loop.** A `loop:` with `until_bash` (or `on_fail: elevate`) is the one
  counter: `loop.max_iterations` is the budget (tiers recommend 3). Iteration 1 runs the
  seat as declared; iteration 2 bumps thinking one step (ceiling-aware, `high → xhigh↘high`
  on a capped model) and resumes the same session with the failing log in
  `$LOOP_USER_INPUT`; iteration 3 moves to the strongest usable model of the same family at
  `max` in a fresh session (`deps.familyMax`; never a cross-family jump). Exhaustion with
  `on_fail: elevate` writes the report and freezes the run (`elevation: <id> failed N
  times`).
- **Budget.** `titan.budget.max_concurrent_children` caps a run's layer parallelism
  (`min` with `/stack concurrency`); `budgetUsd` refuses new children once the session
  ledger is past it (`held-spend`).

## Patterns (0.5.0, 0.7.0)

| Node | What it does | Fail-closed rule |
|---|---|---|
| `best_of: {n, judge?, criteria?, prompt}` | `n` (2–8, default 4) fresh candidates `<node>-c1..cn`, then a judge (role `judge`, or `judge: provider/id`) over anonymous "Candidate 1..n" bodies — the judge prompt never carries a model id, callsign or session ref; winner delivered, losers archived under `artifacts/nodes/<id>/candidates/`, `best_of.candidates` / `best_of.verdict` events | all candidates failed → nothing delivered; an out-of-range verdict is re-asked ≤ 3 in the judge's session, then fails |
| `interleave: {segments, by?, synthesize?, reauthor?, prompt}` | 2–16 fresh segment sessions (each prompt carries only its own segment; `$SEGMENT` / `$SEGMENT_COUNT` are replaced in the handler), archived under `artifacts/nodes/<id>/segments/`, then an architect-role (read-only) synthesis | any failed segment fails the node; with `reauthor: true` it is non-retryable and carries `meta.reauthor` for the escalation path |
| `hypothesis: {hypotheses[], decide_by}` | tallies `links[]` (`supports` / `challenges` / `inconclusive` / `context`, optional `weight`) found in dependency outputs; `decide_by` is `most_supported` or a comparison over `supports|challenges|inconclusive|context|weight|count_*(id)` with `&& \|\|` and parentheses; every link and the decision are chained into `<runDir>/hypotheses.jsonl` | no links → failed, never retried; a tie or a false rule → undecided failure; decisions never come from prose |
| `mimeograph: "a, b"` or `{personas, models?}` on an AI node | the same brief across k personas × m models (`mg-n` cells, fresh sessions), archived under `artifacts/nodes/<id>/mimeograph/`, judged like `best_of` | a missing persona fails the node non-retryably |
| `persona: <name>` on an AI node | appends the persona (`personas/<name>.md` frontmatter `lens`, `bias`, `style`, optional `model`, `thinking`, then the body) to the seat's system prompt; roots `<cwd>/.titan/personas` › `~/.pi/titan-harness/personas` › the package's `personas/` (implementer, test-author, evidence-auditor, contrarian, cursor-cloud-swe, sim-user, workflow-architect, researcher) | prompts never contain a model name; two personas on one model produce different prompt hashes |

## Content presets and approval receipts (0.5.0)

`.titan/presets/content/<key>.yaml` (project) shadows the package's
`.pi/titan-harness/presets/content/` (`README.md` and
`example-saas-blog-post-founder.yaml`): `{key, industry, content_type,
preference_profile: {voice, tone, banned_claims[], style_guide_ref}, rubric:
[{criterion, threshold}], reviewers: {human_min (default 3, 1–20), roles[]},
receipts_dir?}`. An `approval:` node with `preset_key` (and optionally `content:
"$draft.output"`) writes an `approval-receipt` artifact per decision under
`artifacts/receipts/<presetKey>/` (`{presetKey, reviewer, decision, rubricScores, ts,
contentSha256}` — the reply `reviewer: Dana; accuracy=5, clarity=4` is parsed) and outputs
`{approved, receipts, required, presetKey, contentSha256, reviewers, response}`, so a ship
node's `when: $review.output.receipts >= 3` counts distinct named reviewers of the same
content hash; a rejection or a duplicate reviewer blocks it.

## Watchdog (0.6.0)

Titan's own watchdog (`modules/watchdog/`, plan §5.5) replaces nothing in pi-subagents:
that package's watchdog stays off inside titan children by default, its warning cards
are ingested when an operator enables it, and its limits are mirrored
(`stalemateRepeats` 3, reviewer input ≤ 24,000 chars, cadence ≥ 5 tools, review timeout
30 s, compaction inspector 20 s, `WATCHDOG.md` ≤ 8 KB —
`tests/watchdog-limits.test.ts` pins them against the installed 0.67.0 sources).
States `idle → armed → inspecting → cleared | steering | resuming | halted-stalemate |
failed`. Off by default: `/titan-watchdog on`.

| Trigger | Action |
|---|---|
| host `session_before_compact` with a titan run active | a deterministic **state block** (run id, phase, node states, agents, evidence ids, open findings, plan digest, the last 20 event hashes) is built in memory, then on `manual` / `threshold` compactions a read-only inspector on the watchdog model (bounded by `inspectorTimeoutMs`, honouring the hook's signal) writes the narrative → the compaction summary is *block + narrative*; on `overflow` or a retried turn the summary is the block alone; inspector timeout or failure → block alone plus a `watchdog-failed` badge, never a cancelled compaction; `onCompaction: summary-only` skips the inspector, `off` leaves compaction to Pi |
| `session_compact` / `session_compact_failed` | `compaction.done` (summary hash) / `compaction.failed` events; compacting agents go back to work |
| a workflow child at ≥ `preemptAtContextFraction` (0.75) of its model's context, or a `compaction_start` event on its JSON stream | halted at its next `tool_execution_end`; an inspector on the architect's model reads the transcript tail against the state block: **clean** → logical clear (same model, fresh checkpoint session id, the prior transcript flagged `logicalCleared`, bytes kept); **loss / hallucination** → a fresh session on the architect's model with `prompts/USER_PROMPT_RESUME.md` (state block, diff, findings, carry-over) — never a transcript replay; inspector failure → `watchdog-failed`, the child stays halted; one pre-emption per request |
| a run ends without a review frame; a builder pings the architect with an unreviewed write; an agent stops without review; PASS without a harvest | `done-unverified` + auditor dispatch; ping queued with `missing-review`; `done-unverified`; forced harvest |
| the same finding identity (`sha256(category + summary + paths)`) `stalemateRepeats` times | `halted-stalemate`: children are not halted, the turn ends, `/titan-watchdog resume` is the human gate |
| reviewer model or auth error | `watchdog-failed`, `done-verified` refused |
| session ledger over `budgetUsd` | `held-spend`: no new children |
| user input | cancels an in-flight inspection |

Every inspection is a ledger row (`origin` `compaction-inspector` or `watchdog`).
`/titan-watchdog status | on | off | model <provider/id> | thinking <level> | compaction
halt-inspect|summary-only|off | resume`; the `⌗ WATCHDOG` bar row shows state, model,
compaction mode, inspections, spend, findings and the stalemate counter. Prompts:
`SYSTEM_PROMPT_WATCHDOG.md` (evidence over claims — "tests passed" without a hashed log
is a blocker), `USER_PROMPT_WATCHDOG_COMPACTION.md`, `USER_PROMPT_RESUME.md`.

## /workflow-monitor (0.6.1)

Pi has no sidebar or pane API, so the monitor is store-driven and in-process first:

- `/workflow-monitor [runId]` opens a right-anchored overlay (`ctx.ui.custom` with
  `overlay: true`, half the terminal width, the editor keeps input) redrawn every 500 ms
  from `run.json`, `agents/*.json`, `events.jsonl` and `ledger.jsonl` of the in-flight
  `/workflow run` (else the newest run of this project, or the given id prefix). Line 1:
  `◆ MONITOR <workflow> · <runId> · <status> · <totals>`; line 2: the phase rail
  `[✓ plan]─[● build]─[○ verify]` from `phases:`; one row per agent
  `<glyph> <callsign> · <role> · <model> (<thinking>) · <state> · <tok> tok · $<cost>[ · <tps> tps][ · wd:n]`
  (spinner = working, `●` = needs input / terminal, `○` = queued; nested pi-subagents
  children as indented `└` sub-rows, one level); footer `verified k/n · ↑↓ scroll · q close`.
  Colours are the §5.4 vocabulary (`queued` #64748b … `done-verified` #16a34a,
  `done-unverified` #ca8a04, `stalemate` #dc2626, `failed-review` #9f1239); `done-unverified`
  is never folded into `done-verified`.
- `/workflow-monitor list` — the runs table (name · phase · roster · progress · result)
  over titan runs **and** pi-dynamic-workflows runs read from
  `~/.pi/workflows/projects/<key>/runs/*.json` (`key` = sanitized basename + 12 hex of
  `sha256(path.resolve(cwd))`, pi-dw's own rule; its runs map to `dispatched-working` /
  `done-unverified` / `failed` / `cancelled` because pi-dw has no review frames).
- `/workflow-monitor --split` — the same frame in a side pane: `orca terminal split
  --command …`, else `tmux split-window -h`, else an explicit "none" with the command to
  run by hand: `node scripts/titan-monitor.mjs --run <runDir> [--follow] [--interval 1000]
  [--width N] [--height N]` (or `--list <runsRoot> --project <projectSlug>`), whose output
  is pinned byte-for-byte to the overlay renderer by a test.
- `/workflow-monitor close`; the `◫ MONITOR` bar row is always on.

## Plan mode and /ultraplan (0.7.0)

`/plan [brief|on|off|toggle]` is a port of Pi's plan-mode example: `edit` and `write`
leave the active tools, `bash` is allowlisted (`cat`, `head`, `grep`, `find`, `ls`, `git
status/log/diff`, …; anything matching `rm`, `mv`, `cp`, `mkdir`, `tee`, redirects, … is
blocked at `tool_call`), a `[PLAN MODE ACTIVE]` context is injected, numbered steps under
a `Plan:` header are tracked and `[DONE:n]` markers tick them (`/todos`). State persists
as a `titan-plan-mode` session entry. When the live shape declares
`plan_command: /ultraplan` (level 3), bare `/plan` and `/plan <brief>` route to
`/ultraplan`; `on|off|toggle` never route.

`/ultraplan <brief>` enables plan mode, opens a store run (`command: ultraplan`) and runs
the fusion team from `~/.pi/titan-harness/model-stack-ultraplan.yaml` with today's
fallbacks (vacant seats are named, never silently dropped):

1. **Grill** — the architect seat (`rune`) asks numbered frontier questions with a
   recommendation each (structured output); `/ultraplan answer <n> <text>` records an
   answer, unanswered questions take the recommendation.
2. **`/ultraplan fuse`** — every live fusion seat (`quill`, `slate`, `prism`, `lumen`) drafts
   read-only in a fresh session as an anonymous letter (`seats/A.md` …; no prompt carries
   a model id), the judge (`gavel`) ranks the drafts as YAML (`judge.yaml`), the fuser
   (`loom`) merges them into `fused-plan.md`, then each seat ACKs the fused bytes
   (`ACK FUSION <runId>` + sha256 → `acks.json`, a "Seat ACKs" table in the plan).
   Invariants: at least 3 live seats (else `/titan-opinion` is suggested and nothing is
   spawned); the judge model must differ from the fuser model (refused before spawning).
3. **`/ultraplan done`** leaves plan mode and names the next step,
   `/create-workflow --from-plan <planId>`; `abort` stops children; `status` prints the
   phase and paths. Everything lives under `.titan/plans/<planId>/` (`brief.md`,
   `answers.md`, `seats/`, `judge.yaml`, `fused-plan.md`, `acks.json`); ledger rows carry
   `origin` `fusion` / `judge` / `fuser`.

## /create-workflow (0.7.0)

`/create-workflow <goal> [--name n] [--from-plan id] [--from <report> [--elevate]]
[--level 0-3] [--tier t] [--dry-run] [--force]` (`--from-findings` is an alias of `--from`):

- **Context pack**, bounded to 120,000 chars with a `context-manifest.json` (sha256 per
  source, truncation flags): `.titan/terraform/*.md`, `vision.md`, `intent.md`,
  `AGENTS.md`, the fused plan (`--from-plan`) or the escalation report (`--from`), a
  summary of the active shape, the authoring skill's `schema.md` / `rules.md` /
  `examples.md`, the installed workflow names.
- **A read-only workflow-architect child** (argv tools `read,grep,find,ls`, fresh session,
  the level 2/3 architect seat at xhigh — `openai-codex/gpt-6-astra`, today its fallback
  `xai/grok-4.6`), `prompts/SYSTEM_PROMPT_WORKFLOW_ARCHITECT.md` +
  `USER_PROMPT_CREATE_WORKFLOW.md`. It answers through **structured output v2**: the
  runtime exports `TITAN_NODE_SCHEMA` and `TITAN_NODE_RESULT_PATH`
  (`<runDir>/results/<node>-<n>.json`) and adds `submit_result` to the child's tools
  (also for `allowed_tools: []`, surviving `--no-tools` and `subagentTools` off), the child
  extension registers that terminating tool, and the typed object comes back with zero
  re-asks; v1 (schema in the prompt, parse, re-ask ≤ 3) remains the fallback.
- **The host validates and persists**: the YAML and `commands/*.md` bodies are staged
  under the run dir and validated (≤ 3 re-asks carrying the validator's issues), names
  outside `^[a-z0-9][a-z0-9-]{0,63}$` or any path traversal are refused, an existing
  workflow needs `--force`, then `.titan/workflows/<name>/<name>.yaml`, `commands/*.md`
  and `AUTHORING.md` (goal, source, seat, requested vs effective thinking, manifest hash,
  rounds) are written. The child never writes.
- `--elevate` (from an escalation report) targets `min(level + 1, 3)`, halves the failed
  workflow's `context_budget` (60000 when none), deepens the tier
  (`web-general → research-planning → prototype-analytics → production-swe →
  platform-update`), turns the watchdog on, asks for tighter phases and one more
  verifier, and records `titan.parent_run` (the store's `parentRunId`).
- The status line reads `L3 · level-3 · authoring-workflow · rune xhigh` while the child
  runs and follows shape/level changes.

## MCP bridge and the InfraNodus stage (0.7.0)

pi-mcp-adapter registers the catalog's tools for the model; an extension cannot call
another extension's tools, so workflow `mcp_tool:` nodes and the InfraNodus stage use
titan's own runtime bridge, `modules/mcp-client.ts`: a dependency-free stdio JSON-RPC
client (`initialize` → `notifications/initialized` → `tools/list` → `tools/call`,
newline-delimited, the SDK's 10 MiB read cap, protocol `2025-11-25` with the older
versions accepted) over the merged catalog — the package `mcp/mcp.json`, then
`~/.config/mcp/mcp.json`, then `<cwd>/.mcp.json` (later wins). `${VAR}` is expanded from
the environment; a missing variable disables the entry with a names-only reason
(`missing env INFRANODUS_API_KEY`), `!command` secret expressions are never executed, and
`url` servers stay with pi-mcp-adapter. One process per server, started lazily and
reused; a disabled or unknown server fails closed before any call; `close()` runs at
`session_shutdown`. `modules/infranodus.ts` orchestrates only tool calls:
`generate_ontology_graph → generate_contextual_hint → optimize_reasoning`
(`ontologyStage`) and `memory_add_relations` (`rememberRelations`); with the server
disabled the stage returns `confidence: declared` with a banner instead of throwing. Skill:
`infranodus-reasoning-ontology`.

## /terraform (0.8.0)

`/terraform [--refresh] [--section entity|ontology|roadmap|automations|connectors]
[--dry-run]` runs the shipped package workflow `terraform`
(`.pi/titan-harness/workflows/terraform/`): the host gathers the sources (README, package
manifests, `AGENTS.md`, `vision.md`, `intent.md`, existing `.titan/*.md`, git remotes;
`sources.json` with a sha256 per file), a `best_of` of three fusion seats plus a judge
writes the entity (domain, organization, audience, platform, infrastructure, talent,
financials, intent, vision, bias — unknowns stay `unknown`), four seats write ontology,
roadmap, automations and connectors from it, and a `verifier` lane
(research-planning tier) checks every claim against the sources — a fake citation fails
the run and that section is reported `missing` instead of written. The InfraNodus stage
runs host-side over the corpus when the server is keyed, otherwise the ontology carries
the declared banner. Output: `.titan/terraform/{entity,ontology,roadmap,automations,connectors}.md`,
each ending in a Sources table (path, sha256, bytes) and a run footer; `entity.md` ends
with a `harness_defaults:` block (`level`, `tier`, `review`, `exa`, `budget_usd`,
`personas`; the defaults are level 2, prototype-analytics, required, true, 25,
implementer + evidence-auditor) that `/titan-level 2` consumes (`childExa`, `budgetUsd`,
`auditor`); `.titan/terraform/connectors.yaml` is created once from the default
connector list (`macro`, `figma`, `brandfetch`, `testmu`, `infranodus` as catalog MCP
servers, `github` via `gh`, `linear` via `orca linear`, `analytics-db` as a read-only script
with the credential named by `ANALYTICS_DATABASE_URL` — values never belong there) and
dry-run probed as reachable or vacant by name; `automations.md` carries one
`orca automations create --name titan-<workflow> --trigger … --precheck "node
scripts/titan-lock-check.mjs <workflow>" --prompt 'pi -p "/workflow run <workflow>"'
--provider claude --workspace "path:<cwd>"` recipe per `trigger:` workflow (printed, not
run). Existing sections are not overwritten without `--refresh` (or `--section`); the
dry run prints the DAG plan, the source list, the connector table and the recipes and
spends nothing.

## /local-dev-verify (0.8.0)

`/local-dev-verify [--url <u>] [--start "<cmd>"] [--flows <file.json>] [--workers <n>]
[--no-video] [--port <n>] [--timeout <s>]` verifies a locally running app with simulated
users. It is an in-memory workflow (`probe → snapshot → sim-user-<n> → collect → verify →
report`) executed by the engine, so it lands in the run store like any `/workflow run`:

1. **Start.** `--start "<cmd>"`, else a recipe by project type: `package.json` `scripts.dev`
   (`npm run dev`) or `scripts.start` (`npm start`), `Procfile` `web:`, `pyproject`
   `[project.scripts]` (`uv run <name>`; a FastAPI/Flask/Django/uvicorn dependency guesses
   `uv run python -m app`), a bare `index.html` (`python3 -m http.server <port> --bind
   127.0.0.1`). The app runs in its own process group and its log lands in the run
   directory; no recipe and no `--url` → `unavailable`.
2. **Probe.** `--url`, else the port the app's log announces, else `http://localhost:3000`,
   fetched until a 2xx/3xx or the timeout (60 s default, `--timeout <s>`) → otherwise
   `unavailable`, never a pass.
3. **Driver.** `kane-cli` on PATH → the `kane` runner; else a headless Chromium
   (`TITAN_CHROMIUM`, then Playwright's `~/.cache/ms-playwright/chromium_headless_shell-*/
   chrome-linux/headless_shell` or `chromium-*/chrome-linux64/chrome`, then
   `brave-browser` / `google-chrome` / `chromium` on PATH) → the `cdp-browser` runner;
   neither → `unavailable: no Kane, no Chromium`.
4. **Sim users.** `--workers <n>` (default the `workerFanOut` pool, at most 5) fresh-context
   worker seats read the page snapshot and write realistic flows as structured output
   (`prompts/USER_PROMPT_SIM_USER.md`, persona `sim-user`); `--flows <file.json>` replays a
   file instead of asking anyone.
5. **Verify.** every flow runs in a fresh browser through `scripts/cdp-browser.mjs run
   --flow <flow.json> --out <dir>` (steps `goto | click | fill | press | wait | screenshot |
   snapshot | eval | expect`) into `evidence/<flow>/`: `step-<n>.png` (screenshot),
   `snapshot-<n>.txt` + `snapshot-final.txt` (snapshot), `console.json` (console-log),
   `network.json` (network-log), `flow-result.json` (report), `flow.json` (script); every
   file is hashed with source `cdp` (a sim-user source, so production-swe's
   video-or-screenshot rule holds). `video` (WebM/VP8) comes from
   `scripts/stitch-video.mjs --frames <dir> --out <file.webm> [--fps 2]` when ffmpeg exists
   (PATH or `~/.cache/ms-playwright/ffmpeg-*/ffmpeg-linux`); without it the package carries
   `missingInformation: ["video: unavailable (ffmpeg not found)"]` instead of a claim
   (`--no-video` skips the attempt).
6. **Report.** an `inbox.architect` event with the evidence paths, and a panel with one row
   per flow (`pass` / `fail` / `unavailable`); the app and the browser are stopped.

The driver is dependency-free (`modules/cdp-browser.ts`: JSON-RPC over Node's global
`WebSocket`, `--headless=new --no-sandbox --remote-debugging-port=0` with a throw-away
profile; `--no-sandbox` because Ubuntu's AppArmor disables unprivileged user namespaces).
`node scripts/cdp-browser.mjs doctor` names the Chromium it would use (exit 3: none);
`snapshot --url <url>` prints a page snapshot. Exit codes of `run`: 0 ok, 1 the flow failed
(`flow-result.json` says why), 2 usage, 3 no Chromium. The same runner is available to any
workflow as `verify: { runner: cdp-browser, flows: [...] | flows_file: flows.json, video: true }`.

## /cloud-simulated-users (0.7.0)

`/cloud-simulated-users [probe]` prints the provider matrix — `cursor-cloud` (needs
`CURSOR_API_KEY`, `git`), `testmu-hyperexecute` (the `testmu` MCP server enabled),
`kane-remote` (`kane-cli` on PATH), `momentic` (`MOMENTIC_API_KEY` or `MOMENTIC_CONFIG`
and the `momentic` server) — each `ready` or `vacant` with the missing pieces by name
(values are never read; nothing reaches the network during a probe).
`setup <provider>` spawns a read-only worker seat with the provider's skill and
host-persists its advice as `.titan/terraform/remote-testing.md` (the provider's section
replaced on re-run, credential-looking lines dropped; install commands run only after a
confirm). `run <provider> --objective "<text>" [--devices a,b] [--ref <branch>]` executes a
one-node `verify` workflow on the provider's runner (Cursor reads `.titan/cursor.yaml` for
`repo`, `startingRef` and `api_base`; the template is `.pi/titan-harness/templates/cursor.yaml`),
streams `cloud-sim.preflight / started / exec / progress / finished` events into the
store and names the evidence package hash; a vacant provider refuses `run` naming what
is missing. `advice` prints the file.

## Triggers, graph.html and export --dw (0.8.x)

- A workflow with `trigger: {cron: "<5 fields>"}` or `{every: 30s|15m|6h|1d}` is armed with
  `/workflow schedule arm <name>` (`schedules.<name>.armed` in the settings file) and runs
  from an in-process scheduler that ticks every 30 s **while the session that armed it is
  open**; overlapping fires are skipped (a resident-run lock under
  `~/.pi/titan-harness/locks/<workflow>.lock` with pid + heartbeat, stale after 10 min
  without a heartbeat and cleared once), a missed window runs once (`catchUp: latest`),
  `lastRun` is recorded, `disarm` stops it, `list` shows the plan. `recipe <name>` prints
  the `orca automations create …` line for an Orca-scheduled run whose `--precheck` is
  `node scripts/titan-lock-check.mjs <workflow>` (exit 0 free, 1 running, 2 usage). A
  6-field cron validates but cannot be scheduled (reported, not a crash).
- `/workflow graph <name> --html [--out <path>]` writes `.titan/plans/graph-<name>.html`:
  one self-contained file, no external resources, layered SVG with the node glyphs, a
  click shows the node's fields, the Mermaid text in a `<details>`.
- `/workflow export --dw <name> [--out <path>]` writes `.titan/plans/<name>.dw.mjs`, a
  pi-dynamic-workflows 3.10.1 script (pure-literal `meta`, `agent()` calls per node,
  `parallel` per layer, `checkpoint` for approvals, `judgePanel` for `best_of`,
  `workflow(name)` for child workflows, `schema:` for `output_format`); bash/script nodes
  become a small-tier `agent()` with a warning because 3.10.1 has no `bash()` global, and
  unsupported nodes are listed as warnings with `// TODO(id)` blocks. Never YAML; the
  package stays pinned at 3.10.1.

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

`mcp/mcp.json` holds eleven services (Figma, shadcn, Relume, Brandfetch, Higgsfield,
Macro, Fiber, TestMu AI, Momentic, Framer, InfraNodus) as a standard `mcpServers` file with
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

`skills/` is the curated pack, 26 skills: one per server, four combo workflows
(`design-to-code-pipeline`, `brand-launch-kit`, `ship-and-verify`, `outbound-scratch`), nine harness skills
(`titan-orchestration`, `titan-auditor`, `titan-workflow-authoring`, `titan-watchdog`,
`titan-ultraplan`, `titan-terraform`, `titan-local-dev-verify`,
`titan-cloud-simulated-users`, `infranodus-reasoning-ontology`),
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

Gap-fill inside this package, nothing more: no mega-CLI, no model-facing MCP client of
its own (pi-mcp-adapter registers the catalog for the model; the 0.7.0
`modules/mcp-client.ts` is a runtime bridge that only workflow `mcp_tool` nodes and the
InfraNodus stage call, never a replacement for the adapter or the bash bridges), no
Fusion Drive merge, no neuro-quant dump, no Kane-as-MCP, no Higgsfield marketing-skill
dump, no Grok Imagine as a pack server, no OpenRouter video servers.

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
