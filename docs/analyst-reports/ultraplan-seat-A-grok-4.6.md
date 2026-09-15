The rest of the operator brief was truncated; I’ll read only that missing slice, then write the full integration plan in one message with no further tool use.# titan-harness ultraplan (v0.2.0 → 0.3.0…0.8.0)

Plan only. Verdict B: gap-fill inside `ahuserious/titan-harness`. No mega-CLI. No Fusion Drive merge. InfraNodus is catalog/MCP, not native code. `@quintinshaw/pi-dynamic-workflows` stays **3.10.1**.

---

## 1. Architecture decision summary

- **Source of truth is a titan YAML DAG**, not pi-dynamic-workflows JS. Archon is a documented spec with no engine here; titan already has `yaml`, `collaboration-graph.ts`, `child-runner.ts`, and stack YAML. pi-dw 3.10.1 is JS-in-JSON envelopes, has **no YAML schema and no `/create-workflow`**.
- **Do not compile-to-pi-dw as the runtime.** Optional one-way export later. Runtime is titan `pi --mode json -p` children (`TITAN_HARNESS_CHILD=1`), which **do** load host extensions (providers, pi-exa, pi-mcp-adapter). In-process pi-dw stays for existing `/workflows` builtins only.
- **`/workflow-monitor` is an in-process Pi overlay**, not an Orca/tmux split. Pi 0.85.1 has no sidebar/split/pane API. Primary: `ctx.ui.custom(..., {overlay:true, overlayOptions:{anchor:"right-center"}})` + `handle.unfocus({target: editor})`. Totals also extend the existing belowEditor model bar (`titan-harness.ts` `renderFooterWidget`). Orca `terminal split` is an **optional** twin, never required.
- **Hashed logs = K-Dense pattern: append-only JSONL + canonical SHA-256 chain.** Reject SQLite (Archon) and embedded NoSQL. No new DB dependency; titan already SHA-256-ACKs fusion writes; provenance must be observation-derived.
- **Watchdog is a titan module**, not pi-subagents 0.67. That watchdog is diff-gated, stalemate-capable, **no `session_before_compact`**, **no cross-session/on-demand API**, and **does not cover titan `pi -p` children**. Reuse its *finding card* shape (`subagent_watchdog_warning` fields) and stalemate identity. Enable `subagents.watchdog` only for hosted Pi sessions as a bonus.
- **`shift+tab` is not bindable until the user rebinds `app.thinking.cycle`.** Document `~/.pi/agent/keybindings.json` → `"app.thinking.cycle": "alt+t"` then `/reload`. Titan binds **`shift+tab` + `alt+l`** to cycle harness levels 0–3. Existing `ctrl+tab` / `alt+h` keep cycling **shapes**.
- **Plan mode is a titan overlay copied from `PI/examples/extensions/plan-mode/`.** Pi has none. `/ultraplan` enters it (write/edit denied via `tool_call` block + `setActiveTools`). Exit hands a fused brief to a **clean-context workflow-architect**.
- **`/create-workflow` is a titan command**, not a pi-dw patch. It forks a **fresh architect session** (`newSession` / child with `--no-context-files`, org/repo files injected as artifacts only). Default model `openai-codex/gpt-6-astra` thinking **requested xhigh**.
- **Thinking is always stored as `{requested, effective, reason}`.** `gemini-3.8-flash` and `cerebras/qwen-3.8-27b` **xhigh → effective high**. TUI shows both. Never claim xhigh landed if the provider map is null.
- **Roles stay titan’s:** ARCHITECT ◆ never writes files; BUILDER ▲; FUSION ⧉; VALIDATOR ✓; AUDITOR ⚖ ephemeral cross-family; new **WATCHDOG 🐕** and **VERIFIER ⌕/✓** as named slots, not writers. Callsigns only when `anonymize: true`.
- **Fan-out knobs split.** Today `builderFanOut` is 1–4 and one value is mirrored to three files. Levels need builders 5, Exa 10, watchdogs/verifiers **not** jammed into `builderFanOut`. New keys; `/stack` remains the single writer (last-write-wins documented).
- **Verification nodes are YAML node types that shell out to existing CLIs/MCPs** (Kane, TestMu MCP, Momentic if enabled, Cursor REST, Orca browser). No Kane-as-MCP. No new test runner.
- **InfraNodus enters as `mcp/mcp.json` + `"pi": { "mcp": "./mcp/mcp.json" }`.** Namespaced `titan_harness__infranodus`. Ontology/gap stages are prompt+MCP nodes, not TypeScript graph code.
- **Elevation and entity context close InfraNodus gaps:** level-2 trigger jobs read `/terraform` artifacts before picking models/fan-out; n-of-3 failures bump thinking → model → **re-author at a higher harness level / tighter phases**; watchdog/reviewers read the **same ledger** as the TUI (compaction `retainedTail` + evidence JSONL).
- **Degrade missing auth, do not crash the shape.** Codex OAuth is INVALID; no OpenRouter key; no `INFRANODUS_API_KEY` in Pi env. Level-3 / ultraplan slots that cannot authenticate are skipped with a notify, and the fusion team runs with remaining seats.

---

## 2. Feature-by-feature integration table

Thinking column = **requested → effective** after `thinking-normalize.ts`. Codex/OpenRouter seats are **blocked until operator login/key**.

