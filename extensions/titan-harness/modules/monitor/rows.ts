/**
 * monitor/rows.ts — store → view model (plan H4, §5.4, §6.3). Reads one run directory
 * (run.json, agents/*.json, events.jsonl, ledger.jsonl) and folds it into a RunView the
 * frame renderer, the bar row, the runs table and scripts/titan-monitor.mjs all share.
 *
 *   rows        one MonitorRow per agents/*.json record, in the store's first-seen order;
 *               re-ask records (`<node>#2`) nest as depth-1 sub-rows under their node, and
 *               `subagent.*` events with `data.parent` add depth-1 rows for pi-subagents
 *               children a titan child spawned (one level only, per §5.4)
 *   phases      run.json `phases` + `currentPhase`: done before, active = current, pending
 *               after; a completed run shows every phase done; no current phase → pending
 *   wd          watchdog.finding events counted per agent
 *   totals      formatTotals(totalsFor(ledger, agents)) — the same string as Σ TOTALS
 *   verified    done-verified / done-unverified / failed-like over the depth-0 rows;
 *               done-unverified is never counted as verified
 *
 * Everything here is pure file reading; no pi. scripts/titan-monitor.mjs mirrors these
 * rules in plain JS and tests/monitor.test.ts pins the two renderings to each other.
 */
import * as path from "node:path";
import { type ChainRow, readChain } from "../hash-chain.ts";
import { formatTotals, readLedger, totalsFor } from "../ledger.ts";
import { type AgentRecord, EVENTS_FILE, type RunMeta, type RunStore } from "../run-store.ts";
import { thinkingLabel } from "../thinking.ts";
import type { Thinking } from "../model-stack.ts";
import { type AgentState, isVerified, isWorking } from "./state.ts";

export interface MonitorRow {
	agentId: string;
	callsign: string;
	role: string;
	model: string;
	/** "xhigh↘high" when the provider capped the request, else the effective level. */
	thinking: string;
	state: AgentState | string;
	phase?: string;
	tokens: number;
	costUsd: number;
	tps?: number;
	nodeId?: string;
	depth: 0 | 1;
	parentId?: string;
	/** Watchdog findings ingested for this agent. */
	wd?: number;
	startedAt?: string;
	updatedAt?: string;
	note?: string;
}

export interface PhaseView {
	title: string;
	state: "done" | "active" | "pending";
}

export interface RunView {
	runId: string;
	workflow?: string;
	command?: string;
	status: string;
	level?: number;
	tier?: string;
	shape?: string;
	phases: PhaseView[];
	rows: MonitorRow[];
	/** formatTotals(...) or "no spend yet". */
	totals: string;
	verified: { verified: number; unverified: number; failed: number };
	startedAt: string;
	endedAt?: string;
	source: "titan" | "pi-dynamic-workflows";
	elapsedMs: number;
}

/** Terminal states that are neither done-verified nor done-unverified. */
export const FAILED_LIKE_STATES = new Set<string>(["failed", "cancelled", "stalemate", "failed-review", "watchdog-failed"]);

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Phase rail states from the run's declared phases and its current one. */
export function phaseViews(phases: string[] | undefined, currentPhase: string | undefined, status: string): PhaseView[] {
	if (!phases?.length) return [];
	if (status === "completed") return phases.map((title) => ({ title, state: "done" }));
	const index = currentPhase ? phases.indexOf(currentPhase) : -1;
	return phases.map((title, i) => ({ title, state: index < 0 ? "pending" : i < index ? "done" : i === index ? "active" : "pending" }));
}

/** The node a record belongs to: `implement#2` → `implement`. */
export const nodeIdOf = (agentId: string): string => agentId.split("#")[0];

/** Map a pi-subagents child status (from a `subagent.*` event) onto the monitor vocabulary. */
export function subagentState(status: unknown): AgentState {
	switch (String(status ?? "").toLowerCase()) {
		case "running":
		case "working":
		case "started":
			return "dispatched-working";
		case "done":
		case "completed":
		case "success":
			return "done-unverified";
		case "error":
		case "failed":
			return "failed";
		case "cancelled":
		case "aborted":
			return "cancelled";
		default:
			return "queued";
	}
}

function readEvents(runDir: string): ChainRow[] {
	try {
		return readChain(path.join(runDir, EVENTS_FILE));
	} catch {
		return []; // a torn events file never hides the run; the chain verifier reports it
	}
}

function rowFromRecord(record: AgentRecord, phaseByNode: Map<string, string>, wdByAgent: Map<string, number>, parentIds: Set<string>): MonitorRow {
	const nodeId = nodeIdOf(record.agentId);
	const nested = record.agentId.includes("#") && parentIds.has(nodeId);
	const requested = (record.thinking?.requested || record.thinking?.effective || "") as Thinking;
	const effective = (record.thinking?.effective || requested) as Thinking;
	const usage = record.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	const tps = record.tps && num(record.tps.seconds) > 0 ? num(record.tps.outputTokens) / record.tps.seconds : undefined;
	const history = record.stateHistory ?? [];
	const row: MonitorRow = {
		agentId: record.agentId,
		callsign: record.callsign || record.agentId,
		role: record.role || "agent",
		model: record.model || "?",
		thinking: requested || effective ? thinkingLabel({ requested, effective, reason: "identity" }) : "—",
		state: record.state,
		tokens: num(usage.input) + num(usage.output),
		costUsd: num(usage.cost),
		nodeId,
		depth: nested ? 1 : 0,
	};
	if (tps !== undefined) row.tps = tps;
	if (nested) row.parentId = nodeId;
	const phase = phaseByNode.get(nodeId);
	if (phase) row.phase = phase;
	const wd = wdByAgent.get(record.agentId);
	if (wd) row.wd = wd;
	if (history[0]?.ts) row.startedAt = history[0].ts;
	if (history.length) row.updatedAt = history[history.length - 1].ts;
	return row;
}

