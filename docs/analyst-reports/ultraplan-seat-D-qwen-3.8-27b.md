

# ULTRAPLAN — titan-harness 0.2.0 → 0.3.0 (Pi 0.85.1)

## 1. Architecture decision summary

1. **[Big choice 1] Engine: native YAML DAG engine inside titan-harness** (new `modules/workflows/*`, on the existing `yaml ^2.9.0` dep), executing nodes as our existing `pi --mode json -p` children — Archon is a documented spec with **no engine to port**, and titan children already load host extensions (providers, exa, MCP) with per-slot session dirs the watchdog needs.
2. **[Big choice 2] `@quintinshaw/pi-dynamic-workflows` stays pinned 3.10.1 and out of the execution path** — the titan engine never invokes DW at runtime; DW's JS-script model has no YAML and 3.11 crashes; the existing `dist/workflow-commands.js` `/workflows`-menu patch is re-shipped as `scripts/apply-dw-patch.mjs` (it is wiped by updates) with a session-start pin check.
3. **[Big choice 3] `/workflow-monitor` = in-process first**: extend the existing belowEditor model bar (`renderFooterWidget`, titan-harness.ts:744-850 — we already own that slot) + optional experimental right-anchored overlay (`ctx.ui.custom` + `handle.unfocus`, TUI-only); `orca terminal split` + a pipe script is the opt-in *true* side terminal, because Pi 0.85.1 has **no sidebar/split/terminal-pane API**.
4. **[Big choice 4] Ledger = DB-free append-only JSONL + SHA-256 hash chain** (K-Dense precedent), not Archon's SQLite (no hash layer) nor a new NoSQL engine; observations-only writes (no agent tool can append).
5. **[Big choice 5] Watchdog = new titan module (`modules/watchdog.ts`) running ephemeral read-only children, spend ledgered**; it consumes Pi events on-host (`session_before_compact`, `session_compact`, `agent_end`, `session_shutdown`), the child JSON event stream, and a 5 s session-file poll (compaction entry `{type:"compaction"}`) for cross-process coverage; pi-subagents 0.67's watchdog stays **off by default** as an optional second layer for in-process sessions (it has no on-demand/cross-session API, no before-compact handling, and its spend is unledgered upstream).
6. **shift+tab**: reserved by `app.thinking.cycle`; a script-backed user rebind in `~/.pi/agent/keybindings.json` (`{"app.thinking.cycle":"alt+t"}`) + `/reload` frees it; the extension binds shift+tab only after rebind, with `alt+l` twin and `/titan-level` always working (pre-rebind, shift+tab remains the Pi thinking cycle — graceful, never a conflict).
7. **Structured output** = terminating `structured_output` tool registered by one new child-side extension (the only extension that does *not* early-return under `TITAN_HARNESS_CHILD=1`), parsed from the child JSON tool events — replicates pi-dw's terminating-tool schema without forking DW.
8. **Persons/mimeographs** = prompt overlays in `prompts/personas/*.md` applied via `--append-system-prompt`; callsigns + `anonymize` keep model identities hidden (existing mechanism, reused).
9. **Verification tiers T1–T6 + per-run hard-evidence manifest** with K-Dense confidence labels (`observed|inferred|declared`); fail-closed: missing/failed/unusable verification is never a confirming vote (Grok convention).
10. **Re-authoring & elevation = engine primitive** (`parent_run_id`, freeze-and-restart, journal counters), not a prompt convention; the n-of-3 CI/test loop is an `until_bash` + journal counter.
11. **InfraNodus enters as a package MCP catalog entry only** (`"pi":{"mcp":"./mcp/mcp.json"}` in package.json → `titan_harness__infranodus`) — verdict B: catalog entry / local dependency, zero native code.
12. **Simulated users**: Kane CLI headless is the primary runner (NDJSON + sealed `.evidence` pack), Orca browser commands the fallback/remote lane, Cursor cloud agents a `remote_agent` node, Momentic remains `disabled:true` until keyed.
13. **Fusion team (7 seats)** runs as titan children on the existing `/titan-fusion` plumbing (SHA-256 ACK sole-writer), degrading gracefully when a seat lacks credentials (Codex OAuth invalid, no OpenRouter key today).

## 2. Feature-by-feature integration table

