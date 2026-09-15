/**
 * evidence.ts — the evidence package a verify node writes (plan §5.1, D9, P4).
 *
 *   evidence/<nodeId>/evidence.json   EvidencePackage (canonical JSON + sha256 sidecar,
 *                                     written through RunStore.writeEvidence)
 *
 * Hard evidence is `capturedBy: observed` with a sha256 recorded by this process; a
 * `declared` artifact (a model's sentence) never satisfies a requirement, and every
 * degradation (missing, unhashed, truncated, scan-failed) is an explicit row. The status
 * of a package is derived, never asserted: `matched` when every required kind is observed,
 * `current-unverified` when some are, `unavailable` when nothing usable exists.
 *
 * checkCitations() is the deterministic half of the research-planning verifier (H3b): a
 * cited section that does not exist in vision.md / intent.md / terraform docs is flagged
 * without any model in the loop. Pure Node, no pi.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { sha256, sha256File } from "../hash-chain.ts";
import type { RunStore } from "../run-store.ts";

export const EVIDENCE_SCHEMA_VERSION = 1 as const;

export const EVIDENCE_KINDS = [
	"screenshot",
	"video",
	"log",
	"test-result",
	"console-log",
	"network-log",
	"evidence-pack",
	"payload",
	"dataset",
	"script",
	"diff",
	"report",
	"db-op-log",
	"approval-receipt",
	"http-status",
	"payload-hash",
	"source-digests",
	"plan-digest",
	"alignment-table",
	"result-card",
	"design-match",
	"coverage-report",
	"migration-log",
	"rollback-note",
	"probe",
	"snapshot",
	"schedule-id",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export type CapturedBy = "observed" | "inferred" | "declared";
export type EvidenceSource = "tool" | "kane" | "momentic" | "cursor" | "orca" | "testmu" | "human" | "bash" | "verifier";
export type EvidenceStatus = "matched" | "current-unverified" | "unavailable" | "excluded";
export type Degradation = "unhashed" | "scan-failed" | "truncated" | "missing";

/** Runner sources that count as a simulated user (production-swe's video/screenshot rule). */
export const SIM_USER_SOURCES: EvidenceSource[] = ["kane", "momentic", "orca"];

export interface EvidenceArtifact {
	path: string;
	sha256?: string;
	bytes?: number;
	kind: EvidenceKind;
	capturedBy: CapturedBy;
	source: EvidenceSource;
	ts: string;
	degraded?: Degradation[];
	device?: string;
	note?: string;
}

export interface EvidenceChecks {
	testsPass?: boolean;
	exitCode?: number;
	logsPresent?: boolean;
	screenshotPresent?: boolean;
	designMatch?: boolean;
	perfBudgetMet?: boolean;
	orgRulesMet?: boolean;
	userFlowsPassed?: boolean;
	coverage?: number;
	rowCounts?: Record<string, number>;
	httpStatuses?: Record<string, number>;
}

export interface EvidencePackage {
	schemaVersion: 1;
	runId: string;
	nodeId: string;
	agent?: string;
	tier?: string;
	modes: string[];
	status: EvidenceStatus;
	artifacts: EvidenceArtifact[];
	checks: EvidenceChecks;
	provenanceSeq: number[];
	missingInformation: string[];
	reviewedBy?: { callsign: string; verdictHash: string };
	summary?: string;
}

/** A requirement: every kind in `required`, plus for each group in `anyOf` at least one of its kinds (optionally from a sim-user source). */
export interface EvidenceRequirement {
	required: EvidenceKind[];
	anyOf?: EvidenceKind[][];
	/** When set, the anyOf groups must be satisfied by an artifact whose source is a simulated user (kane, momentic, orca). */
	simUser?: boolean;
}

const now = () => new Date().toISOString();

/**
 * Hash one file into an artifact row. A missing or unreadable file keeps the row (so the
 * gap is visible) with `degraded: ["missing"]` and no sha256; a capped hash is `truncated`.
 */
export async function hashArtifact(file: string, kind: EvidenceKind, source: EvidenceSource, extra: Partial<EvidenceArtifact> = {}): Promise<EvidenceArtifact> {
	const row: EvidenceArtifact = { path: file, kind, capturedBy: "observed", source, ts: now(), ...extra };
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile()) {
			row.degraded = [...(row.degraded ?? []), "missing"];
			return row;
		}
		const hashed = await sha256File(file);
		row.sha256 = hashed.sha256;
		row.bytes = hashed.bytes;
		if (hashed.truncated) row.degraded = [...(row.degraded ?? []), "truncated"];
	} catch {
		row.degraded = [...(row.degraded ?? []), "missing"];
	}
	return row;
}

/** A row for something a model or a human asserted — never hard evidence. */
export function declaredArtifact(kind: EvidenceKind, note: string, source: EvidenceSource = "verifier"): EvidenceArtifact {
	return { path: "", kind, capturedBy: "declared", source, ts: now(), note, degraded: ["unhashed"] };
}

