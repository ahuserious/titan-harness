/**
 * runner-seams.ts — the runner-side `mcpTool` and `runWorkflow` seams (LANE-3 N3-06, DESIGN §6.1-6.2).
 *
 * In titan's own host both seams are wired by the TUI extension (titan-harness.ts): mcpTool
 * spawns catalog MCP servers directly and runWorkflow opens a child run in the TUI store. A
 * hosted runner (`wf-runner`, outside every unit) may do neither:
 *
 *   createSidecarMcpTool({socketPath, routes})
 *       mcpTool over the unit's sidecar socket ONLY: one JSON-RPC `tools/call` POSTed to the
 *       fixed route `/mcp/<server>` on a unix-domain socket (sidecar CONTRACT.md). There is no
 *       URL, host, port or header input: the server name must be in the startup route list and
 *       match a plain slug, so a workflow can never name a direct upstream. No redirects are
 *       followed (a 3xx fails), the response is capped, each call has a wall-clock deadline (not
 *       just a socket inactivity timer), and a JSON-RPC error or
 *       `isError` result throws. A sidecar refusal (4xx) is deterministic: the error carries
 *       retryable:false so the node is not re-run. A tool that is not on the read-only allowlist
 *       (isReadOnlyTool) is never retried once the request may have reached the sidecar: a
 *       timeout, a transport error after connect or a 5xx leaves the write's outcome unknown, so
 *       the error carries retryable:false (one approval, at most one write).
 *
 *   validateProdV1(doc)
 *       the `prod-v1` validator profile (DESIGN §6.2): node types prompt, command, bash, script,
 *       verify (runner bash|verifier), approval, mcp_tool, cancel, workflow; no fan_out and no
 *       worktree isolation; titan.budget.max_concurrent_children ≤ 2; an mcp_tool whose name is not
 *       on the read-only allowlist may only run after an approval node SUCCEEDED (trigger rules
 *       followed through intermediate nodes; a skipped approval under all_done does not count),
 *       and runs single-attempt (no retry.max_attempts > 1, no on_fail retry; pinned to 1 at run).
 *
 *   createRunnerRunWorkflow(host)
 *       runWorkflow recursive IN THE RUNNER: the child is loaded by the runner's own loader,
 *       must itself pass prod-v1 (so a prod-v1 workflow can only call prod-v1 workflows), opens
 *       a child run in the SAME runner store (parentRunId = the calling run), executes with the
 *       caller's parentBudget and abort signal (the budget chain of budget.ts holds it to every
 *       ancestor's remainder), maxParallel 2, and gets the same recursive seam for its own
 *       `workflow:` nodes. Cycles and depth > MAX_WORKFLOW_DEPTH are refused before any run opens.
 *
 *   executeProdV1(loaded, deps, opts)   refuse a non-prod-v1 workflow, else executeWorkflow at ≤ 2
 *                                        with every non-read-only mcp_tool pinned to one attempt.
 *
 * Nothing here imports pi. The runner passes its loader and its deps factory in.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { toolResultValue } from "../mcp-client.ts";
import type { RunStore } from "../run-store.ts";
import { type ExecuteOptions, type RunResult, type RunWorkflowOptions, type WorkflowRuntimeDeps, executeWorkflow } from "./executor.ts";
import type { LoadedWorkflow } from "./loader.ts";
import { nodeType, type NodeDoc, type NodeType, type WorkflowDoc } from "./schema.ts";

// ═══ mcpTool through the unit's sidecar socket ═════════════════════════════════

export const SIDECAR_MCP_TIMEOUT_MS = 30_000;
export const SIDECAR_MCP_RESPONSE_CAP = 1_048_576;
const ROUTE_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface SidecarMcpOptions {
	/** Absolute path of the unit's sidecar unix socket (mounted into the runner for that unit alone). */
	socketPath: string;
	/** The MCP route names the unit's Plugin profile configures (`/mcp/<name>`); nothing else is callable. */
	routes: string[];
	timeoutMs?: number;
	responseCap?: number;
}

/**
 * An error from the sidecar path; `retryable: false` for a deterministic refusal, and for a
 * non-read-only tool whose request may have reached the sidecar. `maybeSent` (set by postUnix):
 * the failure came after the request may have been delivered, not while connecting.
 */
