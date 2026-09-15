/**
 * watchdog/triggers.ts — the §5.5 trigger table as pure decisions.
 *
 * Each function maps an observation to the action the host must execute; nothing here
 * spawns, kills or writes. Compaction and pre-emption (rows 1–3) live in compaction.ts
 * and preempt.ts; the rows below are the rest of the table:
 *
 *   terminal without a review frame  → mark done-unverified, dispatch an auditor
 *   ping with an unreviewed write     → queue the ping with a missing-review flag
 *   stopped without review            → done-unverified (optional last-diff review)
 *   review PASS, nothing harvested    → force the harvest, re-prompt the architect
 *   identical finding × 3             → stalemate: end turn, human gate, run paused
 *   reviewer model/auth error         → watchdog-failed, never a silent pass
 *   ledger over budget.usd            → held-spend: no new children
 *   child watchdog card               → ingest as a finding, counts toward stalemate
 *   user input                        → cancel an in-flight inspection
 */
import { mapChildCard, noteFinding, transition, type WatchdogFinding, type WatchdogMachine } from "./state.ts";

export type TriggerAction =
	| { kind: "mark-unverified"; agentId: string; dispatchAuditor: true; reason: string }
	| { kind: "queue-ping"; agentId: string; missingReview: true }
	| { kind: "force-harvest"; agentId: string; rePromptArchitect: true }
	| { kind: "stalemate"; findingId: string; humanGate: true; pauseRun: true }
	| { kind: "watchdog-failed"; reason: string; refuseVerified: true }
	| { kind: "held-spend"; spentUsd: number; budgetUsd: number }
	| { kind: "ingest-card"; finding: WatchdogFinding; stalemate: boolean }
	| { kind: "cancel-inspection" }
	| { kind: "none"; note: string };

/** Row 4: a workflow reached a terminal state; without a review frame the agent is done-unverified and an auditor is dispatched. */
export function onWorkflowTerminal(agentId: string, hasReviewFrame: boolean): TriggerAction {
	return hasReviewFrame ? { kind: "none", note: `${agentId}: terminal with a review frame` } : { kind: "mark-unverified", agentId, dispatchAuditor: true, reason: "terminal state without a review frame" };
}

/** Row 5: a builder/worker pings the architect; an unreviewed last write travels with a missing-review flag. */
export function onArchitectPing(agentId: string, lastWriteReviewed: boolean): TriggerAction {
	return lastWriteReviewed ? { kind: "none", note: `${agentId}: ping with a reviewed last write` } : { kind: "queue-ping", agentId, missingReview: true };
}

/** Row 6: abort, crash or timeout without a review frame → done-unverified (optional last-diff review). */
export function onAgentStopped(agentId: string, reason: "abort" | "crash" | "timeout", hasReviewFrame: boolean): TriggerAction {
	return hasReviewFrame ? { kind: "none", note: `${agentId}: stopped (${reason}) after review` } : { kind: "mark-unverified", agentId, dispatchAuditor: true, reason: `stopped (${reason}) without review` };
}

/** Row 7: review PASS but no report/harvest reached the architect → force the harvest into the store, re-prompt. */
export function onReviewPass(agentId: string, harvested: boolean): TriggerAction {
	return harvested ? { kind: "none", note: `${agentId}: review PASS harvested` } : { kind: "force-harvest", agentId, rePromptArchitect: true };
}

/** Row 8: a finding; the same identity `stalemateRepeats` times in a row → stalemate (human gate, run paused). */
export function onFinding(m: WatchdogMachine, f: Omit<WatchdogFinding, "id" | "ts"> & { id?: string; ts?: string }): { machine: WatchdogMachine; finding: WatchdogFinding; action: TriggerAction } {
	const noted = noteFinding(m, f);
	return { machine: noted.machine, finding: noted.finding, action: noted.stalemate ? { kind: "stalemate", findingId: noted.finding.id, humanGate: true, pauseRun: true } : { kind: "none", note: `finding ${noted.finding.id.slice(0, 12)} ×${noted.machine.lastIdentityRun}` } };
}

/** Row 9: a reviewer model or auth error → watchdog-failed; done-verified is refused; never a silent pass. */
export function onReviewerError(error: string): TriggerAction {
	return { kind: "watchdog-failed", reason: error, refuseVerified: true };
}

/** Row 10: the ledger crossed budget.usd → held-spend, no new children until the budget is raised. */
export function onSpend(spentUsd: number, budgetUsd: number | null | undefined): TriggerAction {
	if (budgetUsd === null || budgetUsd === undefined || !(budgetUsd >= 0)) return { kind: "none", note: "no budget set" };
	return spentUsd > budgetUsd ? { kind: "held-spend", spentUsd, budgetUsd } : { kind: "none", note: `spend ${spentUsd.toFixed(4)} within budget ${budgetUsd.toFixed(2)}` };
}

/** Row 11: a `subagent_watchdog_warning` card from a child stream → finding (severity mapped), counts toward stalemate. */
export function onChildCard(m: WatchdogMachine, card: unknown, agentId?: string): { machine: WatchdogMachine; action: TriggerAction } {
	const finding = mapChildCard(card, agentId);
	if (!finding) return { machine: m, action: { kind: "none", note: "card without a summary ignored" } };
	const noted = noteFinding(m, finding);
	return { machine: noted.machine, action: { kind: "ingest-card", finding: noted.finding, stalemate: noted.stalemate } };
}

/** Row 12: user input cancels an in-flight inspection (matches pi-subagents); otherwise nothing. */
export function onUserInput(m: WatchdogMachine): { machine: WatchdogMachine; action: TriggerAction } {
	if (m.state !== "inspecting") return { machine: m, action: { kind: "none", note: `input while ${m.state}` } };
	return { machine: transition(m, "armed", "inspection cancelled by user input"), action: { kind: "cancel-inspection" } };
}
