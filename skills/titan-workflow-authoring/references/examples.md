# The two shipped workflows

Both live in the package under `.pi/titan-harness/workflows/<name>/<name>.yaml` and are
visible from every project as `source: package` (`/workflow list`); a project or user
workflow with the same name shadows them. Both validate clean with the shipped validator
(a test asserts it). Run `/workflow graph <name>` to see either as a Mermaid flowchart.

## 1. `classify-and-fix` — the Archon canonical example, ported to Pi

The reference DAG from Archon's spec: fetch an issue, classify it with a cheap model into
a structured verdict, fork on the verdict, join with `one_success`, ship. The port keeps
the Archon shape and changes only what Pi needs: `apiVersion: titan.harness/v1`,
`provider: pi`, `model: cerebras/qwen-3.8-27b` instead of `haiku`, and inline `prompt:`
nodes instead of `command:` files so it runs without a `commands/` directory.

```
$ARGUMENTS ─▶ fetch-issue ($ bash) ─▶ classify (✎ prompt, output_format) ─┬─▶ investigate (when bug)     ─┐
                                                                           └─▶ plan        (when feature) ─┴─▶ implement (one_success) ─▶ create-pr
```

Node by node:
- **`fetch-issue`** — `bash: "gh issue view $ARGUMENTS --json title,body,labels"`,
  `timeout: 15000`. No model. `$ARGUMENTS` comes from `/workflow run classify-and-fix
  --args 123` (or the bare trailing text) and is shell-escaped. stdout is JSON, so
  `$fetch-issue.output` is the parsed object.
- **`classify`** — `prompt: "Classify this issue: $fetch-issue.output"`, `model:
  cerebras/qwen-3.8-27b`, `allowed_tools: []`, `output_format` with
  `issue_type: enum [bug, feature]`. Cheap model, no tools, structured answer: the
  runtime exports the schema to the child (`TITAN_NODE_SCHEMA` + `TITAN_NODE_RESULT_PATH`)
  and adds a terminating `submit_result` tool whose parameters are that schema; its
  recorded object (or, as the fallback, the JSON in the answer text) is validated and
  re-asked up to 3 times. This is the only node `when:` may read.
- **`investigate`** — `when: "$classify.output.issue_type == 'bug'"`, `context: fresh`.
  Skipped (not failed) on a feature. Gets the issue inline (`$fetch-issue.output`, the
  parsed JSON) — it has no memory of the classify node — and is told to write its
  findings to `$ARTIFACTS_DIR/investigation.md` (Summary, Root cause, Affected files,
  Proposed fix, Verification) without implementing anything.
- **`plan`** — the mirror branch, `when: … == 'feature'`; writes `$ARTIFACTS_DIR/plan.md`.
- **`implement`** — `depends_on: [investigate, plan]`, `trigger_rule: one_success`:
  exactly one branch ran and the other was skipped, so the default `all_success` would
  skip this node too. Its prompt says so explicitly ("exactly one of them exists, and
  you have no memory of how it was produced"), implements on a new branch, runs the
  tests and writes `$ARTIFACTS_DIR/implementation.md`.
- **`create-pr`** — sequential, fresh context: reads `implementation.md`, opens the PR
  with `gh pr create` referencing `#$ARGUMENTS`, replies with the PR URL only — which
  is what `returns: create-pr` hands back as the run's result.

What to copy from it: the bash→structured→`when` fork→`one_success` join pattern, the
cheap classify node, and named artifact files as the only hand-off (each prompt says
which file to write and which to read; the executor also stores every node's output as
`artifacts/nodes/<id>.md`).

## 2. `proto-analytics-dashboard` — a level-3 `prototype-analytics` run (plan §3.5)

A full titan run: architect spec map → builders (a pool callsign and a TDD loop) →
two verifiers in parallel → cross-family audit → gated report. `returns: report`.
`phases: plan · build · verify · audit · report`; every node names its phase, so the
graph renders as five subgraphs.

```yaml
inputs:
  spec:   { required: true }                 # path to spec.md  → $inputs.spec
  design: { default: design/dashboard.png }  # design-matching reference
titan:
  level: 3
  shape: level-3
  tier: prototype-analytics
  modes: [spec, design, test]
  elevation: default            # 1 bump thinking · 2 max model · 3 re-author at level+1
  watchdog: { enabled: true, stalemate_repeats: 3, on_compaction: halt-inspect }
  budget: { usd: 25, max_concurrent_children: 8, context_budget: 120000 }
```

Node by node:
- **`spec-map`** (`role: architect`, phase plan) — reads the spec and emits a
  feature/acceptance matrix as `output_format: { features: array, tests: array }`.
  Architect ⇒ `prompt` only, `allowed_tools: [read, grep, find, ls]`; the validator
  injects `denied_tools: [write, edit, bash]` and the child blocks any write at
  `tool_call`. The architect never writes.
- **`test-suite`** (`role: builder`, `callsign: pool`, phase build) — authors the
  failing suite for `$spec-map.output.tests`, one per device; `evidence: { produces:
  [test-log] }` is a promise the store checks by hashing the log. `callsign: pool`
  leaves the callsign to the shape: the node runs under the seat its role resolves to
  (the primary builder here) and reports with that seat's callsign.
- **`implement`** (`role: builder`, `review: required`) — a `loop`: implement the next
  failing feature from `$spec-map.output.features`, run the suite, stop on
  `<promise>COMPLETE</promise>` or when `until_bash: "bun test"` exits 0,
  `max_iterations: 3`, `fresh_context: true`. `on_fail: { action: elevate, max: 3 }`
  fires only after the mechanical budget is spent: thinking bump → max model → freeze
  + `artifacts/escalation-report.md` (one counter, D11).
- **`cursor-verify`** and **`kane-flows`** (phase verify, both `depends_on:
  [implement]`) — `verify` nodes with `runner: cursor-cloud` (run the suite, capture
  screenshots) and `runner: kane` (a sim user: "filter by region and export CSV" on
  desktop + mobile, headless). Each declares non-empty `evidence.require`
  (`test-log, screenshot` / `screenshot, console-log, evidence-pack`). Until P4 lands
  the runners are stubs that fail with "not implemented until P4" — the shape is what
  matters: the builder's work is verified by something that is not the builder.
- **`audit`** (`role: auditor`, `trigger_rule: all_done`, `context: fresh`) — runs
  whatever the verifiers did; audits `$ARTIFACTS_DIR/evidence` against the spec, the
  design and org rules; `output_format: { $ref: "titan://schemas/audit-verdict" }`
  (verdict PASS · PASS_WITH_WARNINGS · FAIL · INCONCLUSIVE · SAFETY · SCOPE_VIOLATION).
  `on_fail: { action: reauthor }`: findings go to the architect, never back to the
  builder. This is the `auditor` node that satisfies `review: required` on `implement`.
- **`report`** (`role: architect`, `when: "$audit.output.status == 'PASS'"`) — the
  acceptance report citing the sha256 of every artifact. Skipped unless the audit
  passed, so `returns` is empty on a failed run — by design.

What to copy from it: roles instead of models, `callsign: pool`, a bounded TDD loop
with `until` + `until_bash`, two independent verifiers joined by `all_done`, a
cross-family auditor with the audit-verdict schema, and a `when`-gated final node.

## Running them
```
/workflow validate classify-and-fix
/workflow run classify-and-fix --args 123
/workflow run proto-analytics-dashboard --input spec=docs/spec.md --dry-run
/workflow status
```