export class SidecarMcpError extends Error {
	constructor(message: string, readonly retryable: boolean, readonly status?: number, readonly code?: string, readonly maybeSent = false) {
		super(message);
		this.name = "SidecarMcpError";
	}
}

/** Connect-phase errors: they prove no byte of the request reached a listening sidecar. */
const NOT_SENT_CODES: ReadonlySet<string> = new Set(["ENOENT", "ECONNREFUSED", "EACCES", "ENOTSOCK", "EPERM", "ENOTDIR"]);

export function createSidecarMcpTool(opts: SidecarMcpOptions): NonNullable<WorkflowRuntimeDeps["mcpTool"]> {
	if (typeof opts.socketPath !== "string" || !path.isAbsolute(opts.socketPath)) throw new Error("sidecar mcpTool: socketPath must be an absolute unix socket path");
	if (!Array.isArray(opts.routes) || !opts.routes.length) throw new Error("sidecar mcpTool: routes must list at least one MCP route");
	for (const route of opts.routes) if (typeof route !== "string" || !ROUTE_SLUG.test(route)) throw new Error(`sidecar mcpTool: route ${JSON.stringify(route)} is not a plain slug`);
	const routes = new Set(opts.routes);
	const timeoutMs = opts.timeoutMs ?? SIDECAR_MCP_TIMEOUT_MS;
	const cap = opts.responseCap ?? SIDECAR_MCP_RESPONSE_CAP;
	const socketPath = opts.socketPath;
	let nextId = 1;
	return async (server, tool, args) => {
		if (typeof server !== "string" || !routes.has(server)) throw new SidecarMcpError(`mcp_tool: server ${JSON.stringify(server)} is not a sidecar route of this unit (${[...routes].join(", ")})`, false);
		if (typeof tool !== "string" || !tool.trim()) throw new SidecarMcpError("mcp_tool: tool must be a non-empty string", false);
		if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) throw new SidecarMcpError("mcp_tool: args must be an object", false);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(socketPath);
		} catch {
			throw new SidecarMcpError(`mcp_tool: sidecar socket unavailable`, true);
		}
		if (!stat.isSocket()) throw new SidecarMcpError("mcp_tool: sidecar socketPath is not a unix socket", false);
		const id = nextId++;
		const body = JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args ?? {} } });
		// Once the request may have reached the sidecar, a transient failure leaves a write's outcome
		// unknown (the upstream may already have committed it): only a read-only tool may be re-run.
		const readOnly = isReadOnlyTool(tool);
		const unknownOutcome = readOnly ? "" : "; the write may have been applied, so it is not retried";
		let reply: { status: number; text: string };
		try {
			reply = await postUnix(socketPath, `/mcp/${server}`, body, timeoutMs, cap);
		} catch (error) {
			if (error instanceof SidecarMcpError && error.retryable && error.maybeSent && !readOnly) {
				throw new SidecarMcpError(`${error.message} (${server}/${tool})${unknownOutcome}`, false, error.status, error.code, true);
			}
			throw error;
		}
		const { status, text } = reply;
		const transient = status >= 500 || status === 0;
		const outcomeNote = transient ? unknownOutcome : "";
		if (status >= 300 && status < 400) throw new SidecarMcpError(`mcp_tool ${server}/${tool}: sidecar answered a redirect (${status}); refused`, false, status);
		let parsed: any;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new SidecarMcpError(`mcp_tool ${server}/${tool}: sidecar returned invalid JSON (HTTP ${status})${outcomeNote}`, transient && readOnly, status);
		}
		if (parsed && typeof parsed === "object" && parsed.error) {
			const code = typeof parsed.error?.data?.code === "string" ? parsed.error.data.code : typeof parsed.error?.code === "string" ? parsed.error.code : undefined;
			const message = typeof parsed.error?.message === "string" ? parsed.error.message : "error";
			throw new SidecarMcpError(`mcp_tool ${server}/${tool}: ${code ?? `HTTP ${status}`}: ${message}${outcomeNote}`, transient && readOnly, status, code);
		}
		if (status < 200 || status >= 300) throw new SidecarMcpError(`mcp_tool ${server}/${tool}: sidecar HTTP ${status}${outcomeNote}`, transient && readOnly, status);
		if (!parsed || typeof parsed !== "object" || parsed.id !== id || !parsed.result || typeof parsed.result !== "object") throw new SidecarMcpError(`mcp_tool ${server}/${tool}: sidecar returned no JSON-RPC result for id ${id}`, false, status);
		const result = { content: parsed.result.content, isError: parsed.result.isError === true, structured: parsed.result.structuredContent };
		if (result.isError) {
			const value = toolResultValue(result);
			throw new SidecarMcpError(`mcp_tool ${server}/${tool} returned an error: ${typeof value === "string" ? value : JSON.stringify(value)}`, false, status);
		}
		return toolResultValue(result);
	};
}

