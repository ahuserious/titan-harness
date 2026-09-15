/**
 * ledger.ts — the per-run cost ledger (§6.5 of the v0.3 plan): one hash-chained row per
 * metered turn or child in <run>/ledger.jsonl, tagged with where the spend came from
 * (`origin`) and how it was measured (`source`), plus the totals math behind the model
 * bar's totals row: `Σ 1.24M tok · $3.87 · 41 tps/agent · verified 86 % (12/14)`.
 *
 * Pure Node, no pi imports; the store directory is the only filesystem touch point.
 */
import * as path from "node:path";
import { appendChained, type ChainRow, readChain } from "./hash-chain.ts";

export const LEDGER_FILE = "ledger.jsonl";

export type LedgerSource = "observed" | "estimated" | "unmetered" | "external";
export type LedgerOrigin = "run" | "auditor" | "watchdog" | "compaction-inspector" | "verifier" | "host" | "cursor" | "fusion" | "judge" | "fuser";

/** One ledger row (before the chain adds seq/prev/hash). */
export interface LedgerRow {
	ts: string;
	runId: string;
	agentId: string;
	callsign?: string;
	role: string;
	model: string;
	provider: string;
	thinking?: { requested: string; effective: string };
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
	costUsd: number;
	source: LedgerSource;
	origin: LedgerOrigin;
	tpsSeconds?: number;
	note?: string;
}

/** The totals row's numbers. `failed` counts every terminal non-done state (failed ∪ cancelled ∪ stalemate). */
export interface Totals {
	tokens: number;
	input: number;
	output: number;
	costUsd: number;
	unmetered: number;
	agents: number;
	avgTpsPerAgent?: number;
	completionRate?: number;
	verified: number;
	unverified: number;
	failed: number;
}

/** Agent states that end a node's life, exactly as the monitor names them (§5.4). */
export const VERIFIED_STATE = "done-verified";
export const UNVERIFIED_STATE = "done-unverified";
export const FAILED_STATES = new Set(["failed", "cancelled", "stalemate"]);

/** Append one row to <dir>/ledger.jsonl (ts defaults to now). */
export function appendLedger(dir: string, row: Omit<LedgerRow, "ts"> & { ts?: string }): ChainRow {
	return appendChained(path.join(dir, LEDGER_FILE), row as Record<string, unknown>);
}

/** Every ledger row in order ([] when the run has no ledger yet). */
export function readLedger(dir: string): LedgerRow[] {
	return readChain(path.join(dir, LEDGER_FILE)) as unknown as LedgerRow[];
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * Fold ledger rows (and, when given, the run's agent records) into totals:
 * tokens = Σ input + output; costUsd = Σ costUsd; unmetered = rows with source
 * "unmetered"; agents = the given agents' count, else distinct agentIds in the rows;
 * avgTpsPerAgent = mean over agents with seconds > 0 of outputTokens / seconds;
 * completionRate = done-verified / (done-verified + done-unverified + failed + cancelled
 * + stalemate). Rate and tps are undefined when there is nothing to measure.
 */
export function totalsFor(rows: LedgerRow[], agents?: Array<{ state: string; tps?: { outputTokens: number; seconds: number } }>): Totals {
	let input = 0;
	let output = 0;
	let costUsd = 0;
	let unmetered = 0;
	const ids = new Set<string>();
	for (const row of rows) {
		input += num(row.tokens?.input);
		output += num(row.tokens?.output);
		costUsd += num(row.costUsd);
		if (row.source === "unmetered") unmetered++;
		if (row.agentId) ids.add(row.agentId);
	}
	const totals: Totals = { tokens: input + output, input, output, costUsd, unmetered, agents: agents ? agents.length : ids.size, verified: 0, unverified: 0, failed: 0 };
	if (!agents) return totals;
	let tpsSum = 0;
	let tpsCount = 0;
	for (const agent of agents) {
		if (agent.tps && num(agent.tps.seconds) > 0) {
			tpsSum += num(agent.tps.outputTokens) / agent.tps.seconds;
			tpsCount++;
		}
		if (agent.state === VERIFIED_STATE) totals.verified++;
		else if (agent.state === UNVERIFIED_STATE) totals.unverified++;
		else if (FAILED_STATES.has(agent.state)) totals.failed++;
	}
	if (tpsCount > 0) totals.avgTpsPerAgent = tpsSum / tpsCount;
	const settled = totals.verified + totals.unverified + totals.failed;
	if (settled > 0) totals.completionRate = totals.verified / settled;
	return totals;
}

/** 950 → "950", 12_300 → "12.3k", 1_240_000 → "1.24M" (trailing zeros trimmed: 1_000_000 → "1M"). */
export function fmtTokens(n: number): string {
	const trim = (s: string): string => s.replace(/\.?0+$/, "");
	if (n >= 1_000_000) return `${trim((n / 1_000_000).toFixed(2))}M`;
	if (n >= 1000) return `${trim((n / 1000).toFixed(1))}k`;
	return `${Math.round(n)}`;
}

/** "$3.87"; sub-cent spend keeps four decimals so a cheap run never reads as free. */
export function fmtUsd(cost: number): string {
	return cost > 0 && cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

/** The totals row: `Σ 1.24M tok · $3.87 · 41 tps/agent · verified 86 % (12/14)`; tps, verified and the unmetered badge appear only when there is data. */
export function formatTotals(t: Totals): string {
	const parts = [`Σ ${fmtTokens(t.tokens)} tok`, fmtUsd(t.costUsd)];
	if (t.avgTpsPerAgent !== undefined) parts.push(`${Math.round(t.avgTpsPerAgent)} tps/agent`);
	if (t.completionRate !== undefined) parts.push(`verified ${Math.round(t.completionRate * 100)} % (${t.verified}/${t.verified + t.unverified + t.failed})`);
	if (t.unmetered > 0) parts.push(`unmetered ×${t.unmetered}`);
	return parts.join(" · ");
}

/** `provider/model` → "provider"; a bare model id has no provider. */
export function providerOf(model: string): string {
	const slash = model.indexOf("/");
	return slash > 0 ? model.slice(0, slash) : "unknown";
}

/**
 * Fold a finished AgentRun into a ledger row. The AgentRun's tokensIn already sums
 * input + cacheRead + cacheWrite, so it lands in tokens.input with the cache fields at
 * 0; source is "observed" (the child's own usage events). The agent id defaults to the
 * slot id, then the lower-cased role.
 */
export function rowFromAgentRun(
	run: { role: string; model: string; slot?: { id: string; name: string; thinking?: string }; thinking?: string; tokensIn: number; tokensOut: number; costUsd: number; tpsSeconds: number },
	runId: string,
	origin: LedgerOrigin,
	effectiveThinking?: string,
	agentId?: string,
): Omit<LedgerRow, "ts"> {
	const requested = run.thinking ?? run.slot?.thinking;
	const effective = effectiveThinking ?? requested;
	const row: Omit<LedgerRow, "ts"> = {
		runId,
		agentId: agentId ?? run.slot?.id ?? run.role.toLowerCase(),
		callsign: run.slot?.name,
		role: run.role,
		model: run.model,
		provider: providerOf(run.model),
		tokens: { input: num(run.tokensIn), output: num(run.tokensOut), cacheRead: 0, cacheWrite: 0 },
		costUsd: num(run.costUsd),
		source: "observed",
		origin,
	};
	if (requested !== undefined && effective !== undefined) row.thinking = { requested, effective };
	if (num(run.tpsSeconds) > 0) row.tpsSeconds = run.tpsSeconds;
	return row;
}
