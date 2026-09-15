# JUDGE REPORT: TITAN-HARNESS ULTRAPLAN ARCHITECTURAL PANEL

**Evaluation Target:** Four candidate integration plans (Seats A, B, C, D) for integrating the operator brief into `ahuserious/titan-harness` (Pi 0.85.1 harness).  
**Governing Standards:** 7 verified machine constraints, Grok Review Verdict B, Archon DAG specifications, K-Dense BYOK precedents, and the 9 required delivery sections.

---

## 1. Ranking with Scores (0–10) per Seat

| Seat | Constraint Compliance | Completeness | Concreteness | Feasibility & Realism | Risk Awareness | Composite Score | Rank |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Seat C** | 9.8 | 9.7 | 9.8 | 9.4 | 9.8 | **9.70** | **1** |
| **Seat A** | 9.6 | 9.5 | 9.5 | 9.2 | 9.4 | **9.44** | **2** |
| **Seat D** | 9.3 | 9.2 | 9.3 | 9.0 | 9.3 | **9.22** | **3** |
| **Seat B** | 7.6 | 8.2 | 8.0 | 7.8 | 7.6 | **7.84** | **4** |

### Seat Justifications

*   **Seat C (Rank 1 — 9.70):** Exceptional architectural rigor and precision. Seat C exhibits complete mastery over Pi 0.85.1 internals, subprocess execution semantics, and model reasoning ceilings. It delivers an airtight schema v2 for harness levels, solves child context exhaustion proactively via 75% usage pre-emption (critical for Cerebras Qwen’s 131k ceiling), provides explicit prompts and schemas for pre-compaction state reconstruction, and bridges all three InfraNodus structural gaps with concrete runtime mechanisms.
*   **Seat A (Rank 2 — 9.44):** A highly disciplined, production-ready specification adhering strictly to Verdict B. Seat A cleanly separates the titan native YAML engine from `@quintinshaw/pi-dynamic-workflows` 3.10.1, enforces hard evidence boundaries (`observed` vs `declared`), and presents an immaculate verification matrix. It only slightly trails Seat C in child-context monitoring depth and fallback slot abstractions.
*   **Seat D (Rank 3 — 9.22):** Highly creative and technically nuanced, contributing pivotal insights such as "logical clearing" (preserving SHA-256 hash chains across compaction recoveries instead of illegal transcript deletions) and identifying Exa fan-out as tool-equipped worker subagents. It is docked slightly for introducing a dedicated child extension (`child-structured.ts`) that bypasses the `TITAN_HARNESS_CHILD=1` recursion guard, introducing unnecessary subprocess complexity.
*   **Seat B (Rank 4 — 7.84):** Competent in broad strokes but marred by technical inaccuracies, constraint slips, and ungrounded assumptions. Seat B silently alters Level 0 thinking to `high` rather than displaying `requested xhigh / effective high`, assumes Muse Spark 1.3 is active despite having no API key on the machine, replaces Level 3 workers with generic subagents, relies on `try/catch` for Pi's silent `shift+tab` drop, and places external `orca terminal split` on the critical path instead of treating it as an opt-in surface.

---

## 2. Consensus

The four seats reached strong unanimous or super-majority consensus on the following foundational decisions:

