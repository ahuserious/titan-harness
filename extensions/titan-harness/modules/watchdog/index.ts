/**
 * watchdog/index.ts — the object the host holds: `createWatchdog(deps)`.
 *
 * Wires the state machine (state.ts), the compaction handlers (compaction.ts), child
 * pre-emption (preempt.ts) and the trigger table (triggers.ts) behind one interface the
 * extension calls from Pi's hooks:
 *
 *   arm(runDir) / disarm()                  a run or plan mode starts / ends
 *   beforeCompact(event)                    session_before_compact → CompactionOutcome
 *   afterCompact(event) / compactFailed()   session_compact / session_compact_failed
 *   childUsage(u)                           every child usage update → "continue" | "halt"
 *   preempted(agentId, extra?)              after the host halted a child → PreemptDecision
 *   finding(f) / childCard(card) / userInput() / spend(spent, budget)
 *   status()                                for /titan-watchdog status and the model bar
 *
 * `settings.enabled: false` keeps the machine idle: compaction falls through to Pi,
 * children are never halted, findings are still counted (they cost nothing) but no
 * inspector ever runs. Watchdog children are read-only and spawned on triggers only —
 * capacity (`per_fanout`) is a ceiling, never a resident pool. Pure Node.
 */
import type { RunStore } from "../run-store.ts";
import type { WatchdogSettings } from "../stack-config.ts";
import {
	type AfterCompactEvent,
	type AfterCompactOutcome,
	type CompactFailedEvent,
	type CompactionEvent,
	type CompactionOutcome,
	handleAfterCompact,
	handleBeforeCompact,
	handleCompactFailed,
	type InspectorDeps,
	type LedgerNote,
} from "./compaction.ts";
import { type ChildUsage, inspectPreempted, type PreemptDecision, shouldPreempt } from "./preempt.ts";
import { buildStateBlock, type StateBlock } from "./state-block.ts";
import { createMachine, EDGES, transition, type WatchdogFinding, type WatchdogMachine, type WatchdogState } from "./state.ts";
import { onChildCard, onFinding, onSpend, onUserInput, type TriggerAction } from "./triggers.ts";

export * from "./compaction.ts";
export * from "./preempt.ts";
export * from "./state-block.ts";
export * from "./state.ts";
export * from "./triggers.ts";
export { boundText, PROMPT_DIR, SYSTEM_PROMPT_WATCHDOG, USER_PROMPT_RESUME, USER_PROMPT_WATCHDOG_COMPACTION } from "./prompts.ts";

export interface WatchdogDeps extends InspectorDeps {
	settings: WatchdogSettings;
	store: RunStore;
	runDir?: string;
	ledger(row: LedgerNote): void;
	entriesText(entries: unknown[] | undefined): string;
	transcriptTail?(agentId: string, maxChars: number): string;
	diff?(): string;
	architectModel: string;
	architectThinking: string;
	planDigest?(): string | undefined;
	now?(): number;
}

export interface WatchdogStatus {
	enabled: boolean;
	state: WatchdogState;
	armedRun?: string;
	inspections: number;
	spendUsd: number;
	findings: number;
	stalemateRepeats: number;
	lastIdentityRun: number;
	lastTransition: string;
	model: string;
	thinking: string;
	onCompaction: WatchdogSettings["onCompaction"];
	preemptAt: number;
}

export interface Watchdog {
	machine(): WatchdogMachine;
	arm(runDir: string): void;
	disarm(): void;
	beforeCompact(event: CompactionEvent): Promise<CompactionOutcome>;
	afterCompact(event: AfterCompactEvent): AfterCompactOutcome;
	compactFailed(event: CompactFailedEvent): { note: string };
	childUsage(u: ChildUsage): "continue" | "halt";
	preempted(agentId: string, extra?: { transcriptTail?: string; signal?: AbortSignal }): Promise<PreemptDecision>;
	finding(f: Omit<WatchdogFinding, "id" | "ts"> & { id?: string; ts?: string }): TriggerAction;
	childCard(card: unknown, agentId?: string): TriggerAction;
	userInput(): TriggerAction;
	spend(spentUsd: number, budgetUsd: number | null | undefined): TriggerAction;
	/** A human re-arms a stalemated watchdog (the `ctx.ui.confirm` gate of §5.5). */
	resumeAfterStalemate(): void;
	stateBlock(): StateBlock | undefined;
	status(): WatchdogStatus;
}

