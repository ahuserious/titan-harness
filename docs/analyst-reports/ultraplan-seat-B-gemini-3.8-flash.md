# Ultraplan: Titan-Harness Architectural Integration Plan (v0.3.0)

This plan integrates the operator brief into `titan-harness` (TypeScript, path-installed at `~/Dev Tools/pi-extensions/titan-harness`), respecting all verified machine facts, Pi 0.85.1 internals, and Grok review inputs.

---

## 1. Architecture Decision Summary

1. **Native YAML DAG Engine inside Titan-Harness (Choice 1)**: Build a dedicated TS DAG loader, validator, and runner in `extensions/titan-harness/modules/workflow-engine/` rather than compiling to `@quintinshaw/pi-dynamic-workflows` (DW). *Rationale*: DW 3.10.1 is strictly sandboxed JavaScript (no YAML, no filesystem, no `/create-workflow`), foreground children strip ambient extensions, and its dist patch is fragile; Titan already has subprocess child isolation that cleanly inherits host providers.
2. **Dual-Surface Monitor (Choice 2)**: Implement `/workflow-monitor` primarily as an Orca terminal split (`orca terminal split` + `orca terminal send`) streaming JSONL status, with an in-process right-anchored overlay via `ctx.ui.custom()` using `handle.unfocus({ target: editorComponent })` as fallback. *Rationale*: Pi 0.85.1 has no native terminal pane/sidebar API, but the local machine possesses full Orca CLI automation; the unfocused overlay provides self-contained TUI support.
3. **JSONL + SHA-256 Hash Chaining over SQLite/NoSQL (Choice 3)**: Store runs, provenance, and evidence in append-only JSONL files with canonical key sorting and chained SHA-256 digests (`canonical-json.ts` + `prev_digest`). *Rationale*: Embedded NoSQL/SQLite introduces native C-binding fragility and lock contention in Pi subprocesses; K-Dense BYOK proved that content-addressed, DB-free JSONL delivers zero-dependency, crash-resilient provenance.
4. **Autonomous In-Harness Watchdog Engine (Choice 4)**: Host the watchdog directly inside Titan (`modules/watchdog.ts`), subscribing to Pi's `session_before_compact`, `turn_end`, and child subprocess event streams, reusing `pi-subagents` finding schemas (`subagent_watchdog_warning`). *Rationale*: `pi-subagents` 0.67 exports no programmatic API, ignores `session_before_compact`, cannot monitor detached Titan subprocesses, and fails to ledger watchdog token burn.
5. **Two-Pronged Shift+Tab Binding Strategy (Choice 5)**: Ship `alt+shift+tab` and `alt+l` as zero-config active bindings in Titan, while providing `/titan-setup-keys` to safely remap `app.thinking.cycle` in `~/.pi/agent/keybindings.json` so `shift+tab` can be claimed without Pi dropping the handler. *Rationale*: Pi 0.85.1 hard-reserves `shift+tab` in `runner.js`; extensions attempting to bind it are silently ignored unless remapped in user settings.
6. **Clean Context Handoffs via Typed Artifacts**: Inter-node workflow state transfers strictly via immutable files in `artifacts/<runId>/<nodeId>/` with cold session restarts (`context: fresh`), preventing token pollution and context drift.
7. **Ephemeral Cross-Family Auditor Gating**: Audits are conducted by read-only children selected from a differing model family than the builder, enforcing the review-before-report invariant before any task completion.
8. **Subprocess Execution with Ambient Provider Inheritance**: Spawn child agents via `pi --mode json -p` with `TITAN_HARNESS_CHILD=1`, ensuring Antigravity, Cerebras, and MCP adapter configurations remain accessible while suppressing nested harness loops.
9. **Provider-Aware Thinking Normalization**: Normalizer intercepts requested reasoning levels: Cerebras Qwen and Gemini 3.8 Flash capped at `high`; Grok 4.6, Astra, Fable 5.1, and Muse Spark pass through `xhigh`.
10. **Pre-Compaction State Freezing**: Intercept `session_before_compact` to cancel default lossy summarization, capture frozen state blocks (active tasks, diff hashes, open tickets), and synthesize an Architect-aligned resume prompt.
11. **Grok Gap-Fill inside Titan**: Incorporate Higgsfield studio guardrails, mcp2cli disambiguation, and DivMagic RAW skills into Titan's skill pack without building a mega-CLI.
12. **InfraNodus as Local MCP Catalog Entry**: Integrate InfraNodus via `mcp/mcp.json` using the local server build or `npx infranodus-mcp-server`, surfaced through `pi-mcp-adapter`.
13. **Hierarchical Elevation Ladder (1-2-3 Rule)**: Escalation sequence: 1 fail = reasoning bump; 2 fails = model stack bump; 3 fails = watchdog-halt and Architect workflow re-authoring.
14. **Isolated Writer Lease**: Retain Titan's file mutex mechanism (`writer-lease.ts`) so concurrent builders in parallel phases cannot cause write collisions.
15. **Strict Callsign Masking**: Suppress raw model identifiers in prompts, logs, and rosters (`rune`, `forge`, `ward`), guaranteeing un-biased cross-model peer review.

---

## 2. Feature-by-Feature Integration Table