*   **Native YAML DAG Engine inside `titan-harness` (All Seats: A§1, B§1, C§1, D§1):** Archon on this machine is an engine-less specification. Attempting to compile Archon DAGs to `@quintinshaw/pi-dynamic-workflows` (DW) 3.10.1 was universally rejected because DW runs sandboxed JavaScript, strips ambient extensions in foreground children, lacks a YAML parser, and crashes on version 3.11. Titan executes workflows via its own TypeScript DAG scheduler driving isolated `pi --mode json -p` subprocesses.
*   **DB-Free JSONL Hash-Chained Store over SQLite/NoSQL (All Seats: A§1/§6, B§1/§6, C§1/§6, D§1/§6):** All seats rejected Archon’s SQLite database and embedded NoSQL alternatives. Following K-Dense BYOK precedents, append-only JSONL files with canonical key sorting and SHA-256 digest chains (`prev_sha256 -> sha256`) provide zero-dependency, crash-resilient, git-diffable provenance immune to multi-process locking collisions.
*   **Independent Titan Watchdog Engine (All Seats: A§1/§5, B§1/§5, C§1/§5, D§1/§5):** `pi-subagents` 0.67 cannot serve as the system watchdog because it lacks an on-demand/cross-session API, ignores `session_before_compact`, does not monitor external `pi -p` children, and fails to ledger watchdog token burn. Titan hosts its own watchdog module subscribing to Pi host lifecycle events and child JSON streams, reusing only the `subagent_watchdog_warning` card schema.
*   **`shift+tab` Rebind Strategy (All Seats: A§1/§4, B§1/§4, C§1/§4, D§1/§4):** Pi 0.85.1 reserves `shift+tab` for `app.thinking.cycle` in `runner.js`. Extensions attempting to bind it directly are silently dropped. All seats agree that the user must rebind `app.thinking.cycle` to `alt+t` in `~/.pi/agent/keybindings.json` and `/reload`, while Titan provides an immediate, conflict-free `alt+l` twin shortcut.
*   **Evidence Hardness Invariant (All Seats: A§5, B§5, C§5, D§5.1):** Textual assertions by LLMs (e.g., "all tests passed") are categorized as `confidence: declared` and are strictly invalid for task sign-off. Transition to `done-verified` mandates `confidence: observed` bytes (sha256 hashes of test runner logs, Kane DOM/screenshot artifacts, database transaction receipts).
*   **InfraNodus as Catalog MCP Entry (All Seats: A§1/§2, B§1/§2, C§1/§2, D§1/§11):** Adhering to Grok Verdict B, InfraNodus enters solely as an MCP catalog definition in `mcp/mcp.json` (`npx -y infranodus-mcp-server`), exposed via `pi-mcp-adapter` 2.33.0. No native graph visualization or C++ code is merged into Titan.
*   **1-2-3 Escalation Ladder (All Seats: A§5, B§5, C§5, D§5.4):** Failure 1 triggers an in-place retry with a one-step thinking boost. Failure 2 escalates to the maximum reasoning effort and frontier model for that builder family. Failure 3 triggers an engine-level halt, transitioning to `repairing-workflow`, requiring the Architect to author a new DAG with tighter phases and smaller context scopes.

---

## 3. Disagreements

### Disagreement 1: `/workflow-monitor` Surface Architecture
*   **Positions:**
    *   *Seat B (§1.2, §7-P7):* Makes `orca terminal split` primary. Spawns an external terminal pane via Orca CLI and pipes status JSONL into it; treats Pi's in-process overlay as a secondary fallback.
    *   *Seat C (§1-D2, §2-F4):* Uses a standalone tailer script (`scripts/titan-monitor.mjs`) driving an `orca terminal split` or `tmux split-window`, with an unfocused Pi overlay fallback (`ctx.ui.custom`), while anchoring aggregate totals in the belowEditor model bar.
    *   *Seats A (§1, §2) & D (§1.3, §2-B4):* Makes the in-process Pi overlay (`ctx.ui.custom` + `handle.unfocus`) and the belowEditor footer widget primary. Treats `orca terminal split` as an optional, opt-in twin via `--split`.
*   **Reasoned Pick:** **In-process overlay primary; Orca split opt-in (Seats A & D).**
    *   *Rationale:* Pi is an independent coding agent harness. Hard-coupling the default monitoring experience to an external terminal multiplexer (`orca terminal split`) breaks compatibility in standard terminal emulators, SSH sessions, or headless environments. Pi 0.85.1’s `ctx.ui.custom` with `handle.unfocus({ target: editor })` provides an in-process, non-blocking TUI overlay that works anywhere.

