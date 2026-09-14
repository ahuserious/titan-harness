<!-- Fused output of /titan-fusion on 2026-09-14 with antigravity/gemini-3.8-flash (architect), xai/grok-4.6, antigravity/claude-opus-4-6 (sources) and gemini-3.8-flash as the FUSION writer; cost $2.04, 323 s. GPT-6 Astra was unavailable (Codex OAuth needed re-login). Kept as the design record behind the 3-tier shape, the audit gate, callsign-only prompts and the hotkeys. Deviations in the implementation: auditors are per builder (operator choice) but ephemeral per review and cross-family; Ctrl+Tab / Ctrl+Shift+* are bound as requested with Alt+H/N/S/A twins. -->

# Titan Harness: Canonical Architectural Design Review & Recommendation

*Implementation Note: As sole writer in the working directory, the canonical recommendation document has been written and validated at `(scratch path, not kept)`.*

---

## (a) Final Hierarchy and Role Contracts

Adopt an **Explicit 3-Tier Asynchronous Hierarchy** with a **Shared Ephemeral Auditor Pool** and a serialized **Writer Lease** (`[GEMINI]`, `[GROK]`, `[OPUS]`).

```
[ Tier 1: ARCHITECT (Host Slot: HELM / ATLAS) ]
         │                        ▲
         │ (Task DAG Specification)│ (Audited Task Reports)
         ▼                        │
[ Tier 2: BUILDERS 1..N (Persistent Slots: FORGE-1..N) ] ──▶ [ Ephemeral AUDITOR POOL (WARD) ]
         │                                                      │ (PASS / Bounded Loops / Escalation)
         │ (Stateless Fast Delegations)                         ▼
         ▼                                              [ Mainline Workspace / Merge ]
[ Tier 3: SUBAGENTS (Ephemeral Sparks: MINIONS) ]
```

### Slot & Topology Resolution
- **Host Role Assignment**: The live host chat serves as the **Tier 1 ARCHITECT** (`[GROK]`). Assigning the host as a primary builder (`[OPUS]`) creates an inverted control loop where a background child orchestrates the human’s live session. Builder-as-host is preserved only as an alternate pair-programming preset (`forge.yaml`).
- **Isolation Policy**: Default is a **Single Working Tree with a Serialized Writer Lease** (`[GROK]`, `[OPUS]`). Isolated Git worktrees (`titan/builder-{id}`) are **Opt-In** (`isolation: worktree`) when the DAG defines disjoint path leases (`[OPUS]`, `[GROK]`). Unconditional worktrees (`[GEMINI]`) are rejected due to branch divergence, merge conflicts, and stash overhead.

### Role Contracts

#### Tier 1: ARCHITECT (Callsign: `HELM` / `ATLAS`)
- **Role**: Frontier Orchestrator (`openai/gpt-6-astra`, thinking: `xhigh`).
- **Allowed (Must Do)**:
  - Decompose user requests into an explicit Directed Acyclic Graph (DAG) with claimed paths (`claims[]`), target artifacts (`outputPaths[]`), dependency edges, and acceptance criteria (`[GEMINI]`, `[GROK]`, `[OPUS]`).
  - Assign tasks to builder slots by role callsign (`[GROK]`, `[OPUS]`).
  - Execute a single read-only scout burst before finalizing plans (`[GROK]`).
  - Arbitrate audit escalations, handle conflict resolution, and synthesize the final user transcript (`[GEMINI]`, `[GROK]`, `[OPUS]`).
- **Forbidden (Must Never Do)**:
  - **NEVER** edit, write, or delete files directly (`[GEMINI]`, `[GROK]`, `[OPUS]`).
  - **NEVER** execute mutating bash commands or hold the writer lease (`[GROK]`, `[OPUS]`).
  - **NEVER** spawn Tier 3 subagents directly (orchestration isolation; delegation must route through Tier 2) (`[GEMINI]`, `[OPUS]`).
  - **NEVER** conduct deep file searches, batch reads, or compiler runs directly (`[GEMINI]`, `[OPUS]`).
  - **NEVER** bypass an auditor `SAFETY` failure (`[GROK]`).

