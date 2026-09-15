# Authoring rules (Archon doctrine as titan enforces it)

## 1. Commands are prompts, not code
A `command:` node names `commands/<name>.md` next to the workflow. The file is the prompt
the agent runs (frontmatter `description` / `argument-hint` is stripped; `$ARGUMENTS`
and the other variables are substituted). Put the *what* and the *acceptance criteria*
in the command; leave the *how* to the model. Anything deterministic (fetching, parsing,
formatting, running tests) is a `bash:` or `script:` node — no model, no cost, no drift.

## 2. The artifact is the spec for the next step
Every node's output is written to `$ARTIFACTS_DIR/nodes/<id>.md` (structured output as
JSON, otherwise the final text). A downstream node with `context: fresh` (the default)
has **no memory** of what happened upstream: it sees only what its prompt contains and
what it reads from `$ARTIFACTS_DIR`. So:
- lead every downstream prompt with "Read `$ARTIFACTS_DIR/nodes/<id>.md` …" or inline
  `$<id>.output` / `$<id>.output.<field>`;
- make the upstream node *write the spec the next node needs* (a plan, a file list, a
  test matrix), not a chat summary;
- the executor hands over the artifact, never the transcript — this is what keeps a
  10-node workflow from accumulating 10 contexts' worth of noise.
`context: shared` resumes the previous node's session in the same chain (forbidden in a
parallel layer); `context: { resume: <id> }` resumes a named node's session.

## 3. Cheap models for glue, strong models for substance
Classification, routing, formatting, short summaries: `model: cerebras/qwen-3.8-27b`
(or any authed fast model) with `allowed_tools: []`. Reserve the architect/builder
models for the nodes that produce code, plans or long analysis. Prefer `role:` over
`model:` — a role resolves model, thinking, callsign and system prompt from the live
shape (`/titan-shape`), so the workflow ports between levels without edits.

## 4. `allowed_tools: []` on pure-text nodes
A node that only transforms text needs no tools: `allowed_tools: []` removes the tool
overhead and the temptation to wander the repo. A node with `output_format` still gets
the `submit_result` tool (that is how structured output is returned), nothing else.
`denied_tools` removes named tools; `allowed_tools` is an allowlist. Hooks
(`hooks.PreToolUse` deny matchers) are the fine-grained version: the tool exists but a
matching call is blocked with a reason the model sees.

## 5. The architect never writes
`role: architect` nodes may only be `prompt`, `command` or `approval`, with read-only
tools (`read`, `grep`, `find`, `ls`). The validator rejects `bash`, `script`, `workflow`,
`verify`, `loop`, `best_of`, `interleave`, `mcp_tool` under that role, rejects
`allowed_tools` containing `write` / `edit` / `bash`, and injects
`denied_tools: [write, edit, bash]`. Inside the child, `write`/`edit`/write-capable
`bash` calls are blocked at `tool_call` as a second line. Planning, spec maps,
arbitration and reports are architect work; building is a builder's.

## 6. Review before report
A `role: builder` node defaults to `review: required`: somewhere between it and the
`returns` node there must be an `auditor`-role node (a cross-family, read-only, fresh
session that emits the audit-verdict YAML — `output_format: { $ref:
"titan://schemas/audit-verdict" }`) or a `verify` node (an external runner with hashed
evidence). The builder never negotiates with the auditor: a failed audit goes to the
architect (`on_fail: { action: reauthor }`), a mechanical failure loops at most
`loop.max_iterations` times and then `on_fail: { action: elevate }` fires (thinking bump
→ max model → freeze + escalation report in `artifacts/escalation-report.md`).

## 7. Evidence is observed, never declared
`evidence.produces: [test-log]` on a node is a promise the run store checks by hashing
bytes after tool calls; `verify` nodes need a non-empty `evidence.require`. A sentence
"tests passed" without a hashed log is a watchdog blocker. The tier
(`titan.tier`) lists the kinds a run must produce; the validator checks statically that
some node produces each of them.

## 8. Routing and joins
- `when:` compares `$<id>.output[.field]` refs with literals (`==`, `!=`, `<`, `>`,
  `<=`, `>=`), combined with `&&`, `||`, parentheses. Any unresolved ref → false (fail
  closed). It may only reference nodes with `output_format`.
- After a `when` fork, join with `trigger_rule: one_success` (one branch ran) or
  `none_failed_min_one_success`; `all_done` runs cleanup/`cancel` regardless.
- `all_success` (default) skips the node when any dependency failed or was skipped.

## 9. Hooks on Pi
Only `PreToolUse`, `PostToolUse` and `Stop` with **static** responses. `matcher` is a
regex on the tool name, anchored and case-insensitive (`Bash` matches Pi's `bash`;
`Write|Edit` matches both). `permissionDecision: deny` (and `ask`, which a headless
child cannot answer) block the call with the reason; `updatedInput` replaces the
arguments; `additionalContext` / `systemMessage` are appended to the tool result as
`[hook] …` lines; `continue: false` blocks **and terminates** the child. A `Stop` rule
with `continue: false` terminates at the next matching tool call (Pi has no cancellable
stop event). `submit_result` is exempt from hooks.

## 10. Structured output
`output_format` is a JSON schema (or `$ref: titan://schemas/audit-verdict`). The node's
prompt gets the schema appended; the child gets a terminating `submit_result` tool whose
parameters are the schema; the result is validated and re-asked up to 3 times with the
errors before the node fails. Only nodes with `output_format` may be read by `when:`.

## 11. Keep it small
Ids: `^[a-z0-9][a-z0-9-_]{0,31}$`, unique. Names: `^[a-z0-9][a-z0-9-]{0,63}$`, equal to
the directory. `budget.max_concurrent_children` ≤ 16, `titan.level` 0–3,
`best_of.n` 2–8, `interleave.segments` 2–16, `on_reject.max_attempts` 1–10. Unknown
top-level or node keys are warnings; `steps:` is an error ("use nodes:"); Claude-only
keys are ignored with a warning; `provider` is absent or `pi`.
