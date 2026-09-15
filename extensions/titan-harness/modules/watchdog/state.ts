/**
 * watchdog/state.ts — the titan-native watchdog's state machine (plan §5.4, §5.5, §5.9, D3).
 *
 * Watchdog states: idle → armed → inspecting → {cleared | steering | resuming |
 * halted-stalemate | failed}; every non-idle state re-arms; anything → idle on disarm.
 * Agent states are the monitor vocabulary of §5.4 (plus `failed-review` from P4).
 * Findings carry the stalemate identity of §5.5 — sha256(category + summary + paths),
 * the same function elevation.ts uses — and `stalemateRepeats` (3) consecutive identical
 * identities halt the run in `halted-stalemate` until a human gate re-arms it.
 *
 * LIMITS mirrors pi-subagents 0.67.0's proven bounds (§5.9 item 3); tests/watchdog-
 * limits.test.ts checks them against the pinned package so a future bump is noticed.
 * Pure: no pi, no filesystem.
 */
import { findingIdentity } from "../workflow/elevation.ts";

export type WatchdogState = "idle" | "armed" | "inspecting" | "cleared" | "steering" | "resuming" | "halted-stalemate" | "failed";
export const WATCHDOG_STATES: WatchdogState[] = ["idle", "armed", "inspecting", "cleared", "steering", "resuming", "halted-stalemate", "failed"];

export type AgentState =
	| "queued"
	| "dispatched-working"
	| "waiting-architect"
	| "in-review"
	| `edit-round-${number}`
	| "stalemate"
	| "harvesting"
	| "done-verified"
	| "done-unverified"
	| "authoring-workflow"
	| "repairing-workflow"
	| "compacting"
	| "inspecting-compaction"
	| "resuming"
	| "held-spend"
	| "blocked-guard"
	| "system-run"
	| "watchdog-failed"
	| "uncertain-launch"
	| "failed"
	| "cancelled"
	| "failed-review";

/** Every named agent state (the `edit-round-n` family is represented by `edit-round-1`). */
export const AGENT_STATES: AgentState[] = [
	"queued",
	"dispatched-working",
	"waiting-architect",
	"in-review",
	"edit-round-1",
	"stalemate",
	"harvesting",
	"done-verified",
	"done-unverified",
	"authoring-workflow",
	"repairing-workflow",
	"compacting",
	"inspecting-compaction",
	"resuming",
	"held-spend",
	"blocked-guard",
	"system-run",
	"watchdog-failed",
	"uncertain-launch",
	"failed",
	"cancelled",
	"failed-review",
];

/** pi-subagents 0.67.0 bounds titan mirrors (§5.9): stalemate identity ≥ 3, reviewer input ≤ 24,000 chars, cadence ≥ 5 tools, 30 s cadence reviews, 20 s compaction inspection, WATCHDOG.md ≤ 8 KB. */
export const LIMITS = {
	stalemateRepeats: 3,
	maxReviewInputChars: 24_000,
	cadenceMinTools: 5,
	reviewTimeoutMs: 30_000,
	compactionInspectorTimeoutMs: 20_000,
	watchdogMdMaxChars: 8_000,
} as const;

export type FindingSeverity = "blocker" | "major" | "minor" | "info";
export type FindingSource = "inspector" | "child-card" | "rule";

export interface WatchdogFinding {
	id: string;
	category: string;
	summary: string;
	paths: string[];
	severity: FindingSeverity;
	source: FindingSource;
	agentId?: string;
	ts: string;
}

export interface WatchdogMachine {
	state: WatchdogState;
	findings: WatchdogFinding[];
	/** Total occurrences per identity (for reports). */
	identityRuns: Record<string, number>;
	/** The identity of the most recent finding and how many times in a row it has appeared. */
	lastIdentity?: string;
	lastIdentityRun: number;
	/** The identity that halted the run (set while halted-stalemate). */
	stalemateId?: string;
	inspections: number;
	spendUsd: number;
	lastTransition: string;
	lastTransitionAt: string;
	stalemateRepeats: number;
}

/** The legal edges of §5.5 (`idle` is reachable from anywhere through disarm). */
export const EDGES: Record<WatchdogState, WatchdogState[]> = {
	idle: ["armed"],
	armed: ["inspecting", "halted-stalemate", "failed", "idle"],
	inspecting: ["cleared", "steering", "resuming", "halted-stalemate", "failed", "armed", "idle"],
	cleared: ["armed", "inspecting", "halted-stalemate", "idle"],
	steering: ["armed", "inspecting", "halted-stalemate", "idle"],
	resuming: ["armed", "inspecting", "halted-stalemate", "idle"],
	"halted-stalemate": ["armed", "idle"],
	failed: ["armed", "inspecting", "idle"],
};