function postUnix(socketPath: string, route: string, body: string, timeoutMs: number, cap: number): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		let settled = false;
		// A wall-clock deadline for the whole call (connect → last byte). The socket `timeout`
		// below is only an inactivity timer: a sidecar that trickles bytes would reset it forever.
		let deadline: ReturnType<typeof setTimeout> | undefined;
		const settle = () => {
			settled = true;
			if (deadline !== undefined) clearTimeout(deadline);
			deadline = undefined;
		};
		const fail = (error: Error) => {
			if (settled) return;
			settle();
			reject(error);
		};
		const req = http.request(
			{ socketPath, path: route, method: "POST", headers: { host: "sidecar", "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: timeoutMs },
			(res) => {
				const chunks: Buffer[] = [];
				let size = 0;
				res.on("data", (chunk: Buffer) => {
					if (settled) return;
					size += chunk.length;
					if (size > cap) {
						fail(new SidecarMcpError(`mcp_tool: sidecar response exceeds ${cap} bytes`, false, res.statusCode));
						req.destroy();
						return;
					}
					chunks.push(chunk);
				});
				res.on("end", () => {
					if (settled) return;
					settle();
					resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
				});
				res.on("error", (error) => fail(new SidecarMcpError(`mcp_tool: sidecar response failed: ${error.message}`, true, res.statusCode, undefined, true)));
			},
		);
		// A timeout or a transport error may come after the sidecar received the body (maybeSent);
		// only a connect-phase error (NOT_SENT_CODES) proves nothing was delivered.
		deadline = setTimeout(() => {
			fail(new SidecarMcpError(`mcp_tool: sidecar timed out after ${timeoutMs} ms`, true, undefined, undefined, true));
			req.destroy();
		}, timeoutMs);
		req.on("timeout", () => {
			fail(new SidecarMcpError(`mcp_tool: sidecar timed out after ${timeoutMs} ms`, true, undefined, undefined, true));
			req.destroy();
		});
		req.on("error", (error) => {
			const code = (error as NodeJS.ErrnoException).code;
			fail(new SidecarMcpError(`mcp_tool: sidecar request failed: ${error.message}`, true, undefined, undefined, !(typeof code === "string" && NOT_SENT_CODES.has(code))));
		});
		req.end(body);
	});
}

// ═══ The prod-v1 validator profile ═════════════════════════════════════════════

export const PROD_V1_NODE_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(["prompt", "command", "bash", "script", "verify", "approval", "mcp_tool", "cancel", "workflow"]);
export const PROD_V1_VERIFY_RUNNERS: ReadonlySet<string> = new Set(["bash", "verifier"]);
export const PROD_V1_MAX_PARALLEL = 2;
export const MAX_WORKFLOW_DEPTH = 4;
/**
 * Read verbs: a tool is read-only only if the FIRST word of its name is one of these (and nothing
 * below vetoes it). A read word later in the name counts for nothing (`clear_list`,
 * `increment_count`). `count` is deliberately absent: `count_*` stays gated.
 */