const usable = (artifact: EvidenceArtifact): boolean => artifact.capturedBy === "observed" && typeof artifact.sha256 === "string" && artifact.sha256.length === 64 && !(artifact.degraded ?? []).includes("missing");

/** Kinds backed by hard evidence: observed, hashed, present. */
export function observedKinds(pkg: Pick<EvidencePackage, "artifacts">): Set<EvidenceKind> {
	return new Set(pkg.artifacts.filter(usable).map((artifact) => artifact.kind));
}

/** Kinds backed by hard evidence from a simulated-user source. */
export function simUserKinds(pkg: Pick<EvidencePackage, "artifacts">): Set<EvidenceKind> {
	return new Set(pkg.artifacts.filter((artifact) => usable(artifact) && SIM_USER_SOURCES.includes(artifact.source)).map((artifact) => artifact.kind));
}

/**
 * Derive the package status from what is observed versus what the requirement asks for.
 * matched: everything required is observed; current-unverified: something usable exists
 * but a requirement is missing; unavailable: nothing usable at all (or nothing required and
 * nothing observed); `missing` lists every unmet kind (an anyOf group as "a|b").
 */
export function evidenceStatus(pkg: Pick<EvidencePackage, "artifacts">, requirement: EvidenceKind[] | EvidenceRequirement): { status: EvidenceStatus; missing: string[] } {
	const req: EvidenceRequirement = Array.isArray(requirement) ? { required: requirement } : requirement;
	const observed = observedKinds(pkg);
	const sim = simUserKinds(pkg);
	const missing: string[] = req.required.filter((kind) => !observed.has(kind));
	for (const group of req.anyOf ?? []) {
		const pool = req.simUser ? sim : observed;
		if (!group.some((kind) => pool.has(kind))) missing.push(`${group.join("|")}${req.simUser ? " (sim-user source)" : ""}`);
	}
	if (observed.size === 0) return { status: "unavailable", missing: missing.length ? missing : req.required.length ? [...req.required] : ["no observed evidence"] };
	return { status: missing.length ? "current-unverified" : "matched", missing };
}

export interface BuildEvidenceInput {
	runId: string;
	nodeId: string;
	agent?: string;
	tier?: string;
	modes?: string[];
	artifacts: EvidenceArtifact[];
	checks?: EvidenceChecks;
	provenanceSeq?: number[];
	summary?: string;
	reviewedBy?: { callsign: string; verdictHash: string };
	/** Extra gaps the runner knows about (a device that never reported, a skipped lane). */
	missingInformation?: string[];
}

/** Assemble a package and derive its status against the requirement. */
export function buildEvidence(input: BuildEvidenceInput, requirement: EvidenceKind[] | EvidenceRequirement): EvidencePackage {
	const { status, missing } = evidenceStatus({ artifacts: input.artifacts }, requirement);
	const pkg: EvidencePackage = {
		schemaVersion: EVIDENCE_SCHEMA_VERSION,
		runId: input.runId,
		nodeId: input.nodeId,
		modes: input.modes ?? [],
		status,
		artifacts: input.artifacts,
		checks: input.checks ?? {},
		provenanceSeq: input.provenanceSeq ?? [],
		missingInformation: [...missing.map((kind) => `missing evidence: ${kind}`), ...(input.missingInformation ?? [])],
	};
	if (input.agent) pkg.agent = input.agent;
	if (input.tier) pkg.tier = input.tier;
	if (input.summary) pkg.summary = input.summary;
	if (input.reviewedBy) pkg.reviewedBy = input.reviewedBy;
	return pkg;
}

/** Persist through the store (canonical JSON + sha256sum sidecar); returns the file and the sha256 of its bytes. */
export function writeEvidencePackage(store: RunStore, runDir: string, pkg: EvidencePackage): { path: string; sha256: string } {
	const file = store.writeEvidence(runDir, pkg.nodeId, pkg as unknown as Record<string, unknown>);
	return { path: file, sha256: sha256(fs.readFileSync(file)) };
}

/** The package a node wrote earlier in this run, if any (mirrors RunStore's evidence/<nodeId>/evidence.json layout). */
export function readEvidencePackage(runDir: string, nodeId: string): EvidencePackage | undefined {
	const safe = nodeId
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[.-]+/, "")
		.replace(/-+$/, "");
	const file = path.join(runDir, "evidence", safe || "node", "evidence.json");
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		return parsed && typeof parsed === "object" && parsed.schemaVersion === EVIDENCE_SCHEMA_VERSION ? (parsed as EvidencePackage) : undefined;
	} catch {
		return undefined;
	}
}

// ═══ Citations (research-planning, H3b) ═════════════════════════════════════

export interface CitationDoc {
	name: string;
	text: string;
}

export interface CitationCheck {
	cited: string[];
	missing: string[];
}