| Feature / Brief Item | Design Summary | Where It Lives | Reuse vs Build | Effective Model & Thinking Normalization | Acceptance Test |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Sidebar / Header Totals** | Aggregate live token burn, total cost USD, average TPS/agent, and completion % across all slots; render in footer widget & workflow UI. | `modules/ledger.ts`, `modules/tui.ts`, `titan-harness.ts` | Build on top of `slotPerf` Map & `renderFooterWidget` | N/A (Host display) | Spawn 2 builders; verify footer displays aggregated tokens, accurate USD cost, real TPS (excluding tool wait), and completion rate. |
| **/create-workflow Clean-Context** | Launches Architect in fresh session (`--session-id <uuid>`) with repo context, vision.md, and intent.md to author Archon YAML DAG. | `modules/cmd-author.ts`, `skills/titan-orchestration/` | Build new command; reuse `child-runner.ts` | `openai-codex/gpt-6-astra` @ `xhigh` | Run `/create-workflow "build auth"`; verify clean context, Astra xhigh used, and valid YAML output written to disk. |
| **Verification Tiers × Modes** | 6 phased verification modes enforcing required evidence (DB writes, test logs, Kane screenshots, 3x content review). | `modules/workflow-engine/verifier.ts`, `modules/evidence.ts` | Build new schema-driven verifier | Configurable per node (Default: `xai/grok-4.6` @ `xhigh`) | Run workflow in `prototyping` mode; verify execution halts if Kane screenshots or test logs are missing. |
| **/workflow-monitor** | Pops side terminal via Orca split (`orca terminal split`) or fallback Pi overlay (`ctx.ui.custom`); displays phase rail and color-coded status dots. | `modules/monitor.ts`, `modules/orca-bridge.ts` | Build UI; reuse Orca CLI & Pi `ctx.ui.custom` | N/A (UI renderer) | Execute `/workflow-monitor`; verify terminal splits in Orca, phase rail updates, and states (`dispatched-working`, `in-review`) render with correct colors. |
| **Watchdog Engine & Compaction** | Event listener intercepting `session_before_compact`, stale pings, unreviewed stops, and 3x stalemates; inspects hallucination & injects resume prompt. | `modules/watchdog.ts`, `extensions/titan-harness.ts` | Build native FSM; reuse `subagent_watchdog_warning` shape | `cerebras/qwen-3.8-27b` @ `medium` (or architect model) | Simulate compaction during run; verify `session_before_compact` halts, inspects diffs, and injects architect resume prompt. |
| **/ultraplan** | Multi-model deliberation panel with 5-seat fusion team, judge, and fuser running via clean sessions; outputs finalized DAG. | `skills/ultraplan/`, `modules/cmd-fusion.ts` | Build on `cmd-fusion.ts` & `/grill-with-docs` pattern | Astra (`xhigh`), Fable (`xhigh`), Grok (`xhigh`), Gemini (`high` ceiling), Muse (`xhigh`), Judge: Gemini (`high`), Fuser: Fable (`xhigh`) | Run `/ultraplan "migration"`; verify 5 seats execute, Gemini normalized to `high`, and final fused YAML DAG is emitted. |
| **/terraform** | Wayfinder-style entity ontology engine; generates `vision.md`, `intent.md`, platform maps, and autonomous roadmap triggers. | `skills/terraform/`, `modules/wayfinder.ts` | Build skill + ontology generator; wrap InfraNodus MCP | `openai-codex/gpt-6-astra` @ `xhigh` + `infranodus` MCP | Run `/terraform`; verify `vision.md` and `intent.md` generated with InfraNodus ontology graphs and entity constraints. |
| **/local-dev-verify** | Deploys local stack, spawns simulated user agents running headless Kane CLI or CDP scripts; captures screenshots, video, logs. | `skills/local-dev-verify/`, `modules/local-verify.ts` | Build skill; reuse `@testmuai/kane-cli` & Orca browser commands | `cerebras/qwen-3.8-27b` @ `high` (simulated users) | Run `/local-dev-verify`; verify local port scanned, Kane captures headless run, and evidence bundle hashes match. |
| **/cloud-simulated-users** | Multi-remote browser testing driver orchestrating Cursor cloud agents, TestMu MCP, and Momentic runs; streams data to monitor. | `skills/cloud-simulated-users/`, `modules/cloud-verify.ts` | Build skill; integrate Cursor REST API, TestMu & Momentic MCPs | `xai/grok-4.6` @ `xhigh` (driver) | Run `/cloud-simulated-users`; verify Cursor cloud agent run triggered, artifacts fetched via presigned URL, and logs verified. |
| **Shift+Tab Levels 0–3** | Live harness geometry cycle with updated fan-out, watchdog, and Exa allocations; updates settings and model bar live. | `modules/harness-levels.ts`, `extensions/stack-settings.ts` | Extend `cycleShape` in `titan-harness.ts` | Normalized per Level table (Level 0–3) | Press `alt+shift+tab`; verify harness toggles Level 0 -> 1 -> 2 -> 3, model bar updates, and fan-out limits sync across files. |
| **Archon: System Prompt Override** | Per-node `systemPrompt` and `appendSystemPrompt` mapped to `pi` subprocess flags. | `modules/workflow-engine/executor.ts` | Reuse `child-runner.ts` CLI builder | Inherited by node model | Execute node with `systemPrompt: "custom"`; verify child `pi` argv contains `--system-prompt "custom"`. |
| **Archon: Structured Output** | JSON Schema validation of node outputs via terminating schema tool or strict JSON extraction. | `modules/workflow-engine/schema.ts` | Build TypeBox validator; borrow DW terminating tool pattern | Inherited by node model | Run node with `output_format`; verify output conforms to schema or triggers bounded re-prompt. |
| **Archon: Hashed Provenance Log** | Append-only JSONL event log with SHA-256 hash chains for all run steps, diffs, and evidence files. | `modules/provenance.ts` | Build based on K-Dense `canonical-json` + store | N/A | Execute 3-step DAG; verify `.titan/provenance/<runId>.jsonl` contains valid sequential SHA-256 digest chains. |
| **Archon: Best-of-N** | Parallel generation across N builder instances with an independent judge node scoring and synthesizing. | `modules/workflow-engine/best-of-n.ts` | Transliterate claude-fusion-drive `best-of-n.js` | Builders: `fable-5.1` @ `high`; Judge: `grok-4.6` @ `xhigh` | Run best-of-3 node; verify 3 distinct child sessions run and judge delivers selected candidate. |
| **Archon: Visual DAG Builder Skill** | Interactive ASCII / Mermaid DAG visualization and schema-guided workflow authoring. | `skills/workflow-authoring/` | Build prompt skill | `openai-codex/gpt-6-astra` @ `xhigh` | Invoke skill; verify valid Mermaid diagram and Archon-compatible YAML workflow are produced. |
| **Archon: YAML Validator** | Validates workflow DAG structure, cycles, node exclusivity, dependency existence, and tool allowlists. | `modules/workflow-engine/validator.ts` | Build; port Archon load-time rules | N/A (Pure TypeScript) | Pass cyclic YAML to validator; verify load fails with exact line/node cycle diagnostic. |
| **Archon: Hooks (PreToolUse/PostToolUse)** | Emulates Archon hook constraints (deny, addContext, emergency stop) via Pi `tool_call` and `tool_result` event hooks. | `modules/workflow-engine/hooks.ts` | Build on Pi `tool_call` {block:true} | N/A (Event engine) | Define `PreToolUse: Bash -> deny`; run child; verify bash execution is blocked with defined reason. |
| **Archon: Lateral Clean-Context Pass** | Forces `context: fresh` on subsequent nodes, transferring prior outputs strictly via artifact files on disk. | `modules/workflow-engine/executor.ts` | Build; leverage `child-runner.ts` | Inherited by node model | Node B depends on Node A with `context: fresh`; verify Node B receives clean context with `$A.output` reference. |
| **Archon: Subagents Allowed Tools** | Per-node explicit whitelisting and blacklisting of tools (`allowed_tools`, `denied_tools`). | `modules/workflow-engine/executor.ts` | Reuse `childToolsFor` in `stack-config.ts` | Inherited by node model | Set `allowed_tools: [read, grep]`; verify child `pi` argv receives `--tools read,grep`. |
| **Archon: Interleaved Reasoning** | Segregates codebase into subsets, analyzes each in parallel clean contexts, and fuses findings with re-authoring trigger. | `modules/workflow-engine/interleaved.ts` | Build orchestrator pattern | Split: `gemini-3.8-flash` @ `high`; Fuse: `gpt-6-astra` @ `xhigh` | Run interleaved analysis on 3 dirs; verify 3 parallel clean sessions fuse into unified report. |
| **Archon: Hypothesis-Based Workflow** | DAG nodes structured around hypothesis formulation, falsification tests, and evidence-link updating (`supports`/`challenges`). | `skills/hypothesis-workflow/` | Build skill; adapt K-Dense notebook model | `xai/grok-4.6` @ `xhigh` | Run hypothesis workflow; verify findings update hypothesis status to `supports` or `challenges`. |
| **Archon: Personas & Mimeographs** | Distinct operational roles (`implementer`, `security-auditor`, `perf-tester`) applied via system prompt overlays on identical models. | `modules/personas.ts`, `prompts/personas/` | Build prompt library; port Grok/K-Dense personas | Inherited by node model | Spawn 2 Fable builders with different personas; verify divergent reasoning and distinct callsign behaviors. |
| **Archon: InfraNodus MCP Integration** | Catalog entry in `mcp/mcp.json` providing reasoning ontology generation and cognitive graph gap analysis. | `mcp/mcp.json`, `package.json`, `skills/infranodus-reasoning/` | Wrap existing local server build | N/A (MCP protocol via stdio) | Call `infranodus_generate_knowledge_graph` from child agent; verify graph JSON returns without error. |
| **Grok Gap-Fill: Higgsfield Guardrails** | Studio guardrails in skills: no OpenRouter references; video length restricted to 5–8s looping Framer hero animations. | `skills/higgsfield-media/SKILL.md`, `skills/brand-launch-kit/SKILL.md` | Patch existing skills | N/A (Prompt guardrails) | Inspect Higgsfield skill prompts; verify presence of 5–8s Framer constraints and absence of OpenRouter. |
| **Grok Gap-Fill: mcp2cli Disambiguation** | Clear distinction in documentation and skills between Python `mcp2cli` (via uvx) and Grok Rust `mcp2cli`. | `skills/mcp-cli-bridges/SKILL.md`, `docs/INSTALL.md` | Patch documentation and skills | N/A | Review docs; verify Python uvx vs Rust CLI usage instructions are isolated. |
| **Grok Gap-Fill: Named Links & DivMagic** | Documentation notes for Kane, Framer, Higgsfield CLI installation; new RAW DivMagic skill (Chrome extension). | `skills/divmagic-raw/SKILL.md`, `docs/INSTALL.md` | Build new skill + update docs | N/A | Load DivMagic skill; verify DOM-to-clean-component workflow runs without treating DivMagic as an MCP. |
| **Grok Gap-Fill: Design Token Mentions** | Cross-references in creative skills for Tokens Studio, Untitled UI, and 21st.dev component workflows. | `skills/design-to-code-pipeline/SKILL.md` | Patch existing skill | N/A | Check design-to-code skill; verify guidance includes 21st.dev and Untitled UI token mapping. |