#### Tier 2: BUILDERS (Callsign: `FORGE-1` through `FORGE-N`)
- **Role**: Frontier Execution Engines (1–4 concurrent persistent `pi -p` slots; e.g., `xai/grok-4.6`, `antigravity/claude-opus-4-6`).
- **Allowed (Must Do)**:
  - Execute assigned DAG tasks strictly within claimed paths (`[GEMINI]`, `[GROK]`, `[OPUS]`).
  - Acquire the writer lease before mutating workspace files; release lease immediately on completion or error (`[GROK]`, `[OPUS]`).
  - Spawn Tier 3 subagents for fast parallel search, file reading, test suite execution, and localized edits (`[GEMINI]`, `[GROK]`, `[OPUS]`).
  - Run verification suites, collect test outputs, and generate structured reports ($\le 4\text{ KB}$) with diffs for audit (`[GEMINI]`, `[GROK]`, `[OPUS]`).
  - Execute bounded remediation rounds on receiving blocking defect checklists from the Auditor (`[GEMINI]`, `[GROK]`, `[OPUS]`).
- **Forbidden (Must Never Do)**:
  - **NEVER** mutate files outside claimed paths (`[GEMINI]`, `[GROK]`, `[OPUS]`).
  - **NEVER** hold the writer lease while idle or during read-only scouting (`[GROK]`).
  - **NEVER** spawn sibling builders or alter the global DAG topology (`[GEMINI]`, `[GROK]`, `[OPUS]`).
  - **NEVER** communicate horizontally with peer builders (all coordination routes through Architect) (`[GEMINI]`, `[OPUS]`).
  - **NEVER** permit Tier 3 subagents to spawn further subagents (`[GEMINI]`, `[GROK]`, `[OPUS]`).

#### Tier 3: SUBAGENTS (Callsign: `MINIONS` / `SPARKS`)
- **Role**: Ephemeral High-Throughput Workers (`cerebras/qwen-3.8-27b`, thinking: `high`).
- **Allowed (Must Do)**:
  - Execute narrow, stateless, atomic operations: `read, grep, find, ls`, read-only bash, and bounded web fetches (`[GEMINI]`, `[GROK]`, `[OPUS]`).
  - Perform localized edits only when the parent builder holds the writer lease and specifies exact file paths and line ranges (`[GROK]`, `[GEMINI]`).
  - Return compressed summaries, exact line numbers, and extracted excerpts ($\le 4\text{ KB}$) to the parent builder (`[GEMINI]`, `[GROK]`).
- **Forbidden (Must Never Do)**:
  - **NEVER** spawn 4th-tier subagents (runtime enforcement: `maxSubagentSpawnsPerRun = 0`) (`[GEMINI]`, `[GROK]`, `[OPUS]`).
  - **NEVER** hold the writer lease independently or perform unguided multi-file modifications (`[GROK]`, `[OPUS]`).
  - **NEVER** make architectural design decisions or persist state across tasks (`[GEMINI]`, `[GROK]`, `[OPUS]`).
  - **NEVER** communicate directly with the Architect, Auditor, or Human user (`[GEMINI]`, `[GROK]`, `[OPUS]`).

---

## (b) Audit Protocol and Verdict Format

### 1. Auditor Architecture & Model Selection
- **Pooled Ephemeral Reviewer**: Reject static 1:1 auditors per builder (`[GEMINI]`, `[GROK]`, `[OPUS]`). Use a shared pool of 1 auditor (2 if builders $n \ge 3$) spawned on-demand in a fresh session per review (`[GROK]`, `[OPUS]`).
- **Third Model / Cross-Family Rule**: The Auditor must belong to an orthogonal frontier family distinct from both the Architect and the Builder under review (`[GEMINI]`, `[GROK]`, `[OPUS]`).
  - If Builder is Grok $\rightarrow$ Auditor is Claude 3.7 Sonnet / Sonnet 4.5 or Gemini 3.8 Flash (`[GEMINI]`, `[GROK]`).
  - If Builder is Claude $\rightarrow$ Auditor is Grok 4.6 or Gemini 3.8 Flash (`[GEMINI]`, `[GROK]`).
  - Reject using the Architect's model (conserves top-tier quota, avoids homogenous groupthink) (`[GEMINI]`, `[GROK]`, `[OPUS]`). Reject Qwen-27B (lacks verification depth, triggering false-alarm thrashing or rubber-stamping) (`[GROK]`).
- **Context & Tools**: Auditor receives strictly: Task Spec, Acceptance Criteria, Builder Report, Scoped Git Diff, and Test Evidence (`[GEMINI]`, `[GROK]`, `[OPUS]`). The Builder's internal reasoning/scratchpad and model identity are withheld (`[GROK]`, `[GEMINI]`). Tools are restricted to read-only (`read, grep, find, ls`, read-only git) (`[GROK]`, `[OPUS]`).