| # | Brief item | Design | Where it lives | Reuse / build | Effective model · thinking (req → eff) | Acceptance test |
|---|---|---|---|---|---|---|
| B1 | Sidebar totals (token burn, cost, avg tps/agent, completion rate) | Ledger roll-up rendered as model-bar line 0 + monitor header, 1 Hz, try/catch progressive | `modules/ledger.ts` + `tui.ts` (`renderFooterWidget`) | **build** (ledger) / **reuse** (widget, `bumpSlotPerf`, before_provider_request→message_end tps clock) | n/a | Fixture run ⇒ bar shows Σ tokens, Σ $ (incl. watchdog rows), avg tps = Σout/ΣtpsSec, completion = done/(done+error+aborted); chain verifier passes |
| B2 | `/create-workflow` in clean context; xhigh frontier default; statusline shows harness config | Workflow-architect child, `context: fresh`, context pack = digests of person/org/repo (`vision.md`, `intent.md`, `CONTEXT.md`) + repo summary; statusline = model-bar line 1 (level/shape/fanouts/exa), live via `Symbol.for("titan-harness:shape-changed")` | `modules/workflows/author.ts`, cmd `/create-workflow` (alias `/titan-wf author`); skill `skills/titan-workflow-authoring/` | **build**; reuses `child-runner.ts`, `prompt-library.ts` | `openai-codex/gpt-6-astra` xhigh → xhigh; fallback `anthropic/claude-fable-5-1` xhigh → xhigh (if Codex OAuth invalid — loud bar note) | Author a workflow in a fresh session with no prior transcript; invalid OAuth ⇒ fable fallback + annotation; cycling level updates statusline immediately |
| B3a | Tier: web scraping / general (spec w/ verification; verify on successful DB ops) | Schema `verification_tier: T1`; verification = `script`/`bash` node asserting row counts/migrations with `output_format` | schema field + executor gates | **build** (tier check) / **reuse** (bash/script nodes) | tier default slots per active level | Scraping fixture: node fails ⇒ run red-flags `db_ops` evidence missing; node passes ⇒ `db_ops` observed row in manifest |
| B3b | Tier: research / planning (verify vs org/repo knowledge, vision.md, intent.md) | `T2` requires `knowledge_match` evidence: claim→file-digest links (observed); gated tighter once `/terraform` artifacts exist | `modules/evidence.ts` | **build** | `xai/grok-4.6` xhigh (research lanes lvl2/3) | Research run citing files hashes that digest-match; deleted file ⇒ inferred/Unverified flag ⇒ gate fails |
| B3c | Tier: prototyping / data analytics (spec+TDD; Cursor cloud SWE + test-suite authoring; **separate auditor** runs verification on completed work, loops findings to architect, **new full workflow** when findings; HARD EVIDENCE; suite per end device; n-of-3 → re-author with higher reasoning/deeper stack, smaller contexts, tighter phases) | `T3` DAG (full example §3): `author-suite` per `device` (desktop/mobile), `sim-run` (Kane headless + qwen scanners), `cursor-swe` (`remote_agent`), `audit` (auditor callsign, read-only, fresh session per round — existing `audit.ts` statuses/reuse), findings file → architect inbox; elevation via `elevation` node field + engine freeze/restart | `modules/workflows/executor.ts`, `modules/elevation.ts`, `audit.ts` (reuse), `scripts/cursor-agent.mjs`, skill `local-dev-verify` | **build** engine/elevation; **reuse** audit gate, callsigns | builder `anthropic/claude-fable-5-1` high → high (lvl3); auditor auto cross-family; auditor lanes `xai/grok-4.6` xhigh → xhigh (lvl3 verifiers) | Two-fail workflow bumps builder thinking; third CI fail ⇒ new run id with `parent_run_id`, smaller `fresh_context` scope, new phase count; auditor verdict references only manifest evidence ids |
| B3d | Tier: production SWE / automations (heavier test authoring + simulated user flows) | `T4` = T3 + mandatory Kane `--agent` user-flow run + video evidence type | schema + K-Dense-style evidence | **build** | as T3 + `xai/grok-4.6` high for curation lane | Run missing `video`/`screenshots` pack hash ⇒ `FAIL` + watchdog `complete-no-review`-class alert |
| B3e | Tier: platform update (highest; only simulated-user-tested functionality ships) | `T5`: `script` node computes ship set; assertion `shipped ⊆ simulated_passed` (exact-member check, Archon `archon-validate-pr` pattern); else verdict node unreachable | `scripts/ship-set.mjs` | **build** | `anthropic/claude-fable-5-1` xhigh signoff | Injecting an untested feature id into ship list ⇒ node fails, report lists diff |
| B3f | Tier: content (3× human-reviewed per industry/type/preset preset before agent review may ship) | `T6`: `approval` gate counting human passes keyed `industry:type:preset` in run ledger; counter ≥3 unlocks agent-review node | `modules/evidence.ts`, approval node | **build** | `openai-codex/gpt-6-astra` xhigh reviewer (fallback fable) | Preset with 2 passes ⇒ agent-review node skipped; after 3rd approval node runs |
| B4 | `/workflow-monitor` (side terminal; builders/subagents/reviewers; states dispatched-working, in-review, edit-round-<n>, done-verified, authoring-workflow, repairing-workflow + others; names; color dots; phase rail; Grok-CLI/Archon style) | State machine §5c; names = callsigns (anon); colors from K-Dense table; phase rail from workflow `phases`; compact 3-line in widget + full overlay; `--split` ⇒ `orca terminal split` + `node scripts/monitor-pipe.mjs <runId>` tailing `events.jsonl` | `modules/monitor.ts`; cmd `/workflow-monitor`; `scripts/monitor-pipe.mjs` | **build** on **reused** bar/overlay APIs | n/a | Fixture run transitions walk queued→dispatched-working→in-review→edit-round-1→done-verified with correct dots; overlay editor-input test (unfocus) passes; `--split` pane updates within 2 s |
| B5 | Watchdog (compaction: separate agent halts + inspects for hallucination/compaction loss, then clears logs OR resume prompt from the architect who dispatched the worker; fires on: complete-without-review, ping-without-review, stopped-without-review, pass-not-returned) | §5 full state machine; "clear" implemented as **logical clear** (fresh checkpoint session; old session kept + flagged `logical_cleared` — hash chain must not be rewritten) | `modules/watchdog.ts`, `prompts/WATCHDOG_INSPECT.md`, `prompts/RESUME_PROMPT.md`, child marker from `child-structured.ts` | **build**; reuses `audit.ts` spawn pattern, `READONLY_TOOLS`, `spawnIdentity` resume | inspector: same model as dispatching architect (per run); default `cerebras/qwen-3.8-27b` medium → medium (lvl2/3 lane) | Kill child mid-turn then trigger compact ⇒ run halts, inspect verdict `loss_detected`, resume child starts with checkpoint prompt; PASS-without-return ⇒ nudge fires within one poll cycle |
| B6 | `/ultraplan` (architect upgraded to multi-model fusion team while planning, /grill-with-docs approach; until user exits plan mode or satisfied; then workflow-architect runs `/create-workflow` with clarified shape + test constraints) | Plan phase: frontier-round interviews (`❓ Q1 … ➡️ recommendation`, grilling+domain-modeling pattern) run by fusion panel; exit = user `/ultraplan exit` or `satisfied` marker in journal; then author spec = harness-shape YAML (slots+communication rules) + phases + builder prompts + evidence/loop reqs | cmd `/ultraplan`; `modules/personas.ts`; skill `skills/ultraplan/`; feeds B2 author | **build** on **reused** `/titan-fusion` children + SHA-256 ACK | §4 fusion table (see below) | Plan interview shows numbered frontier; user exit stops panel (ledger shows partial round, no spend after exit); output spec validates via §3 validator |
| B7 | `/terraform` (originalize wayfinder: domain/org/audience/platform/infra/talent/financials/intent/vision/bias; ontologize; reasoning ontologies + KBs; author bias into work; spawns fusion team; docs + real-time data connectors + automations/roadmap + **autonomous workflow triggering if wanted**) | Wayfinder map (destination/notes/decisions/fog/scope) as `.titan/MAP.md` + tickets; ontology stage = `generate_ontology_graph` → `generate_contextual_hint` prepend to planner prompts → `optimize_reasoning` post-check (all via `titan_harness__infranodus` MCP tools); outputs: `vision.md`, `intent.md`, `docs/adr/*`, roadmap with trigger entries; **triggering = file-signal node + documented cron/spawn-inbox** (Pi has no scheduler — partial) | cmd `/terraform`; skill `skills/terraform/`; MCP entry in `mcp/mcp.json` | **build** on **reused** fusion plumbing; InfraNodus = external MCP only | fusion team of B8 | `/terraform` on empty repo produces MAP + docs + graph id; hint XML actually prepends to next `/ultraplan` planner prompt; missing `INFRANODUS_API_KEY` ⇒ declared-confidence fallback path taken |
| B8 | Fusion team comp + elevation defaults (1 fail→reasoning bump; 2 fails→max reasoning+max builder model; loops on CI, on functionality/design-intent proof, on no-issue-report) | Seven seats as titan children + judge + fuser; `elevation` schema field encodes the ladder; loop triggers = watchdog `fires` + `until_bash` | `modules/elevation.ts`, `modules/fusion.ts` (extends `cmd-fusion.ts`) | **build**; reuse fusion ack | architect `openai-codex/gpt-6-astra` xhigh; f1 `anthropic/claude-fable-5-1` xhigh; f2 `xai/grok-4.6` xhigh; f3 `antigravity/gemini-3.8-flash` xhigh→**high**; f4 `openrouter/meta/muse-spark-1.3` max (seat **disabled** until `OPENROUTER_API_KEY`); judge `antigravity/gemini-3.8-flash` xhigh→high; fuser `anthropic/claude-fable-5-1` xhigh | Ladder test: fail1 bumps thinking, fail2 swaps builder to max model, fail3 reauthors; panel of 4 still fuses when f4 disabled |
| B9 | `/local-dev-verify` (deploy locally; simulated agent users default `cerebras/qwen-3.8-27b`; scan site; video+screenshots; log snapshots; report → architect) | Skill-orchestrated: static/deploy via build, Kane headless primary, `orca tab goto/snapshot/screenshot/eval` fallback; qwen workers read via screenshot eval loop; reports = artifact + `evidence:{screenshots,video,logs}` rows | skill `skills/local-dev-verify/`; `scripts/simulated-user.mjs` | **build**; reuse child runner | qwen-3.8-27b high → high (workers), 131k ctx ⇒ fresh sessions per page batch | Running the skill against a fixture site yields ≥1 screenshot hash + report file in run dir + architect-inbox message |
| B10 | `/cloud-simulated-users` (multi-remote flows; connect-provider helper agent; stream data to monitors; inform workflow-architect) | Skill + provider-connect helper subagent (writes MCP/CLI/skill installs for KanE/TestMu/Momentic/Cursor); remote lanes post progress to `events.jsonl` (monitor picks up); architect gets a "remote-test interaction notes" artifact | skill `skills/cloud-simulated-users/`; `scripts/cursor-agent.mjs`; remote_agent executor | **build** | coordinator `xai/grok-4.6` high; lane runners per provider | Provider absent ⇒ helper produces install checklist + dry-run manifest; Cursor run streams ≥3 status events to monitor |
| B11 | shift+Tab levels 0–3 + fan-out defaults + live fusion-config update | §4 shapes + levels module; cycle writes `titan-harness.json` (single writer, extends the 3-file mirror discipline) and rebroadcasts `shape-changed` | `modules/levels.ts`, `scripts/keybindings-rebind.mjs`, shape files `~/.pi/titan-harness/model-stack-lvl0…3.yaml` | **build** on reused `cycleShape`/settings writers | per §4 normalization table | Pre-rebind: shift+tab still cycles thinking (Pi), `alt+l` cycles levels; post-rebind: shift+tab cycles levels; fanouts in `/stack status` match brief |
| B12 | Grok subagents analyzed Archon-derived YAML (DONE — analyst reports) | Consumed as input; no build; reports cited in §3/§5 design | repo `docs/analyst-reports/` (copy in) | **reuse** (done) | n/a | Reports committed; plan cites them |
| A1 | Archon: system prompt override | Already exists (`system_prompt`/`append_system_prompt` → `--system-prompt/--append-system-prompt`); exposed per-workflow-node as `systemPrompt` | `model-stack.ts` + schema | **reuse** | n/a | Node with `systemPrompt` ⇒ child argv contains `--system-prompt` |
| A2 | Structured output | Terminating `structured_output` tool (child ext) + `output_format` JSON Schema; up to 3 re-asks on validation miss (Archon Pi parity) | `extensions/titan-harness/child-structured.ts` (new child-visible file), `modules/workflows/structured.ts` | **build** (pattern = pi-dw) | n/a | Node with `output_format` returns only schema-valid object; bad JSON ⇒ re-ask ≤3 ⇒ node fail |
| A3 | NoSQL DB w/ hashed logs (or better) | JSONL+SHA-256 chain (recommended; §6) — *satisfied via better-DB recommendation* | `modules/{ledger,hashchain,provenance}.ts` | **build** | n/a | `scripts/verify-chain.mjs` passes on real run; tamper one byte ⇒ chain fails |
| A4 | Best-of-n | Engine pattern: N parallel siblings + judge node (pi-dw `judgePanel` / fusion-drive `best-of-n.js` transliterated; default N=4, 2–8) | `modules/workflows/patterns.ts` | **build** (port pattern) | candidates per node `model`, judge `anthropic/claude-fable-5-1` xhigh | best-of-n fixture: 4 candidates + 1 judge; winner delivered, all usage ledgered |
| A5 | Visual DAG builder + authoring skill | TUI: `/titan-wf ui` navigator (widget/overlay) renders ASCII DAG + node states + phase rail; export `mermaid`; authoring skill `titan-workflow-authoring`; **no drag-drop canvas** (TUI has no canvas API) — partial vs Archon Studio | `modules/monitor.ts` (shared renderer), skill | **build** (text-visual) | n/a | `/titan-wf ui` renders DAG live during run; mermaid export opens clean |
| A6 | YAML workflow validator | `modules/workflows/validator.ts`, rules §3.3; `/titan-wf validate <name> --json` | same | **build** | n/a | 12 rule fixtures each correctly error/warn; clean workflow ⇒ exit 0 |
| A7 | Hooks | Pi-flavored: `hooks.PreToolUse/PostToolUse` YAML → per-node tool gate enforced by `tool_call` event handler (in-process) **and** gate-rules JSON consumed by `child-structured.ts` (blocks with reason for children) — Archon SDK-hook matrix not portable (Claude-only); *partial* | `modules/workflows/hooks.ts` | **build** | n/a | Deny-`bash` hook ⇒ bash child call blocked with `permissionDecisionReason`; systemMessage injected post-Read |
| A8 | Lateral pass to clean context | `context: fresh` + artifact handoff rule ("the artifact you produce IS the spec for the next step"; next node reads artifact cold) | executor + `modules/workflows/artifacts.ts` | **reuse** of child fresh sessions; **build** artifact rule | n/a | Two-node chain: node2 transcript contains no node1 chat, does contain artifact bytes |
| A9 | Subagents allowed-tools y/n | Node `allowed_tools`/`denied_tools` (Pi names: `read, bash, edit, write, grep, find, ls` + our tools) → `childToolsFor()` argv `--tools`; blank = none | schema + `stack-config.ts` (reuse) | **reuse+build** | n/a | Node `allowed_tools: []` ⇒ child argv `--no-tools` |
| A10 | Subagents as interleaved reasoning | Pattern `interleave({parts, k})`: k parallel clean-context analysts over segregated slices → synthesis node; optional reauthor hook when synthesis < threshold | `modules/workflows/patterns.ts` | **build** (port pi-dw multi-perspective pattern) | analysts `antigravity/gemini-3.8-flash` high; synth `anthropic/claude-fable-5-1` xhigh | 3-slice fixture: synthesis cites all 3 slice artifacts; no cross-contamination in transcripts |
| A11 | Hypothesis-based workflow | Run-dir `hypotheses.jsonl` (id, claim, status, evidence links `supports|challenges|inconclusive|context`, `supersedes` append-only per K-Dense); `hypothesis`-style command node + report node | `modules/hypothesis.ts` | **build** (K-Dense schema) | n/a | Hypothesis gains 2 `supports` evidence links ⇒ status flips to supported in report |
| A12 | Multiple personas + mimeographs | `persona:` node field ⇒ `prompts/personas/<name>.md` overlay via `--append-system-prompt`; callsign kept; per-seat persona strings (fusion-drive precedent) | `modules/personas.ts`; files under `prompts/personas/` (`implementer`, `test-author`, `evidence-auditor`, `cursor-cloud-swe`, `contrarian`, …) | **build** | n/a | Same task under `contrarian` vs `implementer` personas ⇒ prompts differ by overlay text only (callsign unchanged) |
| A13 | InfraNodus MCP as local dependency | package.json `"pi":{"mcp":"./mcp/mcp.json"}` + catalog entry `infranodus` (stdio `npx -y infranodus-mcp-server`, env `INFRANODUS_API_KEY`); namespaced `titan_harness__infranodus` via pi-mcp-adapter 2.33.0 | `package.json`, `mcp/mcp.json`, `mcp/README.md` | **build** (manifest) / **reuse** adapter | n/a | `/mcp` lists `titan_harness__infranodus`; tools callable (with key) |
| G1 | Grok fill: Higgsfield guardrails on **both** skills + combos (brand-launch-kit step 2; triarc-creative-stack Motion stage); Macro Higgsfield rows → packs + vendor MCP docs | Edit both `higgsfield-media` skill bodies (forbid OpenRouter routing, forbid "5–8s looping Framer hero"); combo call-sites; macro rows cite `https://mcp.higgsfield.ai/mcp` + packs | `skills/higgsfield-media/`, `skills/brand-launch-kit/`, Grok plugin repo (triarc-creative-stack@1.0.0 Motion stage — **Grok plugin sync**) | **reuse** (edits) | n/a | Grep skills: no "OpenRouter" as Higgsfield route, no Framer-hero phrasing; Motion stage diff applied |
| G2 | `@higgsfield/cli` note (named, documented, not on PATH) | Named-link section in `mcp-cli-bridges` + `higgsfield-media` | skills | **edit** | n/a | Doc states: not installed; do not assert on PATH |
| G3 | mcp2cli disambiguation (Python knowsuchagency/uvx vs Rust mcp2cli.dev `link create`) | Callout block in `mcp-cli-bridges` | skill | **edit** | n/a | Both binaries documented separately with exact origins |
| G4 | Named-link docs (Kane, Framer agent, CLI) | `docs/named-links.md` + per-skill one-liners | docs | **build** | n/a | Each named link marked *documented, not installed* |
| G5 | DivMagic RAW skill (Chrome ext, not MCP) | New `skills/divmagic-raw/SKILL.md` (short; RAW = direct editor ops; explicitly not MCP) | new file | **build** | n/a | Skill loads in `/skills`; body states Chrome-extension surface |
| G6 | Tokens Studio / Untitled UI / 21st.dev mentions | One paragraph in `design-to-code-pipeline` + `skills/README.md` | skills | **edit** | n/a | All three named with their nature (plugin/site) |
| G7 | Macro scope fixes (no untitled/Pi-plugin/titan docs; only "What I Did Yesterday" + "Catch Me Up") | `macro-workspace` skill corrections | skill | **edit** | n/a | Skill body matches verified Macro surface |
| G8 | Verdict B scope (no mega-CLI; no Fusion merge; catalog+skills+named-links shape) | Architecture §1.11, §1.2; exclusions list kept | plan/repo | n/a | n/a | No new top-level CLI binary; Fusion Drive untouched |
| G9 | Ship list + pins intact | Pin-check at `session_start` (`pi-dynamic-workflows 3.10.1`, `pi-subagents 0.67.0`, `pi-mcp-adapter 2.33.0`, `pi-exa 0.6.1`, `pi-antigravity 0.7.2`, `@raindrop-ai/pi-agent 0.2.1`, `@signalridge/pi-codex-compact 1.3.1`); MCP enabled/disabled list unchanged | `modules/pins.ts` (new) + docs | **build** small | n/a | Bumped DW ⇒ boot warning + patch re-apply prompt; mcp.json enabled set matches brief |

