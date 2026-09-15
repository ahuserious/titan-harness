# P6 contract — /workflow-monitor (titan-harness 0.6.1)

Plan: D4 (in-process first: overlay primary, model-bar row always, `--split` opt-in), §5.4 (state vocabulary + colours + glyphs + phase rail + nested sub-rows), §2 row H4, §7 P6 row + §7.2 exit bar (frame snapshots for every state; overlay keeps editor input in a TUI smoke; `--split` pane updates within 2 s under Orca and tmux; a pi-dynamic-workflows run appears as a row). Store layout: modules/run-store.ts (run.json, events.jsonl, ledger.jsonl, agents/*.json; listRuns; index.jsonl), ledger.ts (totalsFor/formatTotals), tui.ts (cell helpers, colour handling — read how rows are styled), Pi TUI facts: scratchpad pi-internals-*.md (ctx.ui.custom({overlay:true}) + handle.unfocus({target: editor}); belowEditor widget already owned by titan's renderFooterWidget; no sidebar/split API; Orca CLI `orca terminal split` and tmux `split-window` as the opt-in pane). pi-dynamic-workflows runs: `~/.pi/workflows/projects/<key>/runs/*.json` (read-only polling; inspect a real file if one exists under ~/.pi/workflows, else follow the shape in ~/.pi/agent/npm/node_modules/@quintinshaw/pi-dynamic-workflows/dist — name the fields you rely on).

Owner "monitor" creates ONLY: modules/monitor/{state,rows,frame,dw-adapter,index}.ts, modules/cmd-monitor.ts, scripts/titan-monitor.mjs, tests/monitor.test.ts, tests/fixtures/monitor/{events.jsonl,run.json,agents/*.json,ledger.jsonl,dw-run.json}. The overlay registration itself and the `/workflow-monitor` command wiring into titan-harness.ts are the lead's; cmd-monitor.ts exposes a deps seam like cmd-workflow.ts (register(pi, deps) with deps.openOverlay(render) / deps.closeOverlay() / deps.spawnSplit(command) / deps.store() / deps.cwd(ctx)), and its pure parts (row building, frame rendering, phase rail, colour map) live in modules/monitor/* so tests never touch pi.

## state.ts
```ts
export const STATE_COLORS: Record<AgentState, string>   // exactly §5.4 hex values (queued #64748b … cancelled #6b7280; add failed-review #9f1239)
export const STATE_GLYPH: (state: AgentState, tick: number) => string   // spinner frames ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ for working states (dispatched-working, in-review, harvesting, compacting, inspecting-compaction, resuming, authoring-workflow, repairing-workflow, system-run), `●` for needs-input/terminal (waiting-architect, stalemate, done-*, failed, cancelled, blocked-guard, held-spend, watchdog-failed, uncertain-launch, failed-review), `○` for queued
export const TERMINAL_STATES, WORKING_STATES, NEEDS_INPUT_STATES: AgentState[]
export function isVerified(state): boolean   // only done-verified — never collapse done-unverified into it
```
Import AgentState from modules/watchdog/state.ts when it exists (P5 is being built in parallel — poll `ls modules/watchdog/` every 2 minutes ≤ 20 minutes; if absent, declare the union locally in state.ts with a TODO to switch).

## rows.ts (store → view model)
```ts
export interface MonitorRow { agentId: string; callsign: string; role: string; model: string; thinking: string /* "xhigh↘high" via thinkingLabel */; state: AgentState; phase?: string; tokens: number; costUsd: number; tps?: number; nodeId?: string; depth: 0 | 1; parentId?: string; wd?: number /* ingested watchdog warnings */; startedAt?: string; updatedAt?: string; note?: string }
export interface RunView { runId: string; workflow?: string; command?: string; status: string; level?: number; tier?: string; shape?: string; phases: Array<{ title: string; state: "done" | "active" | "pending" }>; rows: MonitorRow[]; totals: string /* formatTotals */; verified: { verified: number; unverified: number; failed: number }; startedAt: string; endedAt?: string; source: "titan" | "pi-dynamic-workflows"; elapsedMs: number }
export function buildRunView(store: RunStore, runDir: string, now?: number): RunView   // agents/*.json → rows (state from the record, usage → tokens/cost, tps.outputTokens/seconds), phases from run.json phases + currentPhase (done before, active = current, pending after) and events phase.start; nested sub-rows: agent records whose id contains "#" or events `subagent.*` with data.parent → depth 1 under the parent row; wd from events watchdog.finding {agentId}
export function latestRuns(store: RunStore, projectSlug: string, limit?: number): RunView[]
```

## frame.ts (renders text frames, width-aware, no pi)
```ts
export interface FrameOptions { width: number; height: number; tick: number; title?: string; showRail?: boolean; color?: (hex: string, text: string) => string /* default: identity, so snapshots are plain text; the overlay passes a truecolor painter */ }
export function renderFrame(view: RunView, opts: FrameOptions): string[]   // line 1: `◆ MONITOR ${workflow ?? command} · ${runId} · ${status}` + totals; line 2: phase rail `[✓ plan]─[● build]─[○ verify]`; then one row per agent: `${glyph} ${callsign}-${n} · ${role} · ${model} (${thinking}) · ${state} · ${fmtTokens} tok · $${cost} · ${tps} tps` (depth-1 rows indented two spaces with `└`), the header line notes "nested sub-rows: one level" when any depth-1 rows exist; last line: `verified k/n · ↑↓ scroll · q close` — never wider than width (truncate with …), never taller than height (scroll window with `offset`)
export function renderBarRow(view: RunView | undefined): string   // the always-on model-bar row "◫ MONITOR | <workflow> · <status> · <k>/<n> agents working · verified k/n" or "◫ MONITOR | no run" (the lead adds it to renderFooterWidget)
export function renderList(views: RunView[], width: number): string[]   // the runs table for `/workflow-monitor list`: name · phase · roster · progress · result (Grok CLI style)
```

## dw-adapter.ts
```ts
export function dwRunsDir(cwd: string): string | undefined   // ~/.pi/workflows/projects/<key>/runs — derive <key> the way pi-dynamic-workflows does (read its dist to find the project key rule; if it is a hash of the cwd, implement the same hash; say which)
export function readDwRuns(cwd: string): RunView[]   // each *.json → RunView {source: "pi-dynamic-workflows"}, agents from its per-agent fields (name/status/tokens where present), states mapped: running→dispatched-working, completed→done-unverified (pi-dw has no review frames), failed→failed, cancelled→cancelled
```

## cmd-monitor.ts
`registerMonitorCommand(pi, deps: { store(): RunStore; cwd(ctx): string; openOverlay(ctx, render: (tick: number, size: {width: number; height: number}) => string[], onClose: () => void): { close(): void; refresh(): void } | undefined; spawnSplit(ctx, argv: string[]): Promise<{ ok: boolean; how: "orca" | "tmux" | "none"; detail: string }>; notify(ctx, text, level?): void; panel(ctx, title, markdown): void })` registering `/workflow-monitor [runId|list|--split|close]`: default = overlay of the live run (the in-flight workflow run if any — read a `current` marker the lead exposes via deps.currentRunDir?(ctx) — else the latest run of this project) refreshed every 500 ms from the store (re-read files; cheap) with the spinner tick; `list` → panel with renderList over titan runs + pi-dynamic-workflows runs; `--split` → deps.spawnSplit(["node", "<pkg>/scripts/titan-monitor.mjs", "--run", runDir, "--follow"]) preferring Orca (`orca terminal split -- …`) and falling back to `tmux split-window -h …`, reporting "none" when neither is available (never a silent no-op); `close` → close the overlay.

## scripts/titan-monitor.mjs
Node ESM, no deps: `node scripts/titan-monitor.mjs --run <runDir> [--follow] [--interval 1000] [--width N]` prints renderFrame-equivalent text (re-implement the small renderer in plain JS or import the TS module through jiti? — plain JS re-implementation of frame.ts's format, kept in sync by a test that renders the fixture through both and compares) and with --follow redraws (clear screen) every interval until the run's status is terminal; `--list <root> --project <slug>` prints the runs table. Exit 0; exit 2 on a missing run.

## tests
tests/monitor.test.ts: fixture store (write a run with run.json, agents for every §5.4 state, events with phase.start rows and one watchdog.finding, a ledger) → buildRunView (rows, phases done/active/pending, wd counts, depth-1 sub-rows under their parent, totals string), renderFrame snapshot lines for every state (glyph + colour hex via a recording `color` fn) at width 100 and the truncation at width 40, height clipping with offset, renderBarRow with and without a run, renderList shape, dw-adapter mapping from the dw-run.json fixture (source label, state mapping), scripts/titan-monitor.mjs run against the fixture via child_process → its output equals renderFrame's plain text for the same width. Whole suite green; do not commit. Report: files, API deviations, the pi-dynamic-workflows key rule you found, suite summary.