export const READ_ONLY_VERBS: ReadonlySet<string> = new Set(["get", "list", "search", "read", "query", "describe", "fetch"]);
/** Effect verbs: any of them as a word of the name vetoes the allowlist (`get_or_create_contact`, `search_and_update`). */
const EFFECT_VERBS: ReadonlySet<string> = new Set([
	"create", "update", "delete", "upsert", "insert", "write", "send", "post", "put", "patch", "merge", "remove", "add", "set", "convert", "promote", "publish", "trash", "untrash", "mark", "unmark",
	"label", "unlabel", "apply", "delink", "link", "unlink", "assign", "move", "import", "reveal", "run", "submit", "cancel", "archive", "restore", "edit", "modify", "save", "execute", "exec",
	"refund", "charge", "transfer", "pay", "payout", "approve", "reject", "close", "upload", "rename", "drop", "share", "invite", "grant", "revoke", "void", "capture", "deploy", "invoke", "trigger",
	"kill", "reset", "purge", "destroy", "wipe", "erase", "commit", "push", "sync", "enable", "disable", "subscribe", "unsubscribe", "buy", "sell", "withdraw", "deposit", "notify", "forward",
	"replace", "append", "attach", "detach", "untag", "invalidate", "rollback", "revert", "migrate", "provision", "terminate", "suspend", "resume", "enroll", "dispatch", "finalize", "accept",
]);
/** Effect roots that also veto from inside a word, for run-together names (`bulkupdate`, `getandsend`). */
const EFFECT_ROOTS: readonly string[] = [
	"create", "update", "delete", "upsert", "insert", "write", "send", "remove", "merge", "patch", "publish", "refund", "charge", "transfer", "modify", "execute", "upload", "rename", "destroy",
	"purge", "archive", "restore", "submit", "approve", "revoke", "grant", "invite", "withdraw", "deposit", "trigger", "deploy",
];
/** Words that join two actions in one name: the second action is unknown, so the allowlist does not apply. */
const JOIN_WORDS: ReadonlySet<string> = new Set(["and", "or", "then", "also"]);

/** A tool name the allowlist will classify: ASCII letters/digits separated only by `_`, `-` or `.`, starting with a letter. */
const CLASSIFIABLE_TOOL = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/** The lower-case words of a tool name: split on `_`, `-`, `.` and camelCase (acronyms included). */
function toolWords(tool: string): string[] {
	return tool
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.toLowerCase()
		.split(/[_.-]+/)
		.filter(Boolean);
}

/**
 * The prod-v1 read-only allowlist. True only for a name whose LEADING verb is a read verb
 * (get_record, listItems, search_docs) and in which no later word is an effect verb or a join word
 * and no later word contains an effect root (list_delete, getAndDelete, get_or_create_contact).
 * Position counts: a read word anywhere but first does not make a name read-only, so clear_list,
 * increment_count, reset_read_marker and web_search_exa are all NOT read-only. A name with any
 * character outside [A-Za-z0-9_.-] is not classified and is NOT read-only either. Everything that
 * is not read-only needs a succeeded approval under prod-v1 and runs single-attempt; a false
 * negative only costs an approval.
 */
export function isReadOnlyTool(tool: unknown): boolean {
	if (typeof tool !== "string" || !CLASSIFIABLE_TOOL.test(tool)) return false;
	const words = toolWords(tool);
	if (!words.length || !READ_ONLY_VERBS.has(words[0])) return false;
	return !words.slice(1).some((word) => JOIN_WORDS.has(word) || EFFECT_VERBS.has(word) || (!READ_ONLY_VERBS.has(word) && EFFECT_ROOTS.some((root) => word.includes(root))));
}

export interface ProfileIssue {
	nodeId?: string;
	message: string;
}