### Disagreement 2: Watchdog Compaction Handling & Log "Clearing"
*   **Positions:**
    *   *Brief Mandate:* "...halts & inspects for hallucination / compaction loss, then clears the inspected agent's logs to continue, or switches to the same model as the architect... and gives a proper resume prompt."
    *   *Seats A (§5) & B (§5):* Take the brief literally: capture a state block during `session_before_compact`, cancel lossy summarization, and clear/reset transcript logs to continue.
    *   *Seat C (§5):* Intercepts `session_before_compact` on host; for children, monitors usage threshold (75%) or stream. If clean, trims inspected logs; if loss detected, spawns a fresh session on the Architect's model with a resume prompt.
    *   *Seat D (§1.5, §5.5, §8):* Identifies a severe architectural contradiction: physically clearing/deleting an inspected agent's session log violates the immutable append-only SHA-256 hash chain and destroys audit provenance. Seat D introduces **"logical clearing"** (checkpointing state into a fresh child session, marking the prior transcript `logical_cleared`, while preserving the underlying bytes in the immutable JSONL log).
*   **Reasoned Pick:** **Logical Clearing with Custom Pre-Compaction Summary (Seat D + Seats A/C).**
    *   *Rationale:* Seat D makes the superior argument. Physical deletion of log files corrupts K-Dense hash chains and breaks forensic reproducibility. Logical clearing preserves cryptographic immutability while achieving the brief's exact operational objective: restarting the agent with a clean context window containing an Architect-authored resume prompt.

### Disagreement 3: Structured Output Mechanism for Child Subprocesses
*   **Positions:**
    *   *Seat A (§2-A2):* Enforces output schema via prompt engineering and a terminating validation parser in `prompt-library.ts` with bounded retries ($\le 3$).
    *   *Seat B (§2, §3):* Implements TypeBox schema validation with strict JSON extraction and bounded re-prompting.
    *   *Seat C (§1-D10):* Phased approach: v1 prompt-based schema validation with re-ask ($\le 3$); v2 child-side terminating `submit_result` tool registered when `TITAN_NODE_SCHEMA` is present.
    *   *Seat D (§1.7, §2-A2):* Ships a distinct child extension (`child-structured.ts`) that specifically bypasses `TITAN_HARNESS_CHILD=1` to register a terminating `structured_output` tool inside every child agent.