### 2. Audit Lifecycle & Fail Policy: Bounded Gated Fail-Open
- **Trigger**: Non-empty diff or completed write task. Pure recon/read-only tasks skip audit (`AUDIT_SKIPPED`) (`[GROK]`).
- **Bounded Correction**: Maximum **2 correction rounds** (`[GEMINI]`, `[GROK]`, `[OPUS]`). On `FAIL`, the builder receives only structured blocking defect items and hints (no unstructured auditor prose) (`[GROK]`).
- **Resolution After Round 2 (Gated Fail-Open)**:
  - Reject pure fail-closed: halts the entire DAG on edge-case disputes (`[GEMINI]`, `[GROK]`, `[OPUS]`).
  - Reject silent fail-open: unverified code must not enter the codebase (`[GEMINI]`).
  - **Adopted Mechanism**: Mainline merge remains **BLOCKED**. The complete audit trail (diff, defect list, builder responses) escalates to the Architect with status `AUDIT_EXHAUSTED` (`[GEMINI]`, `[GROK]`, `[OPUS]`). The Architect arbitrates: (1) Override audit failure with explicit rationale, (2) Reassign to another builder, (3) Split/redefine the task, or (4) Prompt the human (`[GEMINI]`, `[GROK]`, `[OPUS]`).
- **Fail-Closed Exceptions**:
  - `SAFETY` violations (credential leaks, destructive shell commands, policy breaches) immediately freeze the writer lease, halt correction loops, and escalate to the human (`[GROK]`, `[OPUS]`).
  - `SCOPE_VIOLATION` (mutating files outside claimed paths) is hard fail-closed (`[OPUS]`).

### 3. Evaluation Checklist
1. **Contract Fidelity**: Did changes meet all task acceptance criteria without unrequested refactoring? (`[GEMINI]`, `[GROK]`, `[OPUS]`)
2. **Logic & Correctness**: Syntax validity, edge cases, null/error handling, type safety. (`[GEMINI]`, `[GROK]`, `[OPUS]`)
3. **Scope & Boundary Compliance**: Strict diff subset of claimed paths (`diff ⊆ claims`). (`[GEMINI]`, `[GROK]`, `[OPUS]`)
4. **Verification Evidence**: Reproducible test executions provided (`checked` vs `attested` vs `missing`). (`[GEMINI]`, `[GROK]`, `[OPUS]`)
5. **Diff Hygiene & Safety**: No leaked credentials, debug printouts, orphan files, or destructive scripts. (`[GEMINI]`, `[GROK]`, `[OPUS]`)

### 4. Machine-Parseable Verdict Format
Structured typed payload emitted by the Auditor:

```yaml
verdict: FAIL # PASS | PASS_WITH_WARNINGS | FAIL | INCONCLUSIVE | SAFETY
round: 1 # integer: 1..2
summary: "Missing socket error handler and unverified regression in parser."
checklist:
  contract_fidelity: PASS
  logic_correctness: FAIL
  scope_compliance: PASS
  verification_evidence: FAIL
  diff_hygiene: PASS
evidence_state: missing # checked | attested | missing
blocking:
  - file: "src/net/socket.ts"
    line_range: "42-50"
    rule: "logic_correctness"
    issue: "Unhandled promise rejection on socket disconnect."
    remediation: "Add catch block and emit disconnect event."
warnings:
  - file: "src/net/parser.ts"
    issue: "Variable name shadows outer module scope."
```

---

## (c) Anonymization Rules

### In-Prompt Anonymization (Inter-Agent Boundary)
- **Role Callsigns Only**: All agent-to-agent prompts, system messages, and DAG assignments reference functional callsigns (`HELM`, `FORGE-1`, `ANVIL`, `WARD`, `SPARKS`), never vendor identities (`[GEMINI]`, `[GROK]`, `[OPUS]`).
- **Context Sanitization**: Harness middleware strips vendor tokens, provider system prefixes, and API error signatures from task prompts, diff headers, and audit reports (`[GEMINI]`, `[GROK]`).
- **Capability Scoping**: Prompts disclose functional operational tiers (e.g., "FORGE-1 is a Tier-2 Execution Agent with writer lease"), avoiding model-specific prompting bias while maintaining operational context (`[GEMINI]`).
- **Downside Mitigations**:
  - *Self-identification leakage*: Models may leak styling; typed YAML/JSON exchange schemas enforce structural uniformity across providers (`[GEMINI]`, `[GROK]`, `[OPUS]`).
  - *Prompt tuning loss*: Frontier models execute universal structured Markdown/schema instructions reliably (`[GEMINI]`).

