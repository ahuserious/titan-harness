/**
 * executor.ts — the workflow engine (plan D1, §3, §5.3, P3): walks a validated
 * WorkflowDoc layer by layer, runs the ready nodes of a layer concurrently (≤ maxParallel),
 * routes with `when` + trigger rules, retries, applies `on_fail`, hands artifacts from node
 * to node through `$id.output` / `$ARTIFACTS_DIR`, and records everything in the run store:
 *
 *   events.jsonl     workflow.start/end, phase.start, node.start/end, agent.start/end, elevation.report
 *   ledger.jsonl     one row per agent call (origin "run", or the reviewer roles' own origins)
 *   agents/*.json    one record per agent call (`<nodeId>`, `<nodeId>#2`, …)
 *   artifacts/nodes/<id>.md (+ .meta.json)   every node's text or JSON output
 *   artifacts/escalation-report.md           written when on_fail elevate|reauthor fires
 *
 * The engine never touches pi: everything it needs arrives through WorkflowRuntimeDeps
 * (the extension's factory implements `agent` over runChild + slot resolution, `bash`,
 * `script`, `approval` over the TUI, `notify`, and optionally `mcpTool` / `runWorkflow`).
 *
 * Node handlers live in nodes/*.ts and receive a NodeContext; they return a NodeOutcome.
 * The executor owns attempts (retry.max_attempts, default 2, never on loops), delays,
 * abort handling (deps.signal plus its own cancel controller — every running node ends
 * "cancelled"), artifact writing and the store rows. Roles default to "worker" when a node
 * names none; role "architect" is always read-only (nodes/ai.ts).
 *
 * Contract deviations (all additive): AgentRequest.signal and the bash/script opts
 * carry the run's AbortSignal; ExecuteOptions.baseBranch/context feed $BASE_BRANCH and
 * $CONTEXT; RunResult.plan (dry runs) and RunResult.escalationReport (elevation) are
 * reported back; the elevate/reauthor report also carries `iterations` for loops.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type LedgerOrigin, appendLedger, rowFromAgentRun } from "../ledger.ts";
import type { Thinking } from "../model-stack.ts";
import type { RunStatus, RunStore } from "../run-store.ts";
import { sha256 } from "../hash-chain.ts";
import type { StackSettings } from "../stack-config.ts";
import { THINKING_ORDER, normalizeThinking } from "../thinking.ts";
import type { LoadedWorkflow } from "./loader.ts";
import type { HooksDoc, JsonSchema, NodeDoc, NodeType, SlotRole, WorkflowDoc } from "./schema.ts";
import { nodeType } from "./schema.ts";
import { type NodeStatus, evaluateWhen, layers, readiness } from "./scheduler.ts";
import { type SubstituteMode, type SubstitutionContext, substitute } from "./substitute.ts";
import { runAiNode } from "./nodes/ai.ts";
import { runApprovalNode } from "./nodes/approval.ts";
import { runBashNode } from "./nodes/bash.ts";
import { runBestOfNode } from "./nodes/best-of.ts";
import { runCancelNode } from "./nodes/cancel.ts";
import { runCommandNode } from "./nodes/command.ts";
import { runHypothesisNode } from "./nodes/hypothesis.ts";
import { runInterleaveNode } from "./nodes/interleave.ts";
import { runLoopNode } from "./nodes/loop.ts";
import { runMcpToolNode } from "./nodes/mcp-tool.ts";
import { runScriptNode } from "./nodes/script.ts";
import { runVerifyNode } from "./nodes/verify.ts";
import { runWorkflowNode } from "./nodes/workflow.ts";

// ═══ Public contract ═════════════════════════════════════════════════════════

export interface AgentRequest {
	nodeId: string;
	role: SlotRole;
	callsign?: string;
	model?: string;
	thinking?: string;
	prompt: string;
	systemPrompt?: string;
	appendSystemPrompts?: string[];
	tools: string | "none";
	context: "fresh" | "shared" | { resume: string };
	hooks?: HooksDoc;
	outputSchema?: JsonSchema;
	timeoutMs: number;
	env?: Record<string, string>;
	label?: string;
	/** The run's abort signal (deps.signal ∪ the executor's own cancel) — forward it to runChild. */
	signal?: AbortSignal;
}

