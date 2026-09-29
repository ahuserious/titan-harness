/**
 * run-store.ts — the DB-free run store (§6.2 of the v0.3 plan): one directory per run
 * under ~/.pi/titan-harness/runs/<projectSlug>/<runId>/ holding run.json, the three
 * hash-chained JSONL files, per-agent records, node artifacts, content-addressed blobs
 * and evidence packages.
 *
 *   run.json                          RunMeta — atomic temp + rename, 0600
 *   events.jsonl                      chained {seq, ts, runId, agentId?, type, data, prev, hash}
 *   ledger.jsonl                      chained cost rows           (modules/ledger.ts)
 *   approvals.jsonl                   chained runner-owned approval lifecycle, index derived on read
 *   provenance.jsonl                  chained tool → file edges   (modules/provenance.ts)
 *   agents/<agentId>.json             AgentRecord with its stateHistory
 *   artifacts/nodes/<id>.md           node output, plus <id>.meta.json {sha256, bytes, ts, …}
 *   blobs/<sha256>                    copies of harvested files, named by content
 *   evidence/<nodeId>/evidence.json   canonical JSON, plus a sha256sum-style sidecar
 *   notebook.jsonl                    chained research notes (appendNotebook / readNotebook)
 *   hypotheses.jsonl                  chained hypothesis links + decisions (appendHypothesisLink / readHypothesisLinks)
 *   <root>/index.jsonl                append-only run index {runId, projectSlug, workflow, startedAt}
 *
 * Single writer = the host process; children never write here. Every JSON file is
 * written in canonical key order; files are 0600, directories 0700. Pure Node, no pi.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendChained, canonicalJson, canonicalValue, chainTail, type ChainRow, readChain, sha256, sha256File, verifyChain } from "./hash-chain.ts";
import type { ApprovalDecision, ApprovalRequest } from "./workflow/approver.ts";

/** Where runs live unless a RunStore is given another root. */
export const DEFAULT_RUN_ROOT = path.join(os.homedir(), ".pi", "titan-harness", "runs");
export const RUN_FILE = "run.json";
export const EVENTS_FILE = "events.jsonl";
/** Research notebook rows (plan §6.2): chained `{seq, ts, runId, type: "note"|"link"|"decision", nodeId, …}`. */
export const NOTEBOOK_FILE = "notebook.jsonl";
/** Hypothesis evidence links and decisions (plan A11): chained like the notebook, one row per link or decision. */
export const HYPOTHESES_FILE = "hypotheses.jsonl";
export const APPROVALS_FILE = "approvals.jsonl";
export const INDEX_FILE = "index.jsonl";

export const RUN_STATUSES = ["pending", "running", "paused", "reauthored", "completed", "failed", "aborted", "stalemate", "interrupted"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** run.json — the run's identity, shape and lifecycle (§6.3). */
export interface RunMeta {
	runId: string;
	projectSlug: string;
	cwd: string;
	workflow?: { name: string; sha256?: string };
	command?: string;
	level?: number;
	tier?: string;
	shape?: string;
	status: RunStatus;
	currentPhase?: string;
	phases?: string[];
	startedAt: string;
	endedAt?: string;
	parentRunId?: string;
	totals?: { tokens: number; costUsd: number; agents: number };
	phaseExit?: Record<string, unknown>;
}

/** agents/<agentId>.json — one agent's identity, usage and state history (§6.3). */
export interface AgentRecord {
	agentId: string;
	callsign: string;
	role: string;
	model: string;
	thinking: { requested: string; effective: string };
	parent?: string;
	sessionDir?: string;
	state: string;
	stateHistory: Array<{ state: string; ts: string; seq: number }>;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	tps: { outputTokens: number; seconds: number };
}

/** One line of <root>/index.jsonl. */
export interface RunIndexEntry {
	runId: string;
	projectSlug: string;
	workflow?: { name: string; sha256?: string };
	startedAt: string;
}

/** Filesystem-safe single path segment: anything but [A-Za-z0-9._-] collapses to `-`; never `.`/`..`/empty. */
function safeName(name: string): string {
	const cleaned = name
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[.-]+/, "")
		.replace(/-+$/, "");
	return cleaned || "x";
}

/** Guard for ids that become path segments: no separators, no dot segments. */
function assertSegment(value: string, what: string): void {
	if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
		throw new Error(`invalid ${what}: ${JSON.stringify(value)}`);
	}
}