### Human-Facing Transcript (User Boundary)
- **Verdict: YES (Explicitly Show Models)** (`[GEMINI]`, `[GROK]`, `[OPUS]`).
- Human operators require full visibility for billing, token economics, latency/TPS tracking, debugging provider 429 rate limits, and monitoring model regressions (`[GEMINI]`, `[GROK]`, `[OPUS]`).
- **Rendering Mechanism**: The extension's TUI renderer (`renderResult` / `registerMessageRenderer`) injects provider and performance tags into headers and the status bar, while withholding these fields from LLM input contexts (`[OPUS]`, `[GROK]`).
  - Status display format: `[FORGE-1 · xai/grok-4.6 | Lease: Active | TPS: 68 | Subagents: 3/4 (cerebras/qwen-3.8-27b)]` (`[GEMINI]`, `[GROK]`).

---

## (d) Hotkey Semantics and Application Timing

### 1. Terminal Ergonomics & Keybinding Revisions
- **Reject `Ctrl+Tab`**: Standard terminal emulators (xterm, VT100, tmux, Windows Terminal, macOS Terminal) capture `Ctrl+Tab` for tab navigation or collapse it to standard `Tab`/`Ctrl+I`, conflicting directly with Pi's thinking and input completion controls (`[GEMINI]`, `[GROK]`, `[OPUS]`).
- **Primary Control**: An interactive `/titan` command overlay (`Ctrl+Shift+T` or leader key) provides the authoritative control plane (`[GROK]`, `[OPUS]`).
- **Direct Hotkey Bindings**:
  - **Harness Shape Cycle**: `Alt+H` or `Ctrl+Shift+H` (`[GEMINI]`, `[OPUS]`)
  - **Builder Count Cycle ($n$)**: `Alt+N` or `Ctrl+Shift+B` (`[GEMINI]`, `[GROK]`)
  - **Subagent Fan-Out Cap Cycle**: `Alt+S` or `Ctrl+Shift+F` (`[GEMINI]`, `[GROK]`)
  - **Auditor Toggle**: `Alt+A` or `Ctrl+Shift+Y` (`[GEMINI]`, `[GROK]`)

### 2. Application Timing Matrix
**Golden Principle: In-flight active execution is NEVER preempted or corrupted mid-run; changes take effect at clean task/turn boundaries** (`[GEMINI]`, `[GROK]`, `[OPUS]`).

| Parameter Changed | In-Flight Active Task | Queued DAG Tasks | Turn / Session Boundary |
| :--- | :--- | :--- | :--- |
| **Harness Shape (Stack YAML)** | **Untouched.** Running DAG completes under active shape (`[GEMINI]`, `[GROK]`, `[OPUS]`). | **Blocked.** Shape mutation mid-run is rejected with a warning (`[GEMINI]`, `[GROK]`). | **Next User Command Only.** New topology initializes on subsequent user turn (`[GEMINI]`, `[GROK]`, `[OPUS]`). |
| **Builder Count ($n \uparrow$)** | Active builders run uninterrupted (`[GEMINI]`, `[GROK]`, `[OPUS]`). | **Immediate.** New slots spawn and immediately consume waiting DAG tasks (`[GEMINI]`, `[GROK]`, `[OPUS]`). | Persists as new default (`[GEMINI]`). |
| **Builder Count ($n \downarrow$)** | **Soft Drain.** Active tasks finish; surplus slots are not preempted (`[GEMINI]`, `[GROK]`, `[OPUS]`). | Queued tasks serialize across remaining unretired slots (`[GEMINI]`, `[OPUS]`). | Surplus slots decommissioned once idle (`[GROK]`, `[OPUS]`). |
| **Subagent Fan-Out Cap** | Active subagents run to completion (`[GEMINI]`, `[GROK]`, `[OPUS]`). | Dynamic token bucket: new subagent requests throttle or expand immediately (`[GEMINI]`, `[GROK]`, `[OPUS]`). | Persists across turns (`[GEMINI]`). |
| **Auditor Toggle ON** | No retroactive audit on prior tasks (`[GROK]`). | Completed tasks immediately route to Auditor gate (`[GEMINI]`, `[GROK]`, `[OPUS]`). | Persists across turns (`[GEMINI]`). |
| **Auditor Toggle OFF** | In-flight audits complete or bypass immediately (`[GEMINI]`, `[GROK]`, `[OPUS]`). | Subsequent completed write tasks bypass audit (`AUDIT_SKIPPED`) (`[GEMINI]`, `[GROK]`). | Persists across turns (`[GEMINI]`). |

