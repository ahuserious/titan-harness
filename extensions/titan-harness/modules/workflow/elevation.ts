/**
 * elevation.ts — review-before-report and the control flow of plan §5.3 / D11 (P4).
 *
 * One model for every tier:
 *   (a) audit loop — an auditor's verdict (output_format audit-verdict; `status` accepted
 *       as an alias of `verdict`) becomes a ReviewFrame on the node it reviews. A failed
 *       verdict (FAIL | SAFETY | SCOPE_VIOLATION) fails the auditor node itself, so its
 *       `on_fail: {action: reauthor}` fires: the findings are harvested into
 *       artifacts/escalation-report.md, the run freezes (`status: reauthored`,
 *       `elevation.freeze` event), the reviewed node is `failed-review` and the architect
 *       pseudo-agent enters `repairing-workflow`. The builder never resumes on auditor
 *       prose; the repair workflow is authored by `/create-workflow --from-findings` (P7 —
 *       until then the hand-off is the report path in the run error and a `cancel` node).
 *   (b) mechanical loop — CI/test red inside a `loop:` node with the ladder (ladderFor):
 *       iteration 1 base, iteration 2 thinking +1 step (ceiling-aware, same session
 *       resumed with the failing log), iteration 3 max reasoning on the family's max
 *       model in a fresh session. `loop.max_iterations` is THE budget; exhaustion with
 *       `on_fail: elevate` freezes the run with an escalation report of kind "mechanical".
 *   (c) elevation — the third failed audit for the same reviewed node (in this run) or the
 *       exhausted mechanical budget freezes the run for `/create-workflow --elevate` at
 *       min(level+1, 3) (P7); this module writes the report and the freeze, nothing more.
 *
 * Review-before-report: `done-verified` needs a PASS frame ∧ the required evidence kinds
 * matched ∧ a ledger row for the reviewer; anything else is `done-unverified`, a failed
 * verdict is `failed-review`. Pure: files under the run directory and the store only.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { sha256 } from "../hash-chain.ts";
import type { Thinking } from "../model-stack.ts";
import type { RunStore } from "../run-store.ts";
import { THINKING_ORDER, normalizeThinking } from "../thinking.ts";
import { AUDIT_VERDICTS, type AuditVerdict } from "./json-schema.ts";
import type { NodeDoc, SlotRole, WorkflowDoc } from "./schema.ts";

import type { EvidenceKind, EvidenceStatus } from "./evidence.ts";

export type { EvidenceKind, EvidenceStatus };

export type Verdict = AuditVerdict;
export const VERDICTS: readonly Verdict[] = AUDIT_VERDICTS;
export const FAILED_VERDICTS: readonly Verdict[] = ["FAIL", "SAFETY", "SCOPE_VIOLATION"];
export const REVIEWED_ROLES: readonly SlotRole[] = ["builder", "worker"];
export const REVIEWER_ROLES: readonly SlotRole[] = ["auditor", "verifier", "judge"];
/** Failed audits for one reviewed node before the run elevates (plan §5.3 c). */
export const AUDIT_FAILURES_BEFORE_ELEVATION = 3;
export const ESCALATION_REPORT_FILE = "escalation-report.md";
export const REVIEWS_DIR = "reviews";
/** The agent record that carries `repairing-workflow` / `authoring-workflow` on the monitor. */
export const ARCHITECT_AGENT_ID = "architect";

export type FindingSeverity = "blocker" | "major" | "minor" | "info";

export interface Finding {
	/** sha256(category + summary + paths) — the stalemate identity of plan §5.5. */
	id: string;
	category: string;
	summary: string;
	paths: string[];
	severity: FindingSeverity;
}

export interface ReviewFrame {
	reviewerNodeId: string;
	reviewedNodeId: string;
	reviewerCallsign?: string;
	verdict: Verdict;
	/** sha256 of the canonical verdict object. */
	verdictHash: string;
	evidencePath?: string;
	evidenceStatus?: EvidenceStatus;
	/** A ledger row exists for the reviewer's call (the executor knows). */
	reviewerLedgerRow: boolean;
	ts: string;
	summary?: string;
	findings: Finding[];
}

export type VerificationState = "done-verified" | "done-unverified" | "failed-review";

export interface NormalizedVerdict {
	verdict: Verdict;
	summary: string;
	blocking: string[];
	warnings: string[];
	findings: Finding[];
	round?: number;
	evidenceState?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value));

