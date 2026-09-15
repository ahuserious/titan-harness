# titan-harness ultraplan — integration plan (seat: fable)

Scope: titan-harness 0.2.0 → 1.0.0 as a Pi 0.85.1 package. Plan only. All names below are the verified ones from CONTEXT (files under `~/Dev Tools/pi-extensions/titan-harness`, settings `~/.pi/agent/titan-harness.json`, shapes `~/.pi/titan-harness/model-stack-*.yaml`).

## 1. Architecture decision summary

- **Shape of the solution.** One package, three layers: (a) a *run store* (`~/.pi/titan-harness/runs/<projectSlug>/<runId>/`, hash-chained JSONL) that every feature writes to and reads from; (b) a *YAML workflow engine* (`modules/workflow/*`) that schedules Archon-style DAG nodes as titan `pi --mode json -p` children; (c) *surfaces* (model bar, `/workflow-monitor` pane, status line, commands, skills) that only render store state. Nothing new lives in pi-dynamic-workflows or pi-subagents; both stay pinned and are consumed, not modified (verdict B).
- **D1 — Native YAML DAG engine inside titan, not compile-to-dynamic-workflows.** titan children are observable subprocesses (JSON event stream → observed provenance, ledgered cost, watchdog coverage, compaction control); pi-dw 3.10.1 runs agents in-process with no manager hook, a fragile dist patch, and sandboxed JS. pi-dw stays for its builtins; `/workflow export --dw` emits a pi-dw script from the same YAML as a portability extra (late phase).
- **D2 — Monitor = file tailer with three surfaces.** `scripts/titan-monitor.mjs` tails the run store; `/workflow-monitor` opens it in a side pane via `orca terminal split` (fallback `tmux split-window -h`), falls back to the experimental unfocused right overlay (`ctx.ui.custom({overlay:true, anchor:"right-center", width:"40%"})` + `handle.unfocus`), and the belowEditor model bar always carries the totals row. Pi has no split/sidebar API; a tailer survives `/reload`, spans sessions and also reads pi-dw run JSON.
- **D3 — Hashed logs = append-only JSONL with canonical-JSON SHA-256 chain (K-Dense pattern), no database.** Zero native deps inside a Pi package, crash-safe appends, greppable, evidence packages are file copies; "NoSQL" is satisfied as document-per-line. SQLite (`node:sqlite`) is an optional derived index behind a flag once Pi's Node is ≥ 24 — a decision the operator confirms (§8).
- **D4 — Watchdog is titan-native (`modules/watchdog.ts`) at run level; pi-subagents' watchdog is reused only inside tier-3 children.** pi-subagents exports no review API, ignores `session_before_compact`, does not ledger spend and cannot see titan's `pi -p` children. titan's watchdog spawns ephemeral read-only cross-family reviewer children through the existing `audit.ts` spawn path, handles `session_before_compact`/`session_compact`, and ingests `subagent_watchdog_warning` cards from child streams. Stalemate logic (identity hash ≥ 3 repeats) is copied, not imported.
- **D5 — shift+tab is opt-in; `/titan-level` + `alt+l` are the guaranteed path.** Pi reserves `shift+tab` for `app.thinking.cycle`; titan binds it only after `~/.pi/agent/keybindings.json` contains `{"app.thinking.cycle": "alt+t"}` (written by `/titan-level --claim-shift-tab` after a confirm dialog, then `/reload`). Levels are shape files (`model-stack-level-{0..3}.yaml`, schema v2), so the existing shape machinery, `Symbol.for("titan-harness:shape-changed")` and `announce()` are reused.
- **D6 — Thinking normalization is explicit and logged**: `modules/thinking.ts` resolves requested→effective from Pi provider data; rosters, ledger rows and the model bar show `xhigh↘high` for gemini-3.8-flash and qwen-3.8-27b.
- **D7 — Evidence is observed, never declared**: titan hashes files after `tool_execution_end` events from child streams and on ingest of runner artifacts (Kane `.evidence`, Momentic `.momentic-mcp/`, Cursor `artifacts/download`, Orca screenshots). A model sentence "tests passed" with no hashed log is a watchdog blocker.
- **D8 — Verification tiers are data (`modules/workflow/tiers.ts`)**, each naming required evidence kinds, verifier runners, loop policy (n-of-3) and the elevation target level/tier (bridges InfraNodus gap 2).
- **D9 — Elevation re-authoring is a workflow, not a retry**: after 3 failed loops the scheduler calls `/create-workflow --elevate` (architect at higher thinking, deeper stack, halved `context_budget`, split phases) and links the runs.
- **D10 — Structured output on `pi -p` children**: v1 schema-in-prompt + validate + re-ask ≤ 3 (Archon's Pi behaviour); v2 child-side terminating `submit_result` tool registered by the titan extension when `TITAN_HARNESS_CHILD=1` and `TITAN_NODE_SCHEMA` is set (children already load host extensions).
- **D11 — Archon vocabulary kept** (`nodes`, `depends_on`, `when`, `trigger_rule`, `context: fresh`, `output_format`, `allowed_tools`, `approval`, `loop`, `$ARTIFACTS_DIR`) so workflows stay portable; titan extensions live under `titan:` and per-node role fields.
- **D12 — InfraNodus enters as a catalog entry** (`mcp/mcp.json` → `titan_harness__infranodus` via the new `"pi": {"mcp": "./mcp/mcp.json"}` manifest key) and as workflow nodes that call its tools; no native client.
- **D13 — Callsign anonymity extends to every new role** (worker, watchdog, verifier, fusion seat, judge, fuser) with pools + numeric suffixes; the architect role never gets write tools in any node.

## 2. Feature-by-feature integration table

Columns: design | where | reuse vs build | effective model/thinking (normalized) | acceptance test.

| # | Item | Design | Where it lives | Reuse / build | Model / thinking | Acceptance test |
|---|---|---|---|---|---|---|
| F1 | Sidebar totals (token burn, cost, avg tps/agent, completion rate) | Row `Σ TOTALS` at top of the belowEditor bar and line 1 of the monitor pane; derived from `ledger.jsonl` + `agents/*.json` (formulas §6) | `titan-harness.ts renderFooterWidget`, `modules/ledger.ts`, `scripts/titan-monitor.mjs` | Reuse `bumpSlotPerf`/`runTps`/`slotPerf`; build ledger + derivation | n/a | `bun test tests/ledger.test.ts`: synthetic run with 3 agents → totals equal hand sums; bar row renders within 1 Hz tick |
| F2 | `/create-workflow` clean-context authoring + live status line | Spawns a fresh workflow-architect child with a curated context pack (`.titan/terraform/*.md`, `vision.md`, `intent.md`, `AGENTS.md`, fused plan, shape YAML, schema doc); writes `.titan/workflows/<name>/<name>.yaml` + `commands/*.md`; validator loop ≤ 3; `ctx.ui.setStatus("titan", …)` shows `L3 · consult · authoring-workflow · rune xhigh` | `modules/cmd-create-workflow.ts`, `prompts/SYSTEM_PROMPT_WORKFLOW_ARCHITECT.md`, `skills/titan-workflow-authoring/SKILL.md` | Reuse `child-runner.ts runChild` (fresh session dir), `prompt-library.ts`; build command + context pack | Default `openai-codex/gpt-6-astra` xhigh (needs `/login openai-codex`); fallback `anthropic/claude-fable-5-1` xhigh | Given a goal, produces a YAML that passes `/workflow validate`; child session contains no host transcript (assert `--session-dir` fresh); status text updates on `shape-changed` |
| F3a | Tier `web-general` (spec w/ verification; verify successful DB ops) | `verify` node with `runner: bash|script` checks + evidence `http-status`, `payload-hash`, `screenshot`, `db-op-log` | `modules/workflow/tiers.ts`, `nodes/verify.ts` | Build | Workers per level | Fixture workflow fails closed when payload hash missing |
| F3b | Tier `research-planning` | Verifier compares outputs to `.titan/terraform/*.md`, `vision.md`, `intent.md`; evidence `source-digests`, `plan-digest`; no execution claims allowed | same + `prompts/SYSTEM_PROMPT_VERIFIER.md` | Build | verifier `xai/grok-4.6` xhigh (L3) | Verifier flags a plan that cites a non-existent vision section |
| F3c | Tier `prototype-analytics` | Spec + TDD: test-suite-authoring builder → implement loop → Cursor cloud + Kane verify per device → separate auditor → findings loop back to architect → re-author (§3 example, §5) | tiers + `nodes/verify.ts` runners `cursor-cloud`, `kane` | Reuse `audit.ts` gate; build runners | builders per level; auditor auto cross-family high | Example workflow runs end-to-end on a fixture repo; `done-verified` only with test-log + screenshot hashes |
| F3d | Tier `production-swe` | F3c + simulated user flows (`/local-dev-verify` nodes) + schedule/mission id for automations | same | Build | same | Missing sim-user evidence → `done-unverified` |
| F3e | Tier `platform-update` | Only features covered by simulated-user tests ship: `ship` node `when` = coverage report 100 % of shipped features | tiers + `nodes/verify.ts` + `approval` | Build | same | Coverage 90 % → ship node skipped, run ends `done-unverified` |
| F3f | Tier `content` | 3× human-review `approval` nodes keyed by preset (`.titan/presets/content/<industry>-<type>-<user>.yaml`) before agent re-review | tiers + `nodes/approval.ts` | Build | judge gemini-3.8-flash high | Approval counter < 3 blocks `ship` |
| F4 | `/workflow-monitor` states, colors, phase rail | Store-driven rows `● forge-2 · builder · grok-4.6 (xhigh) · edit-round-2 · 12.3k tok · $0.11 · 38 tps`; rail from `phases:`; state vocabulary + colors §5/§6; also reads `~/.pi/workflows/projects/<key>/runs/*.json` | `scripts/titan-monitor.mjs`, `modules/monitor/{state,overlay}.ts`, `modules/cmd-monitor.ts` | Reuse Orca CLI (`orca terminal split/send`), overlay API; build tailer | n/a | Snapshot test of rendered frame from a fixture `events.jsonl`; pane opens under Orca and under tmux; overlay fallback when neither |
| F5 | Watchdog triggers/actions incl. compaction | State machine §5; host `session_before_compact` → state block + inspector child → custom summary or resume prompt; child pre-emption at 75 % ctx; four brief triggers + stalemate + `watchdog-failed` | `modules/watchdog.ts`, `prompts/SYSTEM_PROMPT_WATCHDOG.md`, `USER_PROMPT_WATCHDOG_COMPACTION.md`, `USER_PROMPT_RESUME.md` | Reuse `audit.ts` spawn/READONLY_TOOLS, K-Dense stalemate/identity pattern; build | watchdog `cerebras/qwen-3.8-27b` medium; compaction inspector = architect's model at its thinking | Simulated compaction event returns `{compaction:{summary}}` containing the state block; a fake "tests passed" without log → blocker; 3 identical findings → `stalemate` halts |
| F6 | `/ultraplan` | titan plan mode (port of `PI/examples/extensions/plan-mode`: `tool_call` block on edit/write, `setStatus`, `[DONE]` markers) + grill rounds (numbered frontier questions with recommendations) + fusion team (§4 ultraplan shape) → fused plan `.titan/plans/<id>/fused-plan.md` → user exits (`/ultraplan done`) → workflow-architect runs `/create-workflow --from-plan` | `modules/cmd-ultraplan.ts`, `modules/plan-mode.ts`, `prompts/USER_PROMPT_ULTRAPLAN_{SEAT,JUDGE,FUSE}.md`, `skills/titan-ultraplan/SKILL.md` | Reuse `cmd-fusion.ts` (FUSION role, SHA-256 ACK), `cmd-readonly.ts` fan-out; build plan mode | architect gpt-6-astra xhigh; seats fable-5.1 xhigh, grok-4.6 xhigh, gemini-3.8-flash xhigh↘high, muse-spark-1.3 max (vacant w/o OpenRouter key); judge gemini high; fuser fable xhigh | With Codex logged in: 4–5 seat drafts, judge YAML, fused plan with ACK hashes; edit/write blocked while in plan mode |
| F7 | `/terraform` | Ultraplan team runs the `terraform` workflow: entity docs (`domain, organization, audience, platform, infrastructure, talent, financials, intent, vision, bias`) → `.titan/terraform/{entity,ontology,roadmap,automations}.md`; InfraNodus ontology stage; optional `trigger:` workflows | `modules/cmd-terraform.ts`, `.titan/workflows/terraform/`, `skills/titan-terraform/SKILL.md`, `prompts/SYSTEM_PROMPT_TERRAFORM.md` | Reuse F6 + F13; build | as F6 | Produces the 4 docs with source digests; `harness_defaults:` block parsed by levels |
| F8 | `/local-dev-verify` | Starts the app (`run` recipe per project type), spawns simulated-user workers driving Orca browser (`orca browser tab create/goto/snapshot/click/fill/screenshot`) or Kane; video/screenshots/log snapshots hashed; reports to architect | `modules/cmd-local-dev-verify.ts`, `nodes/verify.ts` runner `orca-browser`, `prompts/USER_PROMPT_SIM_USER.md`, `skills/titan-local-dev-verify/SKILL.md` | Reuse Orca CLI, `kane-cli-browser-runs` skill; build | workers `cerebras/qwen-3.8-27b` high (xhigh↘high if requested) | On a fixture site: ≥ 1 screenshot + snapshot per flow, all hashed in `evidence.json` |
| F9 | `/cloud-simulated-users` | Provider registry (Cursor cloud, TestMu/HyperExecute, Kane `--remote`, Momentic); readiness probe; if absent spawns a setup agent using the provider's skill; streams results into the store; writes `remote-testing.md` advice for the workflow architect | `modules/cmd-cloud-sim.ts`, runners in `nodes/verify.ts`, `skills/titan-cloud-simulated-users/SKILL.md` | Reuse `testmu-cloud-testing`, `momentic-e2e`, `kane-cli-browser-runs` skills; build | verifier grok-4.6 xhigh | Probe reports each provider ready/not; a Kane `--remote` run yields `run_end` + evidence pack hash |
| F10 | shift+tab levels 0–3 with fan-out defaults | §4 shapes; `/titan-level [0-3|next|status|--claim-shift-tab]`; level writes `level`, `shape`, mirrors fan-out to the 3 files; level 3 sets `plan → /ultraplan` and warns if no terraform | `modules/levels.ts`, `.pi/titan-harness/model-stack-level-{0..3}.yaml` | Reuse `cycleShape`, `bindKey`, `announce()`; build | per §4 | Cycle 0→3 updates bar + `Symbol.for("titan-harness:shape-changed")`; shift+tab bound only when keybindings.json frees it |
| A1 | System prompt override | Node `system_prompt` / `append_system_prompt` → child `--system-prompt` / `--append-system-prompt`; shape slot fields unchanged | `nodes/ai.ts`, `child-runner.ts` | Reuse | n/a | Child argv contains the override |
| A2 | Structured output | `output_format` JSON Schema (D10); `$id.output.field` in `when:` | `modules/workflow/structured-output.ts`, `modules/child-hooks.ts` | Build | n/a | Invalid JSON re-asked ≤ 3 then node `error`; v2 tool returns typed object |
| A3 | NoSQL DB with hashed logs | D3 store §6 | `modules/run-store.ts`, `hash-chain.ts` | Build (pattern from K-Dense `canonical-json.ts`) | n/a | `verifyChain()` detects a tampered row |
| A4 | Best-of-n | `best_of: {n: 2–8, judge, criteria}` → n candidates (callsigns) + judge, fail-closed on collapse (fusion-drive `best-of-n.js` transliterated) | `nodes/best-of.ts` | Build | judge gemini-3.8-flash high | n=3 fixture: judge picks, losers archived, no delivery on all-fail |
| A5 | Visual DAG builder + authoring skill | `/workflow graph <name>` → Mermaid + single-file `graph.html` (read-only inspector); authoring is YAML via skill; Archon Studio cited as reference, not rebuilt | `modules/workflow/graph.ts`, `skills/titan-workflow-authoring` | Build (S) | n/a | HTML opens offline; node click shows fields |
| A6 | YAML workflow validator | §3 rules; `/workflow validate <name> [--json]` | `modules/workflow/validator.ts` | Build; reuse `model-stack.ts` validators | n/a | Fixture suite: every rule has a failing fixture |
| A7 | Hooks | Static `hooks:` (PreToolUse/PostToolUse/Stop) → child-side `tool_call` `{block, reason}` / `tool_result` patch / terminate, loaded from `TITAN_NODE_HOOKS` JSON | `modules/child-hooks.ts` | Build | n/a | Deny matcher on `bash` blocks the call inside a child |
| A8 | Lateral pass to clean context | `context: fresh` + typed artifacts `$ARTIFACTS_DIR/nodes/<id>.md`; watchdog pre-emption re-spawns in a fresh session with resume prompt | `modules/workflow/artifacts.ts`, `watchdog.ts` | Build | resumed agent = architect's model | Second node sees only the artifact, not the first node's transcript |
| A9 | Subagents allowed tools y/n | Node `subagents: {enabled, tools, cap}` + `allowed_tools`/`denied_tools` → `childToolsFor` + `subagentCapHint` | `stack-config.ts`, `nodes/ai.ts` | Reuse | n/a | `subagents.enabled: false` → child argv lacks `subagent` |
| A10 | Subagents as interleaved reasoning | `interleave: {segments, by: files|sections|hypotheses, synthesize: true, reauthor: true}` → N fresh children → synthesizer → optional re-author | `nodes/interleave.ts` | Build; reuse `/titan-collaborate` DAG exec | workers per level | 4 segments → 4 sessions + 1 synthesis; `reauthor` opens `/create-workflow --elevate` |
| A11 | Hypothesis-based workflow | `hypothesis:` node: hypotheses[], evidence links `supports|challenges|inconclusive|context`, `decide_by`; stored as notebook entries; InfraNodus `generate_research_questions` seeds | `nodes/hypothesis.ts`, `run-store.ts notebook.jsonl` | Build (K-Dense data model) | per level | Decision rule resolves from links, not prose |
| A12 | Personas + mimeographs on fusion | `personas/<name>.md` (frontmatter `lens, bias, style, model?, thinking?`) appended via `--append-system-prompt`; mimeograph = same brief × k personas × m models, callsigns only | `modules/personas.ts`, `personas/*.md` | Build; reuse anonymize | seat models | Prompts never contain model names; k×m children spawned |
| A13 | InfraNodus MCP as local dependency | Catalog entry `infranodus` (`npx -y infranodus-mcp-server`, env `INFRANODUS_API_KEY`), manifest `pi.mcp`; stage recipe `generate_ontology_graph → generate_contextual_hint → optimize_reasoning`; `memory_add_relations` for cross-run memory | `mcp/mcp.json`, `package.json`, `modules/infranodus.ts`, `skills/infranodus-reasoning-ontology` | Reuse pi-mcp-adapter 2.33.0 | n/a | `titan_harness__infranodus__generate_ontology_graph` visible in a child's tool list when key present |
| G1–G8 | Grok-review gap-fill | Higgsfield guardrails ("no OpenRouter", "5–8 s looping Framer heroes") in `skills/higgsfield-media`, `brand-launch-kit` step 2, Grok `triarc-creative-stack` Motion stage; `@higgsfield/cli` note; mcp2cli Python (`uvx mcp2cli`) vs Rust (`mcp2cli link create`) disambiguation; named-link docs (Kane, `npx @framer/agent`, `@higgsfield/cli` not on PATH); `skills/divmagic-raw`; Tokens Studio / Untitled UI / 21st.dev mentions; Macro staleness note | skills, `README.md`, `INSTALL.md`, `mcp/README.md`, `plugins/triarc-creative-stack` | Edit | n/a | grep-based doc tests; skill lint |

## 3. YAML workflow schema proposal

Location `.titan/workflows/<name>/<name>.yaml` (+ `commands/*.md`, `scripts/*`), global `~/.pi/titan-harness/workflows/`. Archon-compatible subset for Pi; titan extensions under `titan:` and per-node role fields.

**Top level:** `name` (= directory), `description`, `version: 1`, `inputs {key: {required?, default?}}`, `returns <nodeId>`, `phases [{title, detail?}]`, `provider: pi` (only value), `model`, `thinking`, `trigger {cron|every|event, entity_profile?}` (level-2 jobs), `titan {level, shape, tier, modes [spec|design|test], evidence {require[], dir}, elevation (default|ladder), watchdog {enabled, model?, thinking?, cadence_tools?, stalemate_repeats: 3, on_compaction: halt-inspect|summary-only|off}, budget {usd?, tokens?, max_concurrent_children: 8, context_budget?}, personas []}`.

**Node types (exactly one):** Archon `command | prompt | bash | script | loop | approval | cancel`; titan `verify {runner: kane|testmu|momentic|cursor-cloud|orca-browser|bash, objective, devices[], …}`, `best_of {n, judge, criteria}`, `interleave {segments, by, synthesize, reauthor}`, `hypothesis {hypotheses[], decide_by}`, `mcp_tool {server, tool, args}`, `workflow {name, fan_out?, isolation: worktree?}`.

**Base fields (Archon):** `id`, `depends_on[]`, `when`, `trigger_rule all_success|one_success|none_failed_min_one_success|all_done`, `idle_timeout`, `timeout` (bash/script), `retry {max_attempts, delay_ms}` (error on loop). **AI fields:** `model provider/id`, `thinking`, `context fresh|shared|{resume: id}`, `output_format`, `allowed_tools`/`denied_tools` (Pi names `read bash edit write grep find ls` + MCP tool names), `system_prompt`, `append_system_prompt`, `hooks`, `mcp [server names]`, `skills`, `subagents {enabled, tools, cap}`, `phase`, `output_type`.

**titan per-node:** `role architect|builder|worker|verifier|auditor|watchdog|fusion|judge|fuser` (resolves model/thinking/callsign from the shape when `model` absent), `callsign pool|<name>`, `persona`, `tier` (override), `evidence {produces[], require[]}`, `review required|optional|none` (default `required` for builder nodes), `on_fail {action: retry|elevate|cancel, max: 3}`, `watchdog {…}`, `budget`, `context_budget` (tokens; node is split by the authoring architect when exceeded).

**Validator rules (`validator.ts`, load time):** Archon set — unique ids, `depends_on` resolvable, acyclic, `$id.output` refs known (and `when:` only on nodes with `output_format`), exactly one type key, `script.runtime bun|uv` with matching extension, `retry` on loop = error, `approval.message` and `cancel` reason non-empty, `on_reject.max_attempts` 1–10, `steps:` rejected. titan additions — `name` equals directory; `provider` absent or `pi`; `phase` titles exist in `phases`; `role: architect` nodes may not carry `write|edit` or write-capable bash (validator injects `denied_tools`); every builder node with `review: required` must reach an `auditor`/`verify` node before `returns`; tier's required evidence kinds must be `produces`d by some node (static); `verify` nodes need `runner` and non-empty `evidence.require`; `best_of.n` 2–8; `interleave.segments` 2–16; `hypothesis` ≥ 1 hypothesis + `decide_by`; callsigns unique per run; `model` matches `/^[^/\s]+\/[^\s]+$/` and resolves in Pi's registry (warn if unauthed, error if unknown); thinking above the model's ceiling → warning `requested xhigh / effective high`; `hooks` responses static only; `context: shared` forbidden after a parallel layer; `loop.max_iterations` ≤ 10; `trigger` cron parses; `budget.max_concurrent_children` ≤ 16.

**Example (`prototype-analytics` tier):**

```yaml
name: proto-analytics-dashboard
description: Prototype a sales-analytics page; spec + TDD; Cursor cloud + Kane verification; separate auditor
version: 1
returns: report
phases: [{title: plan}, {title: build}, {title: verify}, {title: audit}, {title: report}]
inputs:
  spec:   { required: true }                 # path to spec.md
  design: { default: design/dashboard.png }  # design-matching reference
titan:
  level: 3
  shape: level-3
  tier: prototype-analytics
  modes: [spec, design, test]
  elevation: default
  watchdog: { enabled: true, stalemate_repeats: 3, on_compaction: halt-inspect }
  budget: { usd: 25, max_concurrent_children: 8, context_budget: 120000 }
nodes:
  - id: spec-map
    role: architect
    phase: plan
    context: fresh
    prompt: "Read $spec and produce a feature/acceptance matrix with test ids per device (desktop, mobile)."
    allowed_tools: [read, grep, find, ls]
    output_format:
      type: object
      properties: { features: { type: array }, tests: { type: array } }
      required: [features, tests]
  - id: test-suite
    role: builder
    callsign: pool
    phase: build
    depends_on: [spec-map]
    context: fresh
    prompt: "Author the failing test suite for $spec-map.output.tests, one suite per end device. Do not implement features."
    evidence: { produces: [test-log] }
  - id: implement
    role: builder
    phase: build
    depends_on: [test-suite]
    review: required
    loop:
      prompt: "Implement the next failing feature from $spec-map.output.features and run the suite. When green: <promise>COMPLETE</promise>"
      until: COMPLETE
      until_bash: "bun test"
      max_iterations: 6
      fresh_context: true
  - id: cursor-verify
    phase: verify
    depends_on: [implement]
    verify: { runner: cursor-cloud, repo: ".", ref: "$implement.output.branch", objective: "Run the suite and exercise the dashboard; capture screenshots" }
    evidence: { require: [test-log, screenshot] }
  - id: kane-flows
    phase: verify
    depends_on: [implement]
    verify: { runner: kane, objective: "As a sales manager, filter by region and export CSV", devices: [desktop, mobile], headless: true }
    evidence: { require: [screenshot, console-log, evidence-pack] }
  - id: audit
    role: auditor
    phase: audit
    depends_on: [cursor-verify, kane-flows]
    trigger_rule: all_done
    context: fresh
    prompt: "Audit $ARTIFACTS_DIR/evidence against $spec, the design $design, performance budgets and org rules. Verdict YAML."
    output_format: { $ref: "titan://schemas/audit-verdict" }
    on_fail: { action: elevate, max: 3 }      # findings → architect → n-of-3 loop → re-authored workflow
  - id: report
    role: architect
    phase: report
    depends_on: [audit]
    when: "$audit.output.status == 'PASS'"
    prompt: "Write the acceptance report from $ARTIFACTS_DIR/evidence, citing sha256 of every artifact."
```

## 4. Harness levels & shapes

Shape schema **v2** (loader keeps v1 bare lists): a mapping with `version: 2`, `level`, `label`, `exa`, `verification`, `watchdog`, `slots[]`. Slot fields = v1 (`name`, `model`, `thinking`, `color`, `architect`, `primary`, `system_prompt`, `append_system_prompt`) plus `role`, `fanout` (clones `forge-1…forge-n`; pools: builders forge/anvil/mason/welder, workers scout/ranger/tracker/courier/harrier, watchdogs hound/vigil/sentry/lookout/beacon, verifiers assay/gauge/probe/caliper/plumb, exa lantern-n, auditors ward/sentinel/warden/arbiter), `counted` (fan-out accounting), `fallback` (model used when the slot is unauthed; `cycleShape` already skips unauthed slots), `optional`, `profile`. Slot count bound for v2: 2–12 templates. Files ship in the package `.pi/titan-harness/` and are copied to `~/.pi/titan-harness/` by `INSTALL.md`.

```yaml
# model-stack-level-0.yaml — ultrafast
version: 2
level: 0
label: ultrafast
exa: { enabled: true, fanout: 5, children: on }
verification: { default_tier: web-general, review: optional }
watchdog: { enabled: false }
slots:
  - { name: rune,  role: architect, architect: true, model: cerebras/qwen-3.8-27b, thinking: xhigh }   # effective high
  - { name: scout, role: worker, primary: true, model: cerebras/qwen-3.8-27b, thinking: high, fanout: 5 }
```
```yaml
# model-stack-level-1.yaml — brain + ultrafast workers
version: 2
level: 1
label: brain-ultrafast
exa: { enabled: true, fanout: 5, children: on }
verification: { default_tier: web-general, review: optional }
watchdog: { enabled: false }
slots:
  - { name: rune,  role: architect, architect: true, model: antigravity/gemini-3.8-flash, thinking: high }
  - { name: scout, role: worker, primary: true, model: cerebras/qwen-3.8-27b, thinking: high, fanout: 5 }
```
```yaml
# model-stack-level-2.yaml — triggered / operations / research / entity-aware strategy
version: 2
level: 2
label: triggered-ops
entry: authored-workflow           # any trigger → architect authors a verified+recoverable workflow first
exa: { enabled: true, fanout: 5, children: on }
verification: { default_tier: research-planning, review: required, elevation: default }
watchdog: { enabled: true, per_fanout: 1, counted: false, on_compaction: halt-inspect }
slots:
  - { name: rune,  role: architect, architect: true, model: openai-codex/gpt-6-astra, thinking: high, fallback: anthropic/claude-fable-5-1 }
  - { name: forge, role: builder, primary: true, model: xai/grok-4.6, thinking: xhigh, fanout: 5 }
  - { name: scout, role: worker, model: antigravity/gemini-3.8-flash, thinking: high, fanout: 5 }   # brief gives no thinking; high chosen
  - { name: hound, role: watchdog, model: cerebras/qwen-3.8-27b, thinking: medium, fanout: 5 }
  - { name: ward,  role: auditor, model: auto, thinking: high }                                      # ephemeral, cross-family
```
```yaml
# model-stack-level-3.yaml — software engineering / architecture / deep research
version: 2
level: 3
label: engineering
plan_command: /ultraplan            # status line shows "plan → /ultraplan"; bare /plan routes there
requires: [terraform]               # notify "run /terraform" when .titan/terraform/entity.md is missing
exa: { enabled: true, fanout: 10, children: on }
verification: { default_tier: production-swe, review: required, elevation: default }
watchdog: { enabled: true, per_fanout: 1, counted: false, on_compaction: halt-inspect }
slots:
  - { name: rune,   role: architect, architect: true, model: openai-codex/gpt-6-astra, thinking: xhigh, fallback: anthropic/claude-fable-5-1 }
  - { name: forge,  role: builder, primary: true, model: anthropic/claude-fable-5-1, thinking: high, fanout: 3 }
  - { name: scout,  role: worker, model: antigravity/gemini-3.8-flash, thinking: high, fanout: 5 }
  - { name: ledger, role: worker, profile: db-ops-findings-curation, model: xai/grok-4.6, thinking: high, fanout: shared }  # alternate listing
  - { name: hound,  role: watchdog, model: cerebras/qwen-3.8-27b, thinking: medium, fanout: 5 }
  - { name: assay,  role: verifier, model: xai/grok-4.6, thinking: xhigh, fanout: 5 }
  - { name: ward,   role: auditor, model: auto, thinking: high }
```
```yaml
# model-stack-ultraplan.yaml — fusion team for /ultraplan and /terraform
version: 2
label: ultraplan
slots:
  - { name: rune,  role: architect, architect: true, model: openai-codex/gpt-6-astra, thinking: xhigh, fallback: anthropic/claude-fable-5-1 }
  - { name: quill, role: fusion, model: anthropic/claude-fable-5-1, thinking: xhigh }
  - { name: slate, role: fusion, model: xai/grok-4.6, thinking: xhigh }
  - { name: prism, role: fusion, model: antigravity/gemini-3.8-flash, thinking: xhigh }            # effective high
  - { name: lumen, role: fusion, model: openrouter/meta/muse-spark-1.3, thinking: max, optional: true }  # vacant until OPENROUTER_API_KEY
  - { name: gavel, role: judge, model: antigravity/gemini-3.8-flash, thinking: xhigh }             # effective high
  - { name: loom,  role: fuser, primary: true, model: anthropic/claude-fable-5-1, thinking: xhigh }
```

**Requested → effective thinking (`modules/thinking.ts`, from Pi provider data):**

| Model | Requested | Effective | Shown as |
|---|---|---|---|
| xai/grok-4.6 | xhigh | xhigh | `xhigh` |
| openai-codex/gpt-6-astra | xhigh / max | xhigh / max | `xhigh` (unavailable until `/login openai-codex` → fallback slot) |
| anthropic/claude-fable-5-1 | xhigh / max | xhigh / max | `xhigh` |
| openrouter/meta/muse-spark-1.3 | max | max | `max` (seat vacant without `OPENROUTER_API_KEY`) |
| antigravity/gemini-3.8-flash | xhigh | high | `xhigh↘high` |
| cerebras/qwen-3.8-27b | xhigh / max | high | `xhigh↘high`; `medium` stays `medium`; ctx 131k enforces `context_budget ≤ 100k` |
| antigravity/claude-opus-4-6 | high | high | `high` |

**Hotkey plan:** `/titan-level [0-3|next|status]` always; `alt+l` (Alt twin, every terminal) and `ctrl+shift+l` (Kitty protocol) registered via `bindKey`; `shift+tab` registered at `session_start` only if `~/.pi/agent/keybindings.json` maps `app.thinking.cycle` away from it. `/titan-level --claim-shift-tab` merges `{"app.thinking.cycle": "alt+t"}` into that file after `ctx.ui.confirm`, then tells the user to `/reload`; otherwise a one-time notify (settings key `shiftTabHintShown`). Existing `ctrl+tab`/`alt+h` keep cycling all shapes; level cycling walks only shapes with `level:`. A level change writes `level` + `shape` to `titan-harness.json`, mirrors fan-out to `subagents.*` in Pi `settings.json`, `~/.pi/workflows/settings.json defaultConcurrency`, `~/.pi/agent/extensions/subagent/config.json globalConcurrencyLimit`, calls `announce()`, updates `setStatus`, and emits `Symbol.for("titan-harness:shape-changed")` so `/ultraplan` and `/create-workflow` defaults follow live; running commands are never pre-empted.

## 5. Verification, evidence & elevation ladder

**Evidence schema (`evidence/<nodeId>/evidence.json`):** `{schemaVersion: 1, runId, nodeId, agent (callsign), tier, modes[], status: matched|current-unverified|unavailable|excluded, artifacts: [{path, sha256, bytes, kind: screenshot|video|log|test-result|console-log|network-log|evidence-pack|payload|dataset|script|diff|report, capturedBy: observed|inferred|declared, source: tool|kane|momentic|cursor|orca|testmu, ts}], checks: {testsPass, exitCode, logsPresent, screenshotPresent, designMatch?, perfBudgetMet?, orgRulesMet?, userFlowsPassed?}, provenanceSeq[], missingInformation[], reviewedBy?: {callsign, verdictHash}}`. Hard evidence = `capturedBy: observed` only; `declared` never satisfies a requirement.

| Tier | Required hard evidence (fail closed) | Verifier nodes |
|---|---|---|
| web-general | URL list + HTTP status, payload sha256, screenshot; DB-op log with row counts | bash/script checks, orca-browser |
| research-planning | plan digest, source ids + digests, alignment table vs `vision.md`/`intent.md`/terraform docs; no execution claims | verifier AI node |
| prototype-analytics | test-runner log + exit code per device, screenshots, script/input hashes, numeric result card, design-match verdict | cursor-cloud, kane, auditor |
| production-swe | above + simulated user-flow video/screenshots + console/network logs, schedule/mission id | kane/momentic/orca-browser, auditor |
| platform-update | diff hash, apply/migration log, coverage report = 100 % of shipped features, post-deploy probe/screenshot, rollback note | all runners + approval |
| content | output hashes, citations with digests, preview screenshot, 3 approval receipts per preset | approval ×3, judge |

**Review-before-report rule:** no node output reaches the architect or the user summary until a review frame (auditor verdict or verifier evidence) is linked in the store; `done-verified` requires review PASS ∧ required evidence present ∧ ledger row for the reviewer; otherwise `done-unverified`. Reviewer inputs are `evidence.json`, provenance rows and the scoped `git diff` (existing `audit.ts`, `DIFF_MAX 60000`), never chat claims (bridges gap 3).

**n-of-3 loop then re-authoring (`modules/workflow/elevation.ts`, ladder `default`):** fail 1 → builder thinking +1 step (normalized; `high→xhigh`, ceiling-aware), same session resumed with findings (`USER_PROMPT_AUDIT_CORRECTION.md`); fail 2 → builder at max reasoning on the max model of its family pool (`anthropic/claude-fable-5-1 max`, or `openai-codex/gpt-6-astra max` when authed) in a fresh session; fail 3 → `/create-workflow --elevate` re-authors: architect thinking xhigh, level `min(L+1, 3)`, tier depth +1, `context_budget` halved, nodes split into more/tighter phases, verifiers +1; the new run links `elevatedFrom`. Loops also fire on CI red (`until_bash`), on functionality/design-intent proof missing, and on "no issue report back" (auditor silent). Content tier loops on human-review rejections.

**Watchdog state machine (`modules/watchdog.ts`).** Agent states: `queued`, `dispatched-working`, `waiting-architect`, `in-review`, `edit-round-n`, `done-verified`, `done-unverified`, `authoring-workflow`, `repairing-workflow`, `compacting`, `inspecting-compaction`, `resuming`, `stalemate`, `watchdog-failed`, `held-spend`, `failed`, `cancelled`.

| Trigger (event) | Action |
|---|---|
| Host `session_before_compact` (reason manual/threshold) while a run or plan mode is active | Build deterministic state block from the store (run id, phase, node states, evidence ids, open findings, plan digest, last 20 event hashes); spawn inspector child (architect's model, read-only, ≤ 90 s) over the entries about to be summarized; return `{compaction: {summary: stateBlock + narrative, firstKeptEntryId}}`; inspector failure → Pi default summary + `watchdog-failed` badge (never cancel). Reason `overflow`/`willRetry` → state block only, no inspector |
| Host `session_compact` | Record `compacted` event with summary hash; reset activity tail; state `compacting → dispatched-working` |
| Child usage ≥ 75 % of model context (from JSON `usage.totalTokens`) or child compaction event | Halt at next `tool_execution_end` (SIGTERM group), inspector reviews transcript tail vs state block; clean → trim inspected logs and resume same session; loss/hallucination → fresh session on the architect's model with `USER_PROMPT_RESUME.md` (state block + diff + findings), never a transcript replay |
| Workflow reached terminal state without a review frame | Halt, mark `done-unverified`, dispatch auditor |
| Builder/worker pings architect (`waiting-architect`) with no review on its last write | Queue the ping with diff + `missing-review` flag; architect prompt says so |
| Agent stopped (abort/crash/timeout) without review | `done-unverified`; optional last-diff review |
| Review PASS but no report/harvest reached the architect | Force harvest of the child session into the store; re-prompt architect |
| Identical finding identity (sha256 of category+summary+paths) ≥ `stalemate_repeats` | `stalemate`: end turn, `ctx.ui.confirm` human gate, run paused |
| Reviewer model/auth error | `watchdog-failed`, refuse `done-verified`, notify |
| Ledger over `budget.usd` | `held-spend`, no new children until raised |
| tier-3 `subagent_watchdog_warning` in child stream | Ingest as finding (severity mapped), count toward stalemate |

**Verification node plug-ins (`nodes/verify.ts` runners):** `kane` → `kane-cli run "<objective>" --agent --headless [--max-steps N] [--variables …]`, parse NDJSON `run_end {status, final_state, test_url}`, hash `.testmuai/evidence/*.evidence` + per-step screenshots; `--remote --device-name` for cloud devices. `testmu` → MCP tools (`titan_harness__testmu__*` or user config) for HyperExecute jobs, command/network/console logs, SmartUI visual diffs, WCAG. `momentic` → enable catalog entry (`MOMENTIC_CONFIG`, `MOMENTIC_API_KEY`), `momentic_run_step`/`momentic_poll_runner`/`momentic_get_artifacts`, hash `.momentic-mcp/`. `cursor-cloud` → script node with `CURSOR_API_KEY`: `POST https://api.cursor.com/v1/agents` (`repos[].startingRef`), poll `GET /v1/agents/{id}/runs/{runId}` until `FINISHED`, `GET …/artifacts` + `download`, require `result` + artifact hashes. `orca-browser` → `orca browser tab create|goto|snapshot|click|fill|screenshot|eval` driven by sim-user workers. Every runner fails closed: status pass ∧ artifacts exist ∧ hashes recorded, else `unavailable`.

## 6. Data & logging

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| JSONL + canonical SHA-256 chain (K-Dense) | No deps, append-only, crash-safe, greppable, evidence packages are copies, tamper-evident | Queries need scans/indices | **Chosen** |
| SQLite (Archon `~/.archon/archon.db`) | Queries, 16-table precedent | Native module or Node ≥ 24 `node:sqlite`; Archon has no hash layer | Optional derived index (flag `store.sqliteIndex`) |
| Embedded NoSQL (LevelDB/LMDB/NeDB) | Document model | New dependency, weaker tooling, same hashing work | Rejected |

**Layout:** `~/.pi/titan-harness/runs/<projectSlug>/<runId>/{run.json, events.jsonl, ledger.jsonl, provenance.jsonl, notebook.jsonl, agents/<callsign>.json, evidence/<nodeId>/evidence.json, artifacts/nodes/<id>.md(+.meta.json)}`; project-side committable `.titan/{workflows,plans,terraform,presets,personas}`; `.titan/runs.json` index (last 300 runs, like pi-dw). Single writer = host process; children never write the store.

**Schemas.** `run.json`: `{runId, projectSlug, workflow{name, sha256}, level, tier, shape, status pending|running|paused|completed|failed|aborted, currentPhase, phases[], startedAt, endedAt, totals, elevatedFrom?}`. `agents/*.json`: `{agentId, callsign, role, model, thinking{requested, effective}, parent, sessionDir, state, stateHistory[{state, ts, seq}], usage{input, output, cacheRead, cacheWrite, cost}, tps{outputTokens, seconds}}`. `events.jsonl` row: `{seq, ts, runId, agentId?, type, data, prev, hash}` with `hash = sha256(canonicalJson(row − hash))`, `prev` = previous hash, genesis `prev: "0"×64`; `verifyChain()` on read; event types `run.*, phase.*, agent.state, tool.start, tool.end, usage, review.verdict, evidence.captured, watchdog.finding, compaction.*, elevation.*`. `ledger.jsonl`: `{ts, runId, agentId, role, model, provider, thinking, tokens{input, output, cacheRead, cacheWrite}, costUsd, source: observed|estimated|unmetered, origin: run|auditor|watchdog|compaction-inspector|verifier|host}`. `provenance.jsonl`: `{ts, runId, agentId, toolCallId, tool, inputs[], outputs[{path, sha256, size, mtimeMs, change, confidence}]}`.

**Provenance rules:** `observed` = tool named the path and titan hashed bytes after `tool_execution_end`; `inferred` = bash/subagent scan-diff or harvest mtime window; `declared` = model assertion only. Degradations (`unhashed`, `scan-failed`, `truncated`) are explicit rows, never silence. Hashes of runner artifacts are taken on ingest (`identityAt: ingest`).

**Cost ledger:** host turns via existing `before_provider_request → message_end` (`usage.cost.total`), children via JSON `usage` events (existing absorb path), auditors/watchdogs/inspectors/verifiers as titan children → `origin` tagged rows; pi-subagents' own watchdog inside children is unmetered → row `source: unmetered, count: 1` and it is off by default (`subagents.watchdog.children.enabled: false`). Budget checks read the ledger before each spawn.

**Sidebar totals:** token burn = Σ `tokens.input+output` over ledger rows of the run (all origins); cost = Σ `costUsd` (+ `unmetered` count badge); avg tps/agent = mean over agents of `outputTokens / seconds` (tool time excluded, existing `runTps`); completion rate = `done-verified / (done-verified + done-unverified + failed + cancelled + stalemate)`, shown for the run and rolling over the last 20 runs. Rendered as `Σ 1.24M tok · $3.87 · 41 tps/agent · verified 86 % (12/14)`.

## 7. Delivery plan

| Phase | Version | Scope | Files touched | Tests | Acceptance | Effort | Deps |
|---|---|---|---|---|---|---|---|
| P0 prerequisites (operator) | — | `/login openai-codex`; optional `OPENROUTER_API_KEY`; `INFRANODUS_API_KEY` in `~/.config/mcp/mcp.json` or `.env`; keybinding rebind decision; `npm i -g @testmuai/kane-cli`; `orca` on PATH; `CURSOR_API_KEY`; Momentic config if wanted | `~/.pi/agent/auth.json`, `~/.pi/agent/keybindings.json`, `.env` | `titan doctor` (new `/titan-doctor`) reports each | doctor all green or explicit "vacant" | S | — |
| P1 Grok-review gap-fill | 0.2.1 / Grok 1.0.1 | Higgsfield guardrails (Pi + Grok skills, brand-launch-kit step 2, Motion stage); `@higgsfield/cli` note; mcp2cli Python-vs-Rust; named-link docs; `skills/divmagic-raw`; Tokens Studio/Untitled UI/21st.dev mentions; Macro staleness note; `"pi": {"mcp": "./mcp/mcp.json"}` manifest key; `infranodus` catalog entry (`disabled: true` until key); `.env.example` | `skills/*`, `README.md`, `INSTALL.md`, `mcp/{mcp.json,README.md}`, `package.json`, `plugins/triarc-creative-stack/*` | doc greps; `pi -p --no-session "/mcp" </dev/null` shows `titan_harness__*` | catalog auto-loads; Grok plugin synced | S | — |
| P2 Foundation | 0.3.0 | run store + hash chain + ledger + provenance; thinking normalization; shape schema v2 + level shapes + `/titan-level` + hotkeys; totals row; status line | `modules/{run-store,hash-chain,ledger,provenance,thinking,levels}.ts`, `model-stack.ts`, `titan-harness.ts`, `.pi/titan-harness/model-stack-level-*.yaml`, `stack-settings.ts` | `tests/{hash-chain,run-store,ledger,thinking,levels,model-stack}.test.ts` | existing commands write to the store; levels cycle; shift+tab conditional | M | P1 |
| P3 Workflow engine | 0.4.0 | schema, validator, loader, layered scheduler, nodes (ai, command, bash, script, loop, approval, cancel, mcp_tool, workflow), artifacts handoff, structured output v1, hooks, allowed tools, `/workflow run|validate|status|stop|resume|graph`, `child-hooks.ts` | `modules/workflow/*`, `modules/cmd-workflow.ts`, `modules/child-hooks.ts`, `skills/titan-workflow-authoring` | `tests/{workflow-validator,scheduler,structured-output}.test.ts`; fixture workflows | Archon example ports run; validator fixtures all red/green as expected | L | P2 |
| P4 Verification & evidence | 0.5.0 | tiers, evidence schema, `verify` runners (kane, testmu, momentic, cursor-cloud, orca-browser), review-before-report, n-of-3 + elevation, `best_of`, `interleave`, `hypothesis` | `modules/workflow/{tiers,evidence,elevation}.ts`, `nodes/{verify,best-of,interleave,hypothesis}.ts`, `prompts/SYSTEM_PROMPT_VERIFIER.md`, skills updates | `tests/{evidence,elevation}.test.ts`; fixture repo | §3 example ends `done-verified`; seeded defect caught (verifier-of-the-verifier) | L | P3 |
| P5 Watchdog & compaction | 0.6.0 | `watchdog.ts` state machine, compaction handlers, child pre-emption, stalemate, ledgered spend, `/titan-watchdog [status|on|off|model]` | `modules/watchdog.ts`, prompts `SYSTEM_PROMPT_WATCHDOG.md`, `USER_PROMPT_WATCHDOG_COMPACTION.md`, `USER_PROMPT_RESUME.md`, `skills/titan-watchdog` | `tests/watchdog.test.ts` with synthetic event streams | all §5 triggers produce the listed actions | M | P4 |
| P6 Monitor | 0.7.0 | `titan-monitor.mjs` tailer, Orca/tmux split, overlay fallback, pi-dw run adapter, states/colors/rail, `/workflow-monitor` | `scripts/titan-monitor.mjs`, `modules/monitor/*`, `modules/cmd-monitor.ts` | frame snapshot tests | pane shows live run + totals; pi-dw runs appear | M | P2 (MVP rows), P5 |
| P7 Authoring & planning | 0.8.0 | `/create-workflow`, `/ultraplan` + plan mode, personas/mimeographs, InfraNodus ontology stage, structured output v2, `/plan` routing at level 3 | `modules/{cmd-create-workflow,cmd-ultraplan,plan-mode,personas,infranodus}.ts`, `.pi/titan-harness/model-stack-ultraplan.yaml`, `personas/*.md`, prompts, skills `titan-ultraplan`, `infranodus-reasoning-ontology` | `tests/{plan-mode,personas}.test.ts`; headless smoke `pi -p … </dev/null` | fused plan → validated workflow without manual edits | L | P3, P4 |
| P8 Terraform & simulated users | 0.9.0 | `/terraform`, `/local-dev-verify`, `/cloud-simulated-users`, content presets | `modules/{cmd-terraform,cmd-local-dev-verify,cmd-cloud-sim}.ts`, `.titan/workflows/terraform`, skills | fixture site run | terraform docs + `harness_defaults` consumed by level 2; sim-user evidence hashed | L | P7 |
| P9 Triggers, DAG viewer, docs, 1.0 | 1.0.0 / Grok 1.1.0 | `trigger:` jobs (resident-run lock, catch-up latest, skip overlaps; Orca `automations` or pi-subagents timers), `graph.html`, `/workflow export --dw`, README/INSTALL/skills/README refresh, Grok plugin mirror of level table + commands | `modules/workflow/{trigger,graph,export-dw}.ts`, docs, `plugins/triarc-creative-stack` | e2e on fixture | docs match `/titan` index; version pins unchanged | M | P8 |

Version pins stay: pi-dynamic-workflows 3.10.1 (+ `.orig` patch restore step in `INSTALL.md`), pi-subagents 0.67.0, pi-mcp-adapter 2.33.0, pi-exa 0.6.1, pi-antigravity 0.7.2.

## 8. Risks, unknowns, minority positions

| # | Risk | Mitigation |
|---|---|---|
| R1 | Codex OAuth invalid → every gpt-6-astra slot (architect, ultraplan, create-workflow) fails | `fallback:` slots to fable-5.1 xhigh; `cycleShape` skips unauthed; doctor warns; P0 `/login openai-codex` |
| R2 | No OpenRouter key → muse-spark seat vacant | `optional: true`; fusion runs with 4 seats; report notes vacancy |
| R3 | shift+tab reserved; user may refuse rebind | `/titan-level` + `alt+l` guaranteed; conditional binding |
| R4 | Overlay API experimental/TUI-only; no split API | Orca/tmux pane primary; overlay fallback; bar rows always |
| R5 | pi-dw dist patch wiped by updates; no manager hook | keep pin + `.orig` restore; monitor polls run JSON; propose upstream `Symbol.for("pi-dynamic-workflows:manager")` |
| R6 | Level-3 pools (3/5/5/5/10 + watchdogs) → up to ~30 children, cost/time blow-up | pools ≠ concurrency: `max_concurrent_children: 8` default, `budget.usd`, `held-spend`; watchdogs event-driven, idle otherwise |
| R7 | Cross-model transcript replay trips Anthropic's classifier | resume = fresh session + state block, never replay (existing per-slot+model session rule) |
| R8 | Hash chain corruption from concurrent writers | single host writer, `O_APPEND` + fsync, `verifyChain()` on open, `.bak` snapshots like pi-dw |
| R9 | Structured output best-effort on `pi -p` | re-ask ≤ 3, then node error; v2 child-side tool |
| R10 | Kane/Momentic/Cursor/TestMu absent or unauthed → verification impossible | fail closed to `done-unverified`; doctor; `/cloud-simulated-users` setup agent |
| R11 | Watchdog false positives / infinite correction | stalemate at 3, human gate, severity threshold `concern` |
| R12 | Secrets in screenshots/logs; evidence never redacted | redaction pass on ingest (env names only), store 0600, `.titan/runs` git-ignored |
| R13 | Provider rate limits (Cerebras, xAI, Antigravity) under fan-out | per-provider concurrency + backoff; fallback models per role |
| R14 | Child compaction events in `--mode json` unverified | design uses usage-threshold pre-emption; verify JSON stream in P5 spike |
| R15 | Triggered jobs overlap / missed slots | resident-run lock, `catchUp: latest`, skip overlaps (K-Dense) |

**Operator must decide/provide:** Codex re-login; `OPENROUTER_API_KEY` (muse-spark); `INFRANODUS_API_KEY` (trial expires in 14 days); keybinding rebind (`alt+t` for thinking) or accept `alt+l`; store choice (JSONL chain recommended vs SQLite index); run-store location (`~/.pi/titan-harness/runs` recommended vs project `.titan/runs`); default `max_concurrent_children` (8) and `budget.usd`; Kane install + TestMu/Cursor credentials; Orca vs tmux pane; whether pi-subagents' child watchdog stays off; level-2 worker thinking (high assumed).

**Disagreements with the brief:** (1) "NoSQL database" → DB-free hash-chained JSONL is better for a Pi package; NoSQL adds a dependency for no query need. (2) "xhigh" for gemini-3.8-flash/qwen-3.8-27b is impossible; plan reports requested/effective everywhere. (3) "/create-workflow" is not a pi-dw feature and workflows are YAML in titan, not pi-dw JS. (4) "pops up a side terminal" is only achievable through Orca/tmux; in-process it is an overlay. (5) "switch to the architect's model and resume" is kept, but as a fresh session with a state block, not a transcript hand-over. (6) Fan-out defaults are treated as pool sizes with a concurrency cap, not simultaneous children. (7) Visual DAG builder is a read-only viewer; YAML stays the source of truth. (8) Content tier "3× human review" cannot be automated — implemented as three approval receipts per preset. (9) Watchdog "1 per fan-out" is honored as capacity, but reviewers are spawned on triggers, not kept resident.

## 9. Requirements trace

| Brief item | Plan sections | Status |
|---|---|---|
| G1 Macro stale on Higgsfield; prefer packs/vendor docs | §2 G1–G8, §7 P1 | full |
| G2 mcp2cli Python vs Rust | §2 G1–G8, §7 P1 | full |
| G3 Higgsfield guardrails (both skills + combos) | §2 G1–G8, §7 P1 | full |
| G4 Named links documented not installed | §2 G1–G8, §7 P0/P1 | full |
| G5 Macro has no titan docs | §7 P1/P9 (Grok plugin sync) | full |
| G6 Verdict B gap-fill, no mega-CLI, no Fusion Drive merge | §1 D1/D12, §7 | full |
| G7 Ship list / pins | §7 (pins unchanged) | full |
| G8 Add-now list (guardrails, cli note, disambiguation, named links, DivMagic, Tokens Studio/Untitled UI/21st.dev) | §2 G1–G8, §7 P1 | full |
| G9 Leave-out list | §1 (nothing added from it) | full |
| H1 Sidebar totals | §2 F1, §6 | full |
| H2 `/create-workflow` clean context + statusline | §2 F2, §4 hotkeys (status), §7 P7 | full |
| H3 Verification tiers × modes (6 tiers) | §2 F3a–f, §3 example, §5 | full (content tier's human review is approval-based) |
| H4 `/workflow-monitor` states/colors/rail | §2 F4, §5 states, §6, §7 P6 | full (side terminal via Orca/tmux, overlay fallback) |
| H5 Watchdog incl. compaction + 4 triggers | §2 F5, §5 state machine, §7 P5 | full (child compaction event unverified → usage threshold) |
| H6 `/ultraplan` skill until user exits plan mode | §2 F6, §4 ultraplan shape, §7 P7 | full |
| H7 `/terraform` | §2 F7, §7 P8 | full |
| H8 Fusion team roster + workflow-architect + elevation defaults | §2 F6, §4, §5 ladder | full (muse-spark seat vacant without key) |
| H9 `/local-dev-verify` | §2 F8, §5 runners, §7 P8 | full |
| H10 `/cloud-simulated-users` | §2 F9, §5 runners, §7 P8 | full |
| H11 shift+tab levels 0–3 + fan-out defaults | §2 F10, §4 shapes/hotkeys, §1 D5 | full (shift+tab conditional on rebind) |
| H12 Grok subagents analyze Archon/K-Dense | CONTEXT analyst reports (done) | full |
| H13.1 System prompt override | §2 A1 | full |
| H13.2 Structured output | §2 A2, §1 D10 | partial in v1 (best-effort), full with v2 tool |
| H13.3 NoSQL + hashed logs | §2 A3, §6, §1 D3 | full (hashed), NoSQL replaced by JSONL by recommendation |
| H13.4 Best-of-n | §2 A4 | full |
| H13.5 Visual DAG builder + authoring skill | §2 A5, §7 P9 | partial (viewer, not editor) |
| H13.6 YAML validator | §2 A6, §3 rules | full |
| H13.7 Hooks | §2 A7 | full (static responses, child-side) |
| H13.8 Lateral pass | §2 A8, §5 | full |
| H13.9 Subagent tools y/n | §2 A9 | full |
| H13.10 Interleaved reasoning + re-authoring | §2 A10 | full |
| H13.11 Hypothesis workflow | §2 A11 | full |
| H13.12 Personas + mimeographs | §2 A12 | full |
| H13.13 InfraNodus MCP local dependency | §2 A13, §1 D12, §7 P1/P7 | full (catalog + nodes; key required) |
| InfraNodus gaps 1–3 | §3 `trigger.entity_profile` + terraform `harness_defaults` (gap 1); §5 ladder ↔ levels (gap 2); §5 review inputs from store (gap 3) | full |
