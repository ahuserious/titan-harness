/**
 * runners/index.ts — the runner adapter contract behind `verify:` nodes (plan §5.8, D9, P4).
 *
 * A runner turns a VerifySpec into observed evidence: it runs a vendor lane (kane-cli,
 * TestMu tools, Momentic tools, the Cursor cloud API, the Orca browser CLI), a bash
 * check, or an AI verifier, and returns hashed artifact rows plus checks. Every runner
 * fails closed — `pass` only when the lane reported success AND artifacts exist AND their
 * hashes were recorded — and never prints, stores or returns a credential value. Vendor
 * calls go through the RunnerContext seams (exec, fetch, mcpTool, agent) so tests replay
 * recorded fixtures; nothing here imports pi.
 *
 *   RUNNERS[name](spec, ctx) → RunnerResult { status, artifacts, checks, summary, … }
 *
 * Shared helpers: directory scanning (new/modified files a lane produced), kind
 * classification by file name, JSON reading, and the injectable fetch used by
 * cursor-cloud (setRunnerFetch for tests; globalThis.fetch otherwise).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ProcessResult, WorkflowRuntimeDeps } from "../executor.ts";
import type { EvidenceArtifact, EvidenceChecks, EvidenceKind, EvidenceSource, CitationDoc } from "../evidence.ts";
import type { JsonSchema, SlotRole, VerifySpec } from "../schema.ts";
import type { RunnerName } from "../tiers.ts";
import { bashRunner } from "./bash.ts";
import { cursorCloudRunner } from "./cursor-cloud.ts";
import { kaneRunner } from "./kane.ts";
import { momenticRunner } from "./momentic.ts";
import { orcaBrowserRunner } from "./orca-browser.ts";
import { testmuRunner } from "./testmu.ts";
import { verifierRunner } from "./verifier.ts";

export type { RunnerName } from "../tiers.ts";

export type RunnerStatus = "pass" | "fail" | "unavailable" | "skipped";

export interface FetchResponse {
	status: number;
	ok?: boolean;
	json(): Promise<unknown>;
	text(): Promise<string>;
	arrayBuffer?(): Promise<ArrayBuffer>;
}
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<FetchResponse>;

export interface RunnerContext {
	runId: string;
	nodeId: string;
	cwd: string;
	/** Process environment merged with the node env — credentials are read from here by NAME and never copied anywhere. */
	env: Record<string, string>;
	artifactsDir: string;
	/** Where this node's evidence files are written (artifacts/evidence/<nodeId>/). */
	evidenceDir: string;
	exec(command: string, args: string[], opts?: { timeoutMs?: number; env?: Record<string, string>; cwd?: string }): Promise<ProcessResult>;
	fetch?: FetchLike;
	mcpTool?: WorkflowRuntimeDeps["mcpTool"];
	agent?(prompt: string, opts?: { role?: SlotRole; outputSchema?: JsonSchema }): Promise<{ ok: boolean; text: string; value?: unknown; error?: string }>;
	notify(text: string, level?: "info" | "warning" | "error"): void;
	signal: AbortSignal;
	timeoutMs: number;
	hash(file: string, kind: EvidenceKind, source: EvidenceSource, extra?: Partial<EvidenceArtifact>): Promise<EvidenceArtifact>;
	which(binary: string): string | undefined;
	/** vision.md, intent.md, .titan/terraform/*.md when present (research-planning). */
	docs?: CitationDoc[];
}

export interface RunnerResult {
	status: RunnerStatus;
	artifacts: EvidenceArtifact[];
	checks: EvidenceChecks;
	summary: string;
	reason?: string;
	raw?: unknown;
	devices?: Record<string, "pass" | "fail" | "unavailable">;
	/** Extra gaps for the package's missingInformation (a device that never reported, …). */
	missing?: string[];
	/** false: a deterministic failure (missing citation, branch not on the remote) that a retry cannot fix. Default true. */
	retryable?: boolean;
}

export type Runner = (spec: VerifySpec, ctx: RunnerContext) => Promise<RunnerResult>;

export const RUNNERS: Record<RunnerName, Runner> = {
	bash: bashRunner,
	kane: kaneRunner,
	testmu: testmuRunner,
	momentic: momenticRunner,
	"cursor-cloud": cursorCloudRunner,
	"orca-browser": orcaBrowserRunner,
	verifier: verifierRunner,
};

export const isRunnerName = (value: unknown): value is RunnerName => typeof value === "string" && Object.prototype.hasOwnProperty.call(RUNNERS, value);

// ═══ Injectable fetch ════════════════════════════════════════════════════════

let injectedFetch: FetchLike | undefined;