/** sha256 over category, the trimmed lower-cased summary and the sorted paths. */
export function findingIdentity(f: { category: string; summary: string; paths: string[] }): string {
	return sha256(`${f.category.trim().toLowerCase()}\n${f.summary.trim().toLowerCase()}\n${[...f.paths].map((p) => p.trim()).sort().join(",")}`);
}

const pathsOf = (value: Record<string, unknown>): string[] => {
	const raw = value.paths ?? value.files ?? (value.path !== undefined ? [value.path] : value.file !== undefined ? [value.file] : []);
	return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string" && p.trim().length > 0) : [];
};

/** One finding from a verdict's blocking/warnings entry (a string or an object). */
export function findingFrom(entry: unknown, severity: FindingSeverity): Finding {
	if (isRecord(entry)) {
		const category = text(entry.category ?? entry.kind ?? entry.type ?? "audit") || "audit";
		const summary = text(entry.summary ?? entry.message ?? entry.title ?? entry.finding ?? entry.text) || JSON.stringify(entry);
		const paths = pathsOf(entry);
		const sev = typeof entry.severity === "string" && ["blocker", "major", "minor", "info"].includes(entry.severity) ? (entry.severity as FindingSeverity) : severity;
		return { id: findingIdentity({ category, summary, paths }), category, summary, paths, severity: sev };
	}
	const summary = text(entry);
	return { id: findingIdentity({ category: "audit", summary, paths: [] }), category: "audit", summary, paths: [], severity };
}

/** The verdict block an auditor emitted, or undefined when `output` is not one. `status` is accepted as an alias of `verdict`. */
export function normalizeVerdict(output: unknown): NormalizedVerdict | undefined {
	if (!isRecord(output)) return undefined;
	const raw = output.verdict ?? output.status;
	if (typeof raw !== "string") return undefined;
	const upper = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
	if (!VERDICTS.includes(upper as Verdict)) return undefined;
	const verdict = upper as Verdict;
	const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
	const blockingEntries = list(output.blocking);
	const warningEntries = list(output.warnings);
	const findings = [...blockingEntries.map((e) => findingFrom(e, "blocker")), ...warningEntries.map((e) => findingFrom(e, "minor"))];
	const round = typeof output.round === "number" && Number.isFinite(output.round) ? output.round : undefined;
	return {
		verdict,
		summary: text(output.summary),
		blocking: blockingEntries.map((e) => findingFrom(e, "blocker").summary),
		warnings: warningEntries.map((e) => findingFrom(e, "minor").summary),
		findings,
		round,
		evidenceState: typeof output.evidence_state === "string" ? output.evidence_state : undefined,
	};
}

/** FAIL | SAFETY | SCOPE_VIOLATION. INCONCLUSIVE blocks `done-verified` but does not count as a failed audit. */
export function isFailedVerdict(verdict: Verdict): boolean {
	return FAILED_VERDICTS.includes(verdict);
}

/**
 * done-verified ⇔ a frame with a passing verdict ∧ the reviewer's ledger row ∧ (no required
 * kinds, or evidence matched). A failed verdict → failed-review. Everything else → done-unverified.
 */
export function verificationOf(frame: ReviewFrame | undefined, required: EvidenceKind[] = []): VerificationState {
	if (!frame) return "done-unverified";
	if (isFailedVerdict(frame.verdict)) return "failed-review";
	if (frame.verdict === "INCONCLUSIVE") return "done-unverified";
	if (!frame.reviewerLedgerRow) return "done-unverified";
	if (required.length > 0) return frame.evidenceStatus === "matched" ? "done-verified" : "done-unverified";
	if (frame.evidenceStatus === "unavailable" || frame.evidenceStatus === "current-unverified") return "done-unverified";
	return "done-verified";
}

/** The node a reviewer reviews: `reviews:` when declared, else the nearest builder/worker ancestor (depends_on, breadth-first, later deps first). */
export function reviewedNodeFor(doc: WorkflowDoc, reviewerNode: NodeDoc): string | undefined {
	const byId = new Map(doc.nodes.map((n) => [n.id, n]));
	const declared = (reviewerNode as { reviews?: string }).reviews;
	if (typeof declared === "string" && declared.trim()) return byId.has(declared) ? declared : undefined;
	const seen = new Set<string>([reviewerNode.id]);
	let frontier = [...(reviewerNode.depends_on ?? [])].reverse();
	while (frontier.length) {
		const next: string[] = [];
		for (const id of frontier) {
			if (seen.has(id)) continue;
			seen.add(id);
			const node = byId.get(id);
			if (!node) continue;
			if (node.role && REVIEWED_ROLES.includes(node.role)) return id;
			next.push(...[...(node.depends_on ?? [])].reverse());
		}
		frontier = next;
	}
	return undefined;
}