const slug = (text: string): string =>
	text
		.toLowerCase()
		.replace(/[`*_~]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

interface DocIndex {
	name: string;
	base: string;
	headings: Array<{ text: string; slug: string; number?: string }>;
}

function indexDoc(doc: CitationDoc): DocIndex {
	const base = path.basename(doc.name).toLowerCase().replace(/\.(md|markdown|txt)$/, "");
	const headings: DocIndex["headings"] = [];
	for (const raw of doc.text.split(/\r?\n/)) {
		const line = raw.trim();
		const md = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
		const numbered = /^(\d+(?:\.\d+)*)[.)]?\s+(\S.*)$/.exec(md ? md[1] : line);
		if (md) {
			const text = md[1].trim();
			headings.push({ text, slug: slug(text), number: numbered?.[1] });
		} else if (numbered && !md) {
			// A bare numbered line ("2.3 Scope") counts as a section marker in plain-text docs.
			headings.push({ text: numbered[2].trim(), slug: slug(numbered[2]), number: numbered[1] });
		}
	}
	return { name: doc.name, base, headings };
}

const docMatches = (index: DocIndex, ref: string): boolean => {
	const wantedPath = ref.toLowerCase().replace(/\.(md|markdown|txt)$/, "");
	const wanted = path.basename(wantedPath);
	const full = index.name.toLowerCase().replace(/\.(md|markdown|txt)$/, "");
	return index.base === wanted || full === wantedPath || full.endsWith(`/${wantedPath}`) || index.base.startsWith(wanted);
};

const sectionExists = (indexes: DocIndex[], section: string): boolean => {
	const trimmed = section.trim().replace(/^[§#\s]+/, "").replace(/[.)]$/, "");
	if (!trimmed) return false;
	const wantedSlug = slug(trimmed);
	return indexes.some((index) =>
		index.headings.some((heading) => {
			if (/^\d+(\.\d+)*$/.test(trimmed)) return heading.number === trimmed || heading.number?.startsWith(`${trimmed}.`) === true;
			return heading.slug === wantedSlug || heading.text.toLowerCase() === trimmed.toLowerCase() || (wantedSlug.length >= 4 && heading.slug.includes(wantedSlug));
		}),
	);
};

/**
 * Find every citation in `text` and check it against the docs. Recognized forms:
 *   vision.md#goals · intent.md#non-goals          (anchor = heading slug)
 *   [vision: Goals] · [intent: Non-goals]           (bracket, doc: section)
 *   vision.md > Goals · terraform/entity.md › Scope (breadcrumb)
 *   vision.md §2.3 · § 2.3 · §2                     (section number, any doc when no doc is named)
 * A citation naming an unknown doc, or a section absent from the named doc, is `missing`.
 */
export function checkCitations(text: string, docs: CitationDoc[]): CitationCheck {
	const indexes = docs.map(indexDoc);
	const cited: string[] = [];
	const missing: string[] = [];
	const seen = new Set<string>();
	const record = (raw: string, ok: boolean) => {
		const key = raw.trim();
		if (seen.has(key)) return;
		seen.add(key);
		cited.push(key);
		if (!ok) missing.push(key);
	};
	const docsFor = (name: string | undefined): DocIndex[] => (name ? indexes.filter((index) => docMatches(index, name)) : indexes);
	// vision.md#goals
	for (const m of text.matchAll(/([A-Za-z0-9_./-]+\.(?:md|markdown|txt))#([A-Za-z0-9_-]+)/g)) {
		const target = docsFor(m[1]);
		record(m[0], target.length > 0 && sectionExists(target, m[2].replace(/-/g, " ")));
	}
	// [vision: Goals]
	for (const m of text.matchAll(/\[([A-Za-z0-9_./-]+?)(?:\.md)?:\s*([^\]]+)\]/g)) {
		const target = docsFor(m[1]);
		if (!target.length) continue; // "[note: …]" style brackets that name no doc are not citations
		record(m[0], sectionExists(target, m[2]));
	}
	// vision.md > Goals · vision.md › Goals
	for (const m of text.matchAll(/([A-Za-z0-9_./-]+\.(?:md|markdown|txt))\s*[>›]\s*([A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+)*?)(?=\s+(?:and|or|plus|with|which|that|for|as|in|on)\b|[.,;:)\n]|$)/g)) {
		const target = docsFor(m[1]);
		record(m[0].trim(), target.length > 0 && sectionExists(target, m[2]));
	}
	// vision.md §2.3 · §2.3 · § 2
	for (const m of text.matchAll(/(?:([A-Za-z0-9_./-]+\.(?:md|markdown|txt))\s*)?§\s*(\d+(?:\.\d+)*)/g)) {
		const target = docsFor(m[1]);
		record(m[0].trim(), target.length > 0 && sectionExists(target, m[2]));
	}
	return { cited, missing };
}
