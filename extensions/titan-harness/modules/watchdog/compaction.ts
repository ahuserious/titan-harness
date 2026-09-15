/**
 * watchdog/compaction.ts — host compaction handling (plan §5.5 rows 1–2, D3, §7.1).
 *
 * Pi fires `session_before_compact` {preparation, branchEntries, customInstructions,
 * reason: manual|threshold|overflow, willRetry, signal} and accepts either {cancel:true}
 * or {compaction:{summary, firstKeptEntryId, tokensBefore}}. The watchdog never cancels:
 *
 *   onCompaction off, or no active run     → mode "default"    (host returns undefined; Pi summarizes)
 *   reason overflow, or willRetry          → mode "state-only" (state block only, no inspector)
 *   onCompaction summary-only              → mode "state-only"
 *   onCompaction halt-inspect              → state block synchronously, then an inspector on
 *                                            the watchdog model bounded by inspectorTimeoutMs
 *                                            (20 s; `titan:inspector=<ms>` in customInstructions
 *                                            raises it for a manual /compact), honouring the
 *                                            hook's signal → mode "custom" (block + narrative);
 *                                            timeout or failure → "state-only" + badge
 *                                            "watchdog-failed" — never a cancelled compaction
 *
 * A custom summary cannot contain Pi's own narrative, so a "state-only" outcome carries
 * the block plus the badge line; the host may instead return undefined (Pi default) and
 * post `stateBlockMessage()` after `session_compact` so the block still reaches the
 * context — both are documented in the skill. Every inspector call, successful or not,
 * is ledgered under origin `compaction-inspector`. Pure Node.
 */
import { sha256 } from "../hash-chain.ts";
import type { RunStore } from "../run-store.ts";
import type { WatchdogSettings } from "../stack-config.ts";
import { compactionPrompt, loadPrompt, SYSTEM_PROMPT_WATCHDOG } from "./prompts.ts";
import { buildStateBlock, type StateBlock, stateBlockMessage } from "./state-block.ts";
import { LIMITS, type WatchdogFinding } from "./state.ts";

export type CompactionReason = "manual" | "threshold" | "overflow";

export interface CompactionEvent {
	reason: CompactionReason;
	willRetry?: boolean;
	signal?: AbortSignal;
	preparation?: { firstKeptEntryId?: string; tokensBefore?: number };
	branchEntries?: unknown[];
	customInstructions?: string;
}

export interface InspectorUsage {
	tokensIn: number;
	tokensOut: number;
	costUsd: number;
	tpsSeconds: number;
}

export interface InspectorResult {
	ok: boolean;
	text: string;
	usage?: InspectorUsage;
	error?: string;
}

export interface InspectorDeps {
	/** Run a read-only inspector (the host spawns it through the audit path); must honour opts.signal. */
	inspect(prompt: string, opts: { timeoutMs: number; signal?: AbortSignal; model: string; thinking: string; systemPrompt: string }): Promise<InspectorResult>;
}

export interface LedgerNote {
	origin: "compaction-inspector" | "watchdog";
	model: string;
	costUsd: number;
	tokensIn: number;
	tokensOut: number;
	tpsSeconds?: number;
	ok: boolean;
	agentId?: string;
	note?: string;
}

export interface CompactionDeps extends InspectorDeps {
	store: RunStore;
	/** The active run (undefined → nothing to protect → default compaction). */
	runDir?: string;
	settings: WatchdogSettings;
	ledger(row: LedgerNote): void;
	/** The host renders the entries about to be summarized as text; bounded here to 24,000 chars. */
	entriesText(entries: unknown[] | undefined): string;
	findings?: () => WatchdogFinding[];
	planDigest?: () => string | undefined;
	now?(): number;
}

export type CompactionMode = "custom" | "default" | "state-only";

export interface CompactionOutcome {
	mode: CompactionMode;
	summary?: string;
	stateBlock?: StateBlock;
	badge?: "watchdog-failed";
	inspectorMs?: number;
	firstKeptEntryId?: string;
	tokensBefore?: number;
	note: string;
}