## 3. YAML workflow schema proposal (Archon-compatible subset for Pi)

**3.1 Node types (exactly one per node).** Supported in v1: `prompt`, `command` (`.titan/commands/<name>.md`, `$ARGUMENTS` frontmatter parity), `bash`, `script` (inline or named, `runtime: bun` only in v1 — `uv` deferred), `loop` (`prompt`, `until` | `until_bash`, `max_iterations`, `fresh_context`), `approval` (`message`, `on_approve/on_reject`, `preset_key` for T6 counters), `cancel` (`reason`). **Titan-only addition:** `remote_agent: {provider: cursor, branch: true, artifact: screenshots}` (REST driver `scripts/cursor-agent.mjs`; idempotent `agentId = sha256(node identity)`). Deferred: `wait/file-signal` (P10+), `include`, child-`workflow`+`fan_out`.

**3.2 Base fields (Archon parity).** `id`; `depends_on: []`; `when` (compares only `output_format`-declared fields); `trigger_rule: all_success|one_success|none_failed_min_one_success|all_done` (default `all_success`); `idle_timeout` (ms, default 300000); per-node `model`, `context: fresh|shared` (default fresh for parallel layers, inherited sequential), `output_format` (JSON Schema), `allowed_tools` / `denied_tools` (Pi names), `retry {max_attempts:2, delay_ms:3000}` (**hard error** on `loop`), `systemPrompt`, `effort` alias of `thinking`.