/** The prod-v1 profile's findings for `doc` (empty = allowed). */
export function validateProdV1(doc: WorkflowDoc): ProfileIssue[] {
	const issues: ProfileIssue[] = [];
	const nodes: NodeDoc[] = Array.isArray(doc?.nodes) ? doc.nodes : [];
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const cap = doc?.titan?.budget?.max_concurrent_children;
	if (cap !== undefined && !(Number.isInteger(cap) && cap >= 1 && cap <= PROD_V1_MAX_PARALLEL)) issues.push({ message: `titan.budget.max_concurrent_children must be 1..${PROD_V1_MAX_PARALLEL} under prod-v1; found ${JSON.stringify(cap)}` });
	// gated(n): "n succeeded ⇒ some approval node succeeded" (a human approved) under the
	// scheduler's trigger rules (scheduler.ts readiness). An approval's success is itself a human
	// approval; any other node succeeds only if it ran, so gated(n) = mustRunAfterApproval(n).
	// mustRunAfterApproval(n), the node may only start once an approval succeeded:
	//   all_success                          any dep gated (every dep must have succeeded)
	//   one_success / none_failed_min_one_success   every dep gated (which dep succeeded is unknown)
	//   all_done (or an unknown rule)        never (every dep may be skipped or failed, e.g. an
	//                                        approval skipped by `when:`)
	// `when:` only ever skips, so it never weakens the guarantee. A missing dep or a cycle is not gated.
	const gatedMemo = new Map<string, boolean>();
	const mustRunAfterApproval = (node: NodeDoc): boolean => {
		const deps = Array.isArray(node.depends_on) ? node.depends_on : [];
		if (!deps.length) return false;
		const rule = node.trigger_rule ?? "all_success";
		if (rule === "all_success") return deps.some(gated);
		if (rule === "one_success" || rule === "none_failed_min_one_success") return deps.every(gated);
		return false;
	};
	const gated = (id: string): boolean => {
		const memo = gatedMemo.get(id);
		if (memo !== undefined) return memo;
		gatedMemo.set(id, false); // cycle guard: in progress counts as not gated
		const dep = byId.get(id);
		const value = !!dep && (nodeType(dep) === "approval" || mustRunAfterApproval(dep));
		gatedMemo.set(id, value);
		return value;
	};
	for (const node of nodes) {
		const type = nodeType(node);
		if (!type || !PROD_V1_NODE_TYPES.has(type)) {
			issues.push({ nodeId: node?.id, message: `node type ${type ?? "unknown"} is not allowed under prod-v1` });
			continue;
		}
		if (node.isolation !== undefined && node.isolation !== "none") issues.push({ nodeId: node.id, message: `isolation must be none under prod-v1 (the unit is the isolation)` });
		const record = node as unknown as Record<string, any>;
		if (type === "verify" && !PROD_V1_VERIFY_RUNNERS.has(String(record.verify?.runner))) issues.push({ nodeId: node.id, message: `verify runner ${JSON.stringify(record.verify?.runner)} is not allowed under prod-v1 (bash or verifier)` });
		if (type === "workflow") {
			if (record.workflow?.fan_out !== undefined) issues.push({ nodeId: node.id, message: `workflow.fan_out is not allowed under prod-v1 (no dynamic fan-out)` });
			if (record.workflow?.isolation !== undefined) issues.push({ nodeId: node.id, message: `workflow.isolation is not allowed under prod-v1` });
		}
		if (type === "mcp_tool" && !isReadOnlyTool(record.mcp_tool?.tool)) {
			const tool = JSON.stringify(record.mcp_tool?.tool);
			if (!mustRunAfterApproval(node)) {
				issues.push({ nodeId: node.id, message: `mcp_tool ${tool} is not on the read-only allowlist, so it must depend on an approval node that must succeed before it runs under prod-v1 (every path through all_success, or all deps of one_success/none_failed_min_one_success; never all_done)` });
			}
			// One approval, at most one call: a retry after an unknown outcome could apply the write twice.
			if ((node.retry?.max_attempts ?? 1) > 1 || node.on_fail?.action === "retry") {
				issues.push({ nodeId: node.id, message: `mcp_tool ${tool} is not on the read-only allowlist, so it runs single-attempt under prod-v1 (no retry.max_attempts > 1, no on_fail retry)` });
			}
		}
	}
	return issues;
}

export class ProfileError extends Error {
	constructor(readonly workflow: string, readonly issues: ProfileIssue[]) {
		super(`workflow ${workflow} is not prod-v1: ${issues.map((i) => (i.nodeId ? `${i.nodeId}: ${i.message}` : i.message)).join("; ")}`);
		this.name = "ProfileError";
	}
}

export function assertProdV1(loaded: Pick<LoadedWorkflow, "name" | "normalized">): void {
	const issues = validateProdV1(loaded.normalized);
	if (issues.length) throw new ProfileError(loaded.name, issues);
}