/** Tests replay recorded HTTP responses through this; `undefined` restores globalThis.fetch. */
export function setRunnerFetch(fn: FetchLike | undefined): void {
	injectedFetch = fn;
}

export function runnerFetch(): FetchLike | undefined {
	if (injectedFetch) return injectedFetch;
	const native = (globalThis as { fetch?: unknown }).fetch;
	return typeof native === "function" ? (native as unknown as FetchLike) : undefined;
}

// ═══ Shared helpers ═════════════════════════════════════════════════════════

export const unavailable = (reason: string, extra: Partial<RunnerResult> = {}): RunnerResult => ({ status: "unavailable", artifacts: [], checks: {}, summary: reason, reason, ...extra });
export const skipped = (reason: string): RunnerResult => ({ status: "skipped", artifacts: [], checks: {}, summary: reason, reason });
export const failed = (reason: string, extra: Partial<RunnerResult> = {}): RunnerResult => ({ status: "fail", artifacts: [], checks: {}, summary: reason, reason, ...extra });

export interface FileSnapshot {
	[file: string]: { size: number; mtimeMs: number };
}

/** Every regular file under `dir` (recursive, symlinks not followed); missing dir → empty. */
export function listFiles(dir: string, maxFiles = 2000): string[] {
	const out: string[] = [];
	const walk = (current: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (out.length >= maxFiles) return;
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) out.push(full);
		}
	};
	walk(dir);
	return out.sort();
}

export function snapshotFiles(dir: string): FileSnapshot {
	const snap: FileSnapshot = {};
	for (const file of listFiles(dir)) {
		try {
			const stat = fs.statSync(file);
			snap[file] = { size: stat.size, mtimeMs: stat.mtimeMs };
		} catch {}
	}
	return snap;
}

/** Files that are new or changed since `before` (what a lane produced). */
export function changedFiles(dir: string, before: FileSnapshot): string[] {
	const after = snapshotFiles(dir);
	return Object.keys(after).filter((file) => {
		const prev = before[file];
		return !prev || prev.size !== after[file].size || prev.mtimeMs !== after[file].mtimeMs;
	});
}

/** Evidence kind from a file name (prefix or extension); `log` when nothing else matches. */
export function kindForFile(file: string, fallback: EvidenceKind = "log"): EvidenceKind {
	const base = path.basename(file).toLowerCase();
	const ext = path.extname(base);
	const rules: Array<[RegExp, EvidenceKind]> = [
		[/^db-op-log/, "db-op-log"],
		[/^http-status/, "http-status"],
		[/^payload-hash|\.sha256$/, "payload-hash"],
		[/^payload/, "payload"],
		[/^screenshot|^shot-|\.(png|jpe?g|webp)$/, "screenshot"],
		[/\.(mp4|webm|mov)$/, "video"],
		[/^coverage/, "coverage-report"],
		[/^probe/, "probe"],
		[/^rollback/, "rollback-note"],
		[/^migration/, "migration-log"],
		[/^diff|\.(diff|patch)$/, "diff"],
		[/^test-result|^junit|^results?[-.]|\.xml$/, "test-result"],
		[/^console/, "console-log"],
		[/^network|\.har$/, "network-log"],
		[/^snapshot/, "snapshot"],
		[/^result-card/, "result-card"],
		[/^design-match/, "design-match"],
		[/^schedule|^mission/, "schedule-id"],
		[/^dataset|\.(csv|parquet)$/, "dataset"],
		[/^report/, "report"],
		[/^alignment/, "alignment-table"],
		[/^plan-digest/, "plan-digest"],
		[/^source-digests?/, "source-digests"],
		[/^approval-receipt/, "approval-receipt"],
		[/^evidence-pack/, "evidence-pack"],
		[/\.(ts|js|py|sh)$/, "script"],
		[/\.log$/, "log"],
	];
	for (const [re, kind] of rules) if (re.test(base) || (ext && re.test(ext))) return kind;
	return fallback;
}

export function readJsonFile(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : undefined);

/** Coverage percentage from the common report shapes: {total:{lines:{pct}}}, {coverage}, {percent}, {pct}. */
export function coverageOf(value: unknown): number | undefined {
	if (!value || typeof value !== "object") return undefined;
	const v = value as Record<string, unknown>;
	const total = v.total as Record<string, unknown> | undefined;
	const lines = total?.lines as Record<string, unknown> | undefined;
	return num(lines?.pct) ?? num(total?.pct) ?? num(v.coverage) ?? num(v.percent) ?? num(v.pct);
}