| Item | Design | Where it lives | Reuse vs build | Model / thinking | Acceptance |
|---|---|---|---|---|---|
| **Sidebar totals** | First model-bar row + overlay header: Σ tokens, $ cost, avg tps/agent, completion rate (verified-done / launched). 1 Hz with existing footer timer. | `titan-harness.ts` `renderFooterWidget`; `modules/tui.ts`; `modules/ledger.ts`; optional pi-dw `twoPaneHeader` patch **kept but not relied on** | Reuse slotPerf + child `absorbedRuns`; **build** ledger aggregation | n/a (observed usage) | With 2 builders + 1 auditor child, numbers match `costs.jsonl` ±1% and survive `/new` reset |
| **`/create-workflow` clean-context** | New command. Enters architect-only child: `--no-skills --no-context-files`, injects `vision.md`/`intent.md`/terraform pack as `--append-system-prompt` paths. Writes YAML under `~/.pi/titan-harness/workflows/` + optional `<cwd>/.pi/titan/workflows/`. Statusline shows live harness. Default bumps reasoning. | `extensions/titan-harness/modules/cmd-create-workflow.ts`; skill `skills/titan-create-workflow/SKILL.md`; prompts `prompts/SYSTEM_PROMPT_WORKFLOW_ARCHITECT.md` | Reuse `child-runner.ts`, `setStatus`; **build** command + schema emit | Default `openai-codex/gpt-6-astra` **xhigh→xhigh** (needs `/login openai-codex`). Fallback chain: `anthropic/claude-fable-5-1` xhigh → `xai/grok-4.6` xhigh | Command exists; child session has no prior transcript; YAML passes validator; statusline shows shape+level+models |
| **Verification tiers × modes** | Workflow `tier:` enum drives required evidence + node templates. Modes: spec-match, design-match, test-depth. Device matrix for proto/prod. | `modules/verification-policy.ts`; `workflows/templates/*.yaml`; skill `skills/titan-orchestration` | Reuse audit gate; **build** policy table + templates | Architect per harness level; auditors cross-family auto | Each tier template validates; missing evidence ⇒ `done-unverified`, never `done-verified` |
| — web scraping / general | Spec verification; **DB-op success** is the hard gate (hashed write + query round-trip). | template `web-general.yaml` | bash/script nodes + evidence hash | workers `cerebras/qwen-3.8-27b` **high→high** | Node fails if DB hash missing |
| — research / planning | Verify vs org/repo + `vision.md`/`intent.md` (warn if `/terraform` not run). | template `research-planning.yaml`; InfraNodus ontology node | MCP + read-only children | architect per level | Report cites hashed docs; terraform-missing banner |
| — prototyping / data analytics | Spec + TDD; Cursor cloud SWE + test-authoring agent; **separate auditor** loops findings to architect; **new workflow on fail-3**. Screenshots+logs hard evidence; mobile+desktop suites. | template `proto-analytics.yaml` (example in §3) | Kane/Cursor/Orca nodes + audit.ts | see §3 | Auditor is different family; n-of-3 then re-author fires |
| — production SWE / automations | Same as proto, heavier sim-user flows. | `prod-swe.yaml` | + `/cloud-simulated-users` | lvl3 defaults | Sim-user evidence required |
| — platform update | **Only sim-user-tested functions ship.** Untested paths = cancel node. | `platform-update.yaml` | fail-closed `when:` | lvl3 + verifiers grok xhigh | Validator rejects ship node without sim-user PASS |
| — content creation | 3× human `approval` per content-type preset, then agent review, then ship. | `content-creation.yaml` | Archon `approval` | fuser `fable-5.1` xhigh | <3 approvals ⇒ cannot reach ship |
| **`/workflow-monitor`** | Unfocused right overlay: agents with callsigns (not models if anonymize), color dots, phase rail from `meta.phases`/`nodes` layers. States below. Optional `orca terminal split` clone. | `modules/monitor.ts`; command `/workflow-monitor`; `Symbol.for("titan-harness:monitor")` | Reuse K-Dense/Grok glyph language; **build** overlay. Poll `~/.pi/workflows/projects/*/runs/*.json` **and** titan run JSONL | n/a | Overlay stays visible while editor focused; states match ledger; works `ctx.mode==="tui"` only |
| Monitor states + colors | `queued` #64748b · `dispatched-working` #2563eb · `waiting-supervisor` #7c3aed · `in-review` #d97706 · `edit-round-n` #ea580c · `stalemate` #dc2626 · `harvesting` #0891b2 · `done-verified` #16a34a · `done-unverified` #ca8a04 · `authoring-workflow` #9333ea · `repairing-workflow` #e11d48 · `compacting` #4f46e5 · `held-spend` #78716c · `blocked-guard` #c026d3 · `system-run` #0d9488 · `failed` #991b1b · `cancelled` #6b7280 · `uncertain-launch` #92400e | `modules/runtime.ts` AgentRun status enum (extend) | Reuse runtime AgentRun; **extend** statuses | n/a | Never collapse unverified→verified; stalemate ≠ in-review |
| **Watchdog (incl. compaction)** | Titan `session_before_compact` / `session_compact` handlers on **host + each child JSON stream**. On compact: halt target, inspect summary vs ledger/evidence for hallucination/loss; then (a) custom compaction `{compaction:{summary, firstKeptEntryId, tokensBefore}}` from artifacts, or (b) cancel overflow compact if inspect fails and `willRetry`, or (c) resume child via `sessionRef` with architect-model rewrite of resume prompt. Also: workflow complete w/o review; worker ping architect w/o review; agent stop w/o review; review PASS with no architect handback. | `modules/watchdog.ts`; hook in `titan-harness.ts`; `prompts/SYSTEM_PROMPT_WATCHDOG.md`; settings `subagents.watchdog` **not** the only path | Reuse finding fields + stalemateRepeats=3; **build** before-compact + titan-child coverage + cost ledger | default `cerebras/qwen-3.8-27b` **medium→medium**; resume-rewrite uses **architect’s model** | Compaction of a builder with a file edit fires inspect; missing review blocks `done-verified`; watchdog $ appears in ledger |
| **`/ultraplan`** | Titan plan-mode + fusion team (grill-with-docs frontier rounds) until user exits or `[DONE]`. Then workflow-architect `/create-workflow` with harness shape + test constraints. | `modules/plan-mode.ts`; `cmd-ultraplan.ts`; skill `skills/titan-ultraplan/SKILL.md`; reuse `/titan-fusion` + `/titan-debate` | Reuse fusion/debate/anonymize; **build** plan-mode copy + fusion roster | architect `openai-codex/gpt-6-astra` xhigh→xhigh; fusion-1 `anthropic/claude-fable-5-1` xhigh; fusion-2 `xai/grok-4.6` xhigh; fusion-3 `antigravity/gemini-3.8-flash` **xhigh→high**; fusion-4 `openrouter/meta/muse-spark-1.3` **max** (needs key); judge `gemini-3.8-flash` **xhigh→high**; fuser `fable-5.1` xhigh | Plan blocks writes; fused YAML emitted only after exit; missing seats skipped with notify |
| **`/terraform`** | Originalize wayfinder: map Destination / Decisions / Fog / Out of scope + domain/org/audience/platform/infra/talent/financials/intent/vision/bias. Triggers ultraplan fusion, writes `intent.md` `vision.md` `CONTEXT.md` `docs/adr/`, optional InfraNodus ontology, optional automations that enqueue workflow authoring. | skill `skills/titan-terraform/SKILL.md`; template `terraform.yaml`; artifacts under `<cwd>/.pi/titan/terraform/` | Reuse grill/wayfinder structure; **build** skill + workflow | same fusion team as ultraplan | After run, hashed terraform pack exists; lvl3 without it shows notify |
| **`/local-dev-verify`** | Originalize prototype: deploy local app/sim-infra; cerebras workers scan, screenshot, optional video, snapshot logs, report to architect. | skill `skills/titan-local-dev-verify/SKILL.md`; verify nodes `orca` + Kane `--headless` | Reuse kane-cli-browser-runs, Orca browser; **build** skill + artifact ingest | workers `cerebras/qwen-3.8-27b` **high→high** (brief xhigh→**high**) | Evidence pack has screenshot hashes + Kane `.evidence` path or Orca screenshot files |
| **`/cloud-simulated-users`** | Orchestrate remote sim-users; if provider missing, spawn helper skill to install MCP/CLI. Stream to monitor; teach workflow-architect the remote contract. | skill `skills/titan-cloud-sim-users/SKILL.md`; Cursor REST helper `scripts/cursor-agent.mjs`; TestMu/Kane remote | Reuse testmu-cloud-testing, kane-cli; **build** Cursor client + connect-helper | verifiers `xai/grok-4.6` xhigh; workers gemini high | `POST /v1/agents` (or Kane `--remote`) artifacts land in evidence; monitor shows `dispatched-working` |
| **shift+tab levels 0–3** | Cycle `harnessLevel`, load `model-stack-lvl{N}-*.yaml`, write settings, `announce()`, fire `titan-harness:shape-changed`. Fan-out per §4. | `modules/levels.ts`; shapes `model-stack-lvl0-ultrafast.yaml` … `lvl3-swe.yaml`; keybindings docs | Reuse cycleShape/skip-unauthed; **build** level map + range expansion | see §4 | After rebind, shift+tab and alt+l cycle 0→3; without rebind, only alt+l; TUI shows requested/effective |
| **Grok-review gap-fill** | Verdict B ship list; see P1. | `mcp/mcp.json`, `package.json` `pi.mcp`, skills, `mcp/README.md`, `skills/README.md`, Grok plugin mirror | Edit in place | n/a | Catalog auto-loads; skills contain guardrails/disambiguation; Grok plugin files match |
| — Higgsfield MCP | Keep `https://mcp.higgsfield.ai/mcp` enabled; **not** Macro first-party API. | `mcp/mcp.json` `higgsfield` | reuse | n/a | Server listed enabled |
| — Higgsfield guardrails | Both Pi + Grok `higgsfield-media` skills: no OpenRouter video; Framer heroes **5–8s looping**; same in `brand-launch-kit` step 2 + `triarc-creative-stack` Motion. | `skills/higgsfield-media/SKILL.md`; Grok plugin copy | edit | n/a | Skills grep-clean of forbidden vendors; loop duration stated |
| — mcp2cli Python vs Rust | Pi/titan = Python `knowsuchagency/mcp2cli` via `uvx`; Grok = Rust `mcp2cli link create`. Never one tool. | `skills/mcp-cli-bridges/SKILL.md`; Grok `/mcp-cli-setup` | edit | n/a | Both docs name both binaries |
| — Named links | Document Kane, `npx @framer/agent`, `@higgsfield/cli` **not on PATH**; install notes only. | `INSTALL.md`, `mcp/README.md` | edit | n/a | INSTALL lists PATH gaps |
| — DivMagic RAW | Short skill: Chrome extension, **not MCP**. | `skills/divmagic-raw/SKILL.md` | **build** | n/a | Skill exists; says not MCP |
| — Tokens Studio / Untitled UI / 21st.dev | Mentions in design-to-code / shadcn skill “later ops pack, not this plugin”. | `skills/design-to-code-pipeline/SKILL.md` | edit | n/a | Named once; Fiber/Jinko/Exa-on-Grok/Tailscale **out of plugin** |
| — Pins / enable-disable | Keep pins: pi-mcp-adapter 2.33.0, pi-dw **3.10.1**, pi-subagents 0.67.0, pi-exa 0.6.1, pi-antigravity 0.7.2, `@raindrop-ai/pi-agent` 0.2.1, `@signalridge/pi-codex-compact` 1.3.1. MCP enable higgsfield, shadcn, relume, brandfetch, figma, macro, testmu; **disable** momentic, figma-desktop, framer-mcp-plugin. | README + `mcp/mcp.json` `disabled: true` | reuse | n/a | File matches ship list |
| — Leave-outs | No mega-CLI, no Fusion Drive merge, no neuro-quant dump, no Kane-as-MCP, no Higgsfield 27–35 marketing skills, no OpenRouter video servers, no Grok Imagine as pack MCP. | README “Non-goals” | edit | n/a | Non-goals section present |
| **Archon 1 — system prompt override** | Keep slot `system_prompt` / `append_system_prompt`; add per-node `systemPrompt` + `systemPromptMode: append\|replace`. | `model-stack.ts`, workflow schema, `child-runner.ts` flags | **reuse** + schema field | per node | Missing path still hard error; replace mode omits default role prompt |
| **Archon 2 — structured output** | Node `output_format` JSON Schema. Titan children: terminating parse in `prompt-library.ts` (retry ≤3, pi-dw/Archon-Pi style). Not provider `response_format`. | `modules/structured-output.ts` | reuse parsers; **build** schema retry | same as node | Invalid JSON ⇒ retry then node fail; `$id.output.field` works in `when:` |
| **Archon 3 — hashed logs (NoSQL ask)** | JSONL+SHA-256 chain, **not** NoSQL. | `modules/ledger.ts`, `modules/provenance.ts` | **build** on K-Dense rules | n/a | Chain verifies with `scripts/verify-ledger.ts` |
| **Archon 4 — best-of-n** | YAML pattern: parallel prompt nodes + `judge` node (port fusion-drive `best-of-n.js` idea, **do not import that repo**). Also `/titan-debate --rounds`. | `cmd-fusion.ts` + template `best-of-n.yaml` | transliterate, don’t merge | judge gemini **xhigh→high**; n=2–8 default 4 | Collapse of identical candidates fail-closed |
| **Archon 5 — visual DAG + authoring skill** | Overlay ASCII/box DAG from `depends_on` (Cole/Archon DIY + Grok phase rail). No React Flow. Authoring = `/create-workflow` skill. | `modules/monitor.ts` dag view; skill above | **build** TUI dag | workflow-architect | Overlay shows nodes+edges+status; click-to-edit deferred |
| **Archon 6 — YAML validator** | Port Archon load-time rules + titan slot rules + thinking normalize + evidence policy. CLI `bun run validate-workflow <file>`. | `modules/workflow-validator.ts`; `extensions/titan-harness/tests/workflow-validator.test.ts` | **build** from Archon rules | n/a | Cycles, missing deps, two kinds/node, xhigh-on-qwen (warn+normalize) all covered |
| **Archon 7 — hooks** | Archon Claude hooks **do not run on Pi**. Map: `allowed_tools`/`denied_tools` → child `--tools`; `PreToolUse deny` → Pi `tool_call` `{block,reason}`; `PreCompact` → `session_before_compact`. | `titan-harness.ts` tool_call; watchdog | **build** mapper; ignore Claude-only YAML with warning | n/a | Write on architect node blocked; compact hook fires |
| **Archon 8 — lateral pass / clean context** | `context: fresh` (default parallel) = new `--session-dir`; handoff **only** via hashed artifacts (`nodes/<id>.md` + `.meta.json`). `shared` = `--fork` / `--session`. | `child-runner.ts` SpawnIdentity | **reuse** sessions keyed slot+model | n/a | Fresh child transcript starts empty except system+artifact paths |
| **Archon 9 — subagent tools y/n** | Already `subagentTools`, `childSubagents` all\|builders\|off, `childToolsFor()`. Surface on YAML `allowed_tools` / `denied_tools` / `agents.*.tools`. | `stack-config.ts` | **reuse** | n/a | `subagent` absent when fan-out 0 or tools off |
| **Archon 10 — interleaved reasoning** | Parallel fresh children on segregated slices → synthesize → optional `repairing-workflow` re-author. Not true token-interleave. | template + `/titan-collaborate` DAG | reuse collaborate; **build** reauthor trigger | mix of builders | Synthesize node sees N artifacts, not N transcripts |
| **Archon 11 — hypothesis workflow** | Node field `hypothesis:{id,claim,predicts}` + evidence links `supports\|challenges\|inconclusive\|context` in JSONL. Classify→route via `when:`. | `modules/hypothesis.ts`; notebook-like JSONL | **build** (K-Dense data model, no engine copy) | research tier | Hypothesis without evidence cannot `done-verified` |
| **Archon 12 — personas + mimeographs** | Persona files `prompts/personas/*.md` + `mimeograph:` overlay (style/bias instructions) so same model diverges. Callsigns stay the public name. | `prompt-library.ts`; `prompts/personas/` | **build** overlays; reuse callsigns | any | Two mimeographs on same model produce different system prompts (hash differs) |
| **Archon 13 — InfraNodus** | Catalog stdio `npx -y infranodus-mcp-server` env `INFRANODUS_API_KEY`; optional local `node …/mcp-server-infranodus/dist/index.js`. Workflow nodes call `generate_ontology_graph` → `generate_contextual_hint` prepend; `optimize_reasoning` post-plan; `generate_content_gaps` seeds hypotheses. | `mcp/mcp.json`; terraform/research templates | **reuse** vendor MCP; no native graph code | ontology node can be gemini high | Adapter registers `titan_harness__infranodus`; missing key ⇒ node `uncertain-launch` not crash |

