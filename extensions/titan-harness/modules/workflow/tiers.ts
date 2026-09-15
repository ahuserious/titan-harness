/**
 * tiers.ts — verification tiers as data (plan D10, §5.2, P4).
 *
 * A tier names the hard-evidence kinds a run must observe, the verifier runners that can
 * produce them, whether a separate review is required, the mechanical-loop budget (3, the
 * single counter of §5.3), whether a simulated user has to be in the loop, how many human
 * approvals a ship needs (content), and where elevation goes (`min(level + 1, 3)`). Nothing
 * here runs anything: nodes/verify.ts and elevation.ts read it. Pure data, no pi.
 */
import type { EvidenceKind, EvidenceRequirement } from "./evidence.ts";
import type { NodeDoc, WorkflowDoc } from "./schema.ts";

export const TIER_NAMES = ["web-general", "research-planning", "prototype-analytics", "production-swe", "platform-update", "content"] as const;
export type TierName = (typeof TIER_NAMES)[number];

export type RunnerName = "bash" | "kane" | "testmu" | "momentic" | "cursor-cloud" | "orca-browser" | "verifier";

export interface TierSpec {
	name: TierName;
	/** Every kind must be observed (hashed) for the package to be `matched`. */
	required: EvidenceKind[];
	/** For each group at least one kind must be observed; with `simUser` from a simulated-user source. */
	anyOf?: EvidenceKind[][];
	/** Runners (and node kinds) that produce this tier's evidence. */
	verifiers: Array<RunnerName | "approval" | "judge">;
	review: "required" | "optional";
	/** The mechanical CI/test loop budget (§5.3, one counter). */
	mechanicalMax: 3;
	simUser: boolean;
	/** Distinct human approval receipts a ship needs (content presets, §5.6). */
	humanApprovals: number;
	/** Minimum coverage percentage a ship node may accept (platform-update). */
	coverageMin?: number;
	/** The next deeper tier when elevation asks for "tier depth +1". */
	depthNext?: TierName;
	elevationTarget(level: number | undefined): number;
}

/** `min(level + 1, 3)`; no level → 1. */
export function elevationTarget(level: number | undefined): number {
	const current = typeof level === "number" && Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
	return Math.min(current + 1, 3);
}

const PROTOTYPE_REQUIRED: EvidenceKind[] = ["test-result", "log", "screenshot", "script", "result-card", "design-match"];

const tier = (spec: Omit<TierSpec, "mechanicalMax" | "elevationTarget">): TierSpec => ({ ...spec, mechanicalMax: 3, elevationTarget });

/** §5.2 verbatim, as data. */
export const TIERS: Record<TierName, TierSpec> = {
	"web-general": tier({
		name: "web-general",
		required: ["http-status", "payload-hash", "screenshot", "db-op-log"],
		verifiers: ["bash", "orca-browser"],
		review: "optional",
		simUser: false,
		humanApprovals: 0,
		depthNext: "prototype-analytics",
	}),
	"research-planning": tier({
		name: "research-planning",
		required: ["plan-digest", "source-digests", "alignment-table"],
		verifiers: ["verifier"],
		review: "required",
		simUser: false,
		humanApprovals: 0,
	}),
	"prototype-analytics": tier({
		name: "prototype-analytics",
		required: PROTOTYPE_REQUIRED,
		verifiers: ["cursor-cloud", "kane"],
		review: "required",
		simUser: false,
		humanApprovals: 0,
		depthNext: "production-swe",
	}),
	"production-swe": tier({
		name: "production-swe",
		required: [...PROTOTYPE_REQUIRED, "console-log", "network-log", "schedule-id"],
		anyOf: [["video", "screenshot"]],
		verifiers: ["kane", "momentic", "orca-browser"],
		review: "required",
		simUser: true,
		humanApprovals: 0,
		depthNext: "platform-update",
	}),
	"platform-update": tier({
		name: "platform-update",
		required: ["diff", "migration-log", "coverage-report", "probe", "rollback-note"],
		verifiers: ["bash", "kane", "testmu", "momentic", "cursor-cloud", "orca-browser", "verifier", "approval"],
		review: "required",
		simUser: true,
		humanApprovals: 1,
		coverageMin: 100,
	}),
	content: tier({
		name: "content",
		required: ["payload-hash", "source-digests", "screenshot", "approval-receipt"],
		verifiers: ["approval", "judge"],
		review: "required",
		simUser: false,
		humanApprovals: 3,
	}),
};

export const isTierName = (value: unknown): value is TierName => typeof value === "string" && (TIER_NAMES as readonly string[]).includes(value);

/** The tier a node runs under: its own `tier`, else the document's `titan.tier`; unknown names → undefined. */
export function tierFor(doc: WorkflowDoc | undefined, node?: NodeDoc): TierSpec | undefined {
	const name = node?.tier ?? doc?.titan?.tier;
	return isTierName(name) ? TIERS[name] : undefined;
}

/** The tier's required kinds plus the node's own `evidence.require` (deduplicated, node order last). */
export function requiredKinds(tier: TierSpec | undefined, node?: NodeDoc): EvidenceKind[] {
	const own = (node?.evidence?.require ?? []) as EvidenceKind[];
	return [...new Set([...(tier?.required ?? []), ...own])];
}

/** The full requirement (required kinds + anyOf groups + sim-user rule) for a node under a tier. */
export function evidenceRequirement(tier: TierSpec | undefined, node?: NodeDoc): EvidenceRequirement {
	const req: EvidenceRequirement = { required: requiredKinds(tier, node) };
	if (tier?.anyOf?.length) req.anyOf = tier.anyOf.map((group) => [...group]);
	if (tier?.simUser) req.simUser = true;
	return req;
}

/** One line per tier for docs and the doctor: "production-swe · review required · sim-user · 9 kinds + video|screenshot". */
export function describeTier(spec: TierSpec): string {
	const parts = [spec.name, `review ${spec.review}`, spec.simUser ? "sim-user" : "no sim-user", `${spec.required.length} kinds${spec.anyOf?.length ? ` + ${spec.anyOf.map((g) => g.join("|")).join(", ")}` : ""}`];
	if (spec.humanApprovals) parts.push(`${spec.humanApprovals} human approvals`);
	if (spec.coverageMin !== undefined) parts.push(`coverage ≥ ${spec.coverageMin} %`);
	return parts.join(" · ");
}