export const INSPECTOR_OVERRIDE_RE = /titan:inspector=(\d{3,7})/;

/** The inspector bound for this event: settings.inspectorTimeoutMs, raised by `titan:inspector=<ms>` on manual compactions only. */
export function inspectorBudgetMs(event: Pick<CompactionEvent, "reason" | "customInstructions">, settings: Pick<WatchdogSettings, "inspectorTimeoutMs">): number {
	const base = Math.max(1, settings.inspectorTimeoutMs || LIMITS.compactionInspectorTimeoutMs);
	if (event.reason !== "manual") return base;
	const match = INSPECTOR_OVERRIDE_RE.exec(event.customInstructions ?? "");
	return match ? Math.max(base, Number.parseInt(match[1], 10)) : base;
}

export class InspectorTimeout extends Error {
	constructor(readonly kind: "timeout" | "aborted", ms: number) {
		super(kind === "timeout" ? `inspector timed out after ${ms} ms` : "inspector aborted by the host");
		this.name = "InspectorTimeout";
	}
}

/** Resolve with `work`, or reject with InspectorTimeout when `ms` elapses or `signal` fires; a late settle is ignored. */
export function withInspectorBound<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			fn();
		};
		const onAbort = () => finish(() => reject(new InspectorTimeout("aborted", ms)));
		const timer = setTimeout(() => finish(() => reject(new InspectorTimeout("timeout", ms))), ms);
		if (signal?.aborted) return onAbort();
		signal?.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error)),
		);
	});
}

const usageOf = (r: InspectorResult | undefined): InspectorUsage => r?.usage ?? { tokensIn: 0, tokensOut: 0, costUsd: 0, tpsSeconds: 0 };