/** Whether a node's success output is subject to review (builder/worker role, `review` not "none"). */
export function isReviewedNode(node: NodeDoc): boolean {
	return !!node.role && REVIEWED_ROLES.includes(node.role) && node.review !== "none";
}

/** Evidence kinds a reviewed node must show before `done-verified`: the node's own `evidence.require`, then the document's `titan.evidence.require`. */
export function requiredKindsFor(doc: WorkflowDoc, node: NodeDoc): EvidenceKind[] {
	const own = node.evidence?.require ?? [];
	const tier = doc.titan?.evidence?.require ?? [];
	return [...new Set([...own, ...tier])] as EvidenceKind[];
}

/** Persist a frame: `review.verdict` event, the reviewed agent's state, artifacts/reviews/<reviewedNodeId>.json. Returns the state written. */
export function recordReviewFrame(store: RunStore, runDir: string, frame: ReviewFrame, state: VerificationState = verificationOf(frame, []), artifactsDir: string = path.join(runDir, "artifacts")): VerificationState {
	store.appendEvent(runDir, "review.verdict", { ...frame, state }, frame.reviewerNodeId);
	if (frame.reviewedNodeId) {
		try {
			store.upsertAgent(runDir, { agentId: frame.reviewedNodeId, state });
		} catch {
			/* a reviewed node that never spawned an agent (bash/script) has no record; the frame file still lands */
		}
		const dir = path.join(artifactsDir, REVIEWS_DIR);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const file = path.join(dir, `${frame.reviewedNodeId.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`);
		let history: unknown[] = [];
		try {
			const existing = JSON.parse(fs.readFileSync(file, "utf8"));
			history = Array.isArray(existing?.history) ? existing.history : [];
		} catch {
			history = [];
		}
		history.push({ ...frame, state });
		fs.writeFileSync(file, `${JSON.stringify({ reviewedNodeId: frame.reviewedNodeId, state, latest: { ...frame, state }, history }, null, 2)}\n`, { mode: 0o600 });
	}
	return state;
}

export type EscalationKind = "audit" | "mechanical" | "elevate";

export interface EscalationInput {
	runId: string;
	workflowId: string;
	nodeId: string;
	nodeType?: string;
	kind: EscalationKind;
	/** The on_fail action (or "freeze") — printed as the report's verdict line. */
	action: string;
	attempts: number;
	verdict?: Verdict;
	findings: Finding[];
	evidenceIds: string[];
	diffHash?: string;
	error?: string;
	outputExcerpt?: string;
	artifactPath?: string;
	level?: number;
	tier?: string;
	reviewedNodeId?: string;
	iterations?: number;
	ladder?: string[];
}

/** min(level + 1, 3): the level a repair workflow is authored at (plan §5.3 c). */
export function elevationTarget(level: number | undefined): number {
	return Math.min((Number.isFinite(level) ? (level as number) : 0) + 1, 3);
}