export interface AgentResult {
	ok: boolean;
	text: string;
	sessionRef?: string;
	usage: { tokensIn: number; tokensOut: number; costUsd: number; tpsSeconds: number };
	error?: string;
	toolCalls: number;
	model?: string;
}

export interface ProcessResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface ProcessOptions {
	cwd: string;
	timeoutMs: number;
	env?: Record<string, string>;
	signal?: AbortSignal;
}

export interface ScriptSpec {
	runtime: "bun" | "uv";
	inline?: string;
	path?: string;
	deps?: string[];
}

export interface ResolvedRole {
	model: string;
	thinking: string;
	callsign: string;
	systemPrompt?: string;
	appendSystemPrompts: string[];
	tools: string;
}

export interface WorkflowRuntimeDeps {
	cwd: string;
	runId: string;
	runDir: string;
	artifactsDir: string;
	workflowId: string;
	store: RunStore;
	agent(req: AgentRequest): Promise<AgentResult>;
	bash(command: string, opts: ProcessOptions): Promise<ProcessResult>;
	script(spec: ScriptSpec, opts: ProcessOptions & { argv?: string[] }): Promise<ProcessResult>;
	approval(message: string, opts?: { captureResponse?: boolean }): Promise<{ approved: boolean; response?: string }>;
	notify(text: string, level?: "info" | "warning" | "error"): void;
	signal?: AbortSignal;
	settings: StackSettings;
	resolveRole(role: SlotRole, node: NodeDoc): ResolvedRole;
	mcpTool?(server: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
	runWorkflow?(name: string, inputs: Record<string, unknown>): Promise<RunResult>;
}

export interface NodeResult {
	nodeId: string;
	type: NodeType;
	status: NodeStatus;
	output: unknown;
	text?: string;
	artifactPath?: string;
	startedAt: string;
	endedAt: string;
	attempts: number;
	error?: string;
	usage?: AgentResult["usage"];
	sessionRef?: string;
}

export interface RunResult {
	runId: string;
	status: "completed" | "failed" | "cancelled" | "paused";
	nodes: Record<string, NodeResult>;
	returns?: unknown;
	error?: string;
	/** The layer plan (dry runs only). */
	plan?: string[][];
	/** artifacts/escalation-report.md when on_fail elevate|reauthor ended the run. */
	escalationReport?: string;
}

export interface ExecuteOptions {
	inputs?: Record<string, unknown>;
	arguments?: string;
	maxParallel?: number;
	dryRun?: boolean;
	onNode?(result: NodeResult): void;
	baseBranch?: string;
	context?: string;
}

// ═══ Node handler contract ═══════════════════════════════════════════════════

/** What a node handler returns; the executor turns it into a NodeResult. */
export interface NodeOutcome {
	status: "success" | "failed" | "cancelled";
	output: unknown;
	text?: string;
	error?: string;
	usage?: AgentResult["usage"];
	sessionRef?: string;
	/** false: never re-run this failure (missing runtime dep, exhausted loop, P4 stub). Default true. */
	retryable?: boolean;
	/** Set when the whole run must end "cancelled" with this reason (cancel node, rejected approval, user-stopped loop). */
	cancelRun?: string;
	/** Extra fields for the artifact's .meta.json (iterations, reworks, calls…). */
	meta?: Record<string, unknown>;
}

/** Everything a node handler may use. */
export interface NodeContext {
	readonly deps: WorkflowRuntimeDeps;
	readonly loaded: LoadedWorkflow;
	readonly doc: WorkflowDoc;
	readonly node: NodeDoc;
	readonly type: NodeType;
	readonly attempt: number;
	readonly inputs: Record<string, unknown>;
	/** Outputs of every settled successful node (live). */
	readonly outputs: Record<string, unknown>;
	/** Results of every finished node (live). */
	readonly results: Record<string, NodeResult>;
	readonly signal: AbortSignal;
	/** Environment for children and processes: ARTIFACTS_DIR, TITAN_RUN_ID, TITAN_WORKFLOW_ID, TITAN_NODE_ID, TITAN_RUN_DIR. */
	readonly env: Record<string, string>;
	substitution(extra?: Partial<SubstitutionContext>): SubstitutionContext;
	/** substitute() over this node's context; unknown refs are reported once as a warning. */
	subst(text: string, mode: SubstituteMode, extra?: Partial<SubstitutionContext>): string;
	/** Run one agent call and record it (agent record, ledger row, agent.start/end events). Throws on abort. */
	runAgent(req: AgentRequest): Promise<AgentResult>;
	/** The sessionRef `context: shared` resumes: the newest dependency with one, else the newest finished node with one. */
	previousSessionRef(): string | undefined;
	/** Timeout for this node: "ai" = idle_timeout ?? timeout ?? 300000, "process" = timeout ?? 120000. */
	timeoutMs(kind: "ai" | "process"): number;
	notify(text: string, level?: "info" | "warning" | "error"): void;
	log(type: string, data: Record<string, unknown>): void;
}

export type NodeHandler = (ctx: NodeContext) => Promise<NodeOutcome>;

export const AI_TIMEOUT_MS = 300_000;
export const PROCESS_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_ATTEMPTS = 2;
export const DEFAULT_RETRY_DELAY_MS = 3000;
export const ESCALATION_REPORT = "escalation-report.md";

const HANDLERS: Record<NodeType, NodeHandler> = {
	prompt: runAiNode,
	command: runCommandNode,
	bash: runBashNode,
	script: runScriptNode,
	loop: runLoopNode,
	approval: runApprovalNode,
	cancel: runCancelNode,
	mcp_tool: runMcpToolNode,
	workflow: runWorkflowNode,
	verify: runVerifyNode,
	best_of: runBestOfNode,
	interleave: runInterleaveNode,
	hypothesis: runHypothesisNode,
};

// ═══ Small helpers ═══════════════════════════════════════════════════════════

export class AbortError extends Error {
	constructor(reason?: unknown) {
		super(reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "aborted");
		this.name = "AbortError";
	}
}

export const isAbortError = (error: unknown): boolean => error instanceof AbortError || (error instanceof Error && error.name === "AbortError");

/** Resolve/reject with `promise`, or reject with AbortError as soon as `signal` fires. A late settle of an abandoned promise is swallowed. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		promise.catch(() => {});
		return Promise.reject(new AbortError(signal.reason));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			promise.catch(() => {});
			reject(new AbortError(signal.reason));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/** Abortable sleep. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(new AbortError(signal.reason));
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new AbortError(signal.reason));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/** Run thunks with at most `limit` in flight; every thunk settles (errors are collected, never thrown). */
export async function runLimited(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
	const max = Math.max(1, Math.floor(limit) || 1);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < tasks.length) {
			const task = tasks[next++];
			try {
				await task();
			} catch {
				/* the node runner reports its own failures */
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(max, tasks.length) }, () => worker()));
}