/** Fold a run directory into a RunView. */
export function buildRunView(store: RunStore, runDir: string, now: number = Date.now()): RunView {
	const run: RunMeta = store.readRun(runDir);
	const agents = store.listAgents(runDir);
	const events = readEvents(runDir);
	// Phase attribution: each node.start inherits the latest phase.start before it.
	const phaseByNode = new Map<string, string>();
	const wdByAgent = new Map<string, number>();
	const subRows = new Map<string, MonitorRow>();
	let currentPhase: string | undefined;
	for (const event of events) {
		const data = (event.data ?? {}) as Record<string, unknown>;
		const type = String(event.type ?? "");
		if (type === "phase.start" && typeof data.phase === "string") currentPhase = data.phase;
		if (type === "node.start" && typeof data.nodeId === "string") {
			const phase = typeof data.phase === "string" ? data.phase : currentPhase;
			if (phase && !phaseByNode.has(data.nodeId)) phaseByNode.set(data.nodeId, phase);
		}
		if (type === "watchdog.finding") {
			const id = typeof event.agentId === "string" ? event.agentId : typeof data.agentId === "string" ? data.agentId : undefined;
			if (id) wdByAgent.set(id, (wdByAgent.get(id) ?? 0) + 1);
		}
		if (type.startsWith("subagent.") && typeof data.parent === "string") {
			const id = typeof data.agentId === "string" ? data.agentId : typeof event.agentId === "string" ? event.agentId : `${data.parent}/${data.label ?? "subagent"}`;
			const previous = subRows.get(id);
			const row: MonitorRow = {
				agentId: id,
				callsign: typeof data.label === "string" ? data.label : (previous?.callsign ?? id),
				role: "subagent",
				model: typeof data.model === "string" ? data.model : (previous?.model ?? "?"),
				thinking: previous?.thinking ?? "—",
				state: data.status === undefined ? (previous?.state ?? "dispatched-working") : subagentState(data.status),
				tokens: num(data.tokens) || (previous?.tokens ?? 0),
				costUsd: num(data.costUsd) || (previous?.costUsd ?? 0),
				depth: 1,
				parentId: data.parent,
				startedAt: previous?.startedAt ?? (typeof event.ts === "string" ? event.ts : undefined),
				updatedAt: typeof event.ts === "string" ? event.ts : previous?.updatedAt,
			};
			subRows.set(id, row);
		}
	}
	const parentIds = new Set(agents.map((record) => record.agentId));
	const rows: MonitorRow[] = [];
	const nested = new Map<string, MonitorRow[]>();
	for (const record of agents) {
		const row = rowFromRecord(record, phaseByNode, wdByAgent, parentIds);
		if (row.depth === 1 && row.parentId) {
			const list = nested.get(row.parentId) ?? [];
			list.push(row);
			nested.set(row.parentId, list);
		} else rows.push(row);
	}
	for (const row of subRows.values()) {
		if (!row.parentId) continue;
		const wd = wdByAgent.get(row.agentId);
		if (wd) row.wd = wd;
		const list = nested.get(row.parentId) ?? [];
		list.push(row);
		nested.set(row.parentId, list);
	}
	const ordered: MonitorRow[] = [];
	for (const row of rows) {
		ordered.push(row);
		const children = nested.get(row.agentId);
		if (children) ordered.push(...children.sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0))); // code-unit order, locale-independent
	}
	// Sub-rows whose parent record is missing still show, at the end, so nothing the store holds is hidden.
	for (const [parentId, children] of nested) if (!rows.some((row) => row.agentId === parentId)) ordered.push(...children);
	const ledger = readLedger(runDir);
	const totals = ledger.length ? formatTotals(totalsFor(ledger, agents)) : "no spend yet";
	const verified = { verified: 0, unverified: 0, failed: 0 };
	for (const row of ordered) {
		if (row.depth !== 0) continue;
		if (isVerified(row.state)) verified.verified++;
		else if (row.state === "done-unverified") verified.unverified++;
		else if (FAILED_LIKE_STATES.has(String(row.state))) verified.failed++;
	}
	const started = Date.parse(run.startedAt);
	const ended = run.endedAt ? Date.parse(run.endedAt) : now;
	const view: RunView = {
		runId: run.runId,
		status: run.status,
		phases: phaseViews(run.phases, run.currentPhase, run.status),
		rows: ordered,
		totals,
		verified,
		startedAt: run.startedAt,
		source: "titan",
		elapsedMs: Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : 0,
	};
	if (run.workflow?.name) view.workflow = run.workflow.name;
	if (run.command) view.command = run.command;
	if (run.level !== undefined) view.level = run.level;
	if (run.tier) view.tier = run.tier;
	if (run.shape) view.shape = run.shape;
	if (run.endedAt) view.endedAt = run.endedAt;
	return view;
}

/** Working / total over the depth-0 rows. */
export function workingCount(view: RunView): { working: number; total: number } {
	const top = view.rows.filter((row) => row.depth === 0);
	return { working: top.filter((row) => isWorking(row.state)).length, total: top.length };
}

/** The newest runs of a project as views (runs whose files are unreadable are skipped). */
export function latestRuns(store: RunStore, projectSlug: string, limit = 20, now: number = Date.now()): RunView[] {
	const views: RunView[] = [];
	for (const run of store.listRuns(projectSlug, limit)) {
		try {
			views.push(buildRunView(store, store.dir(run.runId, run.projectSlug), now));
		} catch {
			/* a run directory mid-write or removed */
		}
	}
	return views;
}