---

## 3. YAML Workflow Schema Proposal (Archon-Compatible Subset for Pi)

### Schema Definition
The workflow schema adheres to Archon DAG semantics while adding Titan harness metadata.

*   **Root Fields**:
    *   `name` (string, required): Kebab-case workflow identifier.
    *   `description` (string): Summary of workflow purpose.
    *   `version` (string): Semver string (e.g., `"1.0.0"`).
    *   `harness_level` (integer, optional): Default harness level (0–3).
    *   `verification_tier` (string, required): One of `web_scraping`, `research_planning`, `prototyping`, `production_swe`, `platform_update`, `content_creation`.
    *   `inputs` (map): Input parameters with `type`, `description`, `default`, and `required`.
    *   `nodes` (list, required): Ordered/graph list of node specifications.
*   **Node Mutually Exclusive Execution Types** (exactly one required per node):
    *   `prompt` (string): Inline prompt for an LLM child agent.
    *   `command` (string): Path to markdown command file in `prompts/` or `.pi/prompts/`.
    *   `bash` (string): Shell script executed via `bash -c`. Stdout captured as `$id.output`.
    *   `script` (string): Code executed via `bun` or `uv`. Requires `runtime: bun | uv`.
    *   `loop` (object): Iterative node with `prompt`, `until_bash` or `until`, and `max_iterations`.
    *   `approval` (object): Human gate with `message`, `on_approve`, `on_reject`.
    *   `cancel` (string): Aborts workflow with reason string.
*   **Node Base Fields**:
    *   `id` (string, required): Unique node ID (`^[a-zA-Z0-9_-]+$`).
    *   `depends_on` (string[], optional): Dependencies that must complete before execution.
    *   `when` (string, optional): Boolean expression evaluated against inputs or `$dep.output`.
    *   `trigger_rule` (string, default `"all_success"`): `all_success | one_success | all_done`.
    *   `timeout` (integer, optional): Execution limit in milliseconds.
    *   `context` (string, default `"fresh"`): `fresh | shared`.
*   **Titan Harness Extensions (per node)**:
    *   `role` (string, default `"builder"`): `architect | builder | worker | auditor | verifier`.
    *   `persona` (string, optional): Callsign persona identifier or prompt overlay.
    *   `callsign` (string, optional): Masked callsign (e.g., `forge`, `ward`).
    *   `model` (string, optional): Provider/model override (e.g., `xai/grok-4.6`).
    *   `thinking` (string, optional): Reasoning effort (`low | medium | high | xhigh`).
    *   `allowed_tools` / `denied_tools` (string[], optional): Explicit tool allow/deny lists.
    *   `output_format` (object, optional): JSON Schema validating `$id.output`.
    *   `evidence` (object, optional): Required hard evidence: `capture_diff` (bool), `test_logs` (bool), `screenshots` (bool).
    *   `elevation_ladder` (object, optional): Escalation policy: `max_retries` (default 3), `on_fail` (`retry | reasoning_bump | model_bump | reauthor`).
    *   `watchdog` (object, optional): Policy override: `strict | lenient`, `halt_on_compaction` (bool).

