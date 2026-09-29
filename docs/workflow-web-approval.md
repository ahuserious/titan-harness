# Runner-owned web approvals

`WorkflowRuntimeHost.approver` injects the host's `Approver` transport and takes
precedence over `ui`. Without either, approvals still cancel with
`headless session: no approver available`. This seam adds no network listener;
the gateway/router integration belongs to P3. Division of labour (DESIGN §7.2):
the router authenticates the reviewer and delivers the decision; the runner,
outside every agent unit, binds (run, node, artifact sha256, expected-actor
policy, expiry), asks the host's actor policy about the delivered actor, and
consumes once. Nothing an agent writes counts as an approval.

```yaml
nodes:
  - id: draft
    prompt: Write the draft.
  - id: review
    depends_on: [draft]
    approval:
      message: Approve the draft for publication?
      content: $draft.output
      capture_response: true
      reviewers: [dana@triarc.test, preston@triarc.test]   # optional, hosted only
```

## Runner store (required for hosted approvals)

Hosted approvals only work on a store from `openRunnerStore(root)` (run-store.ts):

- It refuses `DEFAULT_RUN_ROOT` (the TUI's shared root) and any root nested
  inside or around it, before and after resolving symlinks. The runner needs
  its own root.
- It creates `<root>/runner.lock` with `O_EXCL`, holding `{pid, procStart, token}`.
  `procStart` is the `/proc/<pid>/stat` start time, used to detect pid reuse.
  A second opener is refused while the holder is alive, including an opener in
  the same process. A lock whose pid is dead, or reused with another start time,
  is taken over: it is renamed aside, the renamed file is checked to be the
  stale lock that was observed, and a fresh `O_EXCL` create follows.
- It then runs `recoverInterruptedRuns` exactly once (see Recovery) and returns
  the store. The recovered runs are on `store.recovered`. `store.release()`
  drops the lock, but only while the lock still holds this store's token.

`createHostedApproval`, and so `createWorkflowRuntime` with an `approver`, throws
in these cases:

- the store was not opened this way;
- its lock was released or replaced;
- `runDir` lies outside its root.

The runner checks this again before every request. The TUI/headless path
(no `approver`) is unchanged and needs no runner store.

## Content binding

- `content` is optional, including without `preset_key`. Its raw substituted
  value is hashed as UTF-8 SHA-256. With no `content`, the substituted message is
  hashed. An explicitly empty `content` hashes the empty string.
- Rework issues a fresh request ID and increments `attempt`. From attempt 2 on,
  the node releases the rework's text downstream (`$review.text`, the artifact
  body), not the declared content, which is stale by then. So the request binds
  `sha256(lastRework.text)`, and consumption re-reads that same text. A decision
  carrying an earlier attempt's sha is refused (`artifactSha256 mismatch`).
- Preset gates hash the same bytes.
- The runner re-reads the content immediately before consumption and refuses a
  stale artifact.
- `content` is hashed as a string. `content: $ARTIFACTS_DIR/out.txt` binds the
  path, not the file bytes. Bind the text itself; release-time re-hashing of
  files belongs to the release step.

## Actor binding

Hosted approvals need a host `actorPolicy: {policyId, authorize(actor, req)}` on
`WorkflowRuntimeHost`. `authorize` receives the router-authenticated actor from
the runner's snapshot of the decision and a copy of the request. It must return
exactly `true`, for example when the actor holds the prod-reviewer grant.
Anything else, including throwing, refuses.

Each request records its expected-actor policy as `actorPolicy: {policyId,
allowedActors?}`. `allowedActors` is the approval spec's optional `reviewers:`
list. A decision must pass both the list and the host policy (intersection).

`consumeDecision` refuses and records `approval.refused` with reason
`actor_not_authorized` in two cases: the actor is outside `allowedActors`, or the
runner's `actorAuthorized` verdict is not `true`. With no policy configured,
every hosted decision is refused (fail closed; `policyId: null` is recorded).
The TUI path is unchanged.

## Decisions, refusals, and the transport

- The runner persists `approval.requested` before calling `Approver.request`.
  Request objects passed to the transport or the policy are copies.
- The delivered answer is snapshotted once by explicit field copy
  (`snapshotDecision`). Non-objects, arrays, throwing getters, non-string fields,
  a non-string `response`, and a `response` over 64 KiB are refused as
  `malformed decision` or `response too large`. The actor policy, every check,
  the audit log and the node outcome all use that single snapshot. A getter
  cannot make the log and the outcome disagree.
