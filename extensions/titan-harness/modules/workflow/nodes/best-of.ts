/**
 * nodes/best-of.ts — `best_of: {n, judge, criteria, prompt}` nodes (plan A4, P4).
 *
 * n (2–8, default 4) candidates answer the same substituted prompt in fresh, mutually
 * anonymous sessions (callsigns `<node>-c1..cn`, concurrent up to the child cap), then a
 * judge turn (role "judge" by default; `judge:` may name a role or a provider/id model)
 * scores them against `criteria` with a structured verdict:
 *   { winner: 1..n, scores: [{candidate, score, reason}], summary }
 * The judge sees "Candidate k" bodies only — never a model id or callsign (the prompt is
 * asserted free of them). The winner's text is the node output; losers are archived under
 * artifacts/nodes/<id>/candidates/<k>.md. Fail closed: every candidate failed → failed
 * "all candidates failed" (nothing delivered); an invalid or out-of-range verdict after
 * the schema re-asks → failed. Identical candidate texts (collapse) are reported as a
 * warning and the judge still runs. Every call is ledgered by ctx.runAgent (candidates
 * origin "run", judge origin "judge"). Semantics transliterated from fusion-drive's
 * best-of-n; nothing is imported from it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { sha256 } from "../../hash-chain.ts";
import type { AgentRequest, AgentResult, NodeContext, NodeHandler, NodeOutcome } from "../executor.ts";
import { runLimited } from "../executor.ts";
import type { BestOfSpec, JsonSchema, SlotRole } from "../schema.ts";
import { MAX_SCHEMA_RETRIES, formatSchemaErrors, parseStructured, schemaPromptSuffix } from "../structured-output.ts";
import { buildAgentRequest } from "./ai.ts";

export const BEST_OF_MIN = 2;
export const BEST_OF_MAX = 8;
export const BEST_OF_DEFAULT_N = 4;

export const JUDGE_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		winner: { type: "integer", minimum: 1 },
		scores: { type: "array", items: { type: "object", properties: { candidate: { type: "integer" }, score: { type: "number" }, reason: { type: "string" } }, required: ["candidate", "score"] } },
		summary: { type: "string" },
	},
	required: ["winner", "summary"],
};

export interface Candidate {
	index: number;
	callsign: string;
	ok: boolean;
	text: string;
	error?: string;
	sessionRef?: string;
	sha256: string;
	usage?: AgentResult["usage"];
}

export interface JudgeVerdict {
	winner: number;
	scores?: Array<{ candidate: number; score: number; reason?: string }>;
	summary: string;
}

const emptyUsage = (): AgentResult["usage"] => ({ tokensIn: 0, tokensOut: 0, costUsd: 0, tpsSeconds: 0 });
const addUsage = (acc: AgentResult["usage"], usage?: AgentResult["usage"]): void => {
	if (!usage) return;
	acc.tokensIn += usage.tokensIn || 0;
	acc.tokensOut += usage.tokensOut || 0;
	acc.costUsd += usage.costUsd || 0;
	acc.tpsSeconds += usage.tpsSeconds || 0;
};

/** n clamped to 2–8 (default 4). */
export function candidateCount(spec: Pick<BestOfSpec, "n">): number {
	const raw = Number(spec.n);
	if (!Number.isFinite(raw)) return BEST_OF_DEFAULT_N;
	return Math.min(BEST_OF_MAX, Math.max(BEST_OF_MIN, Math.floor(raw)));
}

/** The judge's brief: criteria + numbered anonymous candidates. Contains no model id, callsign or session ref. */
export function judgePrompt(criteria: string | undefined, candidates: Array<{ index: number; text: string }>): string {
	const lines = [
		`You are the judge of ${candidates.length} anonymous candidate answers to the same task.`,
		criteria?.trim() ? `Criteria: ${criteria.trim()}` : "Criteria: correctness first, then completeness, then clarity.",
		"Score every candidate and pick exactly one winner by its number. Judge the bodies only.",
		"",
	];
	for (const candidate of candidates) {
		lines.push(`## Candidate ${candidate.index}`, "", candidate.text.trim(), "");
	}
	return lines.join("\n");
}

/** Judge model/role from `judge:`: a provider/id string is a model on role judge, anything else names the role (default judge). */
export function judgeSeat(judge: string | undefined): { role: SlotRole; model?: string } {
	if (!judge?.trim()) return { role: "judge" };
	if (judge.includes("/")) return { role: "judge", model: judge.trim() };
	return { role: judge.trim() as SlotRole };
}

async function runCandidate(ctx: NodeContext, prompt: string, index: number): Promise<Candidate> {
	const callsign = `${ctx.node.id}-c${index}`;
	const request: AgentRequest = { ...buildAgentRequest(ctx, prompt, { context: "fresh", label: `${ctx.deps.workflowId}/${ctx.node.id}/candidate-${index}` }), callsign };
	const result = await ctx.runAgent(request);
	const text = result.text ?? "";
	return { index, callsign, ok: result.ok && text.trim().length > 0, text, error: result.ok ? undefined : (result.error ?? "agent failed"), sessionRef: result.sessionRef, sha256: sha256(text), usage: result.usage };
}

