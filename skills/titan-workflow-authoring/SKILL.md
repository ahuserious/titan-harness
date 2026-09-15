---
name: titan-workflow-authoring
description: How to write, validate and run a titan-harness YAML workflow (apiVersion titan.harness/v1) — the Archon-compatible DAG of prompt/command/bash/script/loop/approval nodes with titan roles, evidence and hooks. Use when asked to create or edit a workflow under .titan/workflows, when a /workflow validate run reports errors, or when deciding how to split a job into nodes.
---

# titan-workflow-authoring

A workflow is one YAML file, `.titan/workflows/<name>/<name>.yaml` (project) or
`~/.pi/titan-harness/workflows/<name>/<name>.yaml` (user); the package ships two under
`.pi/titan-harness/workflows/`. Command files live next to it in `commands/<name>.md`,
named scripts in `scripts/`. Project shadows user shadows package.

## Shape of a workflow
```yaml
apiVersion: titan.harness/v1
name: classify-and-fix            # must equal the directory name
description: one line
version: 1
inputs:
  issue: { required: true }       # $inputs.issue
returns: create-pr                # RunResult.returns = that node's output
nodes:
  - id: fetch-issue
    bash: "gh issue view $inputs.issue --json title,body,labels"
  - id: classify
    depends_on: [fetch-issue]
    prompt: "Classify this issue: $fetch-issue.output"
    model: cerebras/qwen-3.8-27b
    allowed_tools: []
    output_format: { type: object, properties: { issue_type: { type: string, enum: [bug, feature] } }, required: [issue_type] }
  - id: investigate
    depends_on: [classify]
    when: "$classify.output.issue_type == 'bug'"
    prompt: "Investigate the bug described in $ARTIFACTS_DIR/nodes/fetch-issue.md …"
```
Exactly one node-type key per node: `command` · `prompt` · `bash` · `script` · `loop` ·
`approval` · `cancel` · `verify` · `best_of` · `interleave` · `hypothesis` · `mcp_tool` ·
`workflow`. Everything else on a node is a base field (`depends_on`, `when`,
`trigger_rule`, `role`, `model`, `thinking`, `context`, `output_format`, `allowed_tools`,
`hooks`, `evidence`, `review`, `on_fail`, …). Full field reference: `references/schema.md`.

## The rules that decide whether it runs (see `references/rules.md`)
1. Nodes hand off through **artifacts**: every node writes `artifacts/nodes/<id>.md`; a
   downstream prompt reads it (`$ARTIFACTS_DIR/nodes/<id>.md`) or references
   `$<id>.output` — never the upstream transcript. `context: fresh` is the default.
2. `when` may only read nodes that declare `output_format` (structured JSON output).
3. `role: architect` nodes are `prompt` / `command` / `approval` only, read-only tools
   (`read, grep, find, ls`); the validator injects `denied_tools: [write, edit, bash]`.
4. `role: builder` nodes default to `review: required` → an `auditor`-role or `verify`
   node must sit between them and `returns`.
5. Cheap model for glue (`cerebras/qwen-3.8-27b`, `allowed_tools: []` on pure-text
   nodes); strong model for substance.
6. `loop.max_iterations` ≤ 10 with `until` and/or `until_bash`; `retry` on a loop is an error.
7. Failed deps: `trigger_rule: all_success` (default) skips the node when a dependency
   failed or was skipped — use `one_success` after a `when` fork, `all_done` for cleanup.

## Run and validate
- `/workflow validate <name> [--json]` — every validator rule with node ids; fix errors, then re-run until clean (warnings are allowed).
- `/workflow run <name> [--input k=v]... [--args "text"] [--dry-run]` — `--dry-run` prints the layer plan only.
- `/workflow graph <name>` — Mermaid of nodes and edges; `/workflow list`, `/workflow status [runId]`, `/workflow stop`.
Runs land in the run store (`~/.pi/titan-harness/runs/<project>/<runId>/`): `run.json`,
hash-chained `events.jsonl` / `ledger.jsonl`, `artifacts/nodes/*.md`.

## Worked examples
`references/examples.md` walks through the two shipped workflows: `classify-and-fix`
(the Archon canonical example ported to Pi: bash → structured classify → `when` fork →
`one_success` join) and `proto-analytics-dashboard` (level 3: architect spec map →
builders → TDD loop with elevation → two verifiers → cross-family audit → gated report).
