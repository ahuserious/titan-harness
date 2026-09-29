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
 *
 * Hosted (web) approvals need a RUNNER store: `openRunnerStore(root)` takes the exclusive
 * `<root>/runner.lock` (written complete, linked no-replace; pid + process start time; a
 * dead holder's lock is taken over only after byte-for-byte revalidation), refuses DEFAULT_RUN_ROOT (the TUI's shared root), runs recoverInterruptedRuns once
 * and registers the store; `assertRunnerStore` is what the hosted approval path checks.
 */
import { randomBytes, randomUUID } from "node:crypto";
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

	/** Only the runner clock can expire a pending request; a future-dated forged reply cannot. Fenced like consumeDecision. */
	expireApproval(dir: string, requestId: string): boolean {
		if (runnerFence(this, dir)) return false;
		const entry = approvalIndex(dir).get(requestId);
		if (!entry || entry.state !== "pending" || Date.now() <= Date.parse(entry.request.expiresAt)) return false;
		this.appendApproval(dir, "approval.expired", { requestId });
		return true;
	}

	/**
	 * Synchronous read/check/append (no await or user callback): atomic between consumers on
	 * the same JS event loop, including separate RunStore instances. Cross-process/worker
	 * access requires the existing SINGLE WRITER per run directory contract; no file lock.
	 * The expected binding comes from the runner, never from the delivered decision:
	 * `artifactSha256` is the runner's re-read of the releasable content and `actorAuthorized`
	 * is the runner's host-policy verdict for the snapshot's actor (anything but `true` refuses).
	 * The delivered decision is snapshotted once; checks, the log and the return use that copy.
	 * The MAX_APPROVAL_REFUSALS-th refusal of a pending request expires it (fail closed).
	 *
	 * Ownership fence, checked first on every call (re-reading the lock file and run.json):
	 * only a store from openRunnerStore whose lock file still carries its token may consume
	 * (else `runner_not_owner`: nothing is written, since a non-owner must not write the
	 * owner's authoritative log), and only while the run is `running` (else `run_not_running`:
	 * recorded as a refusal, never counted toward the refusal cap, request left pending).
	 */
	consumeDecision(dir: string, delivered: unknown, expected: { requestId: string; artifactSha256: string; actorAuthorized?: boolean }): { ok: true; decision: ApprovalDecision } | { ok: false; reason: string } {
		const fenced = runnerFence(this, dir);
		if (fenced === "runner_not_owner") return { ok: false, reason: fenced };
		if (fenced) {
			const snap = snapshotDecision(delivered);
			this.appendApproval(dir, "approval.refused", { requestId: expected.requestId, ...(snap.ok ? { decision: snap.decision } : {}), reason: fenced });
			return { ok: false, reason: fenced };
		}
		const index = approvalIndex(dir);
		const entry = index.get(expected.requestId);
		const req = entry?.request;
		const now = Date.now();
		const snap = snapshotDecision(delivered);
		const decision = snap.ok ? snap.decision : undefined;
		let reason: string | undefined;
		if (!entry) reason = "request not pending";
		else if (entry.state === "consumed") reason = "request already consumed";
		else if (entry.state !== "pending") reason = "request not pending";
		else if (entry.decided) reason = "request already decided"; // crash or truncation after decided: never decide twice
		else if (!snap.ok) reason = snap.reason;
		else if (decision!.requestId !== req!.requestId) reason = "requestId mismatch";
		else if (decision!.runId !== req!.runId || decision!.runId !== this.runIdOf(dir)) reason = "runId mismatch";
		else if (decision!.nodeId !== req!.nodeId) reason = "nodeId mismatch";
		else if (decision!.artifactSha256 !== req!.artifactSha256) reason = "artifactSha256 mismatch";
		else if (expected.artifactSha256 !== req!.artifactSha256) reason = "stale artifact";
		else if (!decision!.actor.trim()) reason = "empty actor";
		else if (decision!.decision !== "approve" && decision!.decision !== "reject") reason = "invalid decision";
		else if (!decision!.nonce.trim()) reason = "empty nonce";
		else if (!Number.isFinite(Date.parse(decision!.decidedAt)) || !Number.isFinite(Date.parse(req!.expiresAt))) reason = "invalid timestamp";
		else if (Date.parse(decision!.decidedAt) > Date.parse(req!.expiresAt) || now > Date.parse(req!.expiresAt)) reason = "approval expired";
		else if (req!.actorPolicy?.allowedActors && !req!.actorPolicy.allowedActors.includes(decision!.actor)) reason = "actor_not_authorized";
		else if (expected.actorAuthorized !== true) reason = "actor_not_authorized";
		if (reason) {
			this.appendApproval(dir, "approval.refused", { requestId: expected.requestId, ...(decision ? { decision } : {}), reason });
			if (entry?.state === "pending" && entry.refusals + 1 >= MAX_APPROVAL_REFUSALS) {
				this.appendApproval(dir, "approval.expired", { requestId: expected.requestId, reason: "refusal limit" });
			} else if (entry?.state === "pending") this.expireApproval(dir, expected.requestId);
			return { ok: false, reason };
		}
		this.appendApproval(dir, "approval.decided", { requestId: expected.requestId, decision });
		this.appendApproval(dir, "approval.consumed", { requestId: expected.requestId, nonce: decision!.nonce, actor: decision!.actor });
		return { ok: true, decision: decision! };
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

/** Refusals a single request tolerates before the runner expires it (bounds log growth and waiting). */
export const MAX_APPROVAL_REFUSALS = 20;
/** Largest delivered `response` the runner accepts (UTF-8 bytes); larger is refused, not truncated. */
export const MAX_APPROVAL_RESPONSE_BYTES = 64 * 1024;

/**
 * One explicit copy of a delivered decision: every field is read exactly once and must be a
 * string (`response`: string or absent). Non-objects, arrays and throwing getters are malformed.
 * Checks, the audit log and the node's outcome all use this copy, never the delivered object.
 */
export function snapshotDecision(value: unknown): { ok: true; decision: ApprovalDecision } | { ok: false; reason: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "malformed decision" };
	let copy: Record<string, unknown>;
	try {
		const v = value as Record<string, unknown>;
		copy = { requestId: v.requestId, runId: v.runId, nodeId: v.nodeId, artifactSha256: v.artifactSha256, actor: v.actor, decision: v.decision, response: v.response, decidedAt: v.decidedAt, nonce: v.nonce };
	} catch {
		return { ok: false, reason: "malformed decision" };
	}
	for (const key of ["requestId", "runId", "nodeId", "artifactSha256", "actor", "decision", "decidedAt", "nonce"]) {
		if (typeof copy[key] !== "string") return { ok: false, reason: "malformed decision" };
	}
	if (copy.response !== undefined && typeof copy.response !== "string") return { ok: false, reason: "malformed decision" };
	if (typeof copy.response === "string" && Buffer.byteLength(copy.response, "utf8") > MAX_APPROVAL_RESPONSE_BYTES) return { ok: false, reason: "response too large" };
	if (copy.response === undefined) delete copy.response;
	return { ok: true, decision: copy as unknown as ApprovalDecision };
}

