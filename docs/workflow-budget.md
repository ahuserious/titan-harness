# Workflow budgets

Titan enforces `budget.usd` and `budget.tokens` while a workflow runs. It does not just record them afterwards. The code is `extensions/titan-harness/modules/workflow/budget.ts` (no Pi import) and the `runAgent` choke point in `modules/workflow/executor.ts`.

## Declaring

```yaml
titan:
  budget:
    usd: 5              # the whole run (and every child workflow it starts)
    tokens: 2000000
    per_call_usd: 0.75  # worst case one agent call may cost (default 5)
    per_call_tokens: 400000  # (default 2000000)
nodes:
  - id: implement
    prompt: ...
    budget: { usd: 1.5, tokens: 600000, per_call_usd: 0.5 }  # this node, every attempt, iteration and fan-out call
```

All four keys are optional at both levels. The validator rejects zero, negative and non-finite values and non-integer token counts. It also rejects a `per_call_*` above the total next to it, and a node total below the per-call worst case its chain declares, because such a budget could never admit a call. It warns when a total is below the default per-call worst case and no `per_call_*` applies.

## How it is enforced

Money is integer micro-USD and tokens are integer tokens. Limits round down. Reservations and charges round up.

Scopes form a chain: the node's scope, then the workflow's scope (`titan.budget`), then, for a child run, the calling `workflow:` node's scope and every ancestor above it.

1. **Reserve before dispatch.** Every agent call reserves its worst case against every scope in the chain before `deps.agent` is called. That covers prompt/command nodes, structured-output re-asks, loop iterations, approval rework turns, best_of candidates and judges, mimeograph cells and judges, interleave segments and synthesis, and the verifier runner. The worst case is the largest `per_call_*` declared anywhere on the scope chain (the node, its workflow, and every ancestor workflow and `workflow:` node), else the defaults ($5 / 2,000,000 tokens). This is **worst-case admission**: the reservation is never reduced to fit what is left or to a node's total. A node or child workflow can raise the per-call worst case but never lower what an ancestor declared, so a child with a tiny total is refused rather than reserving less against its ancestors. The reservation is a synchronous check-and-add, so concurrent calls can never both take the same remainder.
2. **Refuse or wait.** A call is refused when it would exceed a scope's `limit − spent − reserved`:
   - If settling the in-flight calls could make room (`spent + needed ≤ limit`), the call waits for them (`budget.wait`) and then retries the reservation.
   - Otherwise the refusal is hard. The node fails with `budget exceeded: <scope> remaining X, needed Y`, `retryable: false`, and a `budget.refused` event. The agent is never called.
3. **In-flight cap.** Every budgeted call carries a live cap: min(its reservation, reservation + what the chain has left). The child runner kills the child as soon as its observed spend reaches the cap, or as soon as one more message the size of the largest it has sent would pass the cap. So a child whose messages do not grow never spends past its reservation. A watchdog never pre-empts a budgeted call.
4. **Settle after the call.** The charge is the child's reported `usage.costUsd` and `tokensIn + tokensOut`:
   - A dimension the child did not report (missing or non-finite) is charged at the full reservation, never zero.
   - A charge above the reservation is charged in full and flagged with a `budget.overrun` event and a warning.
5. **Retries.** Each attempt reserves on its own. A failed attempt settles at its reported usage, or at the full reservation if the usage is unknown. The attempt that would overshoot is refused.
6. **Nested workflows.** A `workflow:` node passes its scope and the attempt's abort signal to `deps.runWorkflow(name, inputs, { parentBudget, signal })`. The extension forwards them as `ExecuteOptions.parentBudget` and `ExecuteOptions.signal`. The parent registers each child run, so its `budget.summary` waits until the child and all of the child's reservations have settled, even when the parent is cancelled. A child's own `titan.budget` can only narrow what it may spend: it never gets more than the parent's remainder, and a fan-out of children shares that remainder.
7. **Interrupted or failed calls.** The agent runner labels each call's usage `complete`, `partial`, `none` or `not-dispatched`:
   - `partial` means the call reported usage, then was aborted, timed out, halted, crashed or threw. It settles at max(reported, reservation) in each limited dimension. Known spend is never dropped.
   - `none` means no usage arrived. It settles at the full reservation.
   - `not-dispatched` means no child was started. It settles at 0.

   An aborted call gets `ExecuteOptions.budgetAbortGraceMs` (default 2000 ms) to report its usage. Settlement happens in a `finally` block, so a failing run store or event log can never leave a reservation open. The executor drains every settlement before it writes `budget.summary` and `workflow.end`.
8. **No budget anywhere in the chain.** No reservations and no budget events are made, and behaviour is exactly as before. The ledger rows and `agent.end` usage are recorded as always.

## Events (events.jsonl)

| type | when | key fields |
|---|---|---|
| `budget.reserve` | before each dispatch | `reservationId`, `usdMicros`, `tokens`, `scopes` |
| `budget.wait` | an in-flight reservation blocks the call | `scope`, `dimension`, `remaining`, `needed` |
| `budget.refused` | hard refusal, agent not called | `scope`, `dimension`, `limit`, `remaining`, `needed`, `error` |
| `budget.settle` | after each dispatched call (ok, failed, thrown, interrupted) | `chargedUsdMicros`, `chargedTokens`, `reserved*`, `basis`, `interrupted`, workflow totals |
| `budget.overrun` | charge > reservation | `overrunUsdMicros`, `overrunTokens` |
| `budget.summary` | once, before `workflow.end` | workflow and per-node totals |

Every dispatched call ends in exactly one `budget.settle`. So a restarted runner can recompute spend-so-far from the run directory by summing `chargedUsdMicros` and `chargedTokens`. The executor does not reconstruct a budget on resume yet. `RunResult.budget` carries the workflow scope's totals whenever a budget applied.

## Not covered

- Verify runners that spend outside the agent seam (`cursor-cloud`, `kane`, `testmu`, `momentic`) are refused under a budget. The exception is when every workflow on the chain sets `titan.budget.allow_unmetered_runners: true`. Their reported `externalCostUsd` is then charged after the fact, outside the hard cap.
- A single message that is larger than any before it can still pass the in-flight cap by that one message. Such an overrun is charged in full and flagged with `budget.overrun`.
- A resumed run does not reconstruct its budget from `events.jsonl` yet.
- The session-level `/stack budget` held-spend guard (`budgetUsd` in stack settings) is separate and still applies on top of this.
