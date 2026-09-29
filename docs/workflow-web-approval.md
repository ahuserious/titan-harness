# Runner-owned web approvals

`WorkflowRuntimeHost.approver` injects the host's `Approver` transport and takes
precedence over `ui`. Without either, approvals still cancel with
`headless session: no approver available`. This seam adds no network listener;
the gateway/router integration belongs to P3. The router authenticates and
authorizes the reviewer before delivering a decision. The runner requires a
nonblank `actor` but does not itself authenticate that identity.

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
```

`content` is optional, including without `preset_key`. Its raw substituted value
is hashed as UTF-8 SHA-256. With no `content`, the substituted message is hashed.
An explicitly empty `content` hashes the empty string. Rework issues a fresh
request ID and increments `attempt`; it re-substitutes the declared content, so
changed content gets a new hash. Rework prose does not implicitly replace the
workflow's declared content. Preset receipts use the same content hash.

The runner persists `approval.requested` before calling `Approver.request`.
A refused decision is audited and the transport is called again with the same
request ID to await another decision; transports must deliver the next answer,
not repeatedly replay the rejected one. Request objects passed to the transport
are copies. Content is re-read immediately before consumption to reject stale
artifacts. `QueueApprover` is an in-memory test transport with `deliver(answer)`.

`approvals.jsonl` is the authoritative, verified hash chain. Its derived index is
rebuilt on reads, including after restart. Each approval append is flushed with
`fsync` before the runner proceeds; `events.jsonl` mirrors the events for
observers. Errors propagate and fail closed. A crash after `approval.decided`
but before `approval.consumed` leaves the request pending. A crash after
consumption cannot make that request consumable again, even with a new nonce.

`RunStore.consumeDecision(runDir, decision, expected)` checks the runner's
expected request ID and current artifact hash against the persisted pending
request, plus all delivered binding fields, actor, nonce, decision, and time.
It performs the read/check/write synchronously without yielding. This serializes
concurrent promises and different RunStore instances on the runner's JS event
loop. The existing single-writer-per-run-directory assumption remains mandatory:
other processes or worker threads must route writes through that owner. There is
no cross-process file lock, and the run directory must stay outside agent units.

Expiry uses the runner's `Date.now()` wall clock and persisted ISO timestamps.
The default TTL is 24 hours; `approvalTtlMs` overrides it. Both the delivered
`decidedAt` and runner time must be at or before `expiresAt`. A future-dated
invalid decision cannot itself expire a request while the runner clock still
considers it valid. A runner timer bounds waiting even if the host never replies.
Clock rollback can extend real elapsed waiting; the host must maintain its clock.
Read-only listing does not expire requests. Timeout/unavailable answers fail
closed; unavailable leaves the persisted request pending.

Call `recoverInterruptedRuns(store)` once at runner startup, before accepting
work, with exclusive ownership of the store root. Here "owner gone" means
**found running at startup**, not PID probing. Recovery writes `run.interrupted`
before changing each running run to `interrupted`. It does not resume, replay,
consume, expire, or otherwise change approval records, including overdue ones.
`listPendingApprovals(runDir)` remains available for human inspection. Do not
invoke startup recovery against a live runner's store. Resume is out of scope.