interface ApprovalEntry {
	request: ApprovalRequest;
	state: "pending" | "consumed" | "expired";
	/** The last decided snapshot; the consumed decision once state is "consumed". */
	decided?: ApprovalDecision;
	refusals: number;
}

/**
 * Rebuilt from the verified log, not a second mutable source of truth. Lifecycle rules are
 * part of validity: a duplicate `approval.requested`, a decided/consumed/expired row for an
 * unknown or non-pending request, a second decided row, a consumed row without a decided row, or an unknown row
 * type makes the chain invalid and every approval operation throws (fail closed).
 * `approval.refused` rows never change state, so they may name any request.
 */
function approvalIndex(dir: string): Map<string, ApprovalEntry> {
	const file = path.join(dir, APPROVALS_FILE);
	const verified = verifyChain(file);
	if (!verified.ok) throw new Error(`approval chain invalid: ${verified.reason}`);
	const index = new Map<string, ApprovalEntry>();
	const invalid = (row: ChainRow, why: string): never => { throw new Error(`approval chain invalid: seq ${row.seq} ${why}`); };
	for (const row of readChain(file)) {
		const data = (row.data ?? {}) as { request?: ApprovalRequest; requestId?: string; decision?: ApprovalDecision };
		if (row.type === "approval.requested") {
			const id = data.request?.requestId;
			if (typeof id !== "string" || !id) invalid(row, "request without requestId");
			if (index.has(id!)) invalid(row, `duplicate request ${id}`);
			index.set(id!, { request: data.request!, state: "pending", refusals: 0 });
			continue;
		}
		const entry = typeof data.requestId === "string" ? index.get(data.requestId) : undefined;
		if (row.type === "approval.refused") {
			if (entry && (row.data as { reason?: unknown } | undefined)?.reason !== "run_not_running") entry.refusals++;
			continue;
		}
		if (row.type !== "approval.decided" && row.type !== "approval.consumed" && row.type !== "approval.expired") invalid(row, `unknown row type ${String(row.type)}`);
		if (!entry) invalid(row, `${String(row.type)} for unknown request`);
		if (entry!.state !== "pending") invalid(row, `${String(row.type)} for ${entry!.state} request`);
		if (row.type === "approval.decided") {
			if (entry!.decided) invalid(row, "second decision for one request");
			entry!.decided = data.decision;
		}
		else if (row.type === "approval.consumed") {
			if (!entry!.decided) invalid(row, "consumed without a decision");
			entry!.state = "consumed";
		} else entry!.state = "expired";
	}
	return index;
}

