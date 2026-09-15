# Archon YAML DAG spec excerpts (local skill docs: /home/danbot/skill-workshop/neuro-quant-agent-skills-main/neuro-code/archon/references/workflow-dag.md)

## Node types + base fields (lines 105-232)
## Node Types (Mutually Exclusive)

Each node must have exactly ONE of these fields: `command`, `prompt`, `bash`, `script`, `loop`, `approval`, or `cancel`.

### Command Node
Runs a command file from `.archon/commands/`:
```yaml
- id: investigate
  command: investigate-issue         # Loads .archon/commands/investigate-issue.md
```

### Prompt Node
Runs an inline AI prompt:
```yaml
- id: classify
  prompt: |
    Analyze this issue and classify it.
    Issue: $ARGUMENTS
```

### Bash Node
Runs a shell script without AI:
```yaml
- id: fetch-data
  bash: |
    gh issue view 123 --json title,body,labels
  timeout: 30000                    # ms, default: 120000 (2 min)
```

- Script runs via `bash -c`
- **stdout** captured as node output (available as `$fetch-data.output`)
- **stderr** forwarded as warning, does not fail the node
- No AI invoked — AI-specific fields are ignored
- Use `timeout:` (milliseconds) for execution time limit
- `$nodeId.output` substitutions are **auto shell-quoted** (safe to embed)

### Script Node
Runs TypeScript/JavaScript (via `bun`) or Python (via `uv`) without AI. Same stdout/stderr contract as bash nodes.

**Inline script (TypeScript):**
```yaml
- id: parse
  script: |
    const raw = process.argv.slice(2).join(' ') || '{}';
    const data = JSON.parse(raw);
    console.log(JSON.stringify({ items: data.items?.length ?? 0 }));
  runtime: bun                      # REQUIRED: 'bun' or 'uv'
  timeout: 30000                    # ms, default: 120000
```

**Inline script (Python) with uv dependencies:**
```yaml
- id: fetch
  script: |
    import httpx, json
    r = httpx.get("https://api.github.com/repos/anthropics/anthropic-cookbook")
    print(json.dumps({ "stars": r.json()["stargazers_count"] }))
  runtime: uv
  deps: ["httpx>=0.27"]             # Optional — 'uv run --with <dep>'. Ignored for bun.
```

**Named script from `.archon/scripts/`:**
```yaml
- id: analyze
  script: analyze-metrics           # Resolves .archon/scripts/analyze-metrics.py
  runtime: uv                       # Must match file extension (.ts/.js → bun, .py → uv)
  deps: ["pandas>=2.0"]
```