export function createWatchdog(deps: WatchdogDeps): Watchdog {
	let m = createMachine({ stalemateRepeats: deps.settings.stalemateRepeats });
	let runDir: string | undefined = deps.runDir;
	const enabled = deps.settings.enabled;
	const ledger = (row: LedgerNote) => {
		m = { ...m, inspections: m.inspections + 1, spendUsd: m.spendUsd + (row.costUsd || 0) };
		try {
			deps.ledger(row);
		} catch {
			/* the ledger is observational */
		}
	};
	const safe = (to: WatchdogState, note?: string) => {
		try {
			m = transition(m, to, note);
		} catch {
			/* an unexpected edge (e.g. finding during idle) never breaks the host */
		}
	};
	const rearm = () => {
		if (m.state !== "halted-stalemate" && m.state !== "idle") safe("armed", "re-armed");
	};
	// Inspections carry a token: only the inspection that moved the machine to `inspecting`
	// may settle it, so a compaction and a pre-emption in flight together, or an inspection
	// the user cancelled, never overwrite each other's state.
	let inspectionSeq = 0;
	let currentInspection: number | undefined;
	const beginInspection = (note: string): number | undefined => {
		if (!EDGES[m.state].includes("inspecting")) return undefined; // inspecting → inspecting is not an edge: a second in-flight inspection gets no token
		safe("inspecting", note);
		if ((m.state as WatchdogState) !== "inspecting") return undefined;
		currentInspection = ++inspectionSeq;
		return currentInspection;
	};
	const endInspection = (token: number | undefined, to: WatchdogState, note: string, rearmAfter: boolean): void => {
		if (token === undefined || currentInspection !== token || m.state !== "inspecting") return;
		currentInspection = undefined;
		safe(to, note);
		if (rearmAfter) rearm();
	};
	const findingsNow = () => m.findings.filter((f) => f.severity !== "info");
	return {
		machine: () => m,
		arm(dir) {
			runDir = dir;
			if (!enabled) return;
			if (m.state === "idle") safe("armed", `run ${dir.split("/").pop()}`);
		},
		disarm() {
			runDir = undefined;
			safe("idle", "disarmed");
		},
		async beforeCompact(event) {
			if (!enabled || !runDir) return handleBeforeCompact(event, { ...deps, runDir: undefined, ledger, findings: findingsNow, settings: enabled ? deps.settings : { ...deps.settings, onCompaction: "off" } });
			const token = beginInspection(`compaction ${event.reason}`);
			const outcome = await handleBeforeCompact(event, { ...deps, runDir, ledger, findings: findingsNow });
			endInspection(token, outcome.badge ? "failed" : "cleared", outcome.note, true);
			return outcome;
		},
		afterCompact: (event) => handleAfterCompact(event, { store: deps.store, runDir }),
		compactFailed: (event) => handleCompactFailed(event, { store: deps.store, runDir }),
		childUsage(u) {
			if (!enabled || !runDir) return "continue";
			if (m.state === "halted-stalemate" || m.state === "idle") return "continue";
			return shouldPreempt(u, deps.settings.preemptAtContextFraction) ? "halt" : "continue";
		},
		async preempted(agentId, extra = {}) {
			if (!runDir) return { action: "failed", note: "no active run" };
			let block: StateBlock;
			try {
				block = buildStateBlock(deps.store, runDir, { findings: findingsNow(), planDigest: deps.planDigest?.() });
			} catch (error) {
				return { action: "failed", note: `state block unavailable: ${error instanceof Error ? error.message : String(error)}` };
			}
			const token = beginInspection(`pre-empt ${agentId}`);
			const decision = await inspectPreempted(agentId, block, {
				inspect: deps.inspect,
				store: deps.store,
				runDir,
				settings: deps.settings,
				ledger,
				transcriptTail: (id, max) => extra.transcriptTail ?? deps.transcriptTail?.(id, max) ?? "",
				diff: deps.diff,
				architectModel: deps.architectModel,
				architectThinking: deps.architectThinking,
				findings: findingsNow,
				signal: extra.signal,
			});
			endInspection(token, decision.action === "logical-clear" ? "cleared" : decision.action === "resume-fresh" ? "resuming" : "failed", decision.note, decision.action !== "resume-fresh");
			return decision;
		},
		finding(f) {
			const result = onFinding(m, f);
			m = result.machine;
			return result.action;
		},
		childCard(card, agentId) {
			const result = onChildCard(m, card, agentId);
			m = result.machine;
			return result.action;
		},
		userInput() {
			const result = onUserInput(m);
			m = result.machine;
			if (result.action.kind === "cancel-inspection") currentInspection = undefined;
			return result.action;
		},
		spend: (spentUsd, budgetUsd) => onSpend(spentUsd, budgetUsd),
		resumeAfterStalemate() {
			if (m.state === "halted-stalemate") {
				m = { ...transition(m, "armed", "human gate"), lastIdentity: undefined, lastIdentityRun: 0, stalemateId: undefined };
			}
		},
		stateBlock() {
			if (!runDir) return undefined;
			try {
				return buildStateBlock(deps.store, runDir, { findings: findingsNow(), planDigest: deps.planDigest?.() });
			} catch {
				return undefined;
			}
		},
		status: () => ({
			enabled,
			state: m.state,
			armedRun: runDir?.split("/").pop(),
			inspections: m.inspections,
			spendUsd: m.spendUsd,
			findings: m.findings.length,
			stalemateRepeats: m.stalemateRepeats,
			lastIdentityRun: m.lastIdentityRun,
			lastTransition: m.lastTransition,
			model: deps.settings.model,
			thinking: deps.settings.thinking,
			onCompaction: deps.settings.onCompaction,
			preemptAt: deps.settings.preemptAtContextFraction,
		}),
	};
}