/** Pending means no consumed/expired event; reading (including recovery) never expires requests. */
export function listPendingApprovals(dir: string): ApprovalRequest[] {
	return [...approvalIndex(dir).values()].filter(e => e.state === "pending").map(e => e.request);
}

/**
 * The hosted preset tally, from the runner's approvals.jsonl only: DISTINCT actors among
 * consumed approve decisions of this run whose request carried `presetKey` and was bound to
 * `contentSha256`. Receipt files and reviewer names typed into responses never count.
 */
export function tallyPresetApprovals(dir: string, presetKey: string, contentSha256: string): { approve: number; reject: number; reviewers: string[] } {
	const reviewers: string[] = [];
	let reject = 0;
	for (const entry of approvalIndex(dir).values()) {
		if (entry.state !== "consumed" || !entry.decided || entry.request.presetKey !== presetKey || entry.request.artifactSha256 !== contentSha256) continue;
		if (entry.decided.decision === "reject") reject++;
		else if (entry.decided.decision === "approve" && !reviewers.includes(entry.decided.actor)) reviewers.push(entry.decided.actor);
	}
	return { approve: reviewers.length, reject, reviewers };
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

// ═══ Runner store: exclusive root + startup recovery ═══════════════════════════

export const RUNNER_LOCK_FILE = "runner.lock";

interface RunnerLockBody {
	pid: number;
	/** /proc/<pid>/stat starttime (clock ticks since boot); absent off Linux. Detects pid reuse. */
	procStart?: string;
	token: string;
	acquiredAt: string;
}

/** A RunStore whose root this process holds exclusively (see openRunnerStore). */
export interface RunnerStore extends RunStore {
	readonly lockPath: string;
	/** Runs found `running` at open and marked `interrupted`. */
	readonly recovered: RunMeta[];
	/** Drop the lock (only if it is still ours) and unregister the store. */
	release(): void;
}

const runnerStores = new WeakMap<RunStore, { lockPath: string; token: string }>();

function procStartOf(pid: number): string | undefined {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || undefined;
	} catch {
		return undefined;
	}
}

function lockHolderAlive(body: Partial<RunnerLockBody> | undefined): boolean {
	const pid = Number(body?.pid);
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
	}
	// Same pid, different process start → the pid was reused; the recorded holder is gone.
	const now = procStartOf(pid);
	return !(body?.procStart && now && body.procStart !== now);
}

function parseLockBody(raw: string): Partial<RunnerLockBody> | undefined {
	try {
		const body = JSON.parse(raw);
		return body && typeof body === "object" && typeof body.token === "string" && body.token ? body : undefined;
	} catch {
		return undefined;
	}
}

