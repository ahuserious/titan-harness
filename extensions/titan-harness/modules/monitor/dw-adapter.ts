/**
 * monitor/dw-adapter.ts — read-only adapter for pi-dynamic-workflows 3.10.1 runs (plan
 * D1: pinned, polled, never extended). The package persists one JSON per run under
 *
 *   ~/.pi/workflows/projects/<key>/runs/<runId>.json
 *   key = `${sanitize(basename(resolve(cwd)))}-${sha256(resolve(cwd)).slice(0, 12)}`
 *   sanitize = lower-case, [^a-z0-9._-]+ → "-", trim "-", first 48 chars, "project" when empty
 *
 * (dist/workflow-paths.js `workflowProjectKey`; note it hashes `path.resolve(cwd)`, not the
 * realpath, so a symlinked checkout has a different key than its target). Legacy runs may
 * still sit in `<cwd>/.pi/workflows/runs/`; both directories are read. Sidecars
 * (`*.bak`, `*.tmp`, `*.lock`, `*.log`) are ignored.
 *
 * Persisted shape relied on (dist/run-persistence.d.ts PersistedRunState): runId,
 * workflowName, status pending|running|paused|completed|failed|aborted, phases[],
 * currentPhase, agents[] {id, label, phase?, status queued|running|done|error|skipped,
 * model?, tokens?, tokenUsage?{input, output, total, cost}, startedAt?, endedAt?},
 * startedAt, updatedAt, completedAt?, tokenUsage?{input, output, total, cost?}.
 * pi-dynamic-workflows has no review frames, so a finished agent is `done-unverified`.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fmtTokens, fmtUsd } from "../ledger.ts";
import type { MonitorRow, RunView } from "./rows.ts";
import { phaseViews } from "./rows.ts";
import type { AgentState } from "./state.ts";

export const DW_HOME = () => path.join(os.homedir(), ".pi", "workflows");

function sanitizePathSegment(value: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return sanitized || "project";
}

/** pi-dynamic-workflows' project key for a cwd (same rule as its dist/workflow-paths.js). */
export function dwProjectKey(cwd: string): string {
	const projectPath = path.resolve(cwd);
	const slug = sanitizePathSegment(path.basename(projectPath) || "project");
	const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
	return `${slug}-${hash}`;
}

/** `~/.pi/workflows/projects/<key>/runs` (returned even when it does not exist yet). */
export function dwRunsDir(cwd: string, home: string = DW_HOME()): string {
	return path.join(home, "projects", dwProjectKey(cwd), "runs");
}

/** The legacy per-project directory pi-dynamic-workflows still reads. */
export const dwLegacyRunsDir = (cwd: string): string => path.resolve(cwd, ".pi", "workflows", "runs");

export function dwAgentState(status: unknown): AgentState {
	switch (String(status ?? "")) {
		case "running":
			return "dispatched-working";
		case "done":
			return "done-unverified";
		case "error":
			return "failed";
		case "skipped":
			return "cancelled";
		default:
			return "queued";
	}
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** One persisted pi-dynamic-workflows run → RunView (undefined when the JSON is not a run). */
export function dwRunView(raw: unknown, now: number = Date.now()): RunView | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const run = raw as Record<string, any>;
	if (typeof run.runId !== "string" || typeof run.status !== "string") return undefined;
	const agents: any[] = Array.isArray(run.agents) ? run.agents : [];
	const rows: MonitorRow[] = agents.map((agent) => {
		const usage = agent?.tokenUsage && typeof agent.tokenUsage === "object" ? agent.tokenUsage : {};
		const tokens = num(agent?.tokens) || num(usage.total) || num(usage.input) + num(usage.output);
		const row: MonitorRow = {
			agentId: String(agent?.id ?? agent?.label ?? "?"),
			callsign: typeof agent?.label === "string" && agent.label ? agent.label : String(agent?.id ?? "?"),
			role: "agent",
			model: typeof agent?.model === "string" ? agent.model : "?",
			thinking: "—",
			state: dwAgentState(agent?.status),
			tokens,
			costUsd: num(usage.cost),
			depth: 0,
		};
		if (typeof agent?.phase === "string") row.phase = agent.phase;
		if (typeof agent?.startedAt === "string") row.startedAt = agent.startedAt;
		if (typeof agent?.endedAt === "string") row.updatedAt = agent.endedAt;
		if (typeof agent?.error === "string" && agent.error) row.note = agent.error;
		return row;
	});
	const verified = { verified: 0, unverified: rows.filter((row) => row.state === "done-unverified").length, failed: rows.filter((row) => row.state === "failed" || row.state === "cancelled").length };
	const usage = run.tokenUsage && typeof run.tokenUsage === "object" ? run.tokenUsage : undefined;
	const total = usage ? num(usage.total) || num(usage.input) + num(usage.output) : rows.reduce((sum, row) => sum + row.tokens, 0);
	const cost = usage ? num(usage.cost) : rows.reduce((sum, row) => sum + row.costUsd, 0);
	const totals = total || cost ? `Σ ${fmtTokens(total)} tok · ${fmtUsd(cost)}` : "no usage reported";
	const startedAt = typeof run.startedAt === "string" ? run.startedAt : new Date(0).toISOString();
	const endedAt = typeof run.completedAt === "string" ? run.completedAt : undefined;
	const started = Date.parse(startedAt);
	const ended = endedAt ? Date.parse(endedAt) : now;
	const view: RunView = {
		runId: run.runId,
		workflow: typeof run.workflowName === "string" ? run.workflowName : undefined,
		status: run.status,
		phases: phaseViews(Array.isArray(run.phases) ? run.phases.filter((p: unknown) => typeof p === "string") : undefined, typeof run.currentPhase === "string" ? run.currentPhase : undefined, run.status),
		rows,
		totals,
		verified,
		startedAt,
		source: "pi-dynamic-workflows",
		elapsedMs: Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : 0,
	};
	if (endedAt) view.endedAt = endedAt;
	if (typeof run.error === "string" && run.error) view.rows.push({ agentId: "run", callsign: "run", role: "error", model: "—", thinking: "—", state: "failed", tokens: 0, costUsd: 0, depth: 1, parentId: rows[0]?.agentId, note: run.error });
	return view;
}

/** Every pi-dynamic-workflows run visible from `cwd`, newest first. */
export function readDwRuns(cwd: string, opts: { home?: string; now?: number; dirs?: string[] } = {}): RunView[] {
	const dirs = opts.dirs ?? [dwRunsDir(cwd, opts.home), dwLegacyRunsDir(cwd)];
	const views: RunView[] = [];
	const seen = new Set<string>();
	for (const dir of dirs) {
		let names: string[];
		try {
			names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
		} catch {
			continue;
		}
		for (const name of names) {
			try {
				const view = dwRunView(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")), opts.now);
				if (view && !seen.has(view.runId)) {
					seen.add(view.runId);
					views.push(view);
				}
			} catch {
				/* a torn or foreign JSON file is not a run */
			}
		}
	}
	return views.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