---

## (e) Risks and Mitigations

| Risk | Severity | Concrete Mitigation |
| :--- | :--- | :--- |
| **Cost & Latency Bloat** | High | Default $n=2$; restrict audits strictly to mutating write-tasks; subagents pinned to cheap Cerebras Qwen-27B; enforce a request budget cap (default $2.00) with pause/warning at 80% (`[GEMINI]`, `[GROK]`, `[OPUS]`). |
| **Auditor Thrashing & Pedantry** | High | Cap corrections at 2 rounds; restrict Auditor to a functional checklist; subjective style matters are non-blocking warnings; rotate to an orthogonal third-model family (`[GEMINI]`, `[GROK]`, `[OPUS]`). |
| **Writer Lease Deadlock / Starvation** | High | Enforce a strict 120s lease timeout with automatic revocation; release lease during read-only/scout phases; tool-call monitoring revokes lease on builder hang (`[GROK]`, `[OPUS]`). |
| **Architect Context Saturation** | Medium | Enforce a strict 4KB size cap on builder task reports; full diffs, build logs, and test dumps remain on disk (`.titan/logs/` or tool details), passing only concise structured summaries to the Architect (`[GEMINI]`, `[GROK]`, `[OPUS]`). |
| **Subagent Fork Bombs / Tool Escapes** | Medium | Enforce `maxSubagentSpawnsPerRun = 0` and strip the `subagent` delegation and file-writing tools from Tier 3 profiles; guard bash to read-only commands (`[GEMINI]`, `[GROK]`, `[OPUS]`). |
| **Session Drift in Persistent Slots** | Medium | Builders persist processes for prompt cache warmup, but execute automated session compaction/clearing (`session_before_compact`) between distinct DAG tasks (`[GEMINI]`, `[OPUS]`). |
| **Correlated Model Failures** | Medium | Heterogeneous builder roster by default (e.g. Grok + Claude); Auditor drawn from a non-overlapping vendor family (`[GEMINI]`, `[GROK]`, `[OPUS]`). |

---

## (f) Sensible Defaults

| Parameter | Recommended Default | Operating Range | Rationale |
| :--- | :--- | :--- | :--- |
| **Concurrent Builders ($n$)** | **2** | 1 – 4 | Optimal trade-off between parallel throughput, API rate limits, and writer lease contention (`[GEMINI]`, `[GROK]`, `[OPUS]`). |
| **Subagent Fan-Out Cap** | **4 concurrent / 8 queued** per Builder | 2 – 6 concurrent | Generates fast search/read bursts without swamping system IO or context windows (`[GROK]`, `[GEMINI]`, `[OPUS]`). |
| **Audit Correction Rounds** | **2** | 1 – 3 | Catches substantive defects; rounds $\ge 3$ yield diminishing returns and risk thrashing (`[GEMINI]`, `[GROK]`, `[OPUS]`). |
| **Auditor Pool Size** | **1** (scale to 2 if $n \ge 3$) | 1 – 2 | Fast read-only checklist execution prevents pipeline serialization (`[GROK]`, `[OPUS]`). |
| **Architect Model** | `openai/gpt-6-astra` (thinking: `xhigh`) | Best reasoning tier | Superior DAG planning and synthesis; fallback to `antigravity/claude-opus-4-6` (`xhigh`) (`[GEMINI]`, `[GROK]`, `[OPUS]`). |
| **Builder Models** | Slot 1: `xai/grok-4.6` (thinking: `high`)<br>Slot 2: `antigravity/claude-opus-4-6` (thinking: `high`) | Heterogeneous frontier | Diversity prevents correlated failures; Grok provides fast execution, Opus provides deep refactoring (`[GEMINI]`, `[GROK]`, `[OPUS]`). |
| **Auditor Model** | `anthropic/claude-sonnet-4-5` / `claude-3.7-sonnet` (thinking: `medium` / `high`) | Cross-family rotation | Strong structured evaluation at moderate cost; rotated orthogonal to the builder under review (`[GEMINI]`, `[GROK]`, `[OPUS]`). |
| **Subagent Model** | `cerebras/qwen-3.8-27b` (thinking: `high`) | Fixed high-throughput | Ultra-fast token generation, low cost, ideal for stateless atomic tool calls (`[GEMINI]`, `[GROK]`, `[OPUS]`). |
| **Writer Lease Timeout** | **120 seconds** | 30s – 300s | Sufficient for large multi-file writes; prevents permanent deadlocks on unhandled failures (`[OPUS]`, `[GROK]`). |
| **Builder Report Cap** | **4 KB** | 2 KB – 8 KB | Ingests summaries and line pointers while preventing Architect context bloat (`[GEMINI]`, `[OPUS]`, `[GROK]`). |
| **Worktree Isolation** | **Off (Opt-In)** | On / Off | Single tree + writer lease default; worktrees enabled only when DAG paths are verified disjoint (`[GROK]`, `[OPUS]`). |