/** The watchdog's answer to `session_before_compact` (see the header for the mode rules). */
export async function handleBeforeCompact(event: CompactionEvent, deps: CompactionDeps): Promise<CompactionOutcome> {
	const base = { firstKeptEntryId: event.preparation?.firstKeptEntryId, tokensBefore: event.preparation?.tokensBefore };
	if (deps.settings.onCompaction === "off") return { ...base, mode: "default", note: "watchdog onCompaction is off" };
	if (!deps.runDir) return { ...base, mode: "default", note: "no active run or plan; Pi summarizes" };
	let block: StateBlock;
	try {
		block = buildStateBlock(deps.store, deps.runDir, { findings: deps.findings?.(), planDigest: deps.planDigest?.() });
	} catch (error) {
		return { ...base, mode: "default", note: `state block unavailable (${error instanceof Error ? error.message : String(error)}); Pi summarizes` };
	}
	const record = (type: string, data: Record<string, unknown>) => {
		try {
			deps.store.appendEvent(deps.runDir!, type, data);
		} catch {
			/* observational */
		}
	};
	if (event.reason === "overflow" || event.willRetry) {
		record("compaction.before", { reason: event.reason, willRetry: !!event.willRetry, mode: "state-only", stateSha256: block.sha256 });
		return { ...base, mode: "state-only", summary: stateBlockMessage(block), stateBlock: block, note: `${event.reason === "overflow" ? "overflow" : "retry"} compaction: state block only, no inspector` };
	}
	if (deps.settings.onCompaction === "summary-only") {
		record("compaction.before", { reason: event.reason, mode: "state-only", stateSha256: block.sha256 });
		return { ...base, mode: "state-only", summary: stateBlockMessage(block), stateBlock: block, note: "summary-only: state block, no inspector" };
	}
	// halt-inspect: a bounded inspector on the watchdog model writes the narrative.
	const budget = inspectorBudgetMs(event, deps.settings);
	const prompt = compactionPrompt({ STATE_BLOCK: block.text, ENTRIES: deps.entriesText(event.branchEntries) || "(no entries provided)", REASON: event.reason });
	const started = deps.now?.() ?? Date.now();
	let result: InspectorResult | undefined;
	let failure: string | undefined;
	try {
		result = await withInspectorBound(deps.inspect(prompt, { timeoutMs: budget, signal: event.signal, model: deps.settings.model, thinking: deps.settings.thinking, systemPrompt: loadPrompt(SYSTEM_PROMPT_WATCHDOG) }), budget, event.signal);
		if (!result.ok || !result.text.trim()) failure = result.error || "inspector returned no narrative";
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	const inspectorMs = (deps.now?.() ?? Date.now()) - started;
	const usage = usageOf(result);
	deps.ledger({ origin: "compaction-inspector", model: deps.settings.model, costUsd: usage.costUsd, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, tpsSeconds: usage.tpsSeconds, ok: !failure, note: failure ? `failed: ${failure}` : `compaction ${event.reason}` });
	if (failure) {
		record("compaction.before", { reason: event.reason, mode: "state-only", badge: "watchdog-failed", inspectorMs, error: failure, stateSha256: block.sha256 });
		return { ...base, mode: "state-only", badge: "watchdog-failed", summary: stateBlockMessage(block, `watchdog-failed (${failure})`), stateBlock: block, inspectorMs, note: `inspector failed: ${failure}; state block kept, compaction not cancelled` };
	}
	const summary = `${block.text}\n\n## narrative\n${result!.text.trim()}`;
	record("compaction.before", { reason: event.reason, mode: "custom", inspectorMs, stateSha256: block.sha256, summarySha256: sha256(summary) });
	return { ...base, mode: "custom", summary, stateBlock: block, inspectorMs, note: `custom summary: state block + inspector narrative (${inspectorMs} ms)` };
}

export interface AfterCompactEvent {
	reason: CompactionReason;
	fromExtension?: boolean;
	willRetry?: boolean;
	summary?: string;
	compactionEntry?: { summary?: string; tokensBefore?: number };
}

export interface AfterCompactOutcome {
	summaryHash?: string;
	/** Agent states the host applies: every `compacting` agent goes back to work. */
	agentStatePatch: { from: "compacting"; to: "dispatched-working" };
	note: string;
}

/** `session_compact`: record compaction.done with the summary hash; compacting → dispatched-working. */
export function handleAfterCompact(event: AfterCompactEvent, deps: Pick<CompactionDeps, "store" | "runDir">): AfterCompactOutcome {
	const summary = event.summary ?? event.compactionEntry?.summary;
	const summaryHash = typeof summary === "string" ? sha256(summary) : undefined;
	if (deps.runDir) {
		try {
			deps.store.appendEvent(deps.runDir, "compaction.done", { reason: event.reason, fromExtension: !!event.fromExtension, willRetry: !!event.willRetry, summaryHash: summaryHash ?? null });
		} catch {
			/* observational */
		}
	}
	return { summaryHash, agentStatePatch: { from: "compacting", to: "dispatched-working" }, note: `compaction ${event.reason} done${event.fromExtension ? " (titan summary)" : " (Pi summary)"}` };
}

export interface CompactFailedEvent {
	reason: CompactionReason;
	errorMessage?: string;
	aborted?: boolean;
	willRetry?: boolean;
	fromExtension?: boolean;
}

/** `session_compact_failed`: record compaction.failed; the agents keep working on the uncompacted context. */
export function handleCompactFailed(event: CompactFailedEvent, deps: Pick<CompactionDeps, "store" | "runDir">): { note: string } {
	if (deps.runDir) {
		try {
			deps.store.appendEvent(deps.runDir, "compaction.failed", { reason: event.reason, aborted: !!event.aborted, errorMessage: event.errorMessage ?? null, fromExtension: !!event.fromExtension });
		} catch {
			/* observational */
		}
	}
	return { note: event.aborted ? `compaction ${event.reason} aborted` : `compaction ${event.reason} failed: ${event.errorMessage ?? "unknown error"}` };
}