### Validator Rules
1. **Uniqueness**: Node `id`s must be unique across the document.
2. **DAG Structure**: Graph formed by `depends_on` must be acyclic (validated via Kahn's algorithm).
3. **Reference Sanity**: Any `$nodeId.output` in `when`, `prompt`, or `script` must reference a valid preceding dependency.
4. **Execution Exclusivity**: Each node must declare exactly one execution property (`prompt`, `command`, `bash`, `script`, `loop`, `approval`, `cancel`).
5. **Runtime Validation**: Nodes declaring `script` must declare `runtime: bun` or `runtime: uv`. Named scripts must exist on disk.
6. **Provider/Thinking Mapping**: Declared models and thinking levels must pass through the normalization validator (e.g., reject `xhigh` on Cerebras without warning).

### Complete Example: Prototyping / Data Analytics Workflow (~60 lines)
```yaml
name: data-prototype-verify
description: Spec & test-driven prototype verified by ephemeral auditor and Kane CLI
version: 1.0.0
harness_level: 2
verification_tier: prototyping
inputs:
  spec_file: { type: string, required: true, default: "specs/feature-req.md" }
  target_url: { type: string, required: true, default: "http://localhost:3000" }

nodes:
  - id: author-test-suite
    role: worker
    callsign: mason
    model: antigravity/gemini-3.8-flash
    thinking: high
    context: fresh
    prompt: |
      Read the specification at $inputs.spec_file. Author an end-to-end Kane CLI test suite
      in `tests/e2e.test.md` covering UI user flows, edge cases, and performance acceptance.
    allowed_tools: [read, write, grep]
    evidence: { capture_diff: true }

  - id: implement-feature
    depends_on: [author-test-suite]
    role: builder
    callsign: forge
    model: xai/grok-4.6
    thinking: xhigh
    context: fresh
    prompt: |
      Implement the feature requested in $inputs.spec_file to satisfy tests in `tests/e2e.test.md`.
      Ensure local service runs cleanly on $inputs.target_url.
    allowed_tools: [read, write, edit, bash]
    evidence: { capture_diff: true }

  - id: execute-verification
    depends_on: [implement-feature]
    bash: |
      kane-cli run "Verify feature flows" --agent --headless --cdp-endpoint $inputs.target_url > artifacts/kane-run.ndjson
      EXIT_CODE=$?
      echo "{\"exit_code\": $EXIT_CODE, \"log_path\": \"artifacts/kane-run.ndjson\"}" > $OUTPUT_JSON
    timeout: 180000

  - id: auditor-review
    depends_on: [execute-verification]
    role: auditor
    callsign: ward
    model: anthropic/claude-fable-5-1
    thinking: xhigh
    context: fresh
    prompt: |
      Review implementation against $inputs.spec_file and Kane logs at `artifacts/kane-run.ndjson`.
      Verify screenshots, console logs, and hard acceptance evidence. Output PASS or FAIL with diagnostics.
    allowed_tools: [read, grep]
    output_format:
      type: object
      properties:
        verdict: { type: string, enum: [PASS, FAIL] }
        hard_evidence_accepted: { type: boolean }
        findings: { type: array, items: { type: string } }
      required: [verdict, hard_evidence_accepted]
    elevation_ladder:
      max_retries: 3
      on_fail: reauthor
```

---

## 4. Harness Levels & Shapes

### YAML Shape Configurations

#### Level 0: Ultrafast (`model-stack-level-0.yaml`)
```yaml
name: level-0
description: Ultrafast execution with Cerebras Qwen and live Exa search
slots:
  - name: rune
    role: architect
    model: cerebras/qwen-3.8-27b
    thinking: high
    architect: true
    color: "#38bdf8"
  - name: forge
    role: builder
    model: cerebras/qwen-3.8-27b
    thinking: high
    primary: true
    color: "#f97316"
settings:
  builderFanOut: 5
  subagentFanOut: 5
  childExa: true
  auditor: false
```

#### Level 1: Brain + Ultrafast Workers (`model-stack-level-1.yaml`)
```yaml
name: level-1
description: Frontier Flash architect supervising Cerebras ultrafast workers
slots:
  - name: rune
    role: architect
    model: antigravity/gemini-3.8-flash
    thinking: high
    architect: true
    color: "#818cf8"
  - name: forge
    role: builder
    model: cerebras/qwen-3.8-27b
    thinking: high
    primary: true
    color: "#f97316"
settings:
  builderFanOut: 5
  subagentFanOut: 5
  childExa: true
  auditor: false
```

#### Level 2: Triggered / Operations / Deep Research (`model-stack-level-2.yaml`)
```yaml
name: level-2
description: Enterprise operations, entity-aware research, and verification recovery
slots:
  - name: rune
    role: architect
    model: openai-codex/gpt-6-astra
    thinking: high
    architect: true
    color: "#a855f7"
  - name: forge
    role: builder
    model: xai/grok-4.6
    thinking: xhigh
    primary: true
    color: "#ea580c"
  - name: mason
    role: worker
    model: antigravity/gemini-3.8-flash
    thinking: high
    color: "#06b6d4"
  - name: sentry
    role: watchdog
    model: cerebras/qwen-3.8-27b
    thinking: medium
    color: "#eab308"
settings:
  builderFanOut: 5
  subagentFanOut: 5
  watchdogFanOut: 5
  childExa: true
  auditor: true
  auditRounds: 2
```

#### Level 3: SWE / System Architecture / Deep Analytics (`model-stack-level-3.yaml`)
```yaml
name: level-3
description: Full software engineering, multi-audited verification, and entity alignment
slots:
  - name: rune
    role: architect
    model: openai-codex/gpt-6-astra
    thinking: xhigh
    architect: true
    color: "#9333ea"
  - name: forge
    role: builder
    model: anthropic/claude-fable-5-1
    thinking: high
    primary: true
    color: "#f43f5e"
  - name: mason
    role: worker
    model: antigravity/gemini-3.8-flash
    thinking: high
    color: "#06b6d4"
  - name: ward
    role: verifier
    model: xai/grok-4.6
    thinking: xhigh
    color: "#10b981"
  - name: sentry
    role: watchdog
    model: cerebras/qwen-3.8-27b
    thinking: medium
    color: "#eab308"
settings:
  builderFanOut: 3
  subagentFanOut: 5
  verifierFanOut: 5
  watchdogFanOut: 5
  childExa: true
  exaFanOut: 10
  auditor: true
  auditRounds: 3
```

### Requested → Effective Thinking Normalization Table

| Provider / Model | Requested Thinking | Effective Thinking | Ceiling / Reason |
| :--- | :--- | :--- | :--- |
| `cerebras/qwen-3.8-27b` | `xhigh` | `high` | Hardware provider ceiling: Pi custom entry supports `off\|low\|medium\|high`. |
| `cerebras/qwen-3.8-27b` | `high` | `high` | Supported natively. |
| `antigravity/gemini-3.8-flash` | `xhigh` | `high` | Provider ceiling: antigravity maps `xhigh` to `gemini-3.8-flash-high`. |
| `antigravity/gemini-3.8-flash` | `high` | `high` | Supported natively. |
| `xai/grok-4.6` | `xhigh` | `xhigh` | Full native `xhigh` support (ctx 500k). |
| `openai-codex/gpt-6-astra` | `xhigh` | `xhigh` | Native `xhigh` support (ctx 872k). *Requires valid OAuth login*. |
| `anthropic/claude-fable-5-1` | `xhigh` | `xhigh` | Native `xhigh` and `max` thinking supported via Copilot/Anthropic. |
| `openrouter/meta/muse-spark-1.3` | `max` / `xhigh` | `max` / `xhigh` | Native OpenRouter support. *Requires OPENROUTER_API_KEY*. |

### Hotkey Plan
*   **The Conflict**: Pi 0.85.1 hard-reserves `shift+tab` for `app.thinking.cycle` in `runner.js`. Extensions registering `shift+tab` directly are dropped with a diagnostic.
*   **The Resolution**:
    1.  **Direct Active Bindings**: Titan registers `alt+shift+tab` and `alt+l` via `pi.registerShortcut()`. These work immediately without modifying Pi global settings.
    2.  **Keybinding Bridge Command**: Ship `/titan-setup-keys`. This command executes atomic JSON modification of `~/.pi/agent/keybindings.json`:
        ```json
        {
          "app.thinking.cycle": "alt+t"
        }
        ```
    3.  **Claiming Shift+Tab**: On startup or `/reload`, `titan-harness` checks if `app.thinking.cycle` is freed. If freed, it binds `shift+tab` to `cycleHarnessLevel(0 -> 1 -> 2 -> 3 -> 0)`.

---

## 5. Verification, Evidence & Elevation Ladder

### Evidence Schema
Evidence packages are stored at `.titan/evidence/<runId>/<nodeId>/manifest.json`:
```json
{
  "$schema": "https://triarc.dev/schemas/titan-evidence-v1.json",
  "runId": "run_9a8f2c1b",
  "nodeId": "implement-feature",
  "timestamp": "2026-09-14T18:32:05Z",
  "verificationTier": "prototyping",
  "git": {
    "commit": "a4f81c9b82",
    "diffStat": "+142 -12",
    "diffHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  },
  "files": [
    {
      "path": "src/auth/jwt.ts",
      "sha256": "8f4e2...b1",
      "size": 4210,
      "confidence": "observed"
    }
  ],
  "hardEvidence": {
    "testResults": [
      { "suite": "e2e-kane", "passed": 8, "failed": 0, "logHash": "c29a...01" }
    ],
    "artifacts": [
      { "type": "screenshot", "path": "artifacts/kane-step-3.png", "sha256": "4b81...ff" },
      { "type": "network_log", "path": "artifacts/network.har", "sha256": "12aa...90" }
    ]
  },
  "reviewSignoff": {
    "auditorCallsign": "ward",
    "verdict": "PASS",
    "signature": "sig_ed25519_..."
  }
}
```

### Tier-Specific Required Evidence Matrix

| Verification Tier | Required Hard Evidence | Enforcement Mechanism |
| :--- | :--- | :--- |
| **Web Scraping / General** | Database write receipts, row insertion count matching spec, schema validation JSON, zero network unhandled errors. | Auditor parses DB transaction receipt + row hash. |
| **Research / Planning** | Primary source citations, `vision.md` and `intent.md` compliance rubric score ≥ 90%, InfraNodus graph gap metric < 0.15. | Auditor runs graph diff against org ontology. |
| **Prototyping / Data Analytics** | Kane CLI NDJSON logs, per-step browser screenshots, test runner exit code 0, visual diff acceptance report. | Auditor checks Kane artifact directory on disk. |
| **Production SWE / Automations** | Full regression pass, simulated user flow video/DOM trace, zero type/linter warnings, performance/latency bounds met. | CI runner + Cursor cloud agent artifact fetch. |
| **Platform Update** | 100% simulated user scenario completion, backward compatibility test suite, zero deprecated API triggers. | Simulated users verify staging environment. |
| **Content Creation** | 3× independent pass against human review presets, zero hallucinated claims, style guide linting pass. | 3 distinct auditor passes before signoff. |

### Review-Before-Report Rule
*   **Invariant**: No builder, worker, or script output is ever forwarded to the Architect or marked `done-verified` without passing through an independent Auditor review.
*   **Enforcement**: The DAG executor intercepts node completion. If `reviewSignoff` is missing from the evidence manifest, the node status transitions to `done-unverified` and is barred from triggering downstream dependent nodes.

### n-of-3 Loop and Re-Authoring Escalation
1.  **Failure 1 (In-Place Retry)**: Node execution fails test or auditor review. Increment retry counter to 1. Re-prompt the same builder with auditor error diagnostics. Bump thinking level by one step (e.g., `medium` -> `high`).
2.  **Failure 2 (Model Escalation)**: Node fails second attempt. Increment retry counter to 2. Re-prompt builder with escalated model (e.g., promote to `anthropic/claude-fable-5-1` @ `xhigh`). Tighten task prompt scope.
3.  **Failure 3 (Hard Halt & Re-Authoring Escalation)**: Node fails third attempt. The loop halts. The Watchdog triggers `reauthor`:
    *   Subprocess tree is frozen.
    *   A structured failure package (diffs, test failures, auditor findings) is compiled into `artifacts/escalation-report.md`.
    *   The Architect is summoned in a **clean context window** (`context: fresh`) with the escalation package.
    *   The Architect decomposes the failed task into smaller, tighter sub-phases and generates a **new, re-authored workflow DAG**.

### Watchdog State Machine

```
      [Turn/Tool Event]
             │
             ▼
     ┌───────────────┐
     │  MONITORING   │◄───────────────────────────┐
     └───────┬───────┘                            │
             │ session_before_compact             │
             ▼                                    │
     ┌───────────────┐   Hallucination Found      │
     │COMPACTION_HOLD├──────────────────────────┐ │
     └───────┬───────┘                          │ │
             │ Clean Resume Prompt Generated    │ │
             ▼                                  │ │
     ┌───────────────┐                          │ │
     │   RESUMING    │                          │ │
     └───────┬───────┘                          │ │
             │                                  │ │
             ▼                                  │ │
     ┌───────────────┐                          │ │
     │AUDIT_INSPECTION                          │ │
     └───────┬───────┘                          │ │
             │                                  │ │
      Pass   ├──────────────────────────────────┘ │
             │ Consecutive Identical Warnings ≥ 3 │
             ▼                                    │
     ┌───────────────┐                            │
     │   STALEMATE   ├────────────────────────────┘
     └───────┬───────┘      Human / Architect Fix
             │
             ▼
     ┌───────────────┐
     │  ESCALATING   │ ──► Re-Author Workflow
     └───────────────┘
```

*   **Watchdog Triggers**:
    1.  `session_before_compact` event received from Pi.
    2.  Workflow completes without an auditor review pass.
    3.  Worker or builder pings the Architect without an auditor signoff.
    4.  Agent process terminated or aborted without final review.
    5.  Review passes, but the result envelope fails to route back to the Architect.
    6.  Three consecutive identical warnings emitted (Stalemate).
*   **Compaction Inspection Handling**:
    *   Titan intercepts `session_before_compact`.
    *   Halts the agent turn.
    *   Inspects session history for uncommitted file diffs, active DAG task states, and evidence manifests.
    *   Synthesizes a deterministic state block (K-Dense pattern) containing active task IDs, git HEAD hash, and required outputs.
    *   Replaces the lossy default summary with a strict resume prompt matching the Architect persona.

### External Verification Harness Integration
*   **Kane CLI (`@testmuai/kane-cli`)**: Driven via `bash` nodes executing `kane-cli run "<objective>" --agent --headless`. Parses terminal NDJSON `run_end` events and captures `.testmuai/evidence/` artifacts.
*   **TestMu MCP (`https://mcp.lambdatest.com/mcp`)**: Invoked via standard MCP tool calls (`testmu_automation_*`) for cloud browser grid testing, SmartUI visual-diff verification, and accessibility triage.
*   **Momentic (`npx momentic mcp`)**: Activated in `mcp/mcp.json`. Executes YAML test flows (`momentic_run_step`) and downloads step trace videos into `.titan/evidence/`.
*   **Cursor Cloud Agents**: Driven via `modules/cloud-verify.ts` calling `https://api.cursor.com/v1/agents`. Initiates background workspace builds on feature branches, polls SSE run streams, and downloads verification logs and screenshots via presigned URLs.
*   **Orca Browser Automation**: Utilized for rapid local DOM verification via CLI (`orca browser tab create`, `orca browser goto`, `orca browser screenshot`).

---

## 6. Data & Logging

### Store Evaluation: JSONL + Hash Chains vs. SQLite vs. Embedded NoSQL

| Dimension | JSONL + SHA-256 Hash Chain (Recommended) | SQLite (`~/.archon/archon.db`) | Embedded NoSQL (LevelDB/Nedb) |
| :--- | :--- | :--- | :--- |
| **Dependencies** | **Zero native deps** (Pure JS `node:crypto`, `node:fs`). | Requires native compilation (`better-sqlite3` or Bun SQLite). | Requires external npm packages with binary bindings. |
| **Pi Subprocess Safety** | **Immune to locking**; append-only streaming works across child processes. | High risk of `SQLITE_BUSY` when concurrent children write. | Lock contention on single-file stores; risk of corruption. |
| **Auditability & Diff** | Fully git-diffable, human-readable line-by-line JSON. | Opaque binary file; requires external CLI tools to inspect. | Semi-opaque JSON or Level binary tables. |
| **Crash Resilience** | Trailing partial line dropped; prior entries remain intact. | WAL mode required; recovery needed on hard SIGKILL. | Prone to corruption during process abrupt aborts. |
| **Precedent** | Proven in **K-Dense BYOK** on this exact machine. | Used in Archon reference spec (without hash chains). | No precedent in verified local tools. |

*   **Decision**: Adopt **JSONL + SHA-256 Hash Chaining**. Stored at `.titan/ledger/` and `.titan/provenance/`.

### Schemas

#### Run Record (`.titan/ledger/runs.jsonl`)
```json
{
  "runId": "run_9a8f2c1b",
  "workflowName": "data-prototype-verify",
  "harnessLevel": 2,
  "status": "completed",
  "startedAt": "2026-09-14T18:30:00.000Z",
  "completedAt": "2026-09-14T18:34:15.000Z",
  "totalTokens": 142580,
  "totalCostUsd": 0.4812,
  "prevDigest": "7b8f...a1",
  "digest": "4c9d...e2"
}
```

#### Event Record (`.titan/provenance/<runId>-events.jsonl`)
```json
{
  "eventId": "evt_0012",
  "runId": "run_9a8f2c1b",
  "nodeId": "implement-feature",
  "callsign": "forge",
  "role": "builder",
  "model": "xai/grok-4.6",
  "type": "tool_execution_end",
  "toolName": "write",
  "path": "src/auth/jwt.ts",
  "bytesWritten": 4210,
  "sha256": "8f4e2...b1",
  "confidence": "observed",
  "timestamp": "2026-09-14T18:31:22.105Z",
  "prevDigest": "1a2b...c3",
  "digest": "9f8e...d4"
}
```

### Provenance Rules (Observed vs. Inferred vs. Declared)
*   **Observed**: The tool execution explicitly targeted the path (e.g., `write`, `edit`), and bytes were verified and hashed immediately post-execution.
*   **Inferred**: Files detected as changed via `git diff` or sandbox scan after a `bash` or `script` execution where specific paths were not isolated tool arguments.
*   **Declared**: Model asserted in its textual output that a file was modified or verified, but no filesystem mutation or tool call confirms it. *Declared records are never accepted as hard evidence.*

### Cost Ledger & Watchdog Spend Capture
*   Pi's default behavior ignores token spend for background watchdogs and auditors. Titan overcomes this by wrapping all subprocess and nested agent runs in a unified billing collector:
    *   Every child invocation records `AgentRun.usage` (`input`, `output`, `cacheRead`, `cacheWrite`, `costUsd`).
    *   Watchdog turns (including anti-hallucination scans) are logged under `role: "watchdog"`.
    *   Auditor review passes are logged under `role: "auditor"`.
    *   Row entries append to `.titan/ledger/costs.jsonl`.

### Sidebar Totals Derivation
The model bar and `/workflow-monitor` derive totals from the live in-memory ledger:
$$\text{Total Token Burn} = \sum_{\text{all roles}} (\text{input} + \text{output} + \text{cacheRead} + \text{cacheWrite})$$
$$\text{Total Cost USD} = \sum_{\text{all roles}} \text{costUsd}$$
$$\text{Avg TPS per Agent} = \frac{\sum \text{outputTokens}}{\sum \text{durationSeconds (excluding tool wait)}}$$
$$\text{Avg Agent Completion Rate} = \frac{\text{Completed Nodes (Status = PASS)}}{\text{Total Dispatched Nodes}} \times 100\%$$

---

## 7. Delivery Plan

### P0: Grok Review Gap-Fill & Catalog Foundation (Effort: S)
*   **Scope**: Resolve all accepted Grok review findings inside Titan.
*   **Files Touched**:
    *   `skills/higgsfield-media/SKILL.md`: Add studio guardrails (restrict to 5–8s looping Framer heroes, strip OpenRouter).
    *   `skills/brand-launch-kit/SKILL.md`: Enforce Higgsfield video guardrails in Step 2.
    *   `skills/mcp-cli-bridges/SKILL.md`: Disambiguate Python `mcp2cli` (uvx) vs. Rust `mcp2cli`.
    *   `skills/divmagic-raw/SKILL.md`: Create new skill for DivMagic Chrome extension workflow.
    *   `skills/design-to-code-pipeline/SKILL.md`: Add Tokens Studio, Untitled UI, 21st.dev references.
    *   `mcp/mcp.json`: Add `infranodus` entry (`npx -y infranodus-mcp-server`).
    *   `package.json`: Declare `"mcp": "./mcp/mcp.json"` under `"pi"` block so Pi loads the catalog.
*   **Acceptance Criteria**: `bun test` passes; `package.json` contains valid MCP entry; skills contain zero OpenRouter video references.
*   **Dependencies**: None.

### P1: Harness Levels 0–3, Thinking Normalization & Hotkeys (Effort: M)
*   **Scope**: Implement Levels 0–3 shape files, thinking level ceiling normalizer, and the keybinding remapping command.
*   **Files Touched**:
    *   `~/.pi/titan-harness/model-stack-level-*.yaml`: Write level 0, 1, 2, 3 shapes.
    *   `extensions/titan-harness/modules/model-stack.ts`: Add requested-to-effective thinking normalizer.
    *   `extensions/titan-harness/modules/harness-levels.ts`: Harness level FSM and configuration synchronizer.
    *   `extensions/titan-harness/titan-harness.ts`: Register `alt+shift+tab` / `alt+l`; implement `/titan-setup-keys`.
*   **Acceptance Criteria**: Cycling through levels 0–3 updates model bar; Cerebras/Gemini thinking properly normalizes to `high`; `/titan-setup-keys` patches `keybindings.json`.
*   **Dependencies**: P0.

### P2: Hashed Ledger, Provenance & Metrics Engine (Effort: M)
*   **Scope**: Build zero-dependency JSONL hash-chained storage for runs, costs, events, and evidence.
*   **Files Touched**:
    *   `extensions/titan-harness/modules/ledger.ts`: Implement cost ledger, token burn calculator, and metrics aggregator.
    *   `extensions/titan-harness/modules/provenance.ts`: Implement `canonical-json` sorted hashing and digest chaining.
    *   `extensions/titan-harness/modules/tui.ts`: Render sidebar totals in footer widget.
*   **Acceptance Criteria**: Running tasks creates `.titan/ledger/` records with verifiable sequential SHA-256 digests; footer displays live token burn, cost USD, TPS, and completion rate.
*   **Dependencies**: P1.

### P3: Native Archon YAML DAG Engine & Validator (Effort: L)
*   **Scope**: Implement the Archon-compatible YAML workflow loader, acyclic graph validator, and subprocess runner.
*   **Files Touched**:
    *   `extensions/titan-harness/modules/workflow-engine/validator.ts`: DAG validation (Kahn's algorithm, type exclusivity).
    *   `extensions/titan-harness/modules/workflow-engine/executor.ts`: Node dispatcher, `context: fresh` lateral handoffs.
    *   `extensions/titan-harness/modules/workflow-engine/schema.ts`: TypeBox structured output validation.
    *   `skills/workflow-authoring/SKILL.md`: Authoring guide and Mermaid visualizer.
*   **Acceptance Criteria**: Validator rejects cyclic or invalid YAML; executor executes 3-node workflow with clean-context passing.
*   **Dependencies**: P2.

### P4: Autonomous Watchdog & Compaction Interceptor (Effort: L)
*   **Scope**: Implement the Watchdog FSM, staleness detector, `session_before_compact` handler, and resume generator.
*   **Files Touched**:
    *   `extensions/titan-harness/modules/watchdog.ts`: Watchdog state machine, diff analyzer, stalemate detector.
    *   `extensions/titan-harness/titan-harness.ts`: Subscribe to `session_before_compact`, `turn_end`, and child events.
    *   `prompts/SYSTEM_PROMPT_WATCHDOG.md`: Watchdog inspection prompt.
*   **Acceptance Criteria**: Compaction triggers watchdog halt and resume generation; unreviewed agent stops trigger immediate audit warnings; 3 identical warnings trip stalemate.
*   **Dependencies**: P3.

### P5: Verification Ladder & External Test Runners (Effort: M)
*   **Scope**: Integrate Kane CLI, TestMu, Momentic, Cursor cloud agents, and the 1-2-3 escalation ladder.
*   **Files Touched**:
    *   `extensions/titan-harness/modules/evidence.ts`: Evidence package generator and manifest signer.
    *   `extensions/titan-harness/modules/elevation.ts`: Escalation logic (retry -> model bump -> re-author).
    *   `extensions/titan-harness/modules/cloud-verify.ts`: Cursor cloud agent REST client.
    *   `skills/local-dev-verify/SKILL.md`: Local deployment verification driver.
*   **Acceptance Criteria**: Failed tests elevate through retry, model bump, and re-authoring; Kane NDJSON properly parsed into hard evidence.
*   **Dependencies**: P4.

### P6: Advanced Skills: /ultraplan, /terraform, and InfraNodus (Effort: M)
*   **Scope**: Build the multi-model planning team, entity ontology engine, and InfraNodus integration.
*   **Files Touched**:
    *   `skills/ultraplan/SKILL.md`: 5-seat deliberation panel prompt.
    *   `skills/terraform/SKILL.md`: Wayfinder entity ontology engine.
    *   `skills/infranodus-reasoning/SKILL.md`: InfraNodus cognitive graph builder.
*   **Acceptance Criteria**: `/ultraplan` executes multi-model fusion; `/terraform` produces valid `vision.md` and `intent.md` referencing InfraNodus graphs.
*   **Dependencies**: P5.

### P7: /workflow-monitor TUI & Orca Terminal Split (Effort: M)
*   **Scope**: Build terminal monitor utilizing Orca CLI split pane and Pi overlay fallback.
*   **Files Touched**:
    *   `extensions/titan-harness/modules/monitor.ts`: Live status renderer with color dots and phase rail.
    *   `extensions/titan-harness/modules/orca-bridge.ts`: Orca CLI split management (`orca terminal split`).
*   **Acceptance Criteria**: `/workflow-monitor` splits side terminal in Orca; states (`dispatched-working`, `in-review`, etc.) update in real time.
*   **Dependencies**: P6.

### P8: Hardening, Docs, Grok Plugin Sync & v0.3.0 Release (Effort: S)
*   **Scope**: Bump version, update documentation, and synchronize Grok plugin catalog.
*   **Files Touched**:
    *   `package.json`: Bump version to `0.3.0`.
    *   `README.md`, `INSTALL.md`: Document new commands, hotkeys, and workflow engine.
    *   `~/orca/workspaces/triarc-dev/triarc-dev/.grok/`: Sync companion skill manifests.
*   **Acceptance Criteria**: Full test suite passes; docs accurately reflect system capabilities; companion skills load in Grok CLI.
*   **Dependencies**: P7.

---

## 8. Risks, Unknowns, and Disagreements

### Identified Risks & Concrete Mitigations
1. **Codex OAuth Invalidated**: `gpt-6-astra` fails immediately due to expired token.
   *   *Mitigation*: Pre-flight check in `model-stack.ts`. If Codex OAuth is invalid, display clear user notification: `"Run /login openai-codex to enable Astra slots"`, and gracefully fall back to `anthropic/claude-fable-5-1`.
2. **Missing OpenRouter API Key**: `muse-spark-1.3` cannot run in `/ultraplan`.
   *   *Mitigation*: Fusion panel detects missing `OPENROUTER_API_KEY` at runtime; automatically substitutes Seat 4 with `anthropic/claude-fable-5-1` @ `xhigh`.
3. **Pi Shift+Tab Collision**: Extension crashes or drops hotkey if user hasn't remapped `app.thinking.cycle`.
   *   *Mitigation*: Guard `pi.registerShortcut("shift+tab")` in a try/catch block; default to active `alt+shift+tab` twin; prompt user with `/titan-setup-keys`.
4. **`session_before_compact` Handler Latency**: If the watchdog takes too long analyzing diffs during compaction, Pi may drop the turn or freeze.
   *   *Mitigation*: Impose a strict 5,000ms timeout on pre-compaction inspection; if exceeded, write frozen fallback state block immediately and allow compaction to proceed.
5. **Subprocess Concurrency Exhaustion**: Running 5 builders, 5 workers, 5 watchdogs, and 10 Exa agents simultaneously can saturate system memory and file descriptors.
   *   *Mitigation*: Enforce global concurrency semaphore (`maxChildProcesses: 8`) in `child-runner.ts`, queuing excess node executions.
6. **Fragility of Dynamic-Workflows Dist Patch**: Upstream updates to `@quintinshaw/pi-dynamic-workflows` wipe Titan's menu patch in `dist/workflow-commands.js`.
   *   *Mitigation*: Decouple Titan completely from DW runtime; keep DW pinned to 3.10.1; run workflows exclusively via Titan's native YAML engine.
7. **Missing InfraNodus API Key in Pi Environment**: Key exists in Claude Code settings, but not in Pi's ambient environment.
   *   *Mitigation*: Auto-discover and import `INFRANODUS_API_KEY` from `~/.claude.json` during Titan MCP initialization if missing from `process.env`.
8. **Unbudgeted Watchdog Token Burn**: High-frequency watchdog checks can rapidly drain budget unnoticed.
   *   *Mitigation*: Track watchdog tokens in the primary cost ledger; throttle watchdog invocations to once every $N$ tool calls (default: 5) or on file-write boundaries only.

### Operator Actions Required
1. Run `/login openai-codex` to re-authenticate Codex OAuth for `gpt-6-astra`.
2. Set `OPENROUTER_API_KEY` in environment if `muse-spark-1.3` is required for `/ultraplan`.
3. Run `/titan-setup-keys` to rebind `app.thinking.cycle` in `~/.pi/agent/keybindings.json` to enable `shift+tab`.
4. Add `INFRANODUS_API_KEY` to `~/.pi/agent/settings.json` or system environment.

### Disagreements with the Operator Brief
*   **NoSQL Database Specification**:
    *   *Brief*: Calls for an embedded NoSQL database for hashed logs.
    *   *Disagreement*: Rejected. Embedded NoSQL databases (e.g., NeDB, LevelDB) introduce binary C-dependency compilation issues across environments and lock contention under multi-process access. Hashed append-only JSONL files (proven by K-Dense BYOK) provide superior auditability, zero dependencies, crash immunity, and native git compatibility.
*   **Unbounded `xhigh` Thinking Everywhere**:
    *   *Brief*: Specifies `xhigh` thinking across models including Gemini 3.8 Flash and Cerebras Qwen.
    *   *Disagreement*: Rejected at runtime level. Neither Cerebras Qwen nor Gemini 3.8 Flash supports `xhigh` in Pi provider mappings; sending `xhigh` results in null maps or silent fallbacks. Titan will strictly normalize these requests to `high` while reporting effective vs. requested levels in the UI.
*   **Compiling YAML to `@quintinshaw/pi-dynamic-workflows`**:
    *   *Brief*: Suggests leveraging dynamic workflows for DAG execution.
    *   *Disagreement*: Rejected. Dynamic Workflows 3.10.1 is sandboxed JavaScript, strips ambient extensions in foreground children, and lacks a YAML engine. Titan's native TS execution engine running isolated `pi --mode json -p` subprocesses is vastly more capable, preserves ambient auth, and avoids brittle dist patches.

---

## 9. Requirements Trace

| Brief Requirement | Plan Section(s) | Status | Notes / Justification |
| :--- | :--- | :--- | :--- |
| **Top of sidebar: token burn, cost, avg TPS/agent, completion %** | Section 1 (Bullet 1), Section 2, Section 6 | **Satisfied** | Derived via `modules/ledger.ts` and rendered in footer widget. |
| **/create-workflow clean-context with Astra xhigh** | Section 2, Section 3, Section 7 (P3) | **Satisfied** | Spawns clean session (`context: fresh`) with Astra @ xhigh. |
| **6 Verification tiers × modes** | Section 2, Section 3, Section 5 | **Satisfied** | Schema specifies verification modes and required hard evidence. |
| **/workflow-monitor with side terminal, colors & phase rail** | Section 1 (Bullet 2), Section 2, Section 7 (P7) | **Satisfied** | Implemented via Orca terminal split + Pi overlay fallback. |
| **Watchdog engine (compaction halt/resume, stale pings, stalemates)** | Section 1 (Bullet 4), Section 2, Section 5, Section 7 (P4) | **Satisfied** | Native FSM intercepting `session_before_compact` and tool events. |
| **/ultraplan fusion team deliberation panel** | Section 2, Section 4, Section 7 (P6) | **Satisfied** | 5-seat multi-model team with normalized thinking and fuser. |
| **/terraform Wayfinder ontology & intent.md** | Section 2, Section 7 (P6) | **Satisfied** | Originalizes Pocock wayfinder with InfraNodus ontology graphs. |
| **/local-dev-verify simulated prototype users** | Section 2, Section 5, Section 7 (P5) | **Satisfied** | Headless Kane CLI integration with screenshots and DOM logs. |
| **/cloud-simulated-users multi-remote flows** | Section 2, Section 5, Section 7 (P5) | **Satisfied** | Cursor cloud agents REST client + TestMu/Momentic MCPs. |
| **Shift+Tab Levels 0–3 with fan-out defaults** | Section 1 (Bullet 5), Section 2, Section 4 | **Satisfied** | Levels 0–3 defined in YAML shapes; keybinding bridge deployed. |
| **Archon: System prompt override** | Section 2, Section 3 | **Satisfied** | Mapped to `pi` child subprocess `--system-prompt` flags. |
| **Archon: Structured output** | Section 2, Section 3 | **Satisfied** | Validated via JSON Schema / TypeBox contracts. |
| **Archon: NoSQL database with hashed logs** | Section 1 (Bullet 3), Section 6, Section 8 | **Partial (Adopted Better)** | Substituted NoSQL for JSONL + SHA-256 hash chains for stability. |
| **Archon: Best-of-n** | Section 2, Section 3 | **Satisfied** | Transliterated from claude-fusion-drive parallel judge pattern. |
| **Archon: Visual DAG builder w/ skill** | Section 2, Section 3, Section 7 (P3) | **Satisfied** | Skill generates Mermaid visual flow and valid Archon YAML. |
| **Archon: YAML workflow validator** | Section 2, Section 3, Section 7 (P3) | **Satisfied** | Validates acyclicity, exclusivity, and references via Kahn's algorithm. |
| **Archon: Hooks (PreToolUse/PostToolUse)** | Section 2, Section 3 | **Satisfied** | Emulated via Pi `tool_call` {block:true} and injection. |
| **Archon: Lateral pass to clean context** | Section 1 (Bullet 6), Section 2, Section 3 | **Satisfied** | `context: fresh` nodes transfer data strictly via typed artifacts. |
| **Archon: Subagents allowed/denied tools** | Section 2, Section 3 | **Satisfied** | Enforced via `childToolsFor` and `--tools` subprocess flags. |
| **Archon: Interleaved reasoning** | Section 2, Section 7 (P3) | **Satisfied** | Segregated clean context analyzers fused with re-authoring trigger. |
| **Archon: Hypothesis-based workflow** | Section 2, Section 5 | **Satisfied** | Structured nodes around hypothesis formulation and evidence links. |
| **Archon: Personas & mimeographs** | Section 2, Section 3 | **Satisfied** | Callsign-driven persona overlays on identical underlying models. |
| **Archon: InfraNodus MCP dependency** | Section 1 (Bullet 12), Section 2, Section 7 (P0) | **Satisfied** | Registered in `mcp/mcp.json` and declared in `package.json`. |
| **Grok review gap-fill items (Higgsfield, mcp2cli, links, DivMagic)** | Section 1 (Bullet 11), Section 2, Section 7 (P0) | **Satisfied** | All gap-fill items delivered in Phase P0 without mega-CLI. |