**3.3 Titan extensions.**
- `role: architect|builder|worker|watchdog|verifier|auditor` — maps node → child slot family + callsign pool + tool contract (auditor ⇒ `READONLY_TOOLS`, fresh session per round — existing `audit.ts`).
- `persona`, `callsign` — §2 A12.
- `thinking` with normalization: effective = min(requested, provider ceiling); ledger + bar always show `requested → effective` (e.g. `xhigh → high`).
- `verification: {tier: T1..T6, evidence: [test_results|screenshots|video|logs|db_ops|review_verdict|knowledge_match|human_review], hard: bool}` — `hard: true` ⇒ missing evidence = `FAIL` (fail-closed).
- `evidence:` node-level emission spec (which kinds this node must produce; hashes captured at observation time).
- `elevation: {max_fails: 3, on_fails: [{fails, action: bump-thinking|max-model-builder|reauthor-workflow, smaller_context?: true, tighten_phases?: true}]}`.
- Workflow-level `watchdog: {model, thinking, fires: [complete-no-review, ping-no-review, stop-no-review, pass-not-returned], on_compaction: halt-inspect, resume_author: architect}`.
- Workflow header: `name` (slug = filename), `description`, `provider: pi`, `inputs`, `returns` (node id), `verification_tier` (nodes may only be stricter), `phases: [{title}]` (monitor rail).

**3.4 Validator rules** (`/titan-wf validate <name> --json`): (1) exactly one node-type field per node; (2) `id` unique, `^[a-z0-9][a-z0-9-_]{0,31}$`; (3) `depends_on` targets exist; (4) no cycles (topological sort); (5) `$id.output` / `$input.*` refs valid; `when:` only on `output_format` nodes; (6) `loop` needs `prompt` + `until|until_bash`, `max_iterations` 1–50, `retry` on loop = hard error; (7) `script` requires `runtime: bun`, named scripts exist in `.titan/scripts/` or `~/.titan/scripts/` with matching extension; (8) `approval.message` / `cancel.reason` non-empty; (9) `command` files exist (`.titan/commands/` → `~/.titan/commands/`); (10) `persona` files exist; `callsign` format ok; (11) `model` resolves in active shape pool or known provider list; `thinking` normalizes (else warn + record effective); (12) `verification.evidence` ⊆ enum; node tier ≥ workflow tier; (13) `returns` node exists; `watchdog.model` normalizes. Warnings (not errors): node > idle_timeout risk at 131k-ceiling models; `denied_tools` overlapping `allowed_tools`; `fresh_context: false` on qwen lanes.

**3.5 Complete example — `proto-analytics` (tier T3, prototyping / data analytics), ~60 lines:**

```yaml
# .titan/workflows/proto-analytics.yaml
name: proto-analytics
description: Build analytics prototype; external SWE + per-device suites + hard-evidence audit
provider: pi
verification_tier: T3
phases: [{title: Author}, {title: Build}, {title: Verify}, {title: Audit}]
inputs:
  feature: { required: true }
  device:  { default: desktop }       # desktop | mobile — one suite per end device
returns: signoff
watchdog:
  model: cerebras/qwen-3.8-27b
  thinking: medium                    # not counted in fan-out; 1 per builder
  on_compaction: halt-inspect
  resume_author: architect            # the architect who dispatched the worker
  fires: [complete-no-review, ping-no-review, stop-no-review, pass-not-returned]
nodes:
  - id: brief                         # lateral pass: clean-context architect
    command: proto-brief
    role: architect
    context: fresh
    output_format:
      type: object
      properties:
        spec_md: { type: string }
        acceptance: { type: array, items: { type: string } }
        seams: { type: array, items: { type: string } }
      required: [spec_md, acceptance, seams]
  - id: build
    depends_on: [brief]
    role: builder
    persona: implementer
    loop:
      prompt: Read the brief artifact. Implement the next unfinished seam.
      until: COMPLETE
      max_iterations: 12
      fresh_context: true
      until_bash: "bun run build && bun test"
    allowed_tools: [read, bash, edit, write, grep, find, ls]
  - id: author-suite                  # test-suite-authoring agent, per device
    depends_on: [build]
    role: worker
    persona: test-author
    prompt: >
      Author the $input.device suite from $brief.output.acceptance: user flows,
      perf budgets, UI assertions. Runnable specs under tests/$input.device/.
  - id: sim-run                       # local simulated users (default qwen) + Kane
    depends_on: [author-suite]
    script: |
      import { runSimulatedUsers } from '../scripts/simulated-user.mjs'
      console.log(JSON.stringify(await runSimulatedUsers({ device: $input.device })))
    runtime: bun
    timeout: 900000
    evidence: [screenshots, logs, video]
    output_format:
      type: object
      properties: { pass: { type: boolean }, url: { type: string } }
      required: [pass]
  - id: cursor-swe                    # SWE verified by Cursor cloud agents
    depends_on: [sim-run]
    remote_agent: { provider: cursor, branch: true, artifact: screenshots }
    prompt: Reproduce the acceptance list against the built app; fail loudly on any miss.
  - id: audit                         # SEPARATE auditor runs verification, loops findings
    depends_on: [sim-run, cursor-swe]
    role: auditor                     # read-only, fresh session per round
    output_format:
      type: object
      properties:
        status: { type: string, enum: [PASS, FAIL] }
        findings: { type: array, items: { type: string } }
        evidence_refs: { type: array, items: { type: string } }
      required: [status, findings]
    verification:
      tier: T3
      evidence: [test_results, screenshots, logs, db_ops, review_verdict]
      hard: true                      # missing evidence = FAIL
    elevation:
      max_fails: 3                    # n-of-3 CI/test loop, then re-author
      on_fails:
        - { fails: 1, action: bump-thinking }
        - { fails: 2, action: max-model-builder }
        - { fails: 3, action: reauthor-workflow, smaller_context: true,
            tighten_phases: true }
  - id: signoff                       # review-before-report: only reachable on PASS
    depends_on: [audit]
    when: "$audit.output.status == 'PASS'"
    role: architect
    prompt: Summarize hard evidence for $input.feature; file any open findings.
```