---

## 3. YAML workflow schema proposal

**File:** `extensions/titan-harness/schema/workflow.v1.yaml` (JSON Schema generated in `workflow-schema.ts`).  
**On disk:** `~/.pi/titan-harness/workflows/<name>.yaml` and/or `<cwd>/.pi/titan/workflows/`.  
**Engine:** `modules/workflow-engine.ts` (titan children + bash/script). Archon-compatible **subset** so files remain readable by a future Archon Pi adapter.

### Node types (exactly one discriminator)

`command` | `prompt` | `bash` | `script` | `loop` | `approval` | `cancel`  
Titan-only (validator allows; Archon would warn): `verify` | `review` | `mcp_hint` (documentation only — actual MCP is tools on a prompt node).

### Base fields (all nodes)

`id` (unique, `/^[A-Za-z0-9_-]{1,64}$/`) · `depends_on[]` · `when` · `trigger_rule` (`all_success` default \| `one_success` \| `none_failed_min_one_success` \| `all_done`) · `idle_timeout` (ms, default 300000) · `retry` (forbidden on `loop`)

AI nodes also: `model` (`provider/id`) · `thinking` · `context` (`fresh`\|`shared`\|`{resume: node-id}`) · `output_format` · `allowed_tools` · `denied_tools` · `systemPrompt` · `systemPromptMode` · `maxBudgetUsd`