/** The judge turn with the structured re-ask loop (same bounds as nodes/ai.ts callAgent). */
async function runJudge(ctx: NodeContext, spec: BestOfSpec, candidates: Candidate[], usage: AgentResult["usage"]): Promise<{ verdict?: JudgeVerdict; error?: string; calls: number; prompt: string }> {
	const seat = judgeSeat(spec.judge);
	const brief = judgePrompt(spec.criteria, candidates.map((c) => ({ index: c.index, text: c.text })));
	const base = (prompt: string, resume?: string): AgentRequest => ({
		...buildAgentRequest(ctx, prompt, { role: seat.role, context: "fresh", resume, outputSchema: JUDGE_SCHEMA, label: `${ctx.deps.workflowId}/${ctx.node.id}/judge` }),
		callsign: `${ctx.node.id}-judge`,
		...(seat.model ? { model: seat.model } : {}),
	});
	let request = base(brief);
	let calls = 0;
	for (;;) {
		const result = await ctx.runAgent(request);
		calls++;
		addUsage(usage, result.usage);
		if (!result.ok) return { error: `judge failed: ${result.error ?? "agent failed"}`, calls, prompt: brief };
		const parsed = parseStructured(result.text, JUDGE_SCHEMA);
		const inRange = parsed.ok && Number.isInteger((parsed.value as JudgeVerdict).winner) && candidates.some((c) => c.index === (parsed.value as JudgeVerdict).winner);
		if (parsed.ok && inRange) return { verdict: parsed.value as JudgeVerdict, calls, prompt: brief };
		const errors = parsed.ok ? `winner must be one of ${candidates.map((c) => c.index).join(", ")}` : formatSchemaErrors(parsed.errors);
		if (calls > MAX_SCHEMA_RETRIES) return { error: `judge verdict invalid after ${MAX_SCHEMA_RETRIES} re-asks: ${errors}`, calls, prompt: brief };
		ctx.notify(`${ctx.node.id}: judge verdict invalid (${errors}) — re-asking ${calls}/${MAX_SCHEMA_RETRIES}`, "warning");
		const lead = `Your previous verdict was not valid: ${errors}.`;
		request = result.sessionRef ? base(`${lead}${schemaPromptSuffix(JUDGE_SCHEMA)}`, result.sessionRef) : base(`${brief}\n\n${lead}`);
	}
}

function archive(ctx: NodeContext, candidates: Candidate[]): string {
	const dir = path.join(ctx.deps.artifactsDir, "nodes", ctx.node.id, "candidates");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	for (const candidate of candidates) {
		const body = candidate.ok ? candidate.text : `[failed] ${candidate.error ?? ""}\n`;
		fs.writeFileSync(path.join(dir, `${candidate.index}.md`), body.endsWith("\n") ? body : `${body}\n`, { mode: 0o600 });
	}
	return dir;
}

/** `best_of:` nodes. */
export const runBestOfNode: NodeHandler = async (ctx): Promise<NodeOutcome> => {
	const spec = (ctx.node as { best_of: BestOfSpec }).best_of;
	if (!spec || typeof spec.prompt !== "string" || !spec.prompt.trim()) {
		return { status: "failed", output: undefined, error: "best_of: prompt is required", retryable: false };
	}
	const n = candidateCount(spec);
	const prompt = ctx.subst(spec.prompt, "prompt");
	const usage = emptyUsage();
	const candidates: Candidate[] = [];
	const limit = ctx.deps.settings.maxConcurrentChildren ?? 8;
	let aborted: unknown;
	await runLimited(
		Array.from({ length: n }, (_, i) => async () => {
			try {
				const candidate = await runCandidate(ctx, prompt, i + 1);
				candidates.push(candidate);
				addUsage(usage, candidate.usage);
			} catch (error) {
				aborted ??= error;
				throw error;
			}
		}),
		limit,
	);
	if (aborted) throw aborted;
	candidates.sort((a, b) => a.index - b.index);
	const archiveDir = archive(ctx, candidates);
	const alive = candidates.filter((c) => c.ok);
	ctx.log("best_of.candidates", { n, ok: alive.length, failed: candidates.length - alive.length, archive: archiveDir });
	if (!alive.length) {
		return { status: "failed", output: undefined, error: `best_of: all ${n} candidates failed (${candidates.map((c) => c.error ?? "?").join("; ")})`, usage, meta: { n, candidates: 0, archive: archiveDir } };
	}
	const distinct = new Set(alive.map((c) => c.sha256)).size;
	if (distinct < alive.length) ctx.notify(`${ctx.node.id}: ${alive.length - distinct} candidate(s) collapsed to identical text — judging anyway`, "warning");
	const judged = await runJudge(ctx, spec, alive, usage);
	if (!judged.verdict) {
		return { status: "failed", output: undefined, error: `best_of: ${judged.error}`, usage, meta: { n, candidates: alive.length, judgeCalls: judged.calls, archive: archiveDir } };
	}
	const winner = alive.find((c) => c.index === judged.verdict!.winner)!;
	ctx.log("best_of.verdict", { winner: winner.index, summary: judged.verdict.summary, scores: judged.verdict.scores ?? [], collapsed: alive.length - distinct });
	return {
		status: "success",
		output: winner.text,
		text: winner.text,
		usage,
		sessionRef: winner.sessionRef,
		meta: { n, candidates: alive.length, winner: winner.index, winnerCallsign: winner.callsign, scores: judged.verdict.scores ?? [], summary: judged.verdict.summary, judgeCalls: judged.calls, collapsed: alive.length - distinct, archive: archiveDir },
	};
};
