# Runner seams 3-4: `mcpTool` and `runWorkflow` (LANE-3 N3-06)

`extensions/titan-harness/modules/workflow/runner-seams.ts` holds what a hosted runner (`wf-runner`, outside every unit) uses instead of the TUI wiring in `titan-harness.ts`.

## Seam 3: `mcpTool` through the unit's sidecar socket

- `createSidecarMcpTool({ socketPath, routes })` sends one JSON-RPC `tools/call` as a POST to `/mcp/<server>` on the unit's unix socket, following the sidecar `CONTRACT.md` routes.
- It takes no URL, host, port or header input. `server` must be in the startup `routes` list, and each route must be a plain slug (`^[a-z0-9][a-z0-9-]{0,62}$`). A workflow therefore cannot name a direct upstream.
- The call fails on:
  - a redirect;
  - a response over the size cap (1 MiB by default) or the call deadline (30 s by default). The deadline is wall-clock time for the whole call, not a socket inactivity timer, so a sidecar that trickles bytes is still cut off;
  - a JSON-RPC `error`, an `isError` result, or a response id that does not match the request.
- A sidecar 4xx refusal (for example `MCP_TOOL_DENIED`) throws with `retryable: false`, and `mcp_tool` nodes then fail without retries.
- Retries depend on whether the request may have reached the sidecar and whether the tool is read-only (`isReadOnlyTool`, the allowlist described under `prod-v1` below):
  - A missing socket, or a connect error such as `ECONNREFUSED`, means nothing was sent. That error is retryable for every tool.
  - A timeout, a transport error after connecting, or a 5xx is retryable only for a read-only tool. For any other tool the error carries `retryable: false`, because the upstream may already have committed the write. One approval therefore leads to at most one write.
- `createWorkflowRuntime({ sidecarMcp })` wires the seam. A hosted runtime (one with `approver` set) refuses a direct `mcpTool` bridge. Passing both `mcpTool` and `sidecarMcp` is refused.

## Seam 4: `runWorkflow`, recursive in the runner

- `createRunnerRunWorkflow(host, { runId, chain })` loads the child with the runner's own loader and requires it to pass `prod-v1`.
- It opens the child run in the same runner store, with `parentRunId` set to the calling run, and runs the child with:
  - the caller's `parentBudget` (the N3-09 budget chain, which is enforced);
  - the caller's abort signal;
  - `maxParallel` 2.
- The child gets the same recursive seam for its own `workflow:` nodes.
- A cycle, a depth over `MAX_WORKFLOW_DEPTH` (4), a missing child or a non-`prod-v1` child is refused before any child run opens. The refusal sets `RunResult.notStarted`, so the calling node fails once, without retries.

## The `prod-v1` profile (DESIGN §6.2)

`validateProdV1(doc)` and `executeProdV1(loaded, deps)` enforce these rules:

- Allowed node types: `prompt`, `command`, `bash`, `script`, `verify` (runner `bash` or `verifier` only), `approval`, `mcp_tool`, `cancel` and `workflow`.
- `workflow` nodes may not use `fan_out` or `isolation`, and every node's isolation is `none`.
- `titan.budget.max_concurrent_children` is at most 2, and execution is capped at 2 parallel nodes.
- Every `mcp_tool` needs a succeeded `approval` unless its tool name is on the read-only allowlist. A name is read-only only if all three hold:
  - one of its words is a read verb (`get`, `list`, `search`, `read`, `query`, `count`, `describe`, `fetch`, `find`, `lookup`, `view`, `show`, `inspect`, `retrieve`, `browse`, `stat`, `exists`);
  - none of its words is an effect verb (for example `create`, `update`, `send`, `execute`, `refund`, `transfer`) or a joining word (`and`, `or`, `then`, `also`);
  - no word contains an effect root, which catches run-together names such as `bulkupdate`.
- Any other name needs approval, including a name with no verb at all. Examples are `refund_payment`, `transfer_funds`, `bulkupdate`, `get_or_create_contact` and `executeCOQLQuery`. A tool wrongly classed as not read-only only costs an approval.
- The approval check follows trigger rules through intermediate nodes:
  - under `all_success`, one gated dependency is enough;
  - under `one_success` and `none_failed_min_one_success`, every dependency must be gated;
  - a node under `all_done` is never gated, because its approval may have been skipped by `when:`.
- The sidecar tool allowlist limits which tools exist. It does not stand in for the human decision.
- An `mcp_tool` that is not read-only runs once. The validator refuses `retry.max_attempts` above 1 and `on_fail: retry` on it. `executeProdV1` and the runner's `runWorkflow` also pin it to one attempt, overriding the executor's default of 2. A read-only tool keeps its retries.

## Interrupted run

`tests/workflow-runner-seams.test.ts` runs a real runner process that goes through all three seams:

1. An `mcp_tool` node calls the sidecar.
2. A nested `runWorkflow` starts a child run.
3. The child's web `approval` parks.

The test then kills the process with `kill -9` and reopens the store with `openRunnerStore`. The parent and child runs are `interrupted`, the pending approval is byte-identical, and nothing is replayed: the sidecar saw exactly one call.