### Titan extensions (optional on any AI node; workflow-level defaults inherit)

| Field | Meaning |
|---|---|
| `role` | `architect` \| `builder` \| `worker` \| `auditor` \| `watchdog` \| `verifier` \| `fuser` \| `judge` |
| `callsign` | `/^[A-Za-z0-9_-]{1,16}$/` (rune/forge/…/ward) |
| `persona` | key into `prompts/personas/` |
| `mimeograph` | overlay id |
| `tier` | workflow verification tier name |
| `verification_tier` | `spec` \| `design` \| `test` \| `sim-user` \| `human` |
| `evidence` | list of required kinds (see §5) |
| `hypothesis` | `{id, claim, predicts}` |
| `elevation` | override ladder |
| `watchdog` | `{policy: inherit\|off\|strict, model, thinking}` |
| `isolation` | `none` \| `worktree` |
| `anonymize` | bool |

Workflow header: `apiVersion: titan.harness/v1` · `name` · `description` · `tier` · `harness_level` · `phases[]` · `fan_out` · `elevation` · `watchdog` · `returns` (node id).

### Validator rules

Archon load-time **plus**: unique ids; acyclic `depends_on`; `$id.output` only to known ids; exactly one discriminator; `script.runtime` bun\|uv; named scripts exist; `approval.message` non-empty; `cancel.reason` non-empty; **exactly one architect-role writer-lease owner and it must not have write tools**; auditor `modelFamily` ≠ builder/architect when `auditorModel: auto`; thinking normalized (warn); unauthenticated `provider/id` → problem list (same as `cycleShape` skip); evidence kinds must be in the enum; `tier: platform-update` ship nodes require a `verify` sim-user ancestor; fan-out ≤ 16; `builderFanOut` 1–8 after range bump.

### Example (~60 lines) — prototyping / data analytics

```yaml
apiVersion: titan.harness/v1
kind: Workflow
name: proto-analytics
description: Spec+TDD prototype; Cursor+Kane evidence; separate auditor; n-of-3 then re-author
tier: prototyping-data-analytics
harness_level: 3
phases:
  - { title: Spec, detail: acceptance from vision/intent/spec }
  - { title: Build, detail: TDD at seams }
  - { title: Verify, detail: Cursor cloud + Kane desktop/mobile }
  - { title: Audit, detail: cross-family auditor; loop or re-author }
fan_out: { builders: 3, workers: 5, watchdogs: 5, verifiers: 5, exa: 10 }
elevation:
  fail_1: { thinking_bump: 1 }
  fail_2: { thinking: max, builder_model: max }
  fail_3: { reauthor: true, tighter_phases: true, smaller_ctx: true }
watchdog:
  on: [compaction, complete-without-review, ping-without-review, stop-without-review, review-orphaned]
  model: cerebras/qwen-3.8-27b
  thinking: medium
nodes:
  - id: spec
    prompt: |
      Read .pi/titan/terraform/{vision,intent}.md and the user spec.
      Emit acceptance stories with device matrix.
    role: architect
    callsign: rune
    context: fresh
    allowed_tools: [read, grep, find, ls]
    output_format:
      type: object
      properties: { stories: { type: array, items: { type: string } } }
      required: [stories]
    evidence: [spec-hash]
  - id: tdd-author
    prompt: "Author failing tests for $spec.output.stories. No prod code."
    depends_on: [spec]
    role: builder
    callsign: mason
    verification_tier: test
    evidence: [test-log]
  - id: implement
    prompt: "Make tests pass at agreed seams. Do not expand scope."
    depends_on: [tdd-author]
    role: builder
    callsign: forge
    evidence: [git-diff, test-log]
  - id: cursor-swe
    verify: cursor-cloud
    depends_on: [implement]
    role: verifier
    callsign: sentinel
    evidence: [cursor-run, screenshot]
  - id: kane-desktop
    bash: kane-cli run "exercise primary user flow" --agent --headless
    depends_on: [implement]
    evidence: [kane-evidence, screenshot, console-log]
  - id: kane-mobile
    bash: kane-cli testrun run --remote --device-name "Pixel 7" --tags smoke
    depends_on: [implement]
    evidence: [kane-evidence, screenshot]
  - id: audit
    review: ephemeral-auditor
    depends_on: [cursor-swe, kane-desktop, kane-mobile]
    trigger_rule: all_success
    role: auditor
    callsign: ward
    context: fresh
    evidence: [audit-verdict]
  - id: reauthor
    cancel: "n-of-3 exhausted — architect must /create-workflow"
    depends_on: [audit]
    when: "$audit.output.status == 'AUDIT_EXHAUSTED'"
```