## 4. Harness levels & shapes

**4.1 Shape files** (bare slot list, existing schema; new optional `lane:` field, validator-tolerated; saved to `~/.pi/titan-harness/model-stack-lvlN.yaml`).

`model-stack-lvl0.yaml` — **ultrafast** (fan-out: 5 workers / 5 Exa):
```yaml
- name: rune      # architect + live primary
  model: cerebras/qwen-3.8-27b
  thinking: xhigh              # requested xhigh → EFFECTIVE high (ceiling)
  architect: true
  primary: true
  color: "#22d3ee"
- name: forge
  model: cerebras/qwen-3.8-27b
  thinking: high
  color: "#38bdf8"
- name: clerk-1   # worker lane (qwen, as brief)
  model: cerebras/qwen-3.8-27b
  thinking: high
  lane: worker
  color: "#60a5fa"
```

`model-stack-lvl1.yaml` — **brain + ultrafast workers** (5/5):
```yaml
- name: rune
  model: antigravity/gemini-3.8-flash
  thinking: high               # xhigh requested family would cap here; brief says high
  architect: true
  primary: true
  color: "#34d399"
- name: forge
  model: cerebras/qwen-3.8-27b
  thinking: high
  color: "#38bdf8"
- name: clerk-1
  model: cerebras/qwen-3.8-27b
  thinking: high
  lane: worker
  color: "#60a5fa"
```

`model-stack-lvl2.yaml` — **automated/trigger jobs, operations, research, entity-aware strategy, data analysis, deep research + finding elevations** (builders/worker/watchdog/Exa 5 each; watchdogs not in fan-out, 1 per builder):
```yaml
- name: rune
  model: openai-codex/gpt-6-astra      # on trigger: architect authors w/ verification+recovery
  thinking: high
  architect: true
  primary: true
  color: "#f472b6"
- name: forge
  model: xai/grok-4.6
  thinking: xhigh                        # effective xhigh
  color: "#fb923c"
- name: anvil
  model: xai/grok-4.6
  thinking: xhigh
  color: "#f97316"
- name: clerk-1
  model: antigravity/gemini-3.8-flash
  thinking: high
  lane: worker
  color: "#60a5fa"
- name: sentry-1    # lane: watchdog ×5 — 1 per builder, excluded from fan-out count
  model: cerebras/qwen-3.8-27b
  thinking: medium
  lane: watchdog
  color: "#facc15"
```