const asString = (value: unknown): string => (value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value));

/** Ledger origin for a role: the reviewer roles have their own, everything else is "run". */
export function originForRole(role: SlotRole | string): LedgerOrigin {
	switch (role) {
		case "auditor":
		case "verifier":
		case "watchdog":
		case "fusion":
		case "judge":
		case "fuser":
			return role;
		default:
			return "run";
	}
}

/** Merge required/default declarations with the caller's inputs; throws on a missing required input. */
export function resolveInputs(doc: WorkflowDoc, given: Record<string, unknown> = {}): Record<string, unknown> {
	const inputs: Record<string, unknown> = {};
	const missing: string[] = [];
	for (const [key, spec] of Object.entries(doc.inputs ?? {})) {
		if (given[key] !== undefined) inputs[key] = given[key];
		else if (spec?.default !== undefined) inputs[key] = spec.default;
		else if (spec?.required) missing.push(key);
	}
	for (const [key, value] of Object.entries(given)) if (value !== undefined && inputs[key] === undefined) inputs[key] = value;
	if (missing.length) throw new Error(`missing required input${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
	return inputs;
}

/** The dry-run plan: one line per layer with each node's type and its routing fields. */
export function formatPlan(doc: WorkflowDoc, plan: string[][]): string {
	const byId = new Map(doc.nodes.map((n) => [n.id, n]));
	const lines = [`dry run — ${doc.name}: ${plan.length} layer${plan.length === 1 ? "" : "s"}, ${doc.nodes.length} node${doc.nodes.length === 1 ? "" : "s"}`];
	plan.forEach((layer, index) => {
		const cells = layer.map((id) => {
			const node = byId.get(id);
			if (!node) return id;
			const bits = [`${id} (${nodeType(node) ?? "?"})`];
			if (node.role) bits.push(`role ${node.role}`);
			if (node.when) bits.push(`when ${node.when}`);
			if (node.trigger_rule && node.trigger_rule !== "all_success") bits.push(`trigger_rule ${node.trigger_rule}`);
			if (node.output_format) bits.push("output_format");
			return bits.join(" · ");
		});
		lines.push(`  ${index + 1}. ${cells.join("  |  ")}`);
	});
	if (doc.returns) lines.push(`  returns: ${doc.returns}`);
	return lines.join("\n");
}

/** Attempts a node may make: loops never re-run; on_fail retry's `max` wins, then retry.max_attempts, then 2. */
export function attemptsBudget(node: NodeDoc, type: NodeType): number {
	if (type === "loop" || type === "cancel" || type === "approval") return 1;
	const fromOnFail = node.on_fail?.action === "retry" ? node.on_fail.max : undefined;
	const raw = node.retry?.max_attempts ?? fromOnFail ?? DEFAULT_MAX_ATTEMPTS;
	return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_ATTEMPTS;
}

function artifactBody(outcome: NodeOutcome): string {
	if (typeof outcome.text === "string" && outcome.text.length) return outcome.text;
	if (outcome.output !== undefined) return typeof outcome.output === "string" ? outcome.output : `${JSON.stringify(outcome.output, null, 2)}\n`;
	return outcome.status === "success" ? "" : `[${outcome.status}] ${outcome.error ?? ""}`;
}

function runStatusFor(status: RunResult["status"]): RunStatus {
	return status === "cancelled" ? "aborted" : status;
}

// ═══ The executor ════════════════════════════════════════════════════════════

export async function executeWorkflow(loaded: LoadedWorkflow, deps: WorkflowRuntimeDeps, opts: ExecuteOptions = {}): Promise<RunResult> {
	const doc = loaded.normalized ?? loaded.doc;
	const inputs = resolveInputs(doc, opts.inputs);
	const plan = layers(doc);
	const { store, runDir, runId } = deps;

	if (opts.dryRun) {
		deps.notify(formatPlan(doc, plan));
		return { runId, status: "completed", nodes: {}, plan };
	}

	const controller = new AbortController();
	const signal = controller.signal;
	const onOuterAbort = () => controller.abort(deps.signal?.reason ?? new AbortError("aborted"));
	if (deps.signal?.aborted) onOuterAbort();
	else deps.signal?.addEventListener("abort", onOuterAbort, { once: true });

	const byId = new Map(doc.nodes.map((n) => [n.id, n]));
	const outputs: Record<string, unknown> = {};
	const results: Record<string, NodeResult> = {};
	const statuses: Record<string, NodeStatus> = {};
	const finishedOrder: string[] = [];
	const agentCalls = new Map<string, number>();
	let halt: { status: RunResult["status"]; error: string } | undefined;
	let escalationReport: string | undefined;
	let currentPhase: string | undefined;

	const log = (type: string, data: Record<string, unknown>, agentId?: string): void => {
		store.appendEvent(runDir, type, data, agentId);
	};
	const patchRun = (patch: Parameters<RunStore["updateRun"]>[1]): void => {
		try {
			store.updateRun(runDir, patch);
		} catch (error) {
			deps.notify(`run.json update failed: ${asString(error)}`, "warning");
		}
	};

	const baseSubstitution = (): SubstitutionContext => ({
		inputs,
		outputs,
		artifactsDir: deps.artifactsDir,
		workflowId: deps.workflowId,
		runId,
		arguments: opts.arguments,
		baseBranch: opts.baseBranch,
		context: opts.context,
	});

	const finish = (node: NodeDoc, result: NodeResult): void => {
		results[node.id] = result;
		statuses[node.id] = result.status;
		finishedOrder.push(node.id);
		if (result.status === "success") outputs[node.id] = result.output;
		log("node.end", { nodeId: node.id, type: result.type, status: result.status, attempts: result.attempts, error: result.error, artifact: result.artifactPath, durationMs: Date.parse(result.endedAt) - Date.parse(result.startedAt) });
		opts.onNode?.(result);
	};

	const skip = (node: NodeDoc, type: NodeType, reason: string): void => {
		const ts = new Date().toISOString();
		log("node.start", { nodeId: node.id, type, attempt: 0, skipped: true });
		finish(node, { nodeId: node.id, type, status: "skipped", output: undefined, startedAt: ts, endedAt: ts, attempts: 0, error: reason });
	};

	const runAgent = async (node: NodeDoc, req: AgentRequest): Promise<AgentResult> => {
		const index = (agentCalls.get(node.id) ?? 0) + 1;
		agentCalls.set(node.id, index);
		const agentId = index === 1 ? node.id : `${node.id}#${index}`;
		const requested = req.thinking ?? "";
		const effective = THINKING_ORDER.includes(requested as Thinking) && req.model ? normalizeThinking(req.model, requested as Thinking).effective : requested;
		const callsign = req.callsign ?? agentId;
		store.upsertAgent(runDir, { agentId, callsign, role: req.role, model: req.model ?? "", thinking: { requested, effective }, state: "dispatched-working" });
		log("agent.start", { nodeId: node.id, agentId, role: req.role, model: req.model, thinking: effective, tools: req.tools, context: req.context, label: req.label }, agentId);
		let result: AgentResult;
		try {
			result = await raceAbort(deps.agent({ ...req, signal }), signal);
		} catch (error) {
			const aborted = isAbortError(error) || signal.aborted;
			store.upsertAgent(runDir, { agentId, state: aborted ? "cancelled" : "failed" });
			log("agent.end", { nodeId: node.id, agentId, ok: false, error: asString(error), aborted }, agentId);
			throw aborted ? new AbortError(signal.reason) : error;
		}
		const usage = result.usage ?? { tokensIn: 0, tokensOut: 0, costUsd: 0, tpsSeconds: 0 };
		store.upsertAgent(runDir, {
			agentId,
			model: result.model ?? req.model ?? "",
			state: result.ok ? "done-unverified" : "failed",
			usage: { input: usage.tokensIn, output: usage.tokensOut, cacheRead: 0, cacheWrite: 0, cost: usage.costUsd },
			tps: { outputTokens: usage.tokensOut, seconds: usage.tpsSeconds },
		});
		appendLedger(
			runDir,
			rowFromAgentRun(
				{ role: req.role, model: result.model ?? req.model ?? "", slot: { id: agentId, name: callsign, thinking: req.thinking }, thinking: req.thinking, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, costUsd: usage.costUsd, tpsSeconds: usage.tpsSeconds },
				runId,
				originForRole(req.role),
				effective || undefined,
				agentId,
			),
		);
		log("agent.end", { nodeId: node.id, agentId, ok: result.ok, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, costUsd: usage.costUsd, toolCalls: result.toolCalls, sessionRef: result.sessionRef, error: result.error }, agentId);
		return result;
	};

	const makeContext = (node: NodeDoc, type: NodeType, attempt: number): NodeContext => {
		const warned = new Set<string>();
		const env: Record<string, string> = {
			ARTIFACTS_DIR: deps.artifactsDir,
			TITAN_ARTIFACTS_DIR: deps.artifactsDir,
			TITAN_RUN_ID: runId,
			TITAN_RUN_DIR: runDir,
			TITAN_WORKFLOW_ID: deps.workflowId,
			TITAN_NODE_ID: node.id,
		};
		const ctx: NodeContext = {
			deps,
			loaded,
			doc,
			node,
			type,
			attempt,
			inputs,
			outputs,
			results,
			signal,
			env,
			substitution: (extra) => ({ ...baseSubstitution(), ...extra }),
			subst: (text, mode, extra) =>
				substitute(text, ctx.substitution(extra), mode, (ref) => {
					// `$HOME`, `$1` in a shell body and `$5` in prose are not references; a dotted token always is
					if (warned.has(ref) || (!ref.includes(".") && (mode !== "prompt" || /^\$\d/.test(ref)))) return;
					warned.add(ref);
					deps.notify(`${node.id}: unknown reference ${ref} left as-is`, "warning");
				}),
			runAgent: (req) => runAgent(node, req),
			previousSessionRef: () => {
				for (const dep of [...(node.depends_on ?? [])].reverse()) {
					const ref = results[dep]?.sessionRef;
					if (ref) return ref;
				}
				for (let i = finishedOrder.length - 1; i >= 0; i--) {
					const ref = results[finishedOrder[i]]?.sessionRef;
					if (ref) return ref;
				}
				return undefined;
			},
			timeoutMs: (kind) => (kind === "ai" ? (node.idle_timeout ?? node.timeout ?? AI_TIMEOUT_MS) : (node.timeout ?? PROCESS_TIMEOUT_MS)),
			notify: (text, level) => deps.notify(text, level),
			log: (type, data) => log(type, { nodeId: node.id, ...data }),
		};
		return ctx;
	};

	const writeEscalationReport = (node: NodeDoc, result: NodeResult, action: string): string => {
		const body = [
			"# Escalation report",
			"",
			`- workflow: ${deps.workflowId}`,
			`- run: ${runId}`,
			`- node: ${node.id} (${result.type})`,
			`- verdict: ${action}`,
			`- attempts: ${result.attempts}`,
			`- error: ${result.error ?? "—"}`,
			`- artifact: ${result.artifactPath ?? "—"}`,
			`- generated: ${new Date().toISOString()}`,
			"",
			"## Output",
			"",
			"```",
			(result.text ?? (result.output === undefined ? "" : typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2))).trimEnd(),
			"```",
			"",
		].join("\n");
		fs.mkdirSync(deps.artifactsDir, { recursive: true, mode: 0o700 });
		const file = path.join(deps.artifactsDir, ESCALATION_REPORT);
		fs.writeFileSync(file, body, { mode: 0o600 });
		log("elevation.report", { nodeId: node.id, action, attempts: result.attempts, path: file, sha256: sha256(body) });
		return file;
	};

	const runNode = async (node: NodeDoc, layerIndex: number): Promise<void> => {
		if (halt || signal.aborted) return; // the run ended while this layer was in flight: reported as "not reached"
		const type = nodeType(node);
		if (!type) {
			const ts = new Date().toISOString();
			finish(node, { nodeId: node.id, type: "prompt", status: "failed", output: undefined, startedAt: ts, endedAt: ts, attempts: 0, error: "node declares no (or more than one) type" });
			return;
		}
		if (node.when) {
			const verdict = evaluateWhen(node.when, outputs);
			if (!verdict.value) {
				if (verdict.error) deps.notify(`${node.id}: when "${node.when}" failed closed (${verdict.error})`, "warning");
				skip(node, type, `when: ${node.when} → false${verdict.error ? ` (${verdict.error})` : ""}`);
				return;
			}
		}
		if (node.phase && node.phase !== currentPhase) {
			currentPhase = node.phase;
			log("phase.start", { phase: node.phase, nodeId: node.id });
			patchRun({ currentPhase: node.phase });
		}
		const handler = HANDLERS[type];
		const budget = attemptsBudget(node, type);
		const delayMs = node.retry?.delay_ms ?? DEFAULT_RETRY_DELAY_MS;
		let outcome: NodeOutcome | undefined;
		let startedAt = new Date().toISOString();
		let attempt = 0;
		while (attempt < budget) {
			attempt++;
			startedAt = new Date().toISOString();
			log("node.start", { nodeId: node.id, type, attempt, layer: layerIndex, phase: node.phase, role: node.role });
			if (signal.aborted) {
				outcome = { status: "cancelled", output: undefined, error: new AbortError(signal.reason).message };
				break;
			}
			try {
				outcome = await raceAbort(handler(makeContext(node, type, attempt)), signal);
			} catch (error) {
				outcome = isAbortError(error) || signal.aborted ? { status: "cancelled", output: undefined, error: new AbortError(signal.reason).message } : { status: "failed", output: undefined, error: asString(error) };
			}
			if (outcome.status !== "failed") break;
			if (attempt < budget && outcome.retryable !== false) {
				deps.notify(`${node.id}: attempt ${attempt}/${budget} failed (${outcome.error ?? "no error"}), retrying${delayMs > 0 ? ` in ${delayMs} ms` : ""}`, "warning");
				try {
					await sleep(delayMs, signal);
				} catch {
					outcome = { status: "cancelled", output: undefined, error: new AbortError(signal.reason).message };
					break;
				}
				continue;
			}
			break;
		}
		const final = outcome ?? { status: "failed" as const, output: undefined, error: "node never ran" };
		const endedAt = new Date().toISOString();
		const result: NodeResult = { nodeId: node.id, type, status: final.status, output: final.output, text: final.text, startedAt, endedAt, attempts: attempt, error: final.error, usage: final.usage, sessionRef: final.sessionRef };
		const body = artifactBody(final);
		if (final.status === "success" || body.length) {
			try {
				result.artifactPath = store.writeArtifact(runDir, node.id, body, { type, status: final.status, attempts: attempt, role: node.role, sessionRef: final.sessionRef, ...final.meta }).path;
			} catch (error) {
				deps.notify(`${node.id}: artifact write failed: ${asString(error)}`, "warning");
			}
		}
		finish(node, result);

		if (final.cancelRun !== undefined && !halt) {
			halt = { status: "cancelled", error: final.cancelRun };
			controller.abort(new AbortError(final.cancelRun));
			return;
		}
		if (final.status === "cancelled" && !halt) {
			halt = { status: "cancelled", error: final.error ?? "cancelled" };
			controller.abort(new AbortError(halt.error));
			return;
		}
		if (final.status === "failed" && node.on_fail && !halt) {
			const action = node.on_fail.action;
			if (action === "cancel") {
				halt = { status: "cancelled", error: `cancelled by on_fail of ${node.id}: ${final.error ?? "failed"}` };
				controller.abort(new AbortError(halt.error));
			} else if (action === "elevate" || action === "reauthor") {
				escalationReport = writeEscalationReport(node, result, action);
				halt = { status: "failed", error: `elevation: ${node.id} failed ${attempt} times` };
				deps.notify(`${node.id}: ${action} → ${escalationReport}`, "error");
				controller.abort(new AbortError(halt.error));
			}
		}
	};

	patchRun({ status: "running", phases: doc.phases?.map((p) => p.title) });
	log("workflow.start", { workflow: doc.name, sha256: loaded.sha256, layers: plan, inputs: Object.keys(inputs), maxParallel: opts.maxParallel ?? deps.settings.maxConcurrentChildren });
	const maxParallel = opts.maxParallel ?? deps.settings.maxConcurrentChildren ?? 8;
	try {
		for (let layerIndex = 0; layerIndex < plan.length && !halt && !signal.aborted; layerIndex++) {
			const ready: NodeDoc[] = [];
			for (const id of plan[layerIndex]) {
				const node = byId.get(id)!;
				const type = nodeType(node) ?? "prompt";
				const verdict = readiness(node, statuses);
				if (verdict === "run") ready.push(node);
				else skip(node, type, verdict === "skip" ? `trigger_rule ${node.trigger_rule ?? "all_success"} not met by ${(node.depends_on ?? []).map((d) => `${d}=${statuses[d] ?? "pending"}`).join(", ")}` : "a dependency never settled");
			}
			await runLimited(
				ready.map((node) => () => runNode(node, layerIndex)),
				maxParallel,
			);
		}
	} finally {
		deps.signal?.removeEventListener("abort", onOuterAbort);
	}
	if (!halt && signal.aborted) halt = { status: "cancelled", error: new AbortError(signal.reason).message };

	const now = new Date().toISOString();
	for (const node of doc.nodes) {
		if (results[node.id]) continue;
		const result: NodeResult = { nodeId: node.id, type: nodeType(node) ?? "prompt", status: "cancelled", output: undefined, startedAt: now, endedAt: now, attempts: 0, error: `not reached: ${halt?.error ?? "run ended"}` };
		results[node.id] = result;
		statuses[node.id] = "cancelled";
		opts.onNode?.(result);
	}

	const firstFailure = doc.nodes.map((n) => results[n.id]).find((r) => r.status === "failed");
	const status: RunResult["status"] = halt?.status ?? (firstFailure ? "failed" : "completed");
	const error = halt?.error ?? (firstFailure ? `${firstFailure.nodeId}: ${firstFailure.error ?? "failed"}` : undefined);
	const returns = doc.returns && results[doc.returns]?.status === "success" ? outputs[doc.returns] : undefined;
	log("workflow.end", { status, error, returns: doc.returns, nodes: Object.fromEntries(Object.values(results).map((r) => [r.nodeId, r.status])) });
	patchRun({ status: runStatusFor(status), endedAt: new Date().toISOString() });
	const result: RunResult = { runId, status, nodes: results, returns, error };
	if (escalationReport) result.escalationReport = escalationReport;
	return result;
}