---

## 4. Harness levels & shapes

**Dir:** `~/.pi/titan-harness/` (also ship templates in `shapes/`). Codename = filename minus `model-stack-`.  
**Settings:** `~/.pi/agent/titan-harness.json` add `harnessLevel: 0|1|2|3` (default 1), `watchdogFanOut`, `verifierFanOut`, `exaFanOut`; **raise `builderFanOut` max from 4 → 8**. `/stack` remains the only writer to: `titan-harness.json`, Pi `settings.json` `subagents.{defaultModel,defaultProvider,defaultThinking}`, `~/.pi/workflows/settings.json` `defaultConcurrency` (cap 16) / `excludeSubagentTools`, `~/.pi/agent/extensions/subagent/config.json` `globalConcurrencyLimit`.

Watchdogs are **not** counted in the user-facing “fan-out” number used for builders/workers; they still have their own count.

### Level 0 — ultrafast — `model-stack-lvl0-ultrafast.yaml`

```yaml
- name: rune
  architect: true
  model: cerebras/qwen-3.8-27b
  thinking: xhigh   # requested xhigh → effective high
  color: "#64748b"
  system_prompt: prompts/SYSTEM_PROMPT_ARCHITECT.md
- name: forge
  primary: true
  model: cerebras/qwen-3.8-27b
  thinking: high
  system_prompt: prompts/SYSTEM_PROMPT_BUILDER.md
# workers: n × qwen-3.8-27b high via subagentModel; Exa on
# fan-out default: workers 5 / exa 5; builders 1 (host primary); watchdogs 0; verifiers 0
```

### Level 1 — brain + ultrafast workers — `model-stack-lvl1-brain.yaml`

```yaml
- name: rune
  architect: true
  model: antigravity/gemini-3.8-flash
  thinking: high
  system_prompt: prompts/SYSTEM_PROMPT_ARCHITECT.md
- name: forge
  primary: true
  model: cerebras/qwen-3.8-27b
  thinking: high
  system_prompt: prompts/SYSTEM_PROMPT_BUILDER.md
# workers qwen-3.8-27b high; Exa on; default 5/5
```

### Level 2 — triggered ops / research / entity-aware — `model-stack-lvl2-ops.yaml`

```yaml
- name: rune
  architect: true
  model: openai-codex/gpt-6-astra
  thinking: high
  system_prompt: prompts/SYSTEM_PROMPT_ARCHITECT.md
- name: forge
  primary: true
  model: xai/grok-4.6
  thinking: xhigh
  system_prompt: prompts/SYSTEM_PROMPT_BUILDER.md
# n builders grok-4.6 xhigh (fan-out 5); n workers gemini-3.8-flash high (5);
# n watchdogs qwen-3.8-27b medium, 1 per fan-out unit, not in builder/worker count (5);
# Exa on, 5. On trigger: architect MUST /create-workflow with verification+recovery.
# Fan-out/model pick reads terraform pack when present (closes High Performance ↔ Decision Analysis gap).
```

Unauthed Astra: skip rune → fallback `anthropic/claude-fable-5-1` high, notify.

### Level 3 — SWE / architecture — `model-stack-lvl3-swe.yaml`

```yaml
- name: rune
  architect: true
  model: openai-codex/gpt-6-astra
  thinking: xhigh
  system_prompt: prompts/SYSTEM_PROMPT_ARCHITECT.md
- name: forge
  primary: true
  model: anthropic/claude-fable-5-1
  thinking: high
  system_prompt: prompts/SYSTEM_PROMPT_BUILDER.md
- name: anvil
  model: anthropic/claude-fable-5-1
  thinking: high
  system_prompt: prompts/SYSTEM_PROMPT_BUILDER.md
- name: mason
  model: anthropic/claude-fable-5-1
  thinking: high
  system_prompt: prompts/SYSTEM_PROMPT_BUILDER.md
# n builders fable-5.1 high default 3; n workers gemini-3.8-flash high default 5;
# n watchdogs qwen-3.8-27b medium default 5; n verifiers xai/grok-4.6 xhigh default 5;
# n Exa agents default 10.
# Alternate listing (document as stack-settings override, not a second file):
#   workers / db-ops / findings-curation = xai/grok-4.6 high
# TUI: plan defaults to /ultraplan. If terraform pack missing, notify "run /terraform".
```

**Live default shape on this machine stays `consult` until the user cycles a level** (do not silently replace).

### Requested → effective thinking

| Model id | Requested xhigh | Effective | Reason |
|---|---|---|---|
| `xai/grok-4.6` | xhigh | **xhigh** | provider map |
| `openai-codex/gpt-6-astra` | xhigh | **xhigh** (auth INVALID now) | map includes xhigh\|max; needs `/login openai-codex` |
| `openrouter/meta/muse-spark-1.3` | max / xhigh | **as requested** if key present | OpenRouter only; **no key on machine** |
| `antigravity/gemini-3.8-flash` | xhigh | **high** | map xhigh→`gemini-3.8-flash-high`; OpenRouter map max high |
| `cerebras/qwen-3.8-27b` | xhigh | **high** | custom `models.json`: off\|low\|medium\|high; ctx **131072** |
| `anthropic/claude-fable-5-1` | xhigh | **xhigh** | supported |

TUI cell: `qwen-3.8-27b (xhigh→hi)` when normalized.

### Hotkey plan

1. **Operator action (required for shift+tab):** write `~/.pi/agent/keybindings.json`:

```json
{
  "app.thinking.cycle": "alt+t"
}
```

then `/reload`. Empty array `[]` also frees it.

2. **Titan binds** (after free): `shift+tab` **and** `alt+l` → `cycleHarnessLevel` 0→1→2→3→0.  
3. **Keep:** `ctrl+tab` / `alt+h` shape cycle; `ctrl+shift+n` / `alt+n` builders 1–4 **extend cycle to 1–5–8**; `ctrl+shift+s` / `alt+s` subagent cap; `ctrl+shift+a` / `alt+a` auditor.  
4. If shift+tab still reserved, `registerShortcut` is dropped — **`alt+l` still works**; INSTALL must say this. Kitty protocol still needed for Ctrl forms.

---

## 5. Verification, evidence & elevation ladder

### Evidence schema (hard = observed bytes)

Append-only object in `evidence.jsonl` (also copied into packages):

```json
{
  "id": "ev_…",
  "runId": "run-…",
  "nodeId": "kane-desktop",
  "kind": "screenshot|log|test-result|git-diff|hash|cursor-run|kane-evidence|audit-verdict|spec-hash|video|db-roundtrip",
  "confidence": "observed|inferred|declared",
  "sha256": "…",
  "path": "artifacts/…",
  "bytes": 0,
  "createdAt": "ISO",
  "toolCallId": "…",
  "identityAt": "write|harvest",
  "staleness": "current|stale|unverified"
}
```