const mdCell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** artifacts/escalation-report.md — the findings package the architect authors the repair workflow from. */
export function writeEscalationReport(artifactsDir: string, input: EscalationInput): { path: string; sha256: string } {
	const lines = [
		"# Escalation report",
		"",
		`- workflow: ${input.workflowId}`,
		`- run: ${input.runId}`,
		`- node: ${input.nodeId}${input.nodeType ? ` (${input.nodeType})` : ""}`,
		`- kind: ${input.kind}`,
		`- verdict: ${input.action}`,
		...(input.verdict ? [`- audit verdict: ${input.verdict}`] : []),
		...(input.reviewedNodeId ? [`- reviewed node: ${input.reviewedNodeId}`] : []),
		`- attempts: ${input.attempts}`,
		...(input.iterations !== undefined ? [`- iterations: ${input.iterations}`] : []),
		...(input.ladder?.length ? [`- ladder: ${input.ladder.join(" → ")}`] : []),
		`- error: ${input.error ?? "—"}`,
		`- artifact: ${input.artifactPath ?? "—"}`,
		`- evidence ids: ${input.evidenceIds.length ? input.evidenceIds.join(", ") : "—"}`,
		`- diff hash: ${input.diffHash ?? "—"}`,
		...(input.level !== undefined ? [`- level: ${input.level} → elevate to ${elevationTarget(input.level)}`] : []),
		...(input.tier ? [`- tier: ${input.tier}`] : []),
		`- generated: ${new Date().toISOString()}`,
		"",
		"## Findings",
		"",
	];
	if (input.findings.length) {
		lines.push("| id | severity | category | summary | paths |", "|---|---|---|---|---|");
		for (const f of input.findings) lines.push(`| ${f.id.slice(0, 12)} | ${f.severity} | ${mdCell(f.category)} | ${mdCell(f.summary)} | ${mdCell(f.paths.join(", ") || "—")} |`);
	} else {
		lines.push("_no structured findings — see the output below_");
	}
	lines.push("", "## Output", "", "```", (input.outputExcerpt ?? "").trimEnd(), "```", "", "## Next", "", `- /create-workflow --elevate --from ${path.join(artifactsDir, ESCALATION_REPORT_FILE)} (0.7.0)`, "- until then the re-author hand-off is a `cancel` node carrying this report path; the builder never resumes on reviewer prose", "");
	const body = lines.join("\n");
	fs.mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
	const file = path.join(artifactsDir, ESCALATION_REPORT_FILE);
	fs.writeFileSync(file, body, { mode: 0o600 });
	return { path: file, sha256: sha256(body) };
}

/** Freeze the run: run.json → `reauthored`, event `elevation.freeze`; the architect pseudo-agent enters `repairing-workflow` on audit freezes. */
export function freezeRun(store: RunStore, runDir: string, input: EscalationInput & { report: string }): void {
	store.updateRun(runDir, { status: "reauthored", endedAt: new Date().toISOString() });
	store.appendEvent(runDir, "elevation.freeze", { kind: input.kind, nodeId: input.nodeId, attempts: input.attempts, report: input.report, targetLevel: elevationTarget(input.level), verdict: input.verdict, reviewedNodeId: input.reviewedNodeId, findings: input.findings.length });
	if (input.kind === "audit" || input.kind === "elevate") {
		try {
			store.upsertAgent(runDir, { agentId: ARCHITECT_AGENT_ID, callsign: "architect", role: "architect", state: "repairing-workflow" });
		} catch {
			/* observational */
		}
	}
}

export interface LadderStep {
	iteration: number;
	thinking: Thinking;
	model: string;
	freshSession: boolean;
	note: string;
}

const rank = (level: Thinking): number => Math.max(0, THINKING_ORDER.indexOf(level));

/**
 * The mechanical ladder (plan §5.3 b): 1 → base; 2 → thinking one step up (ceiling-aware),
 * same session; 3+ → max reasoning on the family's max model (familyMax, else the base
 * model) in a fresh session.
 */
export function ladderFor(iteration: number, base: { model: string; thinking: Thinking }, familyMax: (model: string) => string | undefined = () => undefined): LadderStep {
	const baseThinking = THINKING_ORDER.includes(base.thinking) ? base.thinking : "medium";
	if (iteration <= 1) return { iteration: Math.max(1, iteration), thinking: normalizeThinking(base.model, baseThinking).effective, model: base.model, freshSession: false, note: "base" };
	if (iteration === 2) {
		const up = THINKING_ORDER[Math.min(THINKING_ORDER.length - 1, rank(baseThinking) + 1)];
		const effective = normalizeThinking(base.model, up).effective;
		return { iteration, thinking: effective, model: base.model, freshSession: false, note: `thinking +1 (${baseThinking} → ${up}${effective !== up ? `↘${effective}` : ""}), same session with the failing log` };
	}
	const model = familyMax(base.model) ?? base.model;
	const effective = normalizeThinking(model, "max").effective;
	return { iteration, thinking: effective, model, freshSession: true, note: `max reasoning (max${effective !== "max" ? `↘${effective}` : ""}) on ${model === base.model ? "the same model" : `the family max model ${model}`}, fresh session` };
}

/** True when a loop node runs under the mechanical counter: `until_bash` present or `on_fail: elevate`. */
export function isMechanicalLoop(node: NodeDoc): boolean {
	const loop = (node as { loop?: { until_bash?: string } }).loop;
	return !!loop && (typeof loop.until_bash === "string" || node.on_fail?.action === "elevate");
}