`model-stack-lvl3.yaml` — **SWE / system architecture / entity-aware / data analysis / deep research** (fan-out **3/5/5/5/10** = builders/workers/watchdogs/verifiers/Exa, in brief's enumeration order; TUI plan defaults to `/ultraplan`; no `/terraform` ⇒ boot notice to run it):
```yaml
- name: rune        # architect / workflow author
  model: openai-codex/gpt-6-astra
  thinking: xhigh                       # fallback anthropic/claude-fable-5-1 xhigh until /login openai-codex
  architect: true
  primary: true
  color: "#f472b6"
- name: forge       # builders: fable-5.1 high (3)
  model: anthropic/claude-fable-5-1
  thinking: high
  color: "#fb923c"
- name: clerk-1     # workers: gemini high (5)
  model: antigravity/gemini-3.8-flash
  thinking: high
  lane: worker
  color: "#60a5fa"
- name: quarry-1    # alt brief listing: workers/database ops/findings-curation = grok high
  model: xai/grok-4.6
  thinking: high
  lane: worker
  color: "#f59e0b"
- name: sentry-1    # lane: watchdog (5)
  model: cerebras/qwen-3.8-27b
  thinking: medium
  lane: watchdog
  color: "#facc15"
- name: probe-1     # verifiers: grok-4.6 xhigh (5)
  model: xai/grok-4.6
  thinking: xhigh
  lane: verifier
  color: "#c084fc"
- name: scouter-1   # Exa lanes (10): worker children carrying the 4 pi-exa tools
  model: cerebras/qwen-3.8-27b          # cheapest valid key; operator-overridable
  thinking: medium
  lane: exa
  color: "#2dd4bf"
```

**4.2 Requested → effective thinking table** (`modules/thinking-normalize.ts` ceiling map; every spawn annotated `requested → effective` in ledger × bar × monitor):

| requested | cerebras/qwen-3.8-27b (ctx 131k) | antigravity/gemini-3.8-flash | xai/grok-4.6 | anthropic/claude-fable-5-1 | openai-codex/gpt-6-astra | openrouter/meta/muse-spark-1.3 |
|---|---|---|---|---|---|---|
| off/low/medium/high | as requested | as requested | as requested | as requested | as requested | as requested |
| xhigh | **high** (ceiling) | **high** (ceiling) | xhigh | xhigh | xhigh (OAuth currently invalid → shape falls back) | xhigh (seat inactive — no key) |
| max | high (ceiling) | high (ceiling) | high (ceiling) | max | max | max (seat inactive — no key) |

**4.3 Hotkey plan.** (a) `scripts/keybindings-reback.mjs` — idempotent merge into `~/.pi/agent/keybindings.json`: `{"app.thinking.cycle":"alt+t"}` (backup `.bak`, `--restore` flag), then user runs `/reload`; extension binds `shift+tab` via `registerShortcut` **only after** the rebind (Pi's `runner.js` reserved-binding check would otherwise drop it). (b) Always-available twins: `alt+l` level cycle, `/titan-level [0-3|next]` (Kitty-free terminals); existing `alt+h` (shape cycle), `alt+n/alt+s/alt+a` unchanged. (c) Level switch = single settings writer updating `~/.pi/agent/titan-harness.json` (+ mirrored `subagents.globalConcurrencyLimit`, workflows `defaultConcurrency ≤16`) then `Symbol.for("titan-harness:shape-changed")` broadcast → bar/monitor/fusion config update live.

## 5. Verification, evidence & elevation ladder

**5.1 Evidence schema** (rows in `evidence/manifest.jsonl`, blobs content-addressed under `evidence/blobs/<sha256>` — K-Dense pattern):
`{evidence_id, run_id, node_id, callsign, kind ∈ {test_results, screenshots, video, logs, db_ops, knowledge_match, review_verdict, human_review, artifacts_hash}, source: {tool|command, path|url}, sha256 (file bytes or canonical-JSON digest), size, captured_at, confidence ∈ {observed, inferred, declared}, identityAt: live|harvest, staleness: Current|Stale|Unverified, claims: [{assert, status: accepted|rejected|inconclusive}]}`. **Hard-evidence rule:** screenshots are PNG bytes hashes (never descriptions); logs = hash of transcript slice; db_ops = script-node stdout conforming to a row-count schema; `review_verdict` = auditor YAML verdict; the `observed vs declared` provenance rule (§6.4) applies.

**5.2 Tier requirements.** T1 scraping/general: `[logs, db_ops]` (verify on successful db ops). T2 research/planning: `[review_verdict, knowledge_match]` vs `vision.md`/`intent.md`/org-repo digests (tightens after `/terraform`). T3 prototyping/analytics: `[test_results, screenshots(per device), logs, db_ops, user_flow_video, review_verdict]` + separate-auditor-loop (findings → architect → **new full workflow**). T4 production: T3 + Kane simulated-user-flow pack. T5 platform: T4 + ship-set ⊆ simulated-passed (exact membership). T6 content: `human_review` ×3 keyed per `industry:contentType:preset` before agent review may ship.

**5.3 Review-before-report rule.** Any `returns`/signoff node pre-checks the manifest: every tier-required kind present with `confidence ∈ {observed, inferred}` and `staleness: Current`; missing ⇒ node `FAIL` (fail-closed) and watchdog `complete-no-review` fires. Agents cannot self-certify: only engine observations write rows.

**5.4 n-of-3 loop → re-authoring escalation.** Journal counters per `(feature, tier)`. fail 1 ⇒ `bump-thinking` (next run spawns builder at next ceiling-safe level). fail 2 ⇒ builder at **max reasoning + max model** in its family. fail 3 (CI/test) ⇒ engine **freezes** the run (`status: reauthored`), records `parent_run_id`, invokes re-authoring (`/create-workflow` with inputs = findings doc + failing evidence + constraints: higher reasoning, deeper stack, more `fresh_context: true` nodes, phase split). Auxiliary loops: functionality/design-intent proof loop (verifier re-runs specific claims; watchdog `pass-not-returned` nudges on silence), no-issue-report loop (no report ⇒ re-dispatch with report-mandate).

**5.5 Watchdog state machine.** States: `idle → armed(per run) → triggered → inspecting → {clean ⇒ continue | finding ⇒ act | stalemate ⇒ human}`; actions: `continue` (annotate ledger), `clear-resume` (fresh checkpoint session from last verified artifact; old session flagged `logical_cleared`, bytes preserved for hash chain), `architect-relaunch` (resume prompt authored by the **architect model that dispatched the worker**, via `prompts/RESUME_PROMPT.md`; builder session resumed via `sessionRef` or restarted fresh). Triggers: (1) compaction — child-side marker + parent detection via child JSON stream and 5 s poll of `{type:"compaction"}` entries (in-host, we can fully use `session_before_compact` `{cancel}` + inspect); (2) workflow completed without a review; (3) worker/builder ping to architect without a review (ping = artifact-inbox file, must carry a verdict ref); (4) agent stopped with no review (`agent_end`/child-exit watcher); (5) review PASS with nothing returned to architect (1-cycle silence check). **Stalemate:** identical finding identity (`sha256` of canonical `{category, node_id, callsign, signature}`) ≥ 3 times (matches pi-subagents `stalemateRepeats:3`) ⇒ run halted, monitor shows `stalemate`, human required. Inspector input capped (diff 24k, transcript tail, evidence slice) mirroring the proven watchdog bounds; inspector spend ledgered under `role: watchdog` (fixing the upstream unledgered gap). Watchdog lane model per §4 (default qwen medium); escalation inspector (resume author) = the dispatching architect's slot.

**5.6 Verification-node plug-ins.** *Kane CLI*: `kane-cli run "<objective>" --headless` (exit 0/1) and `--agent` NDJSON (`run_end {status, summary, final_state, test_url}`); hash the sealed `.testmuai/evidence/` checksums file → `artifacts_hash` + annotated screenshots. *TestMu MCP* (`titan_harness__testmu`, already enabled): verifier-lane MCP calls for suite triage/console/network log inspection → `review_verdict` input. *Momentic*: stays `disabled:true`; opt-in `video`/trace evidence for T5 when `MOMENTIC_API_KEY` set + enabled. *Cursor cloud agents*: `remote_agent: cursor` node — `POST /v1/agents` (branch via `repos[].startingRef`, `agentId` = identity hash for idempotency), poll `GET /v1/agents/{id}/runs/{runId}`, download `artifacts` (screenshots), usage → ledger `provider: "cursor"` (external billing tagged); fail-soft: no `result` + artifacts ⇒ evidence `missing`, never a confirming vote. *Orca*: `orca tab create|goto|snapshot|click|fill|screenshot|eval` as the local browser lane (Kane fallback) and the remote tab driver inside `/cloud-simulated-users`; all captures hashed at observation time.

## 6. Data & logging

**6.1 Store decision.** Recommend **JSONL + SHA-256 chain** (K-Dense precedent). vs SQLite (Archon): transactional queries but *no documented hash/digest layer*, new binary dependency, migration baggage. vs embedded NoSQL: fresh engine dependency, no local precedent, weaker tamper-evidence. JSONL is append-only, hash-chained, offline-verifiable, zero-dep, and script-queryable (`.ts` nodes can read natively); SQLite can be grafted later for reporting without touching the chain. *Operator decision point* — default JSONL.

**6.2 Layout.** `~/.pi/titan-harness/runs/<projectSlug>-<cwdSha12>/<runId>/`: `run.json` (atomic, status `pending|running|reauthored|completed|failed|reauthored|aborted|stalemate`), `events.jsonl` (engine events: node_start/end, state transitions — the monitor consumes this directly), `ledger.jsonl` (cost, §6.3), `evidence/manifest.jsonl` + `evidence/blobs/<sha256>`, `journal.jsonl` (elevation/stalemate/reauthor records, `parent_run_id`), `artifacts/nodes/<id>.md` + `.meta.json` (Archon artifact-handoff shape), `hypotheses.jsonl`. Global index: `~/.pi/titan-harness/ledger/index.jsonl`, chain row = `{seq, prev_sha, sha (canonical-JSON, sorted keys), ts, run_id, role, ...}`.

**6.3 Cost ledger schema.** `{ts, run_id, node_id, agent_id, callsign, role ∈ {architect, builder, worker, watchdog, verifier, auditor, judge, fuser, exa, compute, remote}, model, provider, authType, tokens: {prompt, completion, cacheRead, cacheWrite, total}, costUsd, origin {source: tps-aggregate|child-usage|remote-api|watchdog, schedule?}}`. Includes **watchdog spend** (explicitly, unlike both precedents) and remote (Cursor) usage with `billingMode: external`. Children: input+cache consumed from child JSON `usage` (existing `child-runner` absorption); host: `message_end` usage (existing `bumpSlotPerf` path).

**6.4 Provenance rules.** Rows derived **from observation only** — the engine writes from `tool_execution_end`/child tool events + post-call byte hashing; **no agent tool can write the ledger/evidence** (K-Dense rule). `observed` = tool named the path and bytes hashed after; `inferred` = bash command mention / scan window; `declared` = model assertion (allowed only as a claim, never as evidence; reviewers see the label). Harvested identities ⇒ `identityAt: harvest`, `staleness: Unverified`; never silently re-label current as historical; violations degrade visibly (`unhashed`, `truncatedEdges` flags, cf. K-Dense).

**6.5 Sidebar totals derivation.** Top of bar/monitor: total token burn = Σ `tokens.total` (host + children + watchdog + remote token estimates); cost = Σ `costUsd`; avg tps per agent = per-agent Σ `output / tpsSeconds` averaged (child tps excludes tool time — segment re-opens at tool end; host clock = `before_provider_request → message_end`, never `message_start`); completion rate = agents reaching `done-verified|done-unverified` ÷ spawned (both ratio and `done-verified` % shown). Recomputed on ledger append, rendered at the existing 1 Hz tick inside the try/catch (progressive enhancement — never breaks the session).

## 7. Delivery plan

| Phase | Scope | Files touched | Tests | Acceptance | Effort | Deps |
|---|---|---|---|---|---|---|
| **P0 — Prerequisites & pins** | Operator: `/login openai-codex`; decisions: OpenRouter key, `INFRANODUS_API_KEY`, keybind rebind consent, JSONL-DB ratification, lvl3 fanout-order confirmation, Cursor key. Pin audit; DW 3.10.1 patch state | `scripts/apply-dw-patch.mjs`, `modules/pins.ts` (boot pin check) | pin-check unit | All 7 pins green; astra slots enabled in bar after login | S | — |
| **P1 — Grok-review gap-fill (its own early phase; ships 0.2.1)** | Higgsfield guardrails both skills + combos (brand-launch-kit step 2; triarc-creative-stack Motion stage — Grok plugin sync), Macro Higgsfield rows (packs + `https://mcp.higgsfield.ai/mcp`), `@higgsfield/cli` note, mcp2cli Python-vs-Rust callout, named-link docs, DivMagic RAW skill, Tokens Studio/Untitled UI/21st.dev mentions, Macro scope fixes | `skills/{higgsfield-media,brand-launch-kit,macro-workspace,mcp-cli-bridges,design-to-code-pipeline}`, new `skills/divmagic-raw/`, `docs/named-links.md`; Grok plugin repo (Motion stage) | skill frontmatter lint; greppable guardrail assertions | All G1–G9 edits verifiable by grep; no behavior change; `0.2.1` tag | S–M | P0 (docs only) |
| **P2 — Ledger, evidence, provenance** | `ledger.ts`, `hashchain.ts`, `provenance.ts`, run-dir layout, role tagging incl. watchdog/remote, `scripts/verify-chain.mjs` | new modules; `child-runner.ts` (usage emit), `tui.ts` (bar line 0) | unit: chain verify/tamper; integration: fixture child run | B1 totals live; chain tamper detected; provenance labels correct | M | P0 |
| **P3 — YAML engine core** | schema/validator/scheduler/executor; node types incl. loop/approval/cancel; artifacts (`nodes/<id>.md`+`.meta.json`); structured output child ext; hooks gate; `childToolsFor` wiring; `/titan-wf run|list|validate|ui` | `modules/workflows/{schema,validator,scheduler,executor,artifacts,structured,hooks}.ts`, new `extensions/titan-harness/child-structured.ts` | validator rule fixtures (13 rules); executor against stub child (HarnessDeps seam); structured-output re-ask test | Fixture DAG runs end-to-end via real `pi -p` children; validator parity with §3.4 | L | P2 |
| **P4 — `/create-workflow` + clean-context architect + statusline** | Author child (fresh session, context pack), fallback chain (astra→fable with loud note), statusline live config | `modules/workflows/author.ts`, `prompts/WORKFLOW_ARCHITECT.md`, `tui.ts` | author golden-file test (clean-context assertion: no prior entries in child session) | B2 acceptance | M | P3 |
| **P5 — `/workflow-monitor`** | state machine renderer (17-state vocabulary, K-Dense colors, callsign names, phase rail); widget block; opt-in overlay (`ctx.ui.custom` + `handle.unfocus`); `--split` Orca path | `modules/monitor.ts`, `scripts/monitor-pipe.mjs` | state-transition fixture; overlay unfocus smoke (TUI) | B4 acceptance (true side terminal = opt-in, documented limitation) | M | P3 |
| **P6 — Watchdog** | compaction detection (stream+poll+child marker), 4 review-gate triggers, inspect child (`WATCHDOG_INSPECT.md`), clear-resume vs architect-relaunch (`RESUME_PROMPT.md`), stalemate, ledgered spend; optional pi-subagents `subagents.watchdog` second layer (documented, off) | `modules/watchdog.ts`, prompts, `child-structured.ts` (marker), `titan-harness.json` schema | chaos fixture: kill child + compact; PASS-without-return; ping-without-review; stalemate ×3 | B5 acceptance; inspector spend appears in ledger | M–L | P2, P3 |
| **P7 — Levels 0–3, shapes, normalization, hotkeys** | 4 shape files, `levels.ts` single-writer switch, thinking normalizer + annotations, fanout settings (`builderFanOut` ↑10, `workerFanOut/watchdogFanOut/verifierFanOut/exaFanOut`), keybind rebind helper + shift+tab/alt+l, lvl3 `/ultraplan`-default + `/terraform`-absent notice | `modules/levels.ts`, `modules/thinking-normalize.ts`, `scripts/keybindings-rebind.mjs`, STACK_DIR files, `stack-config.ts` | shape-load unit ×4; normalizer table tests; rebind idempotency + restore | §4 table matches bar/monitor exactly; pre/post-rebind behavior per §4.3 | M | P2, P5 |
| **P8 — `/ultraplan` fusion + `/terraform` + InfraNodus** | 7-seat fusion panel (degrade when seat uncredentialed), grill-with-docs frontier rounds, plan-exit semantics, shape+comm-rules+prompts+evidence output spec; wayfinder MAP + ontology stages via `titan_harness__infranodus` (generate_ontology_graph → generate_contextual_hint → optimize_reasoning) w/ declared-confidence fallback; personas pack; package `pi.mcp` manifest + catalog entry | `modules/fusion.ts`, `modules/personas.ts`, `hypothesis.ts`, cmds `/ultraplan` `/terraform`, `skills/{ultraplan,terraform}`, `mcp/mcp.json`, `package.json` | persona overlay diff test; panel degrade test (f4 off); ontology hint prepend test | B6/B7/B8/A12/A13 acceptance | L | P4, P6; keys (P0) |
| **P9 — Verification tiers & simulated users** | T1–T6 enforcement, elevation engine (freeze/restart, `parent_run_id`), per-device suite nodes, ship-set membership, T6 human-pass counters; `/local-dev-verify` + `/cloud-simulated-users` skills; `scripts/{simulated-user,cursor-agent}.mjs`; remote_agent executor | `modules/elevation.ts`, `modules/evidence.ts`, skills, scripts | n-of-3 escalation test; tier-missing-evidence fail-closed ×6; Kane dry-run; Cursor auth-absent fail-soft | B3a–f, B9, B10 acceptance | M | P3, P6 |
| **P10 — Archon-13 completion, docs, ship** | best-of-n + interleave + interleave-reauthor patterns, hook matrix docs, `/titan-wf ui` DAG renderer + mermaid export, README/INSTALL/skills rewrite, pins doc, changelog, **0.3.0** tag; DW patch re-apply verified; Grok plugin sync final | `modules/workflows/patterns.ts`, `modules/monitor.ts`, docs, `package.json` version | full fixture suite (13 workflow end-to-end); pin check | A1–A13 acceptance (A5 visual = text-visual, documented partial); tag `0.3.0` | M | P3–P9 |

## 8. Risks, unknowns, and minority positions

**Risks & mitigations (≥8):**
1. **Codex OAuth invalid** — every `gpt-6-astra` slot (lvl2/3 architect, author default) dead until `/login openai-codex`. Mitigation: auto fallback `anthropic/claude-fable-5-1` xhigh + persistent bar warning; shape validator skips unauthed slots (existing `cycleShape` skip logic).
2. **No OpenRouter key** — `muse-spark-1.3` fusion seat and OR-routed gemini unavailable. Mitigation: panel degrades to 4 seats with ledger note; key = P0 decision.
3. **shift+tab rebind** touches a reserved user binding; extension shortcut is silently dropped pre-rebind (Pi diagnostic). Mitigation: script with backup/restore; `alt+l`/`/titan-level` always work; never auto-run without consent.
4. **Overlay API experimental** (disposed on close; mouse only in fullscreen; TUI-only). Mitigation: default monitor = belowEditor block; overlay opt-in via `--rich`; guard `ctx.mode === "tui"`.
5. **DW 3.10.1 pin + volatile dist patch** (wiped on `pi update --extensions`; 3.11 crashes). Mitigation: runtime independence (engine never calls DW); pin check at `session_start`; re-apply script; upstream symbol hook filed/awaited.
6. **Cross-process compaction visibility** — child compaction may not appear in the JSON stream. Mitigation: 5 s poll of child session dir for `{type:"compaction"}` + child-side marker; host path uses real `session_before_compact`; worst case = post-hoc inspect + architect-relaunch (repair, not prevention).
7. **Fan-out cost blowout** (lvl3 steady state = 3+5+5+5+10 = 28 children + watchdogs). Mitigation: per-node `maxBudgetUsd`-style caps → child `usageBudget`, launch-time spend gate (refuse over cap, K-Dense pattern), `held-spend` state, cost on bar line 0.
8. **Cursor cloud agents**: auth/env, one-active-run-per-agent, external billing unclear. Mitigation: `remote_agent` fail-soft (missing verification is not a vote), dry-run manifest mode, `billingMode: external` ledger tagging; key = P0 decision.
9. **InfraNodus key absent; 14-day trial keys; hosted-vs-stdio choice**. Mitigation: capability-gated ontology stage with `declared`-confidence fallback to local `vision.md`/`intent.md`/`CONTEXT.md`.
10. **"n Exa agents" is semantically fuzzy** (Exa is 4 tools, not a model). Mitigation: defined as worker children carrying the 4 `pi-exa` tools with per-lane caps; explicit P0 operator confirmation.
11. **qwen 131k ceiling at lvl0/ultrafast** — architect may compact mid-plan on large repos. Mitigation: fresh-context phases everywhere, artifact handoff, `/ctx` only on ≥272k slots, watchdog compaction repair; plan docs state the ceiling.
12. **Two-engine confusion** (DW JS vs titan YAML). Mitigation: engine separation (titan reads only `.titan/workflows/*.yaml`), README decision table, no runtime coupling.
13. **Auth-pending MCPs** (Figma DCR 403, TestMu OAuth) block some evidence sources. Mitigation: evidence kinds degrade to logs/screenshots-only with `missing` flags, never auto-PASS.

**Operator must decide/provide:** (a) `/login openai-codex`; (b) `OPENROUTER_API_KEY` (fusion-4 seat); (c) `INFRANODUS_API_KEY` (trial at infranodus.com/api-access — note: key currently sits only in Claude Code's `~/.claude.json`, never printed); (d) keybinding rebind consent (`alt+t` → thinking cycle); (e) DB ratification (JSONL default); (f) Cursor API key + target `env{type,name}`; (g) lvl3 fan-out mapping 3/5/5/5/10 order confirmation + Exa-lane model default; (h) Momentic enable (`MOMENTIC_API_KEY`) for T5 video; (i) keep DW dist patch vs await upstream hook.

**Minority positions (disagreements with the brief/precedents, and why):**
- **"Side terminal"**: I lead with in-process (widget + overlay), making `orca terminal split` the opt-in. A hard Orca dependency in the primary monitor path over-reaches for a component Pi can render well in-process; the brief's literal pane is only ~20% of the feature value.
- **DB**: brief says "NoSQL database with hashed logs (or a better DB)". I recommend **no database** — JSONL+hash chain beats both named options on integrity and dependency cost; I'm not shipping "NoSQL".
- **Visual DAG builder**: no drag-drop canvas in a TUI extension; I ship ASCII/mermaid + live navigator and mark the item *partial* rather than promising Archon-Studio parity.
- **muse-spark-1.3 seat**: shipping a seat that cannot authenticate is dead surface; I make panel membership credential-gated (degrade, warn) instead of hard-coding 7 seats that may silently be 5.
- **lvl3 dual worker listing**: the main and alternate listings conflict (gemini-high workers vs grok-high db/curation); I resolve via role-routed lanes (`clerk` vs `quarry`) available together, defaulting lanes per node `role`, instead of a global model swap the operator must flip.
- **Autonomous workflow triggering** (`/terraform`): Pi has no scheduler; I ship file-signal nodes + documented cron/spawn-inbox and mark triggering *partial* — claiming native autonomous triggers would be a false surface.
- **Log "clearing" on compaction**: literal deletion of the inspected agent's session contradicts tamper-evident provenance; I implement logical clearing (fresh checkpoint session + `logical_cleared` flag, bytes preserved) — a deliberate deviation from the brief's wording.

## 9. Requirements trace

| Brief item (as numbered in §2) | Satisfied by | Status |
|---|---|---|
| B1 sidebar totals | §1.3, §2-B1, §6.5, P2/P5 | ✅ |
| B2 /create-workflow (xhigh, clean ctx, statusline) | §2-B2, §4.2, P4, §8 risk 1 | ✅ (default model contingent on Codex re-login; fallback shipped) |
| B3a scraping/general tier | §2-B3a, §5.2, P9 | ✅ |
| B3b research/planning tier (vision.md/intent.md) | §2-B3b, §5.2, P8, P9 | ✅ |
| B3c prototyping/analytics (Cursor, suite authoring, separate auditor, hard evidence, per-device, n-of-3 → re-author) | §3.5, §5.4, §5.6, P3/P9 | ✅ |
| B3d production SWE (simulated user flow) | §5.2 T4, P9 | ✅ |
| B3e platform update (sim-tested-only ships) | §5.2 T5, `scripts/ship-set.mjs`, P9 | ✅ |
| B3f content 3×-human-review presets | §5.2 T6, P9 | ✅ |
| B4 /workflow-monitor (states, colors, phase rail, side terminal) | §1.3, §2-B4, §5.5, P5 | ⚠️ **partial**: true side terminal via opt-in Orca (no Pi pane API); all states/colors/rail in-process |
| B5 watchdog (compaction halt/inspect, clear-or-resume via architect model; 4 trigger classes) | §1.5, §5.5, P6 | ✅ (deviation: logical-clear not byte deletion — §8 minority 7) |
| B6 /ultraplan (fusion planning, grill-with-docs, exit semantics, then author) | §2-B6, §7 P8 | ✅ |
| B7 /terraform (wayfinder originalization, ontology, docs, connectors, roadmap, autonomous triggers) | §2-B7, P8 | ⚠️ **partial**: autonomous triggering = file-signal/cron (no Pi scheduler); connectors keyed to existing MCP lanes |
| B8 fusion team roster + elevation defaults (1→bump, 2→max, CI/proof/report loops) | §4.1, §5.4, P8 | ⚠️ **partial at runtime**: f4 seat inactive until OpenRouter key (degrades by design) |
| B9 /local-dev-verify (local deploy, qwen sim-users, video/screenshots, reports) | §2-B9, §5.6, P9 | ✅ |
| B10 /cloud-simulated-users (multi-remote, connect-helper, monitor streaming, architect inform) | §2-B10, §5.6, P9 | ✅ (Cursor key = P0 decision) |
| B11 shift+Tab levels 0–3 (models, thinking, fan-outs, Exa) | §4, §1.6, P7 | ✅ (rebind = human step with script; twin keys unconditional) |
| B12 Grok subagents analyzed Archon YAML (DONE) | §2-B12 (reports committed as design input) | ✅ (no build required) |
| A1 system prompt override | §3.2, §2-A1 (existing flags) | ✅ |
| A2 structured output | §2-A2, §1.7, P3 | ✅ |
| A3 NoSQL DB with hashed logs (or better) | §6.1, P2 | ✅ via recommended alternative (JSONL+SHA-256 chain); SQLite left as optional graft |
| A4 best-of-n | §2-A4, P10 | ✅ |
| A5 visual DAG builder + authoring skill | §2-A5, P10, §8 minority 3 | ⚠️ **partial**: text/mermaid DSL + live navigator + authoring skill; no canvas |
| A6 YAML workflow validator | §3.4, P3 | ✅ |
| A7 hooks | §3.3, §2-A7, P3/P10 | ⚠️ **partial**: Pi-flavored tool gates (Archon's Claude SDK hook matrix not portable) |
| A8 lateral pass to clean context | §2-A8, §3.2 (`context: fresh`), P3 | ✅ |
| A9 subagents allowed-tools y/n | §2-A9, §3.2, P3 | ✅ |
| A10 interleaved reasoning (clean-context shards → whole-synthesis → reauthor) | §2-A10, P10 | ✅ |
| A11 hypothesis-based workflow | §2-A11 (K-Dense hypothesis schema), P8 | ✅ |
| A12 personas + mimeographs over fusion | §1.8, §2-A12, P8 | ✅ |
| A13 InfraNodus MCP as local dependency | §1.11, §2-A13, P8 | ✅ (key = P0 decision; no native code, per verdict B) |
| G1–G7 Grok-review gap-fill items | §2 G1–G7, **P1 (0.2.1)** | ✅ |
| G8 verdict B scope (catalog + skills + named links; no mega-CLI / no fusion merge) | §1.2, §1.11, P10 | ✅ |
| G9 ship list + pins intact | §1.2, P0, P10 | ✅ |

*End of ultraplan — seat 1.*