**Hard evidence** = `confidence: observed` + sha256 of file bytes (or canonical JSON digest). Agent prose is **declared** and never sufficient for `done-verified`.

### Tier-required evidence

| Tier | Required to accept |
|---|---|
| web / general | spec-hash + **db-roundtrip** (write hash then read) |
| research / planning | spec-hash of vision/intent/repo cites; ontology hint optional |
| prototyping / analytics | spec-hash, test-log, git-diff, **screenshot**, console-log, audit-verdict; **per device** |
| production SWE | proto + sim-user pack (Kane `.evidence` or Cursor artifacts) |
| platform update | sim-user PASS **per shipping function**; untested = cancel |
| content | 3× human approval ids + agent review |

### Review-before-report

Reuse `audit.ts` trailer `## AUDIT — <status>`. Engine rule: a builder/worker may not transition `done-verified` without an auditor/watchdog descendant. Architect never files the report; fusion ACK still SHA-256. Watchdog fires if: workflow completes without review; worker pings architect without review; stop with no review; review PASS with no architect handback (`review-orphaned`).

### n-of-3 then re-author

Same CI/test/design-intent/no-issue-report loops:

| Fail count | Action |
|---|---|
| 1 | bump builder thinking one notch (high→xhigh if supported, else stay high + notify) |
| 2 | max thinking + **max model on that builder** (pool: fable-5.1 / grok-4.6 / gpt-6-astra as authed) |
| 3 | halt; state `repairing-workflow`; architect **must author a new workflow** (tighter phases, smaller per-task ctx, higher harness level). **No in-place mutate of the failed YAML.** |

This is the High Performance ↔ Verification Loop bridge: fail-3 on lvl1 proto **escalates recommended level to 3** in the re-author prompt.

### Watchdog state machine

States: `idle` → `armed` → `inspecting` → `steering` | `resuming` | `halted-stalemate` | `cleared`.

| Trigger | Action |
|---|---|
| `session_before_compact` (manual\|threshold\|overflow) | Halt visible work; inspect `preparation` + ledger + `retainedTail` vs last evidence; return **custom `{compaction}`** from artifacts (K-Dense “state block first”) or `{cancel:true}` if `willRetry` and inspect FAIL |
| `session_compact` | Reset activity tail; if loss detected, spawn watchdog child, then resume via `AgentRun.sessionRef` **or** rewrite resume prompt on **architect model** |
| complete-without-review | force `in-review`; block `done-verified` |
| ping-without-review | inject steer; require auditor |
| stop-without-review | mark `done-unverified`; notify |
| review-orphaned | ping architect with artifact path (system-run) |
| identical finding identity ≥ `stalemateRepeats` (3) | `stalemate`, `triggerTurn: false` |
| `input` | cancel in-flight inspect (match pi-subagents) |

Watchdog children: read-only tools; `READONLY_TOOLS`; spend **ledgered** as role `watchdog` (fix pi-subagents hole).

### Verification node adapters

| Node | How |
|---|---|
| **Kane CLI** | `bash: kane-cli run "<objective>" --agent --headless` → parse NDJSON `run_end`; attach `.testmuai/evidence/` pack (observed) |
| **TestMu MCP** | prompt node with `titan_harness__testmu` tools (HyperExecute / Automation logs / SmartUI). Kane runs; TestMu triages |
| **Momentic** | **disabled** in catalog; if operator enables, `momentic_run_step` + artifacts `.momentic-mcp/` |
| **Cursor cloud** | `scripts/cursor-agent.mjs`: `POST https://api.cursor.com/v1/agents` → poll/SSE → `artifacts/download`. Require `result` + screenshot/video paths |
| **Orca** | `bash` `orca` tab create/goto/snapshot/click/fill/screenshot for **local-dev-verify**; iOS emulator when needed |

Momentic/Figma-desktop/framer-mcp-plugin stay disabled unless the operator flips them.

---

## 6. Data & logging

### Store choice

**JSONL + SHA-256 chain (K-Dense).** Not SQLite, not NoSQL.

| Option | Verdict |
|---|---|
| JSONL + canonical digest + prev hash | **Choose.** Zero new deps, git-friendly, observation-first, matches fusion ACK and pi-dw identity journals |
| SQLite `archon.db` | Reject. Extra engine, no hash layer in Archon docs, worse for Pi plugin portability |
| Embedded NoSQL | Reject. Fresh dependency, no local precedent, verdict B forbids mega-platform |

**Paths**

- Run: `~/.pi/titan-harness/runs/<projectSlug>/<runId>/`
- Optional project copy: `<cwd>/.pi/titan/runs/<runId>/`
- Child sessions remain `/tmp/titan-harness-sessions/<projectSlug>/run-<pid>/<slotId>` (rm on `session_shutdown`)
- Blobs: `…/blobs/<sha256>`

### Schema

**`run.json`:** `{runId, workflowName, harnessLevel, shape, status, startedAt, updatedAt, tokenUsage, costUsd, parentRunId?}`

**`events.jsonl`:** each line `{seq, ts, type, agentId, callsign, payload, prevSha256, sha256}` where `sha256 = SHA256(canonical(line without sha256) + prevSha256)`. Types: `phase|agentStart|agentEnd|tokenUsage|review|watchdog|compaction|evidence|control`.

**`agents.json`:** slot, role, callsign, model, thinking `{requested,effective}`, pid, sessionDir, status.

**`costs.jsonl`:** role `architect|builder|worker|auditor|watchdog|verifier|exa|compute`; tokens in/out/cache; `costUsd`; `listPriceUsd?`; `authType`; **watchdog included**.

**`evidence.jsonl`:** §5. **`provenance/steps.jsonl`:** toolCallId, paths, sha256, `confidence observed|inferred|declared`. **No agent tool writes provenance** — recorder subscribes to child JSON event stream + host `tool_execution_*`.

### Provenance rules

- `write`/`edit`/`read` named path → **observed** after hash  
- bash/cursor/kane stdout paths → **observed** if file exists else **inferred**  
- model “I tested X” → **declared**  
- harvest of child session after exit → `identityAt: harvest`, staleness **unverified** until rehash  
- Degrade visibly: `unhashed`, `truncated`, `no-scan-baseline`

### Cost ledger & sidebar derivation

Reuse `bumpSlotPerf` (host: `before_provider_request` → `message_end`, **not** `message_start`) and child-runner usage (input+cache as prompt, output, `cost.total`; tps excludes tool gaps).

```
token_burn     = Σ costs.totalTokens
cost           = Σ costs.costUsd          # include watchdog
avg_tps/agent  = mean(runTps over agents with tpsSeconds>0)
completion_rate = count(status==done-verified) / count(agents launched)
```

Take field-wise max of event tally vs `getSessionStats` delta so compaction cannot shrink the ledger (K-Dense).