/**
 * The workflow as prod-v1 executes it: every mcp_tool that is not read-only gets
 * retry.max_attempts 1, so the executor's default of 2 attempts can never re-send an approved
 * write (the validator already refuses an explicit retry on such a node).
 */
export function pinProdV1Attempts(loaded: LoadedWorkflow): LoadedWorkflow {
	const doc = loaded.normalized ?? loaded.doc;
	if (!doc || !Array.isArray(doc.nodes)) return loaded;
	const nodes = doc.nodes.map((node) => {
		if (nodeType(node) !== "mcp_tool" || isReadOnlyTool((node as unknown as Record<string, any>).mcp_tool?.tool)) return node;
		return { ...node, retry: { ...(node.retry ?? {}), max_attempts: 1 } } as NodeDoc;
	});
	return { ...loaded, normalized: { ...doc, nodes } };
}

/** Refuse a non-prod-v1 workflow; otherwise execute it with at most PROD_V1_MAX_PARALLEL nodes at once. */
export function executeProdV1(loaded: LoadedWorkflow, deps: WorkflowRuntimeDeps, opts: ExecuteOptions = {}): Promise<RunResult> {
	assertProdV1(loaded);
	return executeWorkflow(pinProdV1Attempts(loaded), deps, { ...opts, maxParallel: Math.min(opts.maxParallel ?? PROD_V1_MAX_PARALLEL, PROD_V1_MAX_PARALLEL) });
}

// ═══ runWorkflow, recursive in the runner ══════════════════════════════════════

export interface RunnerWorkflowHost {
	/** The runner's store (openRunnerStore); every child run opens here. */
	store: RunStore;
	cwd: string;
	projectSlug: string;
	/** The runner's loader: a workflow by name from the runner's own roots (never from the unit). */
	load(name: string): LoadedWorkflow;
	/** Deps for one run; `runWorkflow` is the recursive seam this module built for that run. */
	makeDeps(args: { loaded: LoadedWorkflow; runId: string; runDir: string; runWorkflow: NonNullable<WorkflowRuntimeDeps["runWorkflow"]> }): WorkflowRuntimeDeps;
	maxDepth?: number;
}

/**
 * The runWorkflow seam for the run `parent` (runId + its ancestor workflow names, outermost
 * first). A child that fails to load or fails prod-v1 comes back as a failed RunResult (no run
 * opened, RunResult.notStarted set), which fails the calling node without retries.
 */
export function createRunnerRunWorkflow(host: RunnerWorkflowHost, parent: { runId: string; chain: string[] }): NonNullable<WorkflowRuntimeDeps["runWorkflow"]> {
	const maxDepth = host.maxDepth ?? MAX_WORKFLOW_DEPTH;
	return async (name: string, inputs: Record<string, unknown>, opts?: RunWorkflowOptions): Promise<RunResult> => {
		const refuse = (error: string): RunResult => ({ runId: "", status: "failed", nodes: {}, error, notStarted: error });
		if (parent.chain.includes(name)) return refuse(`runWorkflow: ${name} would recurse (${[...parent.chain, name].join(" → ")})`);
		if (parent.chain.length >= maxDepth) return refuse(`runWorkflow: nesting depth ${parent.chain.length + 1} exceeds ${maxDepth}`);
		let child: LoadedWorkflow;
		try {
			child = host.load(name);
			assertProdV1(child);
		} catch (error) {
			return refuse(`runWorkflow: ${error instanceof Error ? error.message : String(error)}`);
		}
		const opened = host.store.open({ projectSlug: host.projectSlug, cwd: host.cwd, command: "workflow", workflow: { name: child.name, sha256: child.sha256 }, parentRunId: parent.runId, status: "running" });
		const runWorkflow = createRunnerRunWorkflow(host, { runId: opened.runId, chain: [...parent.chain, child.name] });
		const deps = host.makeDeps({ loaded: child, runId: opened.runId, runDir: opened.dir, runWorkflow });
		return executeWorkflow(pinProdV1Attempts(child), deps, { inputs, parentBudget: opts?.parentBudget, signal: opts?.signal, maxParallel: PROD_V1_MAX_PARALLEL });
	};
}