### Additional Structural Proposals Evaluated
1. **Context Engineer Role — REJECTED** (`[GROK]`, `[OPUS]`): Redundant 4th tier. Context scoping belongs to the Architect's DAG design and the 4KB builder report cap.
2. **Standing Judge Role — REJECTED** (`[GROK]`, `[OPUS]`): Unnecessary standing resource. Subjective disputes or debates are handled as optional mode flags reusing an ephemeral auditor slot in specialized presets (`debate.yaml`).
3. **Status Bar & UI Dashboard — ACCEPTED** (`[GEMINI]`, `[GROK]`, `[OPUS]`): Persistent widget via `ctx.ui.setWidget()` displaying codenames, models, TPS, cost, and active lease status; detailed breakdowns available on tool expansion (`Ctrl+O`).

---

## Consensus & Divergence

### Full Consensus Across Sources
- **Explicit 3-Tier Acceptance**: All three reviewers (`[GEMINI]`, `[GROK]`, `[OPUS]`) approved formalizing the 3-tier hierarchy and strict operational boundaries (Architect plans/integrates, Builders execute/delegate, Subagents execute stateless atomic operations).
- **Auditor Model & Pooling**: All reviewers rejected 1:1 builder auditors in favor of an ephemeral pooled gate using a third frontier model orthogonal to the reviewee.
- **Anonymization & Human UI**: All reviewers agreed that internal inter-agent prompts must be strictly anonymized by role callsign, while human-facing transcripts must explicitly show model identities and runtime economics.
- **Hotkey Refactoring**: All reviewers rejected `Ctrl+Tab` due to terminal and editor collision constraints.
- **Rejection of Context Engineer & Standing Judge**: Both proposed roles were rejected as costly token overhead that is better handled by Architect scoping and mode-flagged auditor passes (`[GROK]`, `[OPUS]`).

### Resolved Divergences
1. **Host Slot Assignment**: `[OPUS]` preserved the primary builder as the live host chat session. `[GROK]` argued that this inverts the architecture (forcing the human to interact with a worker while a child orchestrates). `[GROK]`'s analysis is adopted for the core Titan harness (Host = Architect), reserving builder-as-host for a pair-programming preset (`forge.yaml`).
2. **Worktree Isolation vs. Writer Lease**: `[GEMINI]` recommended replacing the single-writer lock entirely with isolated Git worktrees. `[GROK]` and `[OPUS]` argued that always-on worktrees introduce branch management overhead and merge conflict complexity. The resolution keeps the single working tree with a serialized writer lease (120s timeout) as default, supporting worktrees as an opt-in mode (`isolation: worktree`) for verified disjoint task graphs.
3. **Fail-Open Policy vs. Safety Halts**: `[GEMINI]` proposed a general fail-open to the Architect without merging. `[GROK]` and `[OPUS]` introduced concrete fail-closed exceptions for `SAFETY` and `SCOPE_VIOLATION`. The resolution establishes gated fail-open to the Architect for quality defects, but enforces immediate fail-closed termination for safety and scope breaches.

### Source Manifest Disclosure
All three configured agents completed successfully with valid artifacts:
- `[GEMINI]` (`antigravity/gemini-3.8-flash`): Status `done`, ok: `true`.
- `[GROK]` (`xai/grok-4.6`): Status `done`, ok: `true`.
- `[OPUS]` (`antigravity/claude-opus-4-6`): Status `done`, ok: `true`.
No sources failed or were missing from the review.