export function createMachine(settings: { stalemateRepeats?: number } = {}): WatchdogMachine {
	const repeats = Math.max(1, Math.round(settings.stalemateRepeats ?? LIMITS.stalemateRepeats));
	return {
		state: "idle",
		findings: [],
		identityRuns: {},
		lastIdentityRun: 0,
		inspections: 0,
		spendUsd: 0,
		lastTransition: "created",
		lastTransitionAt: new Date().toISOString(),
		stalemateRepeats: repeats,
	};
}

/** Move to `to` along a legal edge (a same-state move is a no-op); an illegal edge throws. Returns a new machine. */
export function transition(m: WatchdogMachine, to: WatchdogState, note?: string): WatchdogMachine {
	if (!WATCHDOG_STATES.includes(to)) throw new Error(`watchdog: unknown state ${JSON.stringify(to)}`);
	if (m.state === to) return m;
	if (!EDGES[m.state].includes(to)) throw new Error(`watchdog: illegal transition ${m.state} → ${to}${note ? ` (${note})` : ""}`);
	return {
		...m,
		state: to,
		stalemateId: to === "halted-stalemate" ? m.stalemateId : to === "armed" || to === "idle" ? undefined : m.stalemateId,
		lastTransition: `${m.state} → ${to}${note ? ` · ${note}` : ""}`,
		lastTransitionAt: new Date().toISOString(),
	};
}

/**
 * Record a finding. Identity = sha256(category + summary + paths); the same identity
 * `stalemateRepeats` times in a row halts the run (`halted-stalemate`). A finding never
 * throws: from `idle` the machine arms itself first.
 */
export function noteFinding(m: WatchdogMachine, f: Omit<WatchdogFinding, "id" | "ts"> & { id?: string; ts?: string }): { machine: WatchdogMachine; finding: WatchdogFinding; stalemate: boolean } {
	const id = f.id ?? findingIdentity({ category: f.category, summary: f.summary, paths: f.paths });
	const finding: WatchdogFinding = { ...f, id, ts: f.ts ?? new Date().toISOString() };
	const run = m.lastIdentity === id ? m.lastIdentityRun + 1 : 1;
	let next: WatchdogMachine = {
		...m,
		findings: [...m.findings, finding],
		identityRuns: { ...m.identityRuns, [id]: (m.identityRuns[id] ?? 0) + 1 },
		lastIdentity: id,
		lastIdentityRun: run,
	};
	const stalemate = run >= m.stalemateRepeats;
	if (stalemate && next.state !== "halted-stalemate") {
		if (next.state === "idle") next = transition(next, "armed", "finding while idle");
		next = transition(next, "halted-stalemate", `identity ${id.slice(0, 12)} ×${run}`);
		next = { ...next, stalemateId: id };
	}
	return { machine: next, finding, stalemate };
}

const SEVERITY_MAP: Record<string, FindingSeverity> = { blocker: "blocker", critical: "blocker", concern: "major", major: "major", warning: "minor", note: "minor", minor: "minor", info: "info" };

const looksLikePath = (value: unknown): value is string => typeof value === "string" && /^[\w@./~-]+(?:\/[\w@.~-]+)+|\.\w{1,6}(?::\d+)?$/.test(value.trim()) && !/\s/.test(value.trim());

/**
 * A pi-subagents `subagent_watchdog_warning` card (the custom message, its `details`, or
 * the bare details object) → a finding. Severity blocker→blocker, concern→major,
 * note→minor; evidence entries that look like paths become `paths`. Undefined when the
 * card carries no summary.
 */
export function mapChildCard(card: unknown, agentId?: string): WatchdogFinding | undefined {
	if (!card || typeof card !== "object") return undefined;
	const raw = card as Record<string, unknown>;
	const details = (raw.details && typeof raw.details === "object" ? (raw.details as Record<string, unknown>) : raw) as Record<string, unknown>;
	const summary = typeof details.summary === "string" ? details.summary.trim() : typeof details.message === "string" ? details.message.trim() : "";
	if (!summary) return undefined;
	const category = typeof details.category === "string" && details.category.trim() ? details.category.trim() : "child-watchdog";
	const evidence = Array.isArray(details.evidence) ? details.evidence : typeof details.evidence === "string" ? [details.evidence] : [];
	const paths = evidence.filter(looksLikePath).map((p) => p.trim());
	const severity = SEVERITY_MAP[String(details.severity ?? "").toLowerCase()] ?? "info";
	const identity = typeof details.identity === "string" && /^[0-9a-f]{64}$/.test(details.identity) ? details.identity : undefined;
	return {
		id: identity ?? findingIdentity({ category, summary, paths }),
		category,
		summary,
		paths,
		severity,
		source: "child-card",
		agentId: agentId ?? (typeof details.agentId === "string" ? details.agentId : undefined),
		ts: new Date().toISOString(),
	};
}
