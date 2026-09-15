# Workflow schema reference — `apiVersion: titan.harness/v1`

Source of truth: `extensions/titan-harness/modules/workflow/schema.ts` (types) and
`validator.ts` (rules). Errors stop `/workflow run`; warnings are printed and the run proceeds.

## Top level (`WorkflowDoc`)
| key | type | notes |
|---|---|---|
| `apiVersion` | `titan.harness/v1` | required, exact |
| `name` | string | `^[a-z0-9][a-z0-9-]{0,63}$`, **equal to the directory name** |
| `description` | string | shown by `/workflow list` |
| `version` | number | your own version of the file |
| `inputs` | `{ <key>: { required?, default?, description? } }` | `$inputs.<key>` / `$input.<key>`; required inputs without a default must be passed with `--input key=value` |
| `returns` | node id | `RunResult.returns` = that node's output; must exist |
| `phases` | `[{ title, detail? }]` | node `phase` values must be one of these titles when declared |
| `provider` | `pi` | absent or `pi` (Archon's `claude`/`codex` are rejected) |
| `model` | `provider/id` | default model for AI nodes without `role`/`model` |
| `thinking` | `off · minimal · low · medium · high · xhigh · max` | default thinking; above a model's ceiling → warning `requested X / effective Y` |
| `trigger` | `{ cron? \| every? \| event?, entity_profile? }` | level-2 jobs (P9); parsed, not yet scheduled |
| `titan` | see below | harness-level settings for the run |
| `nodes` | `NodeDoc[]` | non-empty; `steps:` is an error |

### `titan`
| key | type | notes |
|---|---|---|
| `level` | 0–3 | harness level for the run |
| `shape` | codename | `~/.pi/titan-harness/model-stack-<shape>.yaml` |
| `tier` | string | verification tier (P4): its required evidence kinds must be `produces`d by some node; `platform-update` ship nodes need a sim-user `verify` ancestor |
| `modes` | `[spec \| design \| test]` | |
| `evidence` | `{ require?: kind[], dir? }` | |
| `elevation` | `default` or `{ fail_1?, fail_2?, fail_3? }` | the ladder after `loop.max_iterations` is exhausted |
| `watchdog` | `{ enabled?, model?, thinking?, cadence_tools?, stalemate_repeats?, on_compaction?: halt-inspect \| summary-only \| off, inspector_timeout_ms? }` | P5 |
| `budget` | `{ usd?, tokens?, max_concurrent_children? (≤ 16), context_budget? }` | `max_concurrent_children` caps parallel nodes (default: `/stack concurrency`) |
| `personas` | string[] | P7 |

## Node base fields (`NodeBase`, every node type)
| key | type | notes |
|---|---|---|
| `id` | string | `^[a-z0-9][a-z0-9-_]{0,31}$`, unique |
| `depends_on` | id[] | must resolve; the graph must be acyclic |
| `when` | expression | `$id.output[.field] (== \| != \| < \| > \| <= \| >=) literal`, `&&`, `\|\|`, parentheses; only over nodes with `output_format`; false/unresolved → node **skipped** |
| `trigger_rule` | `all_success` (default) · `one_success` · `none_failed_min_one_success` · `all_done` | join semantics over `depends_on` |
| `idle_timeout` | ms | AI streaming idle timeout / per loop iteration |
| `timeout` | ms | bash/script wall-clock (default 120000) |
| `retry` | `{ max_attempts? (default 2), delay_ms? (default 3000) }` | **error on `loop` nodes** |
| `phase` | title | must exist in `phases` when declared |
| `role` | `architect · builder · worker · verifier · auditor · watchdog · fusion · judge · fuser` | resolves model/thinking/callsign/system prompt from the live shape; `architect` is read-only by construction |
| `callsign` | `pool` or a name | unique per document |
| `persona`, `mimeograph` | string | P7 |
| `tier` | string | per-node tier override |
| `evidence` | `{ produces?: kind[], require?: kind[] }` | observed, hashed by the store |
| `review` | `required · optional · none` | default `required` for `role: builder` → needs an `auditor`/`verify` descendant before `returns` |
| `on_fail` | `{ action: retry \| elevate \| reauthor \| cancel, max? }` | `retry` = same as `retry`; `cancel` cancels the run; `elevate`/`reauthor` fail the run with `elevation: <id> failed N times` + `artifacts/escalation-report.md` (freeze semantics land in P4) |
| `watchdog` | `{ policy?: inherit \| off \| strict }` | |
| `budget` | `{ usd?, tokens? }` | |
| `context_budget` | tokens | the authoring architect splits nodes that exceed it |
| `isolation` | `none · worktree` | opt-in worktree per node |
| `anonymize` | boolean | callsign-only prompts |
| `model` | `provider/id` | must be in Pi's registry (unknown → error, unauthed → warning) |
| `thinking` | level | above the ceiling → warning |
| `context` | `fresh` (default) · `shared` · `{ resume: id }` | `shared` resumes the previous node's session (error in a parallel layer) |
| `output_format` | JSON schema or `{ $ref: "titan://schemas/audit-verdict" }` | structured output: schema appended to the prompt + `submit_result` tool; validated, re-asked ≤ 3 times |
| `allowed_tools` | tool[] | allowlist over `read, bash, edit, write, grep, find, ls` (+ extension tools); `[]` = no tools |
| `denied_tools` | tool[] | removed from the list |
| `system_prompt` | string | replaces the child's system prompt |
| `append_system_prompt` | string or string[] | appended |
| `hooks` | `{ PreToolUse?, PostToolUse?, Stop? }` of `{ matcher?, response }` | static responses only; other events → warning "ignored on Pi" |
| `mcp` | string[] | MCP servers to expose |
| `skills` | string[] | skills to load |
| `subagents` | `{ enabled?, tools?, cap? }` | `enabled: false` ⇒ no `subagent` tool |
| `output_type` | string | free tag on the artifact meta |

### `hooks.<event>[].response`
`hookSpecificOutput: { hookEventName?, permissionDecision?: deny | allow | ask,
permissionDecisionReason?, updatedInput?, additionalContext? }`, `systemMessage?`,
`continue?` (false = stop), `stopReason?`, `decision?: approve | block`.
See rules.md §9 for what each does on Pi.

## Node types (exactly one per node)
| key | payload | output (`$id.output`) |
|---|---|---|
| `command` | `commands/<name>.md` file name | final text, or the JSON object with `output_format` |
| `prompt` | inline prompt text | same |
| `bash` | shell script (`bash -c`); `$…` substitutions are single-quote shell-escaped | stdout, trailing newline trimmed, JSON-parsed when it looks like JSON; non-zero exit → failed |
| `script` + `runtime: bun \| uv` (+ `deps` for uv) | inline code (any newline/metachar) or a named file in `scripts/` (`.ts/.js` → bun, `.py` → uv); substitutions are raw | same as bash |
| `loop` | `{ prompt, until?, until_bash?, max_iterations (1–10), fresh_context?, interactive?, gate_message? }` | last iteration's text; stops when `<promise>UNTIL</promise>` (or the bare token) appears or `until_bash` exits 0; `interactive` asks the user each iteration (`gate_message` required) and passes the answer as `$LOOP_USER_INPUT` |
| `approval` | `{ message, capture_response?, on_reject?: { prompt, max_attempts? (1–10, default 3) }, preset_key? }` | `{ approved, response? }`; rejected + `on_reject` → runs the prompt (with `$REJECTION_REASON`) then asks again; headless → rejected |
| `cancel` | reason string | ends the run as `cancelled` with the reason |
| `verify` | `{ runner: kane \| testmu \| momentic \| cursor-cloud \| orca-browser \| bash, objective?, devices?, headless?, command?, repo?, ref?, … }` + non-empty `evidence.require` | P4 (stub: failed "not implemented until P4") |
| `best_of` | `{ n (2–8), judge?, criteria?, prompt }` | P4 stub |
| `interleave` | `{ segments (2–16 or string[]), by?: files \| sections \| hypotheses, synthesize?, reauthor?, prompt }` | P4 stub |
| `hypothesis` | `{ hypotheses: [{ id, claim, predicts? }], decide_by }` | P4 stub |
| `mcp_tool` | `{ server, tool, args? }` | the tool's result (failed when the host has no MCP bridge) |
| `workflow` | `{ name, fan_out?: { source, as, join? }, isolation?: worktree }` | the child run's `returns` |

AI nodes (`command`, `prompt`, `loop`, `best_of`, `interleave`, `hypothesis`) accept the
AI fields (`model`, `thinking`, `context`, `output_format`, tools, prompts, hooks, …);
on `bash`/`script` they are ignored with a warning.

## Variables (substituted in `prompt`, `command` bodies, `loop.prompt`, `bash`, `script`, `when`)
`$ARGUMENTS` (`--args`), `$ARTIFACTS_DIR`, `$WORKFLOW_ID`, `$RUN_ID`, `$BASE_BRANCH`,
`$CONTEXT`, `$LOOP_USER_INPUT`, `$REJECTION_REASON`, `$LOOP_COUNT`,
`$inputs.<key>` / `$input.<key>`, `$<id>.output`, `$<id>.output.<field>[.<field>]`.
Objects render as JSON (pretty in prompts); bash mode shell-escapes every value; script
mode inserts raw values; unknown refs are left as-is and reported.

## Validator rules in one list
apiVersion · name pattern + directory · provider · non-empty nodes · unique ids · one
type key · `depends_on` resolvable · acyclic · `$id.output` refs known · `when` only
over `output_format` nodes and parseable · `trigger_rule` enum · `script.runtime` +
named script exists with a matching extension (`deps` + bun → warning) · no `retry` on
loop · `approval.message` / `cancel` non-empty · `on_reject.max_attempts` 1–10 ·
`loop.max_iterations` 1–10 with `until`/`until_bash` · interactive loop needs
`gate_message` · `steps:` rejected · phase titles exist · architect nodes read-only
(type and tools; `denied_tools` injected) · builder `review: required` reaches an
auditor/verify before `returns` · tier evidence produced · verify has runner + evidence ·
`best_of.n` 2–8 · `interleave.segments` 2–16 · hypothesis ≥ 1 + `decide_by` · callsigns
unique · model known (unauthed → warning) · thinking ceiling → warning · hooks static,
three events only · `context: shared` not in a parallel layer ·
`budget.max_concurrent_children` ≤ 16 · `titan.level` 0–3 · platform-update ship nodes
need a sim-user verify ancestor · `returns` exists · unknown keys → warnings.