function readLockBody(file: string): Partial<RunnerLockBody> | undefined {
	try {
		return parseLockBody(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/** An unparsable (e.g. empty, torn) lock is treated as LIVE until its mtime is this old. */
export const RUNNER_LOCK_UNPARSABLE_GRACE_MS = 30_000;

/** Test-only pauses between takeover steps (deterministic race tests). */
export interface RunnerLockTestHooks {
	/** After the existing lock was read and judged stale, before it is renamed aside. */
	beforeRename?(lockPath: string): void;
	/** After the rename, before the renamed file is re-read and compared. */
	afterRename?(lockPath: string, aside: string): void;
}

/**
 * Create `lockPath` holding `content` without ever exposing an empty or partial lock:
 * write + fsync a unique temp file, then link() it into place (fails with EEXIST instead of
 * replacing). Returns false when a lock already exists.
 */
function createLockNoReplace(lockPath: string, content: string): boolean {
	const tmp = `${lockPath}.tmp.${process.pid}.${randomUUID()}`;
	const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
	try {
		const buf = Buffer.from(content, "utf8");
		for (let off = 0; off < buf.length; ) off += fs.writeSync(fd, buf, off, buf.length - off);
		fs.fsyncSync(fd);
	} catch (error) {
		try { fs.closeSync(fd); } catch {}
		try { fs.unlinkSync(tmp); } catch {}
		throw error;
	}
	fs.closeSync(fd);
	try {
		fs.linkSync(tmp, lockPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally {
		try { fs.unlinkSync(tmp); } catch {}
	}
	const dir = fs.openSync(path.dirname(lockPath), "r");
	try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
	return true;
}

/**
 * The ownership fence: undefined when `store` is a live runner store (registered, and its
 * lock FILE, re-read now, carries its token), `dir` is inside its root and run.json says
 * `running`. Never trusts in-memory state for the lock.
 */
export function runnerFence(store: RunStore, dir: string): "runner_not_owner" | "run_not_running" | undefined {
	const held = runnerStores.get(store);
	if (!held || readLockBody(held.lockPath)?.token !== held.token || !nested(store.root, path.resolve(dir))) return "runner_not_owner";
	try {
		return store.readRun(dir).status === "running" ? undefined : "run_not_running";
	} catch {
		return "run_not_running";
	}
}

function realish(p: string): string {
	try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

function nested(a: string, b: string): boolean {
	const rel = path.relative(a, b);
	// "..runner" is a child named "..runner", not a parent: only ".." or "../…" leaves `a`.
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Open the runner's own store: refuse DEFAULT_RUN_ROOT (and any root nested in or around
 * it), take `<root>/runner.lock`, then run recoverInterruptedRuns exactly once.
 * The lock is created complete (temp file + link(), never replace), so it is never seen
 * empty. Takeover reads and parses the lock; only when its holder pid is dead (or reused,
 * by /proc start time) is it renamed aside, and the renamed file must be byte-identical to
 * what was judged stale, else it is linked back and the open refused. An unparsable lock
 * is live until RUNNER_LOCK_UNPARSABLE_GRACE_MS old. A live holder, including this same
 * process, is refused. The hosted approval path accepts only stores returned here
 * (assertRunnerStore); after release/loss of the lock the store also refuses updateRun.
 */
export function openRunnerStore(root: string, opts: { defaultRoot?: string; _testHooks?: RunnerLockTestHooks } = {}): RunnerStore {
	const resolved = path.resolve(root);
	const shared = realish(opts.defaultRoot ?? DEFAULT_RUN_ROOT);
	const refuse = (real: string) => {
		if (nested(real, shared) || nested(shared, real)) throw new Error(`openRunnerStore: refusing the shared TUI run root ${shared}; give the runner its own root`);
	};
	refuse(realish(resolved)); // before creating anything
	fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
	refuse(realish(resolved)); // and again once symlinks resolve
	const lockPath = path.join(resolved, RUNNER_LOCK_FILE);
	const body: RunnerLockBody = { pid: process.pid, procStart: procStartOf(process.pid), token: randomUUID(), acquiredAt: new Date().toISOString() };
	const hooks = opts._testHooks;
	let acquired = false;
	for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
		if (createLockNoReplace(lockPath, `${JSON.stringify(body)}\n`)) {
			acquired = true;
			break;
		}
		// Takeover: only a lock whose exact bytes we read and judged stale may be moved aside.
		let raw: Buffer;
		let mtimeMs: number;
		try {
			raw = fs.readFileSync(lockPath);
			mtimeMs = fs.statSync(lockPath).mtimeMs;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // released meanwhile; try to create again
			throw error;
		}
		const holder = parseLockBody(raw.toString("utf8"));
		if (!holder && Date.now() - mtimeMs < RUNNER_LOCK_UNPARSABLE_GRACE_MS) throw new Error(`openRunnerStore: ${resolved} has an unreadable runner.lock (treated as live for ${RUNNER_LOCK_UNPARSABLE_GRACE_MS / 1000}s)`);
		if (holder && lockHolderAlive(holder)) throw new Error(`openRunnerStore: ${resolved} is locked by live runner pid ${holder.pid}`);
		hooks?.beforeRename?.(lockPath);
		const aside = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
		try {
			fs.renameSync(lockPath, aside);
		} catch (renameError) {
			if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw renameError;
		}
		hooks?.afterRename?.(lockPath, aside);
		let moved: Buffer | undefined;
		try { moved = fs.readFileSync(aside); } catch {}
		if (!moved || !moved.equals(raw)) {
			// We moved a lock other than the one judged stale (a live runner replaced it): put it
			// back without replacing anything and refuse. If another lock already took its place,
			// leave the moved file aside; its holder's fence (lock token re-read) now refuses it.
			let restored = false;
			if (moved) {
				try { fs.linkSync(aside, lockPath); restored = true; } catch {}
				if (restored) try { fs.unlinkSync(aside); } catch {}
			}
			throw new Error(`openRunnerStore: ${resolved} was taken by another runner during stale-lock takeover${restored ? "" : ` (displaced lock kept at ${aside})`}`);
		}
		fs.unlinkSync(aside);
	}
	if (!acquired) throw new Error(`openRunnerStore: could not lock ${resolved}`);
	if (readLockBody(lockPath)?.token !== body.token) throw new Error(`openRunnerStore: lost ${lockPath} while acquiring it`);
	const store = new RunStore(resolved) as RunnerStore;
	let recovered: RunMeta[];
	try {
		recovered = recoverInterruptedRuns(store);
	} catch (error) {
		try { if (readLockBody(lockPath)?.token === body.token) fs.unlinkSync(lockPath); } catch {}
		throw error;
	}
	runnerStores.set(store, { lockPath, token: body.token });
	// A runner that lost its lock must not rewrite run.json (e.g. flip the new owner's
	// `interrupted` back to cancelled/completed). The executor's patchRun reports the throw.
	const updateRun = store.updateRun.bind(store);
	Object.defineProperties(store, {
		updateRun: {
			value: (dir: string, patch: Partial<RunMeta>): RunMeta => {
				const held = runnerStores.get(store);
				if (!held || readLockBody(held.lockPath)?.token !== held.token) throw new Error(`runner store ${resolved} no longer holds ${lockPath}; refusing to update run.json`);
				return updateRun(dir, patch);
			},
		},
		lockPath: { value: lockPath, enumerable: true },
		recovered: { value: recovered, enumerable: true },
		release: {
			value: () => {
				runnerStores.delete(store);
				try { if (readLockBody(lockPath)?.token === body.token) fs.unlinkSync(lockPath); } catch {}
			},
		},
	});
	return store;
}

/**
 * Defence-in-depth only (NOT the isolation fix): refuse a runner store root that is inside,
 * or contains, the workflow working directory, where agent/bash nodes write by default.
 * Children still learn the run dir (TITAN_RUN_DIR / ARTIFACTS_DIR); see the docs' known limitation.
 */
export function assertRunnerRootOutside(store: RunStore, workdir: string): void {
	const root = realish(store.root);
	const cwd = realish(workdir);
	if (nested(root, cwd) || nested(cwd, root)) throw new Error(`hosted approvals: runner store root ${root} overlaps the workflow cwd ${cwd}; put the runner root outside every agent-writable path`);
}

/** Throws unless `store` came from openRunnerStore in this process and still holds its lock; `runDir`, when given, must be inside its root. */
export function assertRunnerStore(store: RunStore, runDir?: string): void {
	const held = runnerStores.get(store);
	if (!held) throw new Error("hosted approvals require a runner store opened with openRunnerStore(root) (exclusive lock + startup recovery)");
	if (readLockBody(held.lockPath)?.token !== held.token) throw new Error(`hosted approvals: runner lock ${held.lockPath} is no longer held by this store`);
	if (runDir !== undefined && !nested(store.root, path.resolve(runDir))) throw new Error(`hosted approvals: run directory ${runDir} is outside the runner store root ${store.root}`);
}