/** Row counts from a db-op-log: {rowCounts:{…}} or {writes, reads} or {ops:[{table, rows}]}. */
export function rowCountsOf(value: unknown): Record<string, number> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const v = value as Record<string, unknown>;
	const out: Record<string, number> = {};
	if (v.rowCounts && typeof v.rowCounts === "object") {
		for (const [k, raw] of Object.entries(v.rowCounts as Record<string, unknown>)) {
			const n = num(raw);
			if (n !== undefined) out[k] = n;
		}
	}
	for (const key of ["writes", "reads", "written", "read"]) {
		const n = num(v[key]);
		if (n !== undefined) out[key] = n;
	}
	if (Array.isArray(v.ops)) {
		for (const op of v.ops as Array<Record<string, unknown>>) {
			const n = num(op?.rows);
			const label = typeof op?.table === "string" ? `${op.op ?? "op"}:${op.table}` : String(op?.op ?? "op");
			if (n !== undefined) out[label] = (out[label] ?? 0) + n;
		}
	}
	return Object.keys(out).length ? out : undefined;
}

/** {url: status} from an http-status file: {statuses:{url: code}} or [{url, status}] or {url: code}. */
export function httpStatusesOf(value: unknown): Record<string, number> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const out: Record<string, number> = {};
	const rows = Array.isArray(value) ? value : Array.isArray((value as Record<string, unknown>).checks) ? ((value as Record<string, unknown>).checks as unknown[]) : undefined;
	if (rows) {
		for (const row of rows as Array<Record<string, unknown>>) {
			const status = num(row?.status ?? row?.code);
			if (typeof row?.url === "string" && status !== undefined) out[row.url] = status;
		}
	} else {
		const source = ((value as Record<string, unknown>).statuses ?? value) as Record<string, unknown>;
		for (const [url, raw] of Object.entries(source)) {
			const status = num(raw);
			if (status !== undefined && /^https?:\/\//.test(url)) out[url] = status;
		}
	}
	return Object.keys(out).length ? out : undefined;
}

/** Hash every file the lane produced under `dir` since `before`, classifying kinds by name. */
export async function harvestDir(ctx: RunnerContext, dir: string, before: FileSnapshot, source: EvidenceSource, extra: Partial<EvidenceArtifact> = {}): Promise<EvidenceArtifact[]> {
	const artifacts: EvidenceArtifact[] = [];
	for (const file of changedFiles(dir, before)) artifacts.push(await ctx.hash(file, kindForFile(file), source, extra));
	return artifacts;
}

/** Copy `text` into the evidence dir under `name` and hash it. */
export async function saveText(ctx: RunnerContext, name: string, text: string, kind: EvidenceKind, source: EvidenceSource, extra: Partial<EvidenceArtifact> = {}): Promise<EvidenceArtifact> {
	fs.mkdirSync(ctx.evidenceDir, { recursive: true, mode: 0o700 });
	const file = path.join(ctx.evidenceDir, name);
	fs.writeFileSync(file, text, { mode: 0o600 });
	return ctx.hash(file, kind, source, extra);
}

/** Checks derived from harvested artifacts (coverage, row counts, http statuses, presence flags). */
export function checksFromArtifacts(artifacts: EvidenceArtifact[], base: EvidenceChecks = {}): EvidenceChecks {
	const checks: EvidenceChecks = { ...base };
	for (const artifact of artifacts) {
		if (!artifact.sha256 || !artifact.path) continue;
		if (artifact.kind === "screenshot") checks.screenshotPresent = true;
		if (artifact.kind === "log" || artifact.kind === "test-result" || artifact.kind === "console-log") checks.logsPresent = true;
		if (artifact.kind === "coverage-report") {
			const coverage = coverageOf(readJsonFile(artifact.path));
			if (coverage !== undefined) checks.coverage = coverage;
		}
		if (artifact.kind === "db-op-log") {
			const counts = rowCountsOf(readJsonFile(artifact.path));
			if (counts) checks.rowCounts = { ...(checks.rowCounts ?? {}), ...counts };
		}
		if (artifact.kind === "http-status") {
			const statuses = httpStatusesOf(readJsonFile(artifact.path));
			if (statuses) checks.httpStatuses = { ...(checks.httpStatuses ?? {}), ...statuses };
		}
	}
	return checks;
}

const PASS_WORDS = new Set(["pass", "passed", "success", "succeeded", "ok", "completed", "finished", "green"]);
/** True for the vendor vocabularies of "it passed". */
export const isPassStatus = (value: unknown): boolean => typeof value === "string" && PASS_WORDS.has(value.trim().toLowerCase());

/** A string field of the spec (the node substitutes them before the runner sees them). */
export const specString = (spec: VerifySpec, key: string): string | undefined => (typeof spec[key] === "string" && (spec[key] as string).trim() ? (spec[key] as string) : undefined);