---

## 7. Delivery plan

**Repo:** `~/Dev Tools/pi-extensions/titan-harness` (path-installed). Tests: `bun test`. Do not bump pi-dw past 3.10.1.

### P0 — Operator prerequisites (not a release)

**Scope:** Unblock models/MCP. **Files:** none in repo.  
**Operator:** `/login openai-codex`; set `OPENROUTER_API_KEY` if muse-spark required; set `INFRANODUS_API_KEY` (copy from Claude `~/.claude.json` env, do not print); Figma OAuth/`clientId` or desktop; write `keybindings.json` as §4; Kitty if Ctrl hotkeys wanted.  
**Effort:** S (human). **Deps:** none.

### P1 — Grok-review gap-fill → **0.3.0** (early, own phase)

**Scope:** Ship-list hygiene inside titan + Grok plugin sync.  
**Files:** `package.json` add `"pi": { "mcp": "./mcp/mcp.json" }`; `mcp/mcp.json` add `infranodus` stdio (`npx -y infranodus-mcp-server`, env `INFRANODUS_API_KEY`); keep momentic/figma-desktop/framer-mcp-plugin disabled; `skills/higgsfield-media/SKILL.md`; `skills/brand-launch-kit/SKILL.md`; `skills/mcp-cli-bridges/SKILL.md`; `skills/divmagic-raw/SKILL.md` **new**; `skills/design-to-code-pipeline/SKILL.md` Tokens Studio/Untitled UI/21st.dev; `INSTALL.md` named-link PATH + keybind; `README.md` pins + non-goals; `mcp/README.md`; `skills/README.md` (16→17+ skills). Grok `triarc-creative-stack` `higgsfield-media` + Motion stage + `/mcp-cli-setup` Python-vs-Rust.  
**Tests:** fixture that `package.json` `pi.mcp` path exists; skill grep for OpenRouter-video / mega-CLI.  
**Accept:** catalog auto-registers `titan_harness__*`; docs disambiguate mcp2cli; guardrails present.  
**Effort:** M.

### P2 — Thinking normalize + levels shapes + fan-out keys → **0.3.0** (same bump if small, else 0.4.0 start)

**Scope:** `thinking-normalize.ts`; shapes `shapes/model-stack-lvl{0-3}-*.yaml`; settings schema `harnessLevel`, fan-out splits; TUI requested→effective; `/stack` writes three files still, now including new keys; skip unauthed slots.  
**Files:** `modules/model-stack.ts`, `stack-config.ts`, `tui.ts`, `titan-harness.ts`, `stack-settings.ts`, tests `model-stack`.  
**Accept:** qwen xhigh displays `xhigh→hi`; lvl cycle via `alt+l`.  
**Effort:** M. **Deps:** P1 docs for keybind.

### P3 — Ledger, provenance, sidebar totals → **0.4.0**

**Scope:** JSONL chain, costs including watchdog placeholder, footer Σ row, `scripts/verify-ledger.ts`.  
**Files:** `modules/ledger.ts`, `provenance.ts`, `tui.ts`, `child-runner.ts` (emit), tests.  
**Accept:** verify-ledger passes on a `/titan-only` run; totals match.  
**Effort:** M. **Deps:** P2.

### P4 — YAML schema + validator + engine v1 → **0.4.0/0.5.0**

**Scope:** schema, validator CLI, engine executing prompt/bash/approval/review using existing child-runner + audit.ts; artifact handoff `nodes/<id>.md`. **No** visual builder yet.  
**Files:** `modules/workflow-schema.ts`, `workflow-validator.ts`, `workflow-engine.ts`, `cmd-workflow.ts` (`/titan-workflow run|validate|list`); tests.  
**Accept:** proto-analytics YAML validates; dry-run DAG order correct; architect node cannot write.  
**Effort:** L. **Deps:** P3.

### P5 — Watchdog + compaction → **0.5.0**

**Scope:** `session_before_compact` / `session_compact` / lifecycle triggers; resume prompts; stalemate; ledger watchdog spend. Optionally enable `subagents.watchdog` for host-only bonus.  
**Files:** `modules/watchdog.ts`, `titan-harness.ts` hooks, `prompts/SYSTEM_PROMPT_WATCHDOG.md`, tests with fake compact events.  
**Accept:** compact during builder run produces custom summary from artifacts; complete-without-review cannot `done-verified`.  
**Effort:** L. **Deps:** P3, P4.

### P6 — Monitor overlay + phase rail → **0.5.0**

**Scope:** `/workflow-monitor`; states/colors; DAG ascii; poll titan JSONL + pi-dw runs JSON (no WorkflowManager symbol unless upstreamed).  
**Files:** `modules/monitor.ts`, `tui.ts`. Guard `ctx.mode==="tui"`.  
**Accept:** overlay unfocused; colors per §2; does not steal editor input.  
**Effort:** M. **Deps:** P3.

### P7 — Plan-mode + `/ultraplan` + `/create-workflow` → **0.6.0**

**Scope:** Copy plan-mode example; fusion roster with degrade; clean-context architect; statusline harness config; lvl3 TUI defaults plan to `/ultraplan`.  
**Files:** `modules/plan-mode.ts`, `cmd-ultraplan.ts`, `cmd-create-workflow.ts`, skills, prompts.  
**Accept:** writes blocked in plan; fused brief → YAML; Astra missing ⇒ fallback fable/grok.  
**Effort:** L. **Deps:** P2, P4, P0 for full roster.

### P8 — `/terraform` + InfraNodus nodes + entity-aware lvl2 → **0.6.0/0.7.0**

**Scope:** wayfinder artifacts; ontology MCP nodes; lvl2 trigger reads terraform pack for fan-out (Gap 1).  
**Files:** `skills/titan-terraform/`, `workflows/templates/terraform.yaml`.  
**Accept:** pack hashed; lvl3 without pack notifies; lvl2 trigger log shows entity-derived fan-out.  
**Effort:** M. **Deps:** P1 infranodus, P7.

### P9 — `/local-dev-verify` + `/cloud-simulated-users` + elevation loop → **0.7.0**

**Scope:** Kane/Orca/Cursor adapters; n-of-3 re-author; device matrix; platform-update fail-closed.  
**Files:** skills, `scripts/cursor-agent.mjs`, `modules/verification-policy.ts`, templates.  
**Accept:** Kane evidence hashed; fail-3 opens `repairing-workflow` and requires new YAML.  
**Effort:** L. **Deps:** P4–P8, named CLIs on PATH (operator).

### P10 — Remaining Archon patterns → **0.8.0**

**Scope:** best-of-n template, hypothesis JSONL, personas/mimeographs, interleaved parallel+synthesize, TUI DAG view polish. **Not** Archon Studio canvas.  
**Effort:** M. **Deps:** P4, P6.

### Docs + Grok plugin sync

Every bump: `README.md`, `INSTALL.md`, `skills/README.md`, `mcp/README.md`, `docs/harness-shape-*.md`. Grok plugin `triarc-creative-stack@1.0.0` → 1.0.1/1.1.0 **only** for shared skill text (Higgsfield, mcp2cli). Titan `package.json` version 0.3.0….

