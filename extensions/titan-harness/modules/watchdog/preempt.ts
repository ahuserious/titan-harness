/**
 * watchdog/preempt.ts — child pre-emption and logical clearing (plan §5.5 row 3, D3).
 *
 * A titan child whose context reaches `preemptAtContextFraction` (75 %) of its model's
 * window — or whose JSON stream shows a `compaction_start` event — is halted by the host
 * at its next `tool_execution_end`. An inspector on the DISPATCHING ARCHITECT's model
 * (the compaction inspector runs on the cheap watchdog model; pre-emption is
 * asynchronous, so the stronger model is affordable) compares the transcript tail with
 * the state block:
 *
 *   clean         → LOGICAL CLEAR: a fresh checkpoint session id for the same agent; the
 *                   prior transcript is flagged `logicalCleared` on the agent record and in
 *                   a `watchdog.logical_clear` event; bytes are never deleted (the hash
 *                   chain must stay intact)
 *   loss |        → RESUME FRESH: a new session on the architect's model with
 *   hallucination   USER_PROMPT_RESUME.md (state block + diff + findings + carry); never a
 *                   transcript replay into another model
 *   failure       → "failed": the agent is marked watchdog-failed and stays halted
 *
 * Every inspection is ledgered under origin `watchdog`. Pure Node.
 */
import { randomUUID } from "node:crypto";
import type { AgentRecord, RunStore } from "../run-store.ts";
import type { WatchdogSettings } from "../stack-config.ts";
import { type InspectorDeps, type InspectorResult, InspectorTimeout, type LedgerNote, withInspectorBound } from "./compaction.ts";
import { inspectionPrompt, loadPrompt, resumePrompt, SYSTEM_PROMPT_WATCHDOG } from "./prompts.ts";
import type { StateBlock } from "./state-block.ts";
import { LIMITS, type WatchdogFinding } from "./state.ts";

export interface ChildUsage {
	agentId: string;
	ctxTokens: number;
	contextWindow: number;
	/** A `compaction_start` event was seen on the child's JSON stream. */
	compactionSeen?: boolean;
}

/** ctxTokens / contextWindow ≥ fraction, or a compaction event on the stream. A missing window never pre-empts. */
export function shouldPreempt(u: ChildUsage, fraction: number): boolean {
	if (u.compactionSeen) return true;
	if (!(u.contextWindow > 0) || !(u.ctxTokens > 0)) return false;
	const f = Number.isFinite(fraction) && fraction > 0 ? Math.min(fraction, 1) : 0.75;
	return u.ctxTokens / u.contextWindow >= f;
}

/** Pre-emption inspections run asynchronously on the architect's model: three compaction budgets. */
export const PREEMPT_TIMEOUT_MULTIPLIER = 3;

export interface PreemptDeps extends InspectorDeps {
	store: RunStore;
	runDir: string;
	settings: WatchdogSettings;
	ledger(row: LedgerNote): void;
	transcriptTail(agentId: string, maxChars: number): string;
	diff?(): string;
	architectModel: string;
	architectThinking: string;
	findings?: () => WatchdogFinding[];
	signal?: AbortSignal;
}

export type InspectionVerdict = "clean" | "loss" | "hallucination";

export interface ParsedInspection {
	verdict: InspectionVerdict;
	reasons: string[];
	carry: string;
	parsed: boolean;
}

export type PreemptDecision =
	| { action: "logical-clear"; checkpointSessionId: string; verdict: "clean"; reasons: string[]; carry: string; note: string }
	| { action: "resume-fresh"; model: string; thinking: string; resumePrompt: string; verdict: "loss" | "hallucination"; reasons: string[]; carry: string; note: string }
	| { action: "failed"; note: string };

/** Every balanced `{…}` span in `text` (string-aware), in order of appearance. */
export function extractJsonObjects(text: string): string[] {
	const spans: string[] = [];
	for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let i = start; i < text.length; i++) {
			const ch = text[i];
			if (inString) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') inString = true;
			else if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					spans.push(text.slice(start, i + 1));
					break;
				}
			}
		}
	}
	return spans;
}

/** The last JSON object in the inspector's answer that carries a verdict; anything unparseable is treated as `loss` (fail closed). */
export function parseInspection(text: string): ParsedInspection {
	for (const span of extractJsonObjects(text).reverse()) {
		try {
			const value = JSON.parse(span) as Record<string, unknown>;
			const verdict = String(value.verdict ?? "").toLowerCase();
			if (verdict === "clean" || verdict === "loss" || verdict === "hallucination") {
				const reasons = Array.isArray(value.reasons) ? value.reasons.map((r) => String(r)) : [];
				return { verdict, reasons, carry: typeof value.carry === "string" ? value.carry : "", parsed: true };
			}
		} catch {
			/* try the next candidate */
		}
	}
	return { verdict: "loss", reasons: ["inspector answer had no parseable verdict"], carry: "", parsed: false };
}