- A refused decision is audited, and the transport is asked again with the same
  request ID. The runner yields a macrotask between attempts, so a replaying
  transport cannot starve timers. Transports must deliver the next answer, not
  replay the rejected one.
- The 20th refusal of one request (`MAX_APPROVAL_REFUSALS`) writes
  `approval.expired {reason: "refusal limit"}`, and the node fails closed. This
  prevents a 24 h hang and bounds log growth.
- The nonce is an audit field only. Replay defence is per-request single
  consumption, and the same nonce may appear on different requests.
- `QueueApprover` is an in-memory test transport with `deliver(answer)`.
- A hosted outcome with no consumed decision (timeout, unavailable, refusal
  limit, missing binding) is not a human rejection. It never starts an
  `on_reject` rework and never writes a receipt; the node ends `cancelled`.

## Content presets on the hosted path

The preset tally comes from the runner store, never from files under
`ARTIFACTS_DIR` and never from reviewer names typed in a response (agents and
bash nodes can write to that directory).

`tallyPresetApprovals(runDir, presetKey, contentSha256)` counts **distinct
actors** among consumed approve decisions in this run's `approvals.jsonl`. It
counts only requests that carried the same `presetKey` and were bound to the
same content sha. The output's `receipts` is that count, and its `reviewers`
are those actors.

Receipt files are still written for compatibility, with `reviewer` set to the
actor, but the hosted path never counts them. The TUI path keeps its
receipt-file tally.

## Durable log

`approvals.jsonl` is the authoritative, verified hash chain. Its derived index is
rebuilt on reads, including after restart. Each approval append is flushed with
`fsync` before the runner proceeds; `events.jsonl` mirrors the events for
observers. Errors propagate and fail closed.

Lifecycle rules are part of chain validity. Any of the following makes every
approval operation on the run throw `approval chain invalid` (fail closed):

- a second `approval.requested` for an existing request ID;
- a `decided`, `consumed` or `expired` row for an unknown or already-terminal
  request;
- a second `decided` row;
- a `consumed` row without a `decided` row;
- an unknown approval row type.

`approval.refused` rows never change state.

Crash windows:

- A crash after `approval.decided` but before `approval.consumed` leaves the
  request pending, but it can never be decided again (`request already
  decided`). Truncating the final `consumed` row therefore cannot reopen a
  request.
- A crash after consumption cannot make that request consumable again, even
  with a new nonce.

The chain is **unkeyed** SHA-256 with no external tail anchor. It detects
accidental and non-recomputed edits, not a writer who recomputes hashes. Its
integrity relies on the run directory, and therefore the runner store root,
being outside every agent unit. The P3 node-exec wiring must not expose the
runner's run dir (`TITAN_RUN_DIR`, `ARTIFACTS_DIR`) to units.

`RunStore.consumeDecision(runDir, decision, expected)` checks the delivered
decision against the persisted pending request and against the runner's
expected values:

- the runner's expected request ID;
- the current artifact hash;
- the actor policy verdict (`actorAuthorized`);
- all delivered binding fields, plus actor, nonce, decision and time.

It performs the read/check/write synchronously without yielding. This serializes
concurrent promises and different RunStore instances on the runner's JS event
loop. Across processes, the runner lock enforces one runner per store root.
Other processes or worker threads must route writes through that owner.

## Expiry

- Expiry uses the runner's `Date.now()` wall clock and persisted ISO timestamps.
- The default TTL is 24 hours; `approvalTtlMs` overrides it.
- Both the delivered `decidedAt` and runner time must be at or before
  `expiresAt`. A future-dated invalid decision cannot itself expire a request
  while the runner clock still considers it valid.
- A runner timer bounds waiting even if the host never replies.
- Clock rollback can extend real elapsed waiting; the host must maintain its
  clock.
- Read-only listing does not expire requests.
- Timeout/unavailable answers fail closed; unavailable leaves the persisted
  request pending.

## Recovery

`openRunnerStore` calls `recoverInterruptedRuns(store)` once, under the runner
lock, before the store is returned and before any work is accepted. Here "owner
gone" means **found running at startup** by the lock holder. Recovery:

- writes `run.interrupted`, then changes each running run to `interrupted`;
- does not resume, replay, consume, expire, or otherwise change approval
  records, including overdue ones.

`listPendingApprovals(runDir)` remains available for human inspection. Do not
call `recoverInterruptedRuns` directly against a store another runner might own.
Resume is out of scope.

## Other callers

An `interactive: true` loop calls `deps.approval` without a node/content
binding. Under a hosted approver it gets `approval binding unavailable`, and the
loop stops (fail closed). Interactive loops are a TUI feature.