*   **Reasoned Pick:** **Phased Prompt Validation evolving to Native Terminating Tool (Seat C).**
    *   *Rationale:* Seat D’s bypass of the `TITAN_HARNESS_CHILD=1` recursion guard risks re-introducing extension loading loops and fragile subprocess states. Seat C’s strategy provides immediate zero-risk stability via schema re-prompting (identical to Archon's Pi implementation), followed by a controlled terminating tool registration that does not compromise harness recursion guards.

### Disagreement 4: Representation of Level 3 Exa Agents (Fan-Out 10)
*   **Positions:**
    *   *Seat A (§4):* Treats Exa fan-out as a configuration integer (`exa: 10`) passed to the stack settings.
    *   *Seat B (§4):* Configures `childExa: true` and `exaFanOut: 10`, but replaces the worker fan-out with `subagentFanOut`.
    *   *Seat C (§4):* Defines Exa slots in schema v2 (`lantern-n`) carrying Exa tools with a dedicated fan-out of 10.
    *   *Seat D (§4.1, §8):* Highlights the semantic reality: Exa is a set of 4 search tools (`pi-exa`), not an LLM model family. It concretely instantiates Exa lanes as lightweight worker subagents running Cerebras Qwen (for cost efficiency) equipped with `pi-exa` tools, capped by a concurrency semaphore.
*   **Reasoned Pick:** **Lightweight Worker Children Equipped with Exa Tools (Seat D + Seat C).**
    *   *Rationale:* Treating "Exa" as an abstract agent without assigning a model causes runtime executor failures. Seat D correctly maps Exa agents to Cerebras Qwen subprocesses loaded with host Exa tools, ensuring searches execute at ultrafast speeds without inflating frontier token burn.

### Disagreement 5: Level 3 Worker Slot Discrepancy
*   **Positions:**
    *   *Brief Ambiguity:* Lists `n workers gemini-3.8-flash high`, but adds an alternate listing: `workers / database ops / findings document curation = grok-4.6 high`.
    *   *Seat A (§4):* Configures Gemini 3.8 Flash high as the default; treats Grok 4.6 high as a manual stack-settings override.
    *   *Seat B (§4):* Configures Gemini 3.8 Flash high; ignores Grok 4.6 high entirely.
    *   *Seats C (§4) & D (§4.1):* Simultaneously incorporate both slots into the Level 3 shape via role-based routing (`scout`/`clerk` = Gemini 3.8 Flash high for general tasks; `ledger`/`quarry` = Grok 4.6 high for database operations and findings curation).
*   **Reasoned Pick:** **Simultaneous Dual-Lane Routing (Seats C & D).**
    *   *Rationale:* Forcing the operator to manually toggle configuration files defeats the purpose of an autonomous orchestrator. Workflow nodes declaring `role: worker` route to Gemini, while nodes declaring database operations or curation route automatically to Grok.

---

## 4. Minority Findings Worth Preserving

*   **Seat C — Proactive 75% Context Usage Pre-emption (§5):**
    *   *Finding:* Cerebras Qwen-3.8-27b has a hard hardware ceiling of 131k context. Rather than waiting for Pi to trigger a reactive `session_before_compact` (which can drop turns mid-tool execution), Seat C’s watchdog monitors child JSON streams and pre-emptively halts the child at 75% context usage (~98k tokens), executing a clean state extraction and session rotation. *Must be incorporated into the final fused plan.*
*   **Seat C — Schema v2 with Template Pools & Model Fallbacks (§4):**
    *   *Finding:* Harness shapes cannot remain flat slot arrays if they are to support dynamic fan-outs up to 10. Seat C defines Shape Schema v2 supporting role pools (`forge-1..n`, `scout-1..n`) and explicit fallback chains (e.g., `model: openai-codex/gpt-6-astra`, `fallback: anthropic/claude-fable-5-1`). This allows unauthenticated frontier models to degrade gracefully without breaking workflow launch. *Must be incorporated.*
*   **Seat D — "Logical Clearing" for Compaction State Recovery (§1.5, §8):**
    *   *Finding:* Preserves append-only cryptographic provenance by flagging compacted sessions as `logical_cleared` while maintaining physical disk bytes, solving the contradiction between the operator brief and K-Dense SHA-256 integrity rules. *Must be incorporated.*
*   **Seat B — 5,000ms Watchdog Pre-Compaction Timeout (§8):**
    *   *Finding:* If a secondary watchdog agent takes too long inspecting diffs during `session_before_compact`, Pi's turn runner will freeze or drop connection. Seat B enforces a strict 5-second timeout on pre-compaction inspection, falling back to a deterministic state block immediately. *Must be incorporated.*
*   **Seat B — Auto-Discovery of `INFRANODUS_API_KEY` from Claude Code (§8):**
    *   *Finding:* The InfraNodus API key exists on this machine inside Claude Code’s `~/.claude.json`, but is absent from Pi’s ambient environment. Auto-importing this key during MCP adapter setup avoids manual credential duplication. *Must be preserved.*

---

## 5. Errors and Constraint Violations

### Seat B
1.  **Hard Constraint 4 Violation (Thinking Ceilings):** In §4 (Level 0), Seat B silently sets Rune's thinking to `thinking: high`. The operator brief explicitly demands requested `xhigh` on Level 0, requiring the system to normalize and report it as `requested xhigh / effective high`.
2.  **Hard Constraint 4 Slip (Uncredentialed Models):** In §2 and §4, Seat B lists `openrouter/meta/muse-spark-1.3` as active @ `xhigh` in `/ultraplan` without noting in the tables that no OpenRouter key exists on the machine, relegating this fact to a risk footnote.
3.  **Constraint 1 Misunderstanding (Keybindings):** In §1.5, Seat B claims registering `shift+tab` in a `try/catch` block will catch collisions. Pi 0.85.1’s `runner.js` does not throw an exception when an extension registers a reserved key; it silently drops the binding with a diagnostic log.
4.  **Hard Constraint 5 Slip (Architect Write Permissions):** In §3, Seat B fails to specify in the YAML validator that nodes with `role: architect` must be stripped of `write` and `edit` tools.
5.  **Brief Specification Omission:** In §4 (Level 3), Seat B omits the dedicated workers fan-out, renaming and collapsing workers into `subagentFanOut: 5`.

### Seat A
1.  **Minor Fan-Out Discrepancy:** In §4 (Level 0), Seat A specifies builder fan-out as 1, whereas the brief requests ultrafast fan-out defaults of 5 workers and 5 Exa agents. (Seat A lists workers 5 in comments, but omits it from the primary YAML template block).

### Seat C
1.  **Scope Creep / Version Numbering:** In §1 and §7, Seat C targets version bumps up to `1.0.0`, whereas Grok Verdict B and the machine status specify remaining within the `0.3.0` -> `0.8.0` progression.

### Seat D
1.  **Subprocess Guard Risk:** In §1.7 and §2-A2, Seat D proposes bypassing `TITAN_HARNESS_CHILD=1` for `child-structured.ts`. This risks re-triggering parent extension hooks within nested child environments.

---

## 6. Gaps (Brief Requirements Missed by ALL Seats)

1.  **Content Creation 3× Human Review Preset Catalog Schema:**
    *   *Requirement:* "content creation: only content proven 3x to pass human review per industry / content type / user preference presets goes back to agent review prior to shipping."
    *   *Gap:* All seats implemented a generic counter requiring 3 approvals, but **no seat defined the structure or location of the preset catalog itself** (e.g., how `.titan/presets/content/<industry>-<type>.yaml` defines rubric thresholds, brand voice, or user preference profiles).
2.  **`/terraform` Real-Time Data Connectors Definition:**
    *   *Requirement:* `/terraform ... connects to real-time data & platforms, creates automations & roadmaps that trigger workflow creation autonomously if wanted.`
    *   *Gap:* All seats detailed the Wayfinder document generation (`vision.md`, `intent.md`), but **no seat specified how real-time data connectors actually attach to external platforms** (e.g., GitHub webhooks, Linear API, live DB connections) or how live telemetry updates the reasoning ontology.
3.  **Cursor Cloud Agent Authentication & Workspace Indexing:**
    *   *Requirement:* Prototyping and production tiers verify SWE via Cursor cloud agents.
    *   *Gap:* All seats cited `POST https://api.cursor.com/v1/agents`, but **no seat detailed how the workspace context, repository branch, and Cursor API authentication are pre-flighted or injected** on a headless CLI machine without an active Cursor GUI session.

---

## 7. Fusion Guidance

### A. Prioritized Plan Source Matrix

The final fused plan must be synthesized directly from the four candidates according to this strict source mapping:

1.  **From Seat C:**
    *   **Core Architecture & Shape Schema v2 (§4):** Adopt Seat C’s Shape Schema v2 with slot pools, template expansion, and explicit fallback models for unauthenticated frontier slots.
    *   **Child Context Pre-emption Engine (§5):** Adopt the 75% usage threshold halt for child subprocesses to prevent Cerebras 131k compaction overflow.
    *   **Detailed Delivery Roadmap (§7):** Adopt Seat C’s phased delivery plan (P0 through P9), preserving exact test acceptance criteria and version gates (re-pegged to 0.3.0 -> 0.8.0).
    *   **Validator & Tier Policy Rules (§3, §5):** Adopt Seat C’s validator rules enforcing that Architect roles cannot possess write tools and builder nodes cannot complete without auditor signoff.
2.  **From Seat D:**
    *   **Logical Clearing Architecture (§1.5, §5.5):** Implement compaction recovery via logical session rotation and checkpointing, preserving append-only SHA-256 cryptographic provenance.
    *   **Exa Subagent Modeling (§4.1):** Model Exa agents as Cerebras Qwen worker subagents equipped with host `pi-exa` tools, subject to a global concurrency semaphore.
    *   **Dual-Lane Worker Routing (§4.1):** Route Level 3 general worker tasks to Gemini 3.8 Flash high and database/curation tasks to Grok 4.6 high.
    *   **Honest Triggering & Partial Surface Disclosures (§1.12, §8):** Adopt Seat D’s explicit disclosure regarding Pi’s lack of a native scheduler, utilizing file-signal triggers and documented cron hooks.
3.  **From Seat A:**
    *   **In-Process Monitor Overlay & BelowEditor Bar (§1, §2):** Implement the primary workflow monitor using `ctx.ui.custom` with `handle.unfocus({ target: editor })` and the footer widget; keep Orca terminal split as an opt-in CLI flag.
    *   **Strict Evidence Manifest Schema (§5, §6):** Enforce K-Dense confidence classifications (`observed`, `inferred`, `declared`) with fail-closed gates rejecting declared-only claims.
    *   **Grok Gap-Fill Exhaustiveness (§2, §7-P1):** Adopt Seat A’s verbatim execution of the Grok Verdict B gap-fill items.
4.  **From Seat B:**
    *   **Watchdog Pre-Compaction Timeout (§8):** Incorporate the 5,000ms safety timeout on pre-compaction inspection turns.
    *   **Ambient Key Discovery (§8):** Auto-import `INFRANODUS_API_KEY` from `~/.claude.json` into Pi’s MCP environment during adapter boot.

---

### B. InfraNodus Structural Gaps Assessment

The operator brief highlights three structural gaps identified in the InfraNodus cognitive network analysis. Here is how the seats performed and how the final plan bridges them:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    INFRANODUS STRUCTURAL GAP BRIDGES                        │
├───────────────────────────────┬─────────────────────────────┬───────────────┤
│ Structural Gap                │ Evaluation Across Seats     │ Fused Bridge  │
├───────────────────────────────┼─────────────────────────────┼───────────────┤
│ 1. High Performance           │ Seat A: Level 2 reads       │ Level 2/3 DAG │
│    ↔ Decision Analysis        │    terraform docs.          │ compilation   │
│    (Ultrafast execution       │ Seat B: Weak (notes only).  │ injects       │
│    decoupled from entity      │ Seat C: Strong (triggers    │ InfraNodus    │
│    intent and ontology)       │    parse entity profile).   │ ontology hints│
│                               │ Seat D: Context packs link  │ into planner  │
│                               │    ontology to authoring.   │ prompt.       │
├───────────────────────────────┼─────────────────────────────┼───────────────┤
│ 2. High Performance           │ Seat A: 1-2-3 ladder bumps  │ 3-fail CI red │
│    ↔ Verification Loop        │    thinking then reauthors. │ halts run,    │
│    (Fast builder loops        │ Seat B: In-place retry only.│ re-authors DAG│
│    churning without           │ Seat C: Escalates harness   │ at higher     │
│    escalating verification    │    level & cuts ctx budget. │ level with    │
│    rigor)                     │ Seat D: Freeze/restart with │ halved context│
│                               │    parent_run_id link.      │ scopes.       │
├───────────────────────────────┼─────────────────────────────┼───────────────┤
│ 3. Agent Review               │ Seat A: Auditors use fresh  │ Ephemeral     │
│    ↔ Context Management       │    ctx & hashed artifacts.  │ cross-family  │
│    (Deep reviews polluting    │ Seat B: Basic diff capture. │ auditors read │
│    context and triggering     │ Seat C: 75% ctx pre-emption │ disk artifacts│
│    destructive compactions)   │    & immutable manifests.   │ while watchdog│
│                               │ Seat D: Logical clearing of │ freezes state │
│                               │    compaction state blocks. │ at 75% ctx.   │
└───────────────────────────────┴─────────────────────────────┴───────────────┘
```

#### Detailed Gap Bridging Analysis:
1.  **High Performance ↔ Decision Analysis:**
    *   *The Problem:* Ultrafast worker execution (Levels 0/1) optimizes solely for execution throughput, remaining blind to org bias, business intent, and system ontology.
    *   *Bridge:* **Bridged by Seats C and D.** Level 2 automated jobs require an upfront Architect pass that ingests `.titan/terraform/` artifacts (`vision.md`, `intent.md`, `ontology.md`). The workflow compiler invokes `titan_harness__infranodus__generate_contextual_hint` and injects the resulting ontology graph directly into the builder prompts, ensuring ultrafast code generation adheres strictly to verified architectural constraints.
2.  **High Performance ↔ Verification Loop:**
    *   *The Problem:* Rapid builder loops can burn through iterations encountering the same error without increasing reasoning depth or re-evaluating the decomposition.
    *   *Bridge:* **Bridged by Seats A, C, and D.** Governed by `modules/elevation.ts`: Failure 1 bumps model reasoning effort. Failure 2 escalates the builder slot to the frontier family ceiling. Failure 3 triggers a hard freeze (`parent_run_id`), increments the harness level (`min(L+1, 3)`), halves the `context_budget` per node, and requires the Architect to author a new workflow that decomposes the failing seam into tighter, smaller phases.
3.  **Agent Review ↔ Context Management:**
    *   *The Problem:* Thorough auditor reviews require massive diffs, test logs, and DOM snapshots. Injecting these into active conversation contexts balloons token counts, triggering Pi’s lossy compaction and inducing catastrophic forgetting.
    *   *Bridge:* **Bridged by Seats C and D.** Ephemeral auditors execute in cold, isolated child sessions (`context: fresh`), reading structured evidence strictly from immutable disk artifacts (`artifacts/nodes/<id>.md` and `.titan/evidence/`). Furthermore, Seat C’s proactive 75% context usage pre-emption and Seat D’s logical clearing guarantee that neither builders nor verifiers ever suffer from mid-turn compaction amnesia.

---

### C. Final Unified Implementation Directives

1.  **Immediate P0 Operator Unblocks:**
    *   Execute `/login openai-codex` to re-authenticate `gpt-6-astra`.
    *   Execute the keybinding remapping command to set `"app.thinking.cycle": "alt+t"` in `~/.pi/agent/keybindings.json`, freeing `shift+tab` for Titan harness level cycling.
    *   Import `INFRANODUS_API_KEY` from Claude Code configuration.
2.  **File System & Process Invariants:**
    *   All workflow state, ledger rows, and evidence records must reside in `~/.pi/titan-harness/runs/<projectSlug>/<runId>/`.
    *   Provenance and ledgering must use append-only JSONL files with canonical SHA-256 digest chains. No database binaries (SQLite or NoSQL) may be added to package dependencies.
    *   Every child subprocess invocation must set `TITAN_HARNESS_CHILD=1`, inherit ambient host providers and MCP catalog entries, and run with callsign-anonymized prompts.
    *   The Architect role must be strictly denied file-modifying tools (`write`, `edit`, mutating `bash`) by the workflow schema validator.

**Verdict:** Seat C provides the winning master architectural blueprint. Integrate Seat D’s logical clearing and worker routing, Seat A’s in-process TUI monitor and evidence manifests, and Seat B’s pre-compaction timeout to construct the definitive Titan Ultraplan integration.