/** Pretty, key-sorted JSON with a trailing newline (run.json, agent and meta files). */
function prettyJson(value: unknown): string {
	return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

let tmpCounter = 0;
/** Atomic write: temp file in the same directory (0600) then rename over the target. */
function writeFileAtomic(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
	fs.writeFileSync(tmp, text, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/** Plain (unchained) JSONL append with O_APPEND, 0600 on create — the run index only. */
function appendLine(file: string, line: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const fd = fs.openSync(file, "a", 0o600);
	try {
		fs.writeSync(fd, `${line}\n`);
	} finally {
		fs.closeSync(fd);
	}
}

function readJson<T>(file: string): T {
	return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

/** `run-20260915T031455Z-a1b2c3`: ISO compact UTC time plus 6 hex — sortable, unique enough per host. */
export function newRunId(now: Date = new Date()): string {
	const compact = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
	return `run-${compact}-${randomBytes(3).toString("hex")}`;
}

const zeroUsage = (): AgentRecord["usage"] => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

export class RunStore {
	readonly root: string;
	private readonly runIds = new Map<string, string>();

	constructor(root: string = DEFAULT_RUN_ROOT) {
		this.root = path.resolve(root);
	}

	/** Same scheme as titan-harness.ts: readable tail (40 chars) of the real path + "-" + sha256(realpath)[0:12]. */
	static projectSlug(cwd: string): string {
		let canonical = path.resolve(cwd);
		try {
			canonical = fs.realpathSync.native(canonical);
		} catch {}
		const readable = canonical.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(-40) || "root";
		return `${readable}-${sha256(canonical).slice(0, 12)}`;
	}

	/** Mint a run: its directory tree, run.json (status defaults to "pending") and an index line. */
	open(meta: Omit<RunMeta, "runId" | "startedAt" | "status"> & { status?: RunStatus }): { runId: string; dir: string } {
		const runId = newRunId();
		const dir = this.dir(runId, meta.projectSlug);
		for (const sub of ["", "evidence", path.join("artifacts", "nodes"), "blobs", "agents"]) {
			fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 });
		}
		const run: RunMeta = { ...meta, runId, status: meta.status ?? "pending", startedAt: new Date().toISOString() };
		writeFileAtomic(path.join(dir, RUN_FILE), prettyJson(run));
		this.runIds.set(dir, runId);
		const entry: RunIndexEntry = { runId, projectSlug: meta.projectSlug, workflow: meta.workflow, startedAt: run.startedAt };
		appendLine(path.join(this.root, INDEX_FILE), canonicalJson(entry));
		return { runId, dir };
	}

	/** `<root>/<projectSlug>/<runId>` — both ids must be single path segments. */
	dir(runId: string, projectSlug: string): string {
		assertSegment(runId, "runId");
		assertSegment(projectSlug, "projectSlug");
		return path.join(this.root, projectSlug, runId);
	}

	/** Parse run.json. */
	readRun(dir: string): RunMeta {
		const run = readJson<RunMeta>(path.join(dir, RUN_FILE));
		this.runIds.set(dir, run.runId);
		return run;
	}

	/** Shallow-merge a patch into run.json (nested objects such as `totals` are replaced whole) and rewrite it atomically. */
	updateRun(dir: string, patch: Partial<RunMeta>): RunMeta {
		const current = this.readRun(dir);
		const next: RunMeta = { ...current, ...patch, runId: current.runId };
		writeFileAtomic(path.join(dir, RUN_FILE), prettyJson(next));
		return next;
	}

	/** Append one chained row to events.jsonl: `{runId, agentId?, type, data}` plus the chain fields. */
	appendEvent(dir: string, type: string, data: Record<string, unknown>, agentId?: string): ChainRow {
		const row: Record<string, unknown> = { runId: this.runIdOf(dir), type, data };
		if (agentId) row.agentId = agentId;
		return appendChained(path.join(dir, EVENTS_FILE), row);
	}

	/**
	 * Create or merge agents/<agentId>.json. A `state` that differs from the current one
	 * (and the first state of a new record, "queued" when none is given) is appended to
	 * stateHistory with `seq` = the events chain's current length; repeating the current
	 * state is a no-op for the history. `stateHistory` in the patch is ignored — the
	 * store owns it. The file name is the sanitized agentId (`aud/1` → `aud-1.json`).
	 */
	upsertAgent(dir: string, record: Partial<AgentRecord> & { agentId: string }): AgentRecord {
		if (!record.agentId) throw new Error("upsertAgent: agentId is required");
		const file = path.join(dir, "agents", `${safeName(record.agentId)}.json`);
		let current: AgentRecord | undefined;
		try {
			current = readJson<AgentRecord>(file);
		} catch {
			current = undefined;
		}
		const base: AgentRecord = current ?? {
			agentId: record.agentId,
			callsign: record.callsign ?? record.agentId,
			role: record.role ?? "",
			model: record.model ?? "",
			thinking: { requested: "", effective: "" },
			state: "queued",
			stateHistory: [],
			usage: zeroUsage(),
			tps: { outputTokens: 0, seconds: 0 },
		};
		const { state, stateHistory: _owned, ...patch } = record;
		const next: AgentRecord = { ...base, stateHistory: [...base.stateHistory] };
		for (const [key, value] of Object.entries(patch)) {
			if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value;
		}
		const nextState = state ?? base.state;
		const last = next.stateHistory[next.stateHistory.length - 1];
		if (!last || last.state !== nextState) {
			next.stateHistory.push({ state: nextState, ts: new Date().toISOString(), seq: chainTail(path.join(dir, EVENTS_FILE)).seq });
		}
		next.state = nextState;
		writeFileAtomic(file, prettyJson(next));
		return next;
	}

	/** Every agents/*.json, in first-seen order (first history seq, then ts, then agentId). */
	listAgents(dir: string): AgentRecord[] {
		const folder = path.join(dir, "agents");
		let names: string[];
		try {
			names = fs.readdirSync(folder).filter((name) => name.endsWith(".json"));
		} catch {
			return [];
		}
		const records: AgentRecord[] = [];
		for (const name of names) {
			try {
				records.push(readJson<AgentRecord>(path.join(folder, name)));
			} catch {
				/* a torn or foreign file never hides the others */
			}
		}
		const key = (r: AgentRecord): [number, string, string] => [r.stateHistory[0]?.seq ?? 0, r.stateHistory[0]?.ts ?? "", r.agentId];
		return records.sort((a, b) => {
			const [sa, ta, ia] = key(a);
			const [sb, tb, ib] = key(b);
			return sa - sb || ta.localeCompare(tb) || ia.localeCompare(ib);
		});
	}

	/** artifacts/nodes/<nodeId>.md plus <nodeId>.meta.json `{…meta, sha256, bytes, ts, nodeId}` (the store's fields win). */
	writeArtifact(dir: string, nodeId: string, body: string, meta: Record<string, unknown> = {}): { path: string; sha256: string } {
		const name = safeName(nodeId);
		const file = path.join(dir, "artifacts", "nodes", `${name}.md`);
		const digest = sha256(body);
		writeFileAtomic(file, body);
		writeFileAtomic(path.join(dir, "artifacts", "nodes", `${name}.meta.json`), prettyJson({ ...meta, sha256: digest, bytes: Buffer.byteLength(body, "utf8"), ts: new Date().toISOString(), nodeId }));
		return { path: file, sha256: digest };
	}

	/** Copy a file into blobs/<sha256> (hashed from the copy, so the name always matches the bytes stored); an existing blob is reused. */
	async storeBlob(dir: string, sourcePath: string): Promise<{ sha256: string; blobPath: string; bytes: number }> {
		const blobs = path.join(dir, "blobs");
		await fs.promises.mkdir(blobs, { recursive: true, mode: 0o700 });
		const tmp = path.join(blobs, `incoming.${process.pid}.${++tmpCounter}.tmp`);
		await fs.promises.copyFile(sourcePath, tmp);
		await fs.promises.chmod(tmp, 0o600);
		const hashed = await sha256File(tmp, Number.MAX_SAFE_INTEGER);
		const blobPath = path.join(blobs, hashed.sha256);
		if (fs.existsSync(blobPath)) await fs.promises.unlink(tmp);
		else await fs.promises.rename(tmp, blobPath);
		return { sha256: hashed.sha256, blobPath, bytes: hashed.bytes };
	}

	/** evidence/<nodeId>/evidence.json as canonical JSON, with an `evidence.json.sha256` sidecar in sha256sum format. Returns the JSON path. */
	writeEvidence(dir: string, nodeId: string, evidence: Record<string, unknown>): string {
		const file = path.join(dir, "evidence", safeName(nodeId), "evidence.json");
		const text = `${canonicalJson(evidence)}\n`;
		writeFileAtomic(file, text);
		writeFileAtomic(`${file}.sha256`, `${sha256(text)}  evidence.json\n`);
		return file;
	}

	/** The newest runs first (at most `limit` of the index's tail), optionally one project's; runs whose directory is gone are skipped. */
	listRuns(projectSlug?: string, limit = 300): RunMeta[] {
		let lines: string[];
		try {
			lines = fs.readFileSync(path.join(this.root, INDEX_FILE), "utf8").split("\n");
		} catch {
			return [];
		}
		const entries: RunIndexEntry[] = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as RunIndexEntry;
				if (entry?.runId && entry.projectSlug && (!projectSlug || entry.projectSlug === projectSlug)) entries.push(entry);
			} catch {
				/* a torn index line is not a run */
			}
		}
		const runs: RunMeta[] = [];
		for (const entry of entries.slice(-Math.max(0, limit)).reverse()) {
			try {
				runs.push(this.readRun(this.dir(entry.runId, entry.projectSlug)));
			} catch {
				/* deleted run directory */
			}
		}
		return runs;
	}

	/** Append a chained notebook row (`type` note | link | decision; `runId` from run.json). */
	appendNotebook(dir: string, row: NotebookRow): ChainRow {
		return appendChained(path.join(dir, NOTEBOOK_FILE), { runId: this.runIdOf(dir), ...row });
	}

	/** Append a chained hypothesis row: an evidence link or a decision (`runId` from run.json). */
	appendHypothesisLink(dir: string, row: HypothesisRow): ChainRow {
		return appendChained(path.join(dir, HYPOTHESES_FILE), { runId: this.runIdOf(dir), ...row });
	}

	/** Approval rows are authoritative; events.jsonl is a monitor mirror. Fail closed on either write failure. */
	private appendApproval(dir: string, type: string, data: Record<string, unknown>): void {
		const file = path.join(dir, APPROVALS_FILE);
		appendChained(file, { runId: this.runIdOf(dir), type, data });
		const fd = fs.openSync(file, "r");
		try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
		// Persist the directory entry too when approvals.jsonl was newly created.
		const directory = fs.openSync(dir, "r");
		try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
		this.appendEvent(dir, type, data);
	}

	requestApproval(dir: string, request: ApprovalRequest): void {
		if (request.runId !== this.runIdOf(dir)) throw new Error("approval runId mismatch");
		if (approvalIndex(dir).has(request.requestId)) throw new Error("approval requestId already exists");
		this.appendApproval(dir, "approval.requested", { request: { ...request } });
	}

	listPendingApprovals(dir: string): ApprovalRequest[] { return listPendingApprovals(dir); }

	/** Only the runner clock can expire a pending request; a future-dated forged reply cannot. */
	expireApproval(dir: string, requestId: string): boolean {
		const entry = approvalIndex(dir).get(requestId);
		if (!entry || entry.state !== "pending" || Date.now() <= Date.parse(entry.request.expiresAt)) return false;
		this.appendApproval(dir, "approval.expired", { requestId });
		return true;
	}

	/**
	 * Synchronous read/check/append (no await or user callback): atomic between consumers on
	 * the same JS event loop, including separate RunStore instances. Cross-process/worker
	 * access requires the existing SINGLE WRITER per run directory contract; no file lock.
	 * The expected binding comes from the runner, never from the delivered decision.
	 */
	consumeDecision(dir: string, decision: ApprovalDecision, expected: { requestId: string; artifactSha256: string }): { ok: true } | { ok: false; reason: string } {
		const entry = approvalIndex(dir).get(expected.requestId);
		const req = entry?.request;
		const now = Date.now();
		let reason: string | undefined;
		if (!entry) reason = "request not pending";
		else if (entry.state === "consumed") reason = "request already consumed";
		else if (entry.state !== "pending") reason = "request not pending";
		else if (decision.requestId !== req!.requestId) reason = "requestId mismatch";
		else if (decision.runId !== req!.runId || decision.runId !== this.runIdOf(dir)) reason = "runId mismatch";
		else if (decision.nodeId !== req!.nodeId) reason = "nodeId mismatch";
		else if (decision.artifactSha256 !== req!.artifactSha256) reason = "artifactSha256 mismatch";
		else if (expected.artifactSha256 !== req!.artifactSha256) reason = "stale artifact";
		else if (typeof decision.actor !== "string" || !decision.actor.trim()) reason = "empty actor";
		else if (decision.decision !== "approve" && decision.decision !== "reject") reason = "invalid decision";
		else if (typeof decision.nonce !== "string" || !decision.nonce.trim()) reason = "empty nonce";
		else if (!Number.isFinite(Date.parse(decision.decidedAt)) || !Number.isFinite(Date.parse(req!.expiresAt))) reason = "invalid timestamp";
		else if (Date.parse(decision.decidedAt) > Date.parse(req!.expiresAt) || now > Date.parse(req!.expiresAt)) reason = "approval expired";
		if (reason) {
			this.appendApproval(dir, "approval.refused", { requestId: expected.requestId, decision, reason });
			this.expireApproval(dir, expected.requestId);
			return { ok: false, reason };
		}
		this.appendApproval(dir, "approval.decided", { requestId: expected.requestId, decision });
		this.appendApproval(dir, "approval.consumed", { requestId: expected.requestId, nonce: decision.nonce, actor: decision.actor });
		return { ok: true };
	}

	private runIdOf(dir: string): string {
		return this.runIds.get(dir) ?? this.readRun(dir).runId;
	}
}