**Keep:** titan dist patch to pi-dw `workflow-commands.js:175-190` with `.orig` restore note — still wiped by `pi update --extensions`. Prefer requesting `Symbol.for("pi-dynamic-workflows:manager")` upstream; until then poll run JSON.

---

## 8. Risks, unknowns, and minority positions

1. **Codex OAuth INVALID** — Astra architect/ultraplan/create-workflow fail until `/login openai-codex`. Mitigation: skip-unauthed + fallback fable-5.1 / grok-4.6; TUI banner.  
2. **No OpenRouter key** — muse-spark-1.3 fusion-4 always skipped. Mitigation: 3-seat fusion + judge; do not invent a non-OpenRouter id.  
3. **No `INFRANODUS_API_KEY` in Pi env** — ontology nodes `uncertain-launch`. Mitigation: catalog + INSTALL; never embed the Claude key in git.  
4. **shift+tab silently dropped** — Mitigation: `alt+l` twin + INSTALL + notify on session_start if reserved.  
5. **pi-dw 3.11 crash** — stay 3.10.1; titan patch is fragile. Mitigation: poll JSON; don’t make `/workflows` the runtime.  
6. **belowEditor already 6+ rows** — totals + monitor can crush the editor. Mitigation: overlay for monitor; one Σ row on footer; `progressPanelMode` compact.  
7. **Fan-out last-write-wins across 3 files** — Mitigation: single `/stack` writer; document; semaphore if engine also writes.  
8. **Watchdog double-fire** (titan + pi-subagents) — Mitigation: titan owns children; host-only optional `subagents.watchdog`; emission-guard by runId.  
9. **Child JSON stream is the only IPC** — compaction/review across processes can race. Mitigation: sessionRef + artifacts as source of truth; harvest on `agent_end`.  
10. **Cursor/Kane/Framer/Higgsfield CLI not on PATH** — Mitigation: skills fail with install text; no fake MCP for Kane.  
11. **Cerebras 131k ctx / 40k maxTokens** — lvl0 architect will compact often. Mitigation: watchdog before-compact is P5-critical for lvl0.  
12. **Figma DCR 403 / MCP OAuth pending** — design nodes degrade; not a titan code bug.

**Operator must provide:** Codex re-login; OpenRouter key (optional but required for muse); InfraNodus key in Pi MCP env; keybindings rebind; Kane/Cursor credentials if using those nodes; decision to enable Momentic.

**Where this seat disagrees with the brief**

- **`/create-workflow` is not a pi-dw feature** — implementing it as a dw command would fight 3.10.1. Titan YAML authoring is the honest surface.  
- **“NoSQL database with hashed logs”** — hashed logs do not need NoSQL. JSONL chain is strictly better here.  
- **Visual DAG builder** — a React Flow studio is a different product (Archon). Pi gets an overlay graph.  
- **xhigh on gemini/qwen** — do not pretend. Always requested/effective.  
- **Orca split as the monitor** — optional; in-process overlay matches “Pi plugin” and works without Orca.  
- **Compile-to-dynamic-workflows as primary engine** — dw sandbox forbids fs/Date/random; YAML DAG with titan children is the engine that can hash evidence.  
- **Lvl2 “5 per agent type” including watchdogs** — implement as 5 watchdogs, but they must not inflate builder fan-out or the three-file concurrency cap will hit 16 immediately (5+5+5+5). Cap: `defaultConcurrency` = max(builders, workers, 16).  
- **Fusion Drive merge / mega-CLI** — reject (already verdict B). Transliterate best-of-n only.  
- **“Plan mode” language in TUI** — must be titan-owned; saying Pi has plan mode is false.

---

## 9. Requirements trace

| Brief item | Plan sections | Coverage |
|---|---|---|
| Grok 1 Macro Higgsfield stale → packs + vendor MCP | 2 (gap-fill), 7 P1 | full |
| Grok 2 mcp2cli Python vs Rust | 2, 7 P1 | full |
| Grok 3 Higgsfield guardrails + combos | 2, 7 P1 | full |
| Grok 4 named links not on PATH | 2, 7 P1 INSTALL | full |
| Grok 5 Macro untitled/titan docs (out of this plugin) | 2 leave-outs; mention only | **partial** (document, don’t write Macro skills) |
| Grok 6 verdict B gap-fill, pins, enable/disable, leave-outs | 1, 2, 7 | full |
| Add DivMagic, Tokens Studio/Untitled/21st.dev, higgsfield/cli note | 2, 7 P1 | full |
| Later ops pack Fiber/Jinko/… | 2 leave-outs | full (explicitly out) |
| Sidebar totals | 2, 6, 7 P3 | full |
| `/create-workflow` clean ctx + xhigh frontier + statusline | 1, 2, 4, 7 P7 | full (titan-owned, not dw) |
| Verification tiers × modes (all six) | 2, 3, 5, 7 P9 | full |
| `/workflow-monitor` states/colors/phase rail | 2, 6, 7 P6 | full (overlay; Orca optional) |
| Watchdog incl. compaction + four review-gap triggers | 1, 2, 5, 7 P5 | full |
| `/ultraplan` fusion team + workflow-architect | 2, 4, 7 P7 | full, with auth degrade |
| `/terraform` wayfinder + fusion + automations | 2, 7 P8 | full; autonomous enqueue **partial** (opt-in YAML, no resident scheduler like K-Dense until a later ops pack) |
| `/local-dev-verify` | 2, 5, 7 P9 | full |
| `/cloud-simulated-users` | 2, 5, 7 P9 | full |
| shift+tab levels 0–3 + fan-out | 1, 4, 7 P2 | full, **gated on rebind** |
| Fusion roster models/thinking | 2, 4 | full + normalization |
| Elevation 1/2 fail + CI/design/no-report loops | 5, 7 P9 | full |
| Grok subagents analyze Archon YAML | brief says DONE | n/a |
| Archon 13 features | 2 rows, 3, 6, 7 P10 | **visual DAG partial** (TUI not Studio); **NoSQL replaced by JSONL**; **hooks partial** (Pi mapping, not Claude SDK) |
| InfraNodus as local/MCP dep | 1, 2, 7 P1/P8 | full |
| InfraNodus gap 1 level↔entity | 4 lvl2, 7 P8 | full |
| InfraNodus gap 2 level↔verification/elevation | 5 n-of-3, 7 P9 | full |
| InfraNodus gap 3 review↔compaction/ledger | 5 watchdog, 6 | full |
| Architect never writes; callsigns; child env guard | 1, 3 validator | full |
| No mega-CLI / no Fusion Drive merge | 1, 8 | full |

**Partially satisfied by design:** Macro product docs (wrong host); autonomous terraform schedulers (no K-Dense resident session in a Pi plugin without a daemon); Archon visual Studio; Archon Claude hooks fidelity; muse-spark/Astra seats until operator secrets exist.