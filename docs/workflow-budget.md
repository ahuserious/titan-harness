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

All four keys are optional at both levels. The validator rejects negative values, and rejects non-integer token counts.

## How it is enforced

Money is integer micro-USD and tokens are integer tokens. Limits round down. Reservations and charges round up.

Scopes form a chain: the node's scope, then the workflow's scope (`titan.budget`), then, for a child run, the calling `workflow:` node's scope and every ancestor above it.

1. **Reserve before dispatch.** Every agent call reserves its worst case against every scope in the chain before `deps.agent` is called. That covers prompt/command nodes, structured-output re-asks, loop iterations, approval rework turns, best_of candidates and judges, mimeograph cells and judges, interleave segments and synthesis, and the verifier runner. The worst case comes from the node's `budget.per_call_*`, else `titan.budget.per_call_*`, else the defaults ($5 / 2,000,000 tokens). It is never larger than the node's own total. The reservation is a synchronous check-and-add, so concurrent calls can never both take the same remainder.
2. **Refuse or wait.** A call is refused when it would exceed a scope's `limit − spent − reserved`:
   - If settling the in-flight calls could make room (`spent + needed ≤ limit`), the call waits for them (`budget.wait`) and then retries the reservation.
   - Otherwise the refusal is hard. The node fails with `budget exceeded: <scope> remaining X, needed Y`, `retryable: false`, and a `budget.refused` event. The agent is never called.
3. **Settle after the call.** The charge is the child's reported `usage.costUsd` and `tokensIn + tokensOut`:
   - A dimension the child did not report (missing or non-finite) is charged at the full reservation, never zero.
   - A charge above the reservation is charged in full and flagged with a `budget.overrun` event and a warning.
4. **Retries.** Each attempt reserves on its own. A failed attempt settles at its reported usage, or at the full reservation if the usage is unknown. The attempt that would overshoot is refused.
5. **Nested workflows.** A `workflow:` node passes its scope to `deps.runWorkflow(name, inputs, { parentBudget })`. The extension forwards it as `ExecuteOptions.parentBudget`. A child's own `titan.budget` can only narrow what it may spend: it never gets more than the parent's remainder, and a fan-out of children shares that remainder.
6. **Interrupted calls.** When a call is aborted or cancelled mid-flight, its reservation settles at the usage the child reports within `ExecuteOptions.budgetAbortGraceMs` (default 2000 ms). If nothing arrives in that window, it settles at the full reservation. The executor waits for these settlements before it writes `budget.summary` and `workflow.end`.
7. **No budget anywhere in the chain.** No reservations and no budget events are made, and behaviour is exactly as before. The ledger rows and `agent.end` usage are recorded as always.

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

- Verify runners that spend outside the agent seam (for example the Cursor cloud agents runner, which bills Cursor directly) are not reserved. Their cost is external and shows up only as `externalLedger` metadata.
- The session-level `/stack budget` held-spend guard (`budgetUsd` in stack settings) is separate and still applies on top of this.