/** A notebook row before chaining. */
export interface NotebookRow {
	type: "note" | "link" | "decision";
	nodeId: string;
	[k: string]: unknown;
}

/** A hypothesis row before chaining: `link` rows carry the relation, `decision` rows the resolved id and tallies. */
export type HypothesisRelation = "supports" | "challenges" | "inconclusive" | "context";
export interface HypothesisRow {
	type: "link" | "decision";
	nodeId: string;
	hypothesis?: string | null;
	relation?: HypothesisRelation;
	evidence?: string;
	weight?: number;
	source?: string;
	rule?: string;
	tallies?: Record<string, unknown>;
	[k: string]: unknown;
}

/** Every notebook row of a run (empty when the file is absent). */
export function readNotebook(dir: string): ChainRow[] {
	return readChainOrEmpty(path.join(dir, NOTEBOOK_FILE));
}

/** Every hypothesis row of a run (empty when the file is absent). */
export function readHypothesisLinks(dir: string): ChainRow[] {
	return readChainOrEmpty(path.join(dir, HYPOTHESES_FILE));
}

function readChainOrEmpty(file: string): ChainRow[] {
	if (!fs.existsSync(file)) return [];
	return readChain(file);
}

/** Rebuilt from the verified log, not a second mutable source of truth. */
function approvalIndex(dir: string): Map<string, { request: ApprovalRequest; state: "pending" | "consumed" | "expired" }> {
	const file = path.join(dir, APPROVALS_FILE);
	const verified = verifyChain(file);
	if (!verified.ok) throw new Error(`approval chain invalid: ${verified.reason}`);
	const index = new Map<string, { request: ApprovalRequest; state: "pending" | "consumed" | "expired" }>();
	for (const row of readChain(file)) {
		const data = row.data as { request?: ApprovalRequest; requestId?: string };
		if (row.type === "approval.requested" && data.request) index.set(data.request.requestId, { request: data.request, state: "pending" });
		const entry = data.requestId ? index.get(data.requestId) : undefined;
		if (entry && row.type === "approval.consumed") entry.state = "consumed";
		if (entry && row.type === "approval.expired") entry.state = "expired";
	}
	return index;
}

/** Pending means no consumed/expired event; reading (including recovery) never expires requests. */
export function listPendingApprovals(dir: string): ApprovalRequest[] {
	return [...approvalIndex(dir).values()].filter(e => e.state === "pending").map(e => e.request);
}

/**
 * Startup only, BEFORE accepting work. The caller owns this store exclusively: "owner
 * gone" means found running at startup, not a PID probe. Never invoke against a live
 * runner's root. No resume/replay and no approval writes, including overdue requests.
 */
export function recoverInterruptedRuns(store: RunStore): RunMeta[] {
	const recovered: RunMeta[] = [];
	for (const run of store.listRuns(undefined, Number.MAX_SAFE_INTEGER)) {
		if (run.status !== "running") continue;
		const dir = store.dir(run.runId, run.projectSlug);
		store.appendEvent(dir, "run.interrupted", { reason: "found running at startup", previousStatus: "running" });
		recovered.push(store.updateRun(dir, { status: "interrupted" }));
	}
	return recovered;
}