- **Inline vs named**: a `script` value is treated as inline code if it contains a newline or any shell metacharacter (space, or any of: `;` `(` `)` `{` `}` `&` `|` `<` `>` `$` `` ` `` `"` `'`). Otherwise it's a named-script lookup (bare identifier).
- **Named script resolution**: `<cwd>/.archon/scripts/` (wins) → `~/.archon/scripts/`. 1-level subfolder grouping allowed. Extension determines runtime (`.ts`/`.js` → `bun`, `.py` → `uv`) and MUST match the declared `runtime:`
- **Dispatch**:
  - `bun` + inline → `bun --no-env-file -e '<code>'`
  - `bun` + named → `bun --no-env-file run <path>`
  - `uv` + inline → `uv run [--with dep ...] python -c '<code>'`
  - `uv` + named → `uv run [--with dep ...] <path>`
- **`deps`** is uv-only. Bun auto-installs on import; `deps` with `runtime: bun` emits a validator warning
- **stdout** captured as `$nodeId.output` (trailing newline trimmed)
- **stderr** forwarded as warning, does NOT fail the node. Non-zero exit DOES fail it.
- **`bun --no-env-file`** prevents target repo `.env` from leaking into the subprocess
- `$nodeId.output` substitutions are **NOT shell-quoted** in script bodies — assign directly (`const data = $nodeId.output;`) or parse with `JSON.parse` / `json.loads`; don't interpolate into shell syntax
- **CAUTION — `String.raw\`$nodeId.output\`` is fragile**: if the substituted value contains a backtick (common in AI-generated markdown, `output_format` payloads, or any content with code spans), the template literal terminates early and produces a cryptic `Expected ";"` parse error. Use direct assignment instead — JSON is valid JS expression syntax and needs no wrapper.
- AI-specific fields (`model`, `provider`, `hooks`, `mcp`, `skills`, `output_format`, `allowed_tools`, `denied_tools`, `agents`, `effort`, `thinking`, `maxBudgetUsd`, `systemPrompt`, `fallbackModel`, `betas`, `sandbox`) emit a loader warning and are ignored

### Loop Node
Iterates an AI prompt until a completion signal or max iterations:
```yaml
- id: implement
  depends_on: [setup]
  idle_timeout: 600000              # Per-iteration idle timeout (ms)
  loop:
    prompt: |
      Read the PRD and implement the next unfinished story.
      When all stories are done: <promise>COMPLETE</promise>
    until: COMPLETE                 # Completion signal string
    max_iterations: 10              # Hard limit — node fails if exceeded
    fresh_context: true             # true = fresh session each iteration
    until_bash: "bun run test"      # Optional: exit 0 = complete
```

See the dedicated **Loop Nodes** section below for full details.

## Node Base Fields

All node types share these fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | **required** | Unique node identifier |
| `depends_on` | string[] | `[]` | Node IDs that must settle before this node runs |
| `when` | string | — | Condition expression. Node **skipped** when false |
| `trigger_rule` | string | `all_success` | Join semantics for multiple dependencies |
| `idle_timeout` | number (ms) | 300000 | Idle timeout for AI streaming (`command`, `prompt`) and per-iteration idle for `loop`. Accepted but ignored on `bash` and `script` — use `timeout` there |

**Command, prompt, and bash nodes** (silently ignored on loop nodes, except `retry` which is a hard error):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | inherited | Per-node model override |
| `provider` | `claude` / `codex` | inherited | Per-node provider override |
| `context` | `fresh` / `shared` | — | `fresh` = new session; `shared` = inherit from prior node. Defaults to `fresh` for parallel layers, inherited for sequential |
| `output_format` | object | — | JSON Schema for structured output |
| `allowed_tools` | string[] | all | Tool whitelist. `[]` = disable all. Claude only |
| `denied_tools` | string[] | none | Tool blacklist. Claude only |
| `retry` | object | 2 retries, 3s | Retry config. **Hard error on loop nodes** |
| `hooks` | object | — | SDK hooks. Claude only. See `dag-advanced.md` |
| `mcp` | string | — | MCP config path. Claude only. See `dag-advanced.md` |
| `skills` | string[] | — | Skill names. Claude only. See `dag-advanced.md` |

## Validator rules (632-662)
## Validate Before Finishing

Before declaring a workflow complete, validate it:

```bash
archon validate workflows <name>
```

Fix any errors and re-validate until the command returns clean. This checks:
- YAML syntax and required fields
- DAG structure (cycles, missing dependencies, invalid `$nodeId.output` refs)
- All `command:` files exist on disk
- All `mcp:` config files exist and contain valid JSON
- All `skills:` directories exist

Use `--json` for machine-readable output. Use `archon validate commands <name>` to validate individual command files.

## Validation Rules (Load Time)

- All node IDs unique
- All `depends_on` reference existing IDs
- No cycles
- `$nodeId.output` refs in `when:`, `prompt:`, `loop.prompt:` must point to known IDs
- Exactly one of `command`, `prompt`, `bash`, `script`, `loop`, `approval`, `cancel` per node
- Script nodes require `runtime: bun` or `runtime: uv`
- Named scripts must exist in `.archon/scripts/` or `~/.archon/scripts/` with extension matching declared runtime
- `retry` on loop node = hard error
- `approval.message` required and non-empty
- `cancel` reason required and non-empty
- Approval `on_reject.max_attempts` must be 1–10 if set
- `steps:` format rejected (deprecated — use `nodes:` only)

## Canonical example (664-710)
## Complete Example

```yaml
name: classify-and-fix
description: Classify a GitHub issue, then route to the appropriate handler

nodes:
  - id: fetch-issue
    bash: "gh issue view $ARGUMENTS --json title,body,labels"
    timeout: 15000

  - id: classify
    prompt: "Classify this issue: $fetch-issue.output"
    depends_on: [fetch-issue]
    model: haiku
    allowed_tools: []
    output_format:
      type: object
      properties:
        issue_type:
          type: string
          enum: [bug, feature]
      required: [issue_type]

  - id: investigate
    command: investigate-bug
    depends_on: [classify]
    when: "$classify.output.issue_type == 'bug'"
    context: fresh

  - id: plan
    command: plan-feature
    depends_on: [classify]
    when: "$classify.output.issue_type == 'feature'"
    context: fresh

  - id: implement
    command: implement-changes
    depends_on: [investigate, plan]
    trigger_rule: one_success
    context: fresh

  - id: create-pr
    command: create-pull-request
    depends_on: [implement]
    context: fresh
```

## Hooks (dag-advanced.md 39-150)
## Hooks

> Claude only. Codex nodes log a warning and ignore hooks.

Hooks intercept tool calls during a node's AI execution. Use them to approve/deny tools, inject context after tool use, or emergency-stop the agent.

### Syntax

```yaml
- id: analyze
  prompt: "Analyze the codebase"
  hooks:
    PreToolUse:
      - matcher: "Bash"                    # Regex on tool name (optional)
        response:                          # Required: SDK SyncHookJSONOutput
          hookSpecificOutput:
            hookEventName: PreToolUse      # Must match the event key
            permissionDecision: deny
            permissionDecisionReason: "No shell access in analysis phase"
        timeout: 30                        # Seconds (optional, default: 60)
    PostToolUse:
      - matcher: "Read"
        response:
          systemMessage: "You just read a file. Stay focused on analysis — do not modify anything."
      - response:                          # No matcher = fires on every tool
          systemMessage: "Verify this output is relevant."
```

### Supported Hook Events

Most commonly used: `PreToolUse`, `PostToolUse`, `Stop`

Full list: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PermissionRequest`, `Setup`, `TeammateIdle`, `TaskCompleted`, `Elicitation`, `ElicitationResult`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`, `InstructionsLoaded`

### Matcher Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `matcher` | string | No | Regex pattern to filter by tool name. Omit to match all |
| `response` | object | **Yes** | The `SyncHookJSONOutput` returned when hook fires |
| `timeout` | number | No | Timeout in **seconds** (default: 60) |

### Response Fields

| Field | Type | Effect |
|-------|------|--------|
| `hookSpecificOutput` | object | Event-specific payload. Must include `hookEventName` matching the outer event key |
| `systemMessage` | string | Inject a message visible to the AI model |
| `continue` | boolean | Set to `false` to stop the agent |
| `stopReason` | string | Reason when stopping |
| `decision` | `approve` / `block` | Top-level approve/block decision |

### PreToolUse hookSpecificOutput

| Field | Effect |
|-------|--------|
| `permissionDecision` | `deny` / `allow` / `ask` |
| `permissionDecisionReason` | Human-readable reason |
| `updatedInput` | Object to replace tool arguments |
| `additionalContext` | Extra context injected into the conversation |

### PostToolUse hookSpecificOutput

| Field | Effect |
|-------|--------|
| `additionalContext` | Context injected after the tool runs |
| `updatedMCPToolOutput` | Replace MCP tool output |

### Common Patterns

**Deny specific tools:**
```yaml
hooks:
  PreToolUse:
    - matcher: "Write|Edit|Bash"
      response:
        hookSpecificOutput:
          hookEventName: PreToolUse
          permissionDecision: deny
          permissionDecisionReason: "Read-only analysis node"
```

**Inject guidance after file reads:**
```yaml
hooks:
  PostToolUse:
    - matcher: "Read"
      response:
        systemMessage: "Focus on identifying security vulnerabilities in what you just read."
```

**Emergency stop on shell access:**
```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      response:
        continue: false
        stopReason: "Shell access not permitted"
```

### Hooks vs Tool Restrictions

| Mechanism | Granularity | Effect |
|-----------|------------|--------|
| `allowed_tools` | Coarse | Tools not in list are invisible to AI |
| `denied_tools` | Coarse | Listed tools are invisible to AI |
| `hooks.PreToolUse` | Fine | Tool is visible but call can be denied/modified/annotated |

Use `allowed_tools`/`denied_tools` for hard restrictions. Use hooks when you want the AI to know the tool exists but have guardrails on how it's used.

---

## Inline agents (parameter-matrix.md 101-130)
```yaml
- id: analysis
  prompt: |
    For each area of the codebase, delegate to the appropriate sub-agent
    via the Task tool. Summarize all findings into a single report.
  agents:
    security-scanner:                     # kebab-case id
      description: "Scan for common web vulnerabilities"
      prompt: "Run OWASP top-10 style checks on the given files"
      model: haiku
      tools: [Read, Grep, Glob]           # tool whitelist for this sub-agent
      disallowedTools: [Write, Edit, Bash]
      maxTurns: 5
    test-coverage-auditor:
      description: "Report untested or weakly-tested surfaces"
      prompt: "Identify code paths without corresponding tests"
      model: haiku
      tools: [Read, Grep, Glob]
      skills: [test-coverage-patterns]    # skill injection per sub-agent
      maxTurns: 5
```

**Fields per agent:**

| Field              | Required | Description                                               |
| ------------------ | :------: | --------------------------------------------------------- |
| `description`      | yes      | Shown when Claude decides which agent to delegate to      |
| `prompt`           | yes      | System prompt the sub-agent runs under                    |
| `model`            | no       | Per-agent model override                                  |
| `tools`            | no       | Tool whitelist for the sub-agent                          |

## Fresh context guidance (good-practices.md 60-100)

- id: implement
  command: implement
  depends_on: [investigate, plan]
  trigger_rule: none_failed_min_one_success   # CORRECT — exactly one ran
  # trigger_rule: all_success               ← would fail here (one dep skipped)
```

Use `one_success` when any dep succeeding is enough; `none_failed_min_one_success` when no dep should have failed AND at least one must have succeeded; `all_done` for "run cleanup regardless" patterns with `cancel:` or notification nodes.

### 4. `context: fresh` requires artifacts for state passing

A node with `context: fresh` starts with no memory of prior nodes in the same workflow. The only way state moves is via files. Default is `fresh` for parallel layers and `shared` for sequential — explicit `context: fresh` is common when you want cost isolation.

```yaml
- id: investigate
  command: investigate-bug
  # Investigator WRITES to $ARTIFACTS_DIR/investigation.md

- id: implement
  command: implement-fix
  depends_on: [investigate]
  context: fresh
  # Implementer MUST read $ARTIFACTS_DIR/investigation.md — it has no memory
  # of what the investigator found.
```

Command files should lead with "read artifacts from `$ARTIFACTS_DIR/...`" when they're downstream of a fresh node. This is the single biggest quality lever on multi-node workflows.

### 5. Cheap models for glue, strong models for substance

Classification, routing, formatting, and short summaries don't need Opus. Use `model: haiku` for these and reserve `sonnet`/`opus` for the nodes that actually produce code or long-form analysis. Combined with `allowed_tools: []` on pure-text nodes, this cuts cost dramatically.

```yaml
- id: classify
  prompt: "Classify this issue"
  model: haiku              # fast + cheap
  allowed_tools: []         # no tool overhead
  output_format: { ... }

- id: implement

## Loop + approval nodes (workflow-dag.md 370-420, 490-520)
## Loop Nodes

Loop nodes iterate an AI prompt until a completion condition is met. Use them for autonomous multi-step work: implementing stories from a PRD, iterating until tests pass, or refining output.

### Configuration

```yaml
- id: my-loop
  loop:
    prompt: "..."              # Required. Sent each iteration
    until: COMPLETE            # Required. Completion signal
    max_iterations: 10         # Required. Integer >= 1. Fails if exceeded
    fresh_context: true        # Optional. Default: false
    until_bash: "..."          # Optional. Exit 0 = complete
    interactive: true          # Optional. Pauses between iterations for user input
    gate_message: "..."        # Required when interactive: true
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | Yes | Prompt template. Supports all variable substitution (`$ARGUMENTS`, `$nodeId.output`, `$LOOP_USER_INPUT`, etc.) |
| `until` | string | Yes | Completion signal to detect in AI output |
| `max_iterations` | number | Yes | Hard limit. Node **fails** if exceeded |
| `fresh_context` | boolean | No | Default `false`. `true` = fresh AI session each iteration |
| `until_bash` | string | No | Shell script run after each iteration. Exit 0 = complete. Variable substitution applies; `$nodeId.output` IS shell-quoted here |
| `interactive` | boolean | No | Default `false`. `true` = pause after each non-completing iteration for user feedback via `/workflow approve <id> <text>` |
| `gate_message` | string | **Required when `interactive: true`** | Message shown to the user at each pause. Validated at parse time — a loop with `interactive: true` and no `gate_message` fails to load |

### Interactive Loops

Interactive loops pause between iterations so a human can provide feedback that feeds the next iteration. Use them for guided writing/refinement (e.g. PRD co-authoring, iterative design).

```yaml
name: guided-refine
description: Refine an output with human feedback between iterations
interactive: true                # REQUIRED at the workflow level for web UI

nodes:
  - id: refine
    loop:
      prompt: |
        Review the current draft and improve it based on this feedback:
        $LOOP_USER_INPUT

        When the output is satisfactory, output: <promise>DONE</promise>
      until: DONE
      max_iterations: 5
      interactive: true          # node level — enables the pause
      gate_message: |
        Review the output above. Reply with feedback, or type DONE to finish.
```
## Approval Nodes

Approval nodes **pause the workflow** until a human approves or rejects the gate. Use them to insert review steps between AI-driven nodes — for example, reviewing a generated plan before committing to expensive implementation work.

### Configuration

```yaml
- id: review-gate
  approval:
    message: "Review the plan above before proceeding with implementation."
    capture_response: false        # Optional. true = user's comment stored as $review-gate.output
    on_reject:                     # Optional. AI rework on rejection instead of cancel
      prompt: "Revise based on feedback: $REJECTION_REASON"
      max_attempts: 3              # Range 1–10, default 3. After max, workflow is cancelled.
  depends_on: [plan]
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `approval.message` | **Yes** | The message shown to the user when the workflow pauses |
| `approval.capture_response` | No | `true` = user's approval comment stored as `$<node-id>.output` for downstream nodes. Default: `false` (downstream `$<node-id>.output` is empty string) |
| `approval.on_reject.prompt` | No | Prompt run via AI when the user rejects. `$REJECTION_REASON` is substituted with the reject reason. After running, the workflow re-pauses at the same gate |
| `approval.on_reject.max_attempts` | No | Max times the on_reject prompt runs before the workflow is cancelled. Range: 1–10. Default: 3 |

### Web UI Requirement

Approval gates delivered on the Web UI require `interactive: true` at the **workflow level** — otherwise the workflow dispatches to a background worker and the gate message never reaches the user's chat window.

```yaml