const usageOf = (r: InspectorResult | undefined) => r?.usage ?? { tokensIn: 0, tokensOut: 0, costUsd: 0, tpsSeconds: 0 };

const formatFindings = (findings: WatchdogFinding[] | undefined): string => (findings?.length ? findings.map((f) => `- [${f.severity}] ${f.category}: ${f.summary}${f.paths.length ? ` (${f.paths.join(", ")})` : ""}`).join("\n") : "- none");

/** Inspect a halted child and decide: logical clear, fresh resume on the architect's model, or failed. */
export async function inspectPreempted(agentId: string, block: StateBlock, deps: PreemptDeps): Promise<PreemptDecision> {
	const record = (type: string, data: Record<string, unknown>) => {
		try {
			deps.store.appendEvent(deps.runDir, type, data, agentId);
		} catch {
			/* observational */
		}
	};
	const setAgent = (patch: Record<string, unknown> & { state: string }) => {
		try {
			deps.store.upsertAgent(deps.runDir, { agentId, ...patch } as Partial<AgentRecord> & { agentId: string });
		} catch {
			/* observational */
		}
	};
	let priorSessionRef: string | undefined;
	try {
		const current = deps.store.listAgents(deps.runDir).find((a) => a.agentId === agentId) as (AgentRecord & { sessionRef?: string }) | undefined;
		priorSessionRef = current?.sessionRef;
	} catch {
		/* no record yet */
	}
	setAgent({ state: "inspecting-compaction" });
	const budget = Math.max(1, deps.settings.inspectorTimeoutMs || LIMITS.compactionInspectorTimeoutMs) * PREEMPT_TIMEOUT_MULTIPLIER;
	const prompt = inspectionPrompt({ STATE_BLOCK: block.text, TRANSCRIPT_TAIL: deps.transcriptTail(agentId, LIMITS.maxReviewInputChars) || "(empty transcript)", AGENT: agentId });
	let result: InspectorResult | undefined;
	let failure: string | undefined;
	try {
		result = await withInspectorBound(deps.inspect(prompt, { timeoutMs: budget, signal: deps.signal, model: deps.architectModel, thinking: deps.architectThinking, systemPrompt: loadPrompt(SYSTEM_PROMPT_WATCHDOG) }), budget, deps.signal);
		if (!result.ok) failure = result.error || "inspector failed";
	} catch (error) {
		failure = error instanceof InspectorTimeout ? error.message : error instanceof Error ? error.message : String(error);
	}
	const usage = usageOf(result);
	deps.ledger({ origin: "watchdog", model: deps.architectModel, costUsd: usage.costUsd, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, tpsSeconds: usage.tpsSeconds, ok: !failure, agentId, note: failure ? `pre-emption inspection failed: ${failure}` : "pre-emption inspection" });
	if (failure) {
		record("watchdog.failed", { reason: failure, phase: "preempt" });
		setAgent({ state: "watchdog-failed" });
		return { action: "failed", note: `inspector failed: ${failure}; agent stays halted (watchdog-failed)` };
	}
	const inspection = parseInspection(result!.text);
	if (inspection.verdict === "clean") {
		const checkpointSessionId = randomUUID();
		const at = new Date().toISOString();
		record("watchdog.logical_clear", { priorSessionRef: priorSessionRef ?? null, checkpointSessionId, reasons: inspection.reasons });
		setAgent({ state: "resuming", logicalCleared: { at, priorSessionRef: priorSessionRef ?? null, reason: "clean inspection after pre-emption", checkpointSessionId } });
		return { action: "logical-clear", checkpointSessionId, verdict: "clean", reasons: inspection.reasons, carry: inspection.carry, note: `clean: logical clear, checkpoint ${checkpointSessionId.slice(0, 8)}; prior transcript kept (${priorSessionRef ?? "no session ref"})` };
	}
	const prompt2 = resumePrompt({ STATE_BLOCK: block.text, DIFF: deps.diff?.() || "(no diff available)", FINDINGS: formatFindings(deps.findings?.()), CARRY: inspection.carry || "(the inspector left no notes)" });
	record("watchdog.resume_fresh", { verdict: inspection.verdict, reasons: inspection.reasons, model: deps.architectModel, parsed: inspection.parsed });
	setAgent({ state: "resuming" });
	return { action: "resume-fresh", model: deps.architectModel, thinking: deps.architectThinking, resumePrompt: prompt2, verdict: inspection.verdict, reasons: inspection.reasons, carry: inspection.carry, note: `${inspection.verdict}: fresh session on ${deps.architectModel} from the state block (no transcript replay)` };
}
