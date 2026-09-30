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
- It creates `<root>/runner.lock` holding `{pid, procStart, token}`. The full
  content is written and fsynced to a unique temp file first, then `link()`ed
  into place, which fails instead of replacing an existing lock. The lock file
  is therefore never seen empty or partial.
  `procStart` is the `/proc/<pid>/stat` start time, used to detect pid reuse.
  A second opener is refused while the holder is alive, including an opener in
  the same process.
- Takeover never removes a lock whose content was not validated as stale. The
  opener reads and parses the lock. Only if its pid is dead, or reused with
  another start time, is it renamed to a unique name. The renamed file is then
  re-read and must be byte-identical to the bytes judged stale. If not (a live
  runner replaced the lock in between), it is linked back without replacing
  anything and the open is refused. If another lock has already taken its
  place, the displaced file is left aside and its holder fails closed at its
  next ownership check. Only after a successful check does the opener create
  its own lock, using the same no-replace primitive.
- An empty or unparsable lock is treated as live (refused, left untouched)
  until its mtime is older than `RUNNER_LOCK_UNPARSABLE_GRACE_MS` (30 s).
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

As defence in depth (not run-dir isolation; the isolation itself is the child sandbox, see "Approval-store isolation" below),
hosted approvals also refuse a runner root that lies inside, or contains, the
workflow `cwd`.

### Ownership fence

A runner that has lost ownership must not consume decisions. `consumeDecision`
checks the fence first on every call, and `createHostedApproval` checks it
after every wait, immediately before consuming. Both re-read the lock file and
`run.json` and do not trust in-memory state:

- The store must come from `openRunnerStore`, its lock file must still carry
  its token, and the run dir must be inside its root. Otherwise the result is
  `runner_not_owner`. Nothing is written, because a non-owner must not write
  to the owner's authoritative log.
- The run's status must still be `running` (not `interrupted`, `aborted`, or
  terminal). Otherwise the result is `run_not_running`. This is recorded as an
  `approval.refused` row. It does not count toward the refusal cap, and the
  request stays pending.

In both cases the node ends cancelled (fail closed) and the request stays
pending (for `runner_not_owner`, in the new owner's view; for
`run_not_running`, in the same root, where no new owner may exist). The runner-store `updateRun` also refuses to
run after the lock is lost, so the old runner cannot overwrite the new owner's
`interrupted` status with its final status. While the lock is still held, the
runner-store `updateRun` also never changes the status of a stopped run
(`interrupted`, `completed`, `failed`, `aborted`, `stalemate`, `reauthored`):
executor finalization of a run that became `interrupted` mid-approval is
refused, and `interrupted` survives. Same-status patches (for example `endedAt`)
and `pending` to `running` still apply. `expireApproval` is fenced the same
way.

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
being unreachable from every child process. That is enforced by the child
sandbox (see "Approval-store isolation" below).

`RunStore.consumeDecision(runDir, decision, expected)` checks the delivered
decision against the persisted pending request and against the runner's
expected values:

- the runner's expected request ID;
- the current artifact hash;
- the actor policy verdict (`actorAuthorized`);
- all delivered binding fields, plus actor, nonce, decision and time.

It performs the read/check/write synchronously without yielding, which serializes
concurrent promises on the runner's JS event loop (only the registered runner store
can consume at all). Across processes the runner lock enforces one runner per store
root, and the ownership fence (above) refuses consumption by a runner that lost it.
The fence is **check-then-write, not atomic, across processes**: the lock is a pid
file, not a kernel lock, so a takeover landing between the fence read and the append
is not excluded. Reaching that window first needs a live lock to be displaced
(see takeover). During a misjudged takeover's put-back, the live lock is briefly
absent; the holder's fence then reports `runner_not_owner` and fails closed (a
liveness cost, not a safety hole). The runner root must be on a filesystem that
supports hard links (`link()`); otherwise opening fails closed. A lost-lock runner
may still append to `events.jsonl` (`node.end`); resume (out of scope) must fence
that chain before a second writer appends. Other processes or worker threads must
route writes through the owner.

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

## Approval-store isolation (P3 prerequisite, fixed)

Ruling (Dan, 2026-09-29 22:50, RULINGS-0929): "N3-03: titan #3 may merge with
the forgeable approval store documented as a P3 prerequisite (fix lands in P3
before any hosted use)." This section describes that fix
(`modules/workflow/child-sandbox.ts`).

When `createWorkflowRuntime` gets an `approver` (a hosted run):

- **Runner-owned store.** Pending approvals, consumed-approval records,
  `run.json`, `runner.lock`, events and the authoritative node artifacts stay
  under the runner store root. Only the runner process writes there.
- **Child scratch, not the run dir.** Children get a separate node scratch dir
  (`nodeScratchDir`, default a fresh `mkdtemp` under the OS tmp dir; it must not
  overlap the runner root). `ARTIFACTS_DIR`/`TITAN_ARTIFACTS_DIR`, agent
  sessions, `submit_result` files, inline scripts, evidence, receipts and
  best-of/mimeograph archives live there. Each node's output is mirrored to
  `$ARTIFACTS_DIR/nodes/<id>.md` so downstream nodes keep working; the store
  copy is authoritative.
- **No run dir in the environment.** `TITAN_RUN_DIR` is no longer exported to
  any child (executor node env and `/create-workflow`), and the sandbox drops
  any variable whose value names the runner root.
- **Sandbox.** Every hosted child process (bash and script nodes, verify
  runners through `deps.bash`, agent children through `runChild`'s
  `wrapSpawn`) runs under bubblewrap: the host filesystem read-only, a private
  `/tmp`, only the workflow cwd, the scratch dir and host-listed
  `sandbox.writable` paths writable, a new pid namespace with its own `/proc`,
  and the runner root (plus `sandbox.hide` paths) covered by an empty
  read-only tmpfs. A writable path may not contain or lie inside a hidden path,
  so a child cannot rename a parent of the root away. A child therefore cannot
  list, read, create, edit, truncate, delete, rename or symlink-swap
  `approvals.jsonl`, `run.json`, `runner.lock`, lock temp names or sibling
  runs, and cannot reach them through `/proc/<pid>/root`.
- **Fail closed.** Building the sandbox runs a preflight inside it (the root
  must look empty and be unwritable). No bwrap, a failing preflight, or a
  scratch/writable path overlapping the root throws, so the hosted runtime is
  not built.
- **No confused deputy.** The scratch dir is child-writable, so the runner
  writes and reads there only through `guardedWriteFileSync` /
  `guardedMkdirSync` / `guardedReadFileSync`: every component is opened with
  `O_NOFOLLOW` and multiply-linked files are refused, so a planted symlink or
  hard link cannot turn a runner write into a write to the store.

Tests: `tests/workflow-approval-isolation.test.ts` gives a child the store's
absolute paths and shows that every create/edit/replay/lock/sibling/proc
attack is blocked, the store bytes are unchanged, and the runner still
consumes the real decision.

Still required by the deployment (not code in this repo): the router and the
Studio must never hand units the runner root; hosts that keep several runner
roots under one parent should pass that parent in `sandbox.hide`; hosts that
need extra writable paths for agent children (for example `~/.pi/agent`) list
them in `sandbox.writable`. The TUI/headless path (no `approver`) is unchanged:
it keeps `<runDir>/artifacts` and runs children unsandboxed, and it has no
hosted approvals.

## Other callers

An `interactive: true` loop calls `deps.approval` without a node/content
binding. Under a hosted approver it gets `approval binding unavailable`, and the
loop stops (fail closed). Interactive loops are a TUI feature.
