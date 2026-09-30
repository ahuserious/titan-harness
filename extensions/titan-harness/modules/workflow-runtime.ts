/**
 * workflow-runtime.ts — the bridge between the pure workflow engine (modules/workflow/)
 * and this process: it builds the WorkflowRuntimeDeps a run needs from things only the
 * extension has (runChild, the live shape, the TUI, the run store).
 *
 *   createAgentRunner(host)      AgentRequest → runChild → AgentResult. One sessions
 *                                directory per run (<runDir>/sessions) so `context:
 *                                shared` / `{resume}` can re-enter any node's session;
 *                                a fresh context is a fresh session id. Static hooks ride
 *                                TITAN_NODE_HOOKS (child-hooks.ts hooksEnv); the thinking
 *                                level is normalized to the provider ceiling; reviewer
 *                                roles (auditor, verifier, watchdog) get the priority lease.
 *                                Structured output v2 (plan D12): a request with
 *                                `outputSchema` exports TITAN_NODE_SCHEMA (refs resolved)
 *                                and TITAN_NODE_RESULT_PATH (<runDir>/results/<node>-<n>.json),
 *                                names `submit_result` as an extra child tool (it survives
 *                                --no-tools and the /stack subagentTools=off policy), ends the
 *                                prompt with SUBMIT_RESULT_INSTRUCTION, and reads the file the
 *                                child's terminating tool wrote back as `AgentResult.value`
 *                                (nodes/ai.ts validates it and skips the text parse). No file
 *                                → the v1 prompt-suffix path stays the fallback.
 *   runProcess(command, args)    a subprocess with separate stdout/stderr, a timeout, an
 *                                AbortSignal and process-group kill — what `bash:` and
 *                                `script:` nodes run through.
 *   createWorkflowRuntime(host)  the full WorkflowRuntimeDeps: agent, bash (`bash -c`),
 *                                script (bun / uv run, inline text written under
 *                                <runDir>/tmp), approval (TUI confirm + input; headless →
 *                                rejected), notify, settings, resolveRole, runWorkflow.
 *
 * Nothing here imports pi: the host passes `runChild`, the UI seam and the role resolver
 * in, so tests drive it with fakes. mcpTool: the TUI passes its catalog bridge; a hosted run
 * (an `approver` is set) reaches MCP only through the unit's sidecar socket (`sidecarMcp`,
 * workflow/runner-seams.ts) and a direct `mcpTool` is refused at construction.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { hooksEnv, SUBMIT_RESULT_INSTRUCTION, SUBMIT_RESULT_TOOL, schemaEnv } from "./child-hooks.ts";
import { effectiveChildTools, guardCharged, type runChild as RunChild } from "./child-runner.ts";
import type { ModelSlot, Thinking } from "./model-stack.ts";
import type { RunStore } from "./run-store.ts";
import { type AgentRun, newRun, type Role, runError, runOk } from "./runtime.ts";
import type { UsageProvenance } from "./workflow/budget.ts";
import { readStackSettings, type StackSettings } from "./stack-config.ts";
import { THINKING_ORDER, normalizeThinking } from "./thinking.ts";
import { type ActorPolicy, createHostedApproval, type Approver } from "./workflow/approver.ts";
import { createSidecarMcpTool, type SidecarMcpOptions } from "./workflow/runner-seams.ts";
import type { AgentRequest, AgentResult, ProcessOptions, ProcessResult, ResolvedRole, RunResult, ScriptSpec, WorkflowRuntimeDeps } from "./workflow/executor.ts";
import type { LoadedWorkflow } from "./workflow/loader.ts";
import { resolveRef } from "./workflow/json-schema.ts";
import type { JsonSchema, NodeDoc, SlotRole } from "./workflow/schema.ts";

// ═══ Agents over runChild ═══════════════════════════════════════════════════

export interface AgentRunnerHost {
	/** child-runner's runChild, or a fake in tests. */
	runChild: typeof RunChild;
	/** One directory per run; every node's session lives here so resumes work across nodes. */
	sessionsDir: string;
	cwd: string;
	/** The stack slot a request maps to (for perf accounting and prompts); optional. */
	slotFor?(req: AgentRequest): ModelSlot | undefined;
	/** Host bookkeeping after every call (slot perf, the session ledger); never throws into the run. */
	onRun?(run: AgentRun, req: AgentRequest): void;
	/** Where `submit_result` files land (structured output v2); default <sessionsDir>/../results. */
	resultsDir?: string;
}

/**
 * The tool list a workflow request's child is spawned with: the /stack child policy over
 * req.tools (an explicit allowed_tools is final), plus `submit_result` for output_format
 * nodes. `settings` defaults to a fresh readStackSettings() (~/.pi/agent/titan-harness.json).
 */
export function agentChildTools(req: Pick<AgentRequest, "tools" | "toolsFinal" | "outputSchema">, settings?: StackSettings): string | "none" {
	return effectiveChildTools(req.tools, req.outputSchema ? [SUBMIT_RESULT_TOOL] : [], { final: req.toolsFinal, settings: settings ?? readStackSettings() });
}

/** An AgentResult that may carry the typed object a child's `submit_result` recorded (structured output v2). */
export interface StructuredAgentResult extends AgentResult {
	value?: unknown;
	/** The result file the child was told to write (set whenever `outputSchema` was requested). */
	resultPath?: string;
}

/** The schema as the child sees it: every `titan://schemas/*` $ref resolved (a child has no registry). */
export function resolveSchemaRefs(schema: JsonSchema, depth = 0): JsonSchema {
	if (!schema || typeof schema !== "object" || depth > 32) return schema;
	if (typeof schema.$ref === "string") {
		const resolved = resolveRef(schema.$ref);
		if (resolved) {
			const { $ref: _ref, ...rest } = schema;
			return resolveSchemaRefs({ ...resolved, ...rest }, depth + 1);
		}
		return schema; // unknown ref: the child degrades it to "any" (child-hooks.ts)
	}
	const out: JsonSchema = { ...schema };
	if (schema.properties) out.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, resolveSchemaRefs(value, depth + 1)]));
	if (schema.items) out.items = resolveSchemaRefs(schema.items, depth + 1);
	if (schema.additionalProperties && typeof schema.additionalProperties === "object") out.additionalProperties = resolveSchemaRefs(schema.additionalProperties, depth + 1);
	return out;
}

const safeSegment = (text: string): string => text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "node";

/** Workflow role → the transcript role the model bar and ledger know. */
export function transcriptRole(role: SlotRole): Role {
	switch (role) {
		case "architect":
			return "ARCHITECT";
		case "auditor":
			return "AUDITOR";
		case "verifier":
			return "VALIDATOR";
		case "fusion":
		case "judge":
		case "fuser":
			return "FUSION";
		default:
			return "BUILDER";
	}
}

const PRIORITY_ROLES: SlotRole[] = ["auditor", "verifier", "watchdog"];

const asThinking = (value: string | undefined): Thinking => (THINKING_ORDER.includes(value as Thinking) ? (value as Thinking) : "medium");

/**
 * How far a settled run's usage can be trusted for workflow budgets (budget.ts UsageProvenance):
 *   not-dispatched  no child process was started (aborted while queued, a held-spend refusal)
 *   none            no usage event arrived (thrown, aborted, crashed, timed out or exited before any)
 *   partial         it reported usage but did not finish cleanly (thrown after usage, aborted, timed out,
 *                   pre-empted, budget-halted, killed/crashed): the turn in progress may be unbilled, so
 *                   settlement charges max(reported, reservation) — reported usage is never dropped
 *   complete        it exited on its own with usage reported
 */
export function usageProvenanceOf(run: AgentRun, threw = false): UsageProvenance {
	if (run.notDispatched) return "not-dispatched";
	// The child's per-turn guard refused its FIRST model turn: no request was ever sent, so nothing was spent.
	if (run.budgetRefusal && run.budgetGuard?.turns === 0 && !run.usageSeen) return "not-dispatched";
	if (!run.usageSeen) return "none";
	// A budgeted child whose guard state could not be read at settle: its conservative charges are unknown.
	if (run.budgetStatePath && !run.budgetGuard?.spent) return "partial";
	const interrupted = threw || run.status === "aborted" || run.status === "timeout" || run.preempted || run.budgetHalted || !!run.budgetRefusal || run.exitCode !== 0;
	return interrupted ? "partial" : "complete";
}

/**
 * The usage a budgeted run settles at: what the parent observed, raised to what the child's per-turn guard charged in
 * each dimension it bounded. The guard charges a turn's planned worst case for every dimension that turn did not
 * report (and for a turn whose end it never saw), so a child that reported some turns and not others is never
 * settled at the reported subset alone — that would release budget the child actually spent.
 */
export function settledUsage(run: AgentRun): AgentResult["usage"] {
	const usage = { tokensIn: run.tokensIn, tokensOut: run.tokensOut, costUsd: run.costUsd, tpsSeconds: run.tpsSeconds };
	const charged = guardCharged(run.budgetGuard as any);
	if (!charged) return usage;
	if (charged.usdMicros !== undefined && charged.usdMicros > Math.ceil(Math.round(usage.costUsd * 1e9) / 1e3)) usage.costUsd = charged.usdMicros / 1e6;
	if (charged.tokens !== undefined && charged.tokens > usage.tokensIn + usage.tokensOut) usage.tokensIn += charged.tokens - (usage.tokensIn + usage.tokensOut);
	return usage;
}

/** The AgentResult a settled AgentRun means. */
export function resultOf(run: AgentRun): AgentResult {
	const ok = run.status === "done" && runOk(run);
	return {
		ok,
		text: run.text,
		sessionRef: run.sessionRef,
		usage: settledUsage(run),
		error: ok ? undefined : run.budgetRefusal ? `budget refused a model turn: ${run.budgetRefusal.reason}` : run.budgetHalted ? "stopped: budget in-flight cap exceeded" : run.status === "aborted" ? "aborted" : run.status === "timeout" ? "timed out" : runError(run),
		toolCalls: run.toolCalls,
		model: run.model,
		...(run.budgetRefusal ? { budgetRefusal: run.budgetRefusal } : {}),
	};
}

export function createAgentRunner(host: AgentRunnerHost): (req: AgentRequest) => Promise<StructuredAgentResult> {
	fs.mkdirSync(host.sessionsDir, { recursive: true, mode: 0o700 });
	const resultsDir = host.resultsDir ?? path.join(host.sessionsDir, "..", "results");
	const resultCounters = new Map<string, number>();
	return async (req) => {
		if (!req.model) {
			return { ok: false, text: "", usage: { tokensIn: 0, tokensOut: 0, costUsd: 0, tpsSeconds: 0 }, usageProvenance: "not-dispatched", error: `${req.nodeId}: no model resolved for role ${req.role}`, toolCalls: 0 };
		}
		const slot = host.slotFor?.(req);
		const run = newRun(transcriptRole(req.role), req.model, slot);
		const thinking = normalizeThinking(req.model, asThinking(req.thinking)).effective;
		const resume = typeof req.context === "object" && req.context ? req.context.resume : undefined;
		// Structured output v2: the schema and the result file travel as env, submit_result as an extra tool.
		let prompt = req.prompt;
		let resultPath: string | undefined;
		let schemaEnvironment: Record<string, string> = {};
		const extraTools: string[] = [];
		if (req.outputSchema) {
			const n = (resultCounters.get(req.nodeId) ?? 0) + 1;
			resultCounters.set(req.nodeId, n);
			resultPath = path.join(resultsDir, `${safeSegment(req.nodeId)}-${n}.json`);
			try {
				fs.rmSync(resultPath, { force: true });
			} catch {}
			schemaEnvironment = schemaEnv(resolveSchemaRefs(req.outputSchema), resultPath);
			extraTools.push(SUBMIT_RESULT_TOOL);
			if (!prompt.trimEnd().endsWith(SUBMIT_RESULT_INSTRUCTION)) prompt = `${prompt}\n\n${SUBMIT_RESULT_INSTRUCTION}`;
		}
		let threw = false;
		try {
			await host.runChild({
				run,
				prompt,
				systemPrompt: req.systemPrompt,
				appendSystemPrompts: req.appendSystemPrompts,
				tools: req.tools,
				thinking,
				sessionDir: host.sessionsDir,
				...(resume ? { resume } : { sessionId: randomUUID() }),
				cwd: host.cwd,
				timeoutMs: req.timeoutMs,
				signal: req.signal,
				priority: PRIORITY_ROLES.includes(req.role),
				env: { ...(req.env ?? {}), ...hooksEnv(req.hooks), ...schemaEnvironment },
				...(extraTools.length ? { extraTools } : {}),
				...(req.spendCap ? { spendCap: req.spendCap } : {}),
				...(req.toolsFinal ? { toolsFinal: true } : {}),
				...(req.effectiveTools !== undefined ? { resolvedTools: req.effectiveTools } : {}),
			});
		} catch (error) {
			threw = true;
			run.status = "failed";
			run.errorMessage = error instanceof Error ? error.message : String(error);
		}
		// The typed object the child's terminating submit_result wrote, when it did.
		let value: unknown;
		if (resultPath && run.status !== "aborted") {
			try {
				value = JSON.parse(fs.readFileSync(resultPath, "utf8"));
				run.text = JSON.stringify(value);
				// A child that ended right after submit_result has no closing prose: the file is its answer.
				if (run.status === "failed" && run.exitCode === 0 && run.stopReason !== "error" && run.stopReason !== "aborted") run.status = "done";
			} catch {
				value = undefined; // no file (v1 path) or unreadable JSON (treated as no result; the text parse decides)
			}
		}
		try {
			host.onRun?.(run, req);
		} catch {
			/* bookkeeping never fails a node */
		}
		const result: StructuredAgentResult = resultOf(run);
		result.usageProvenance = usageProvenanceOf(run, threw);
		if (resultPath) result.resultPath = resultPath;
		if (value !== undefined) result.value = value;
		return result;
	};
}

// ═══ Subprocesses ═══════════════════════════════════════════════════════════

const killTree = (proc: ReturnType<typeof spawn>): void => {
	try {
		if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGKILL");
		else proc.kill("SIGKILL");
	} catch {
		try {
			proc.kill("SIGKILL");
		} catch {}
	}
};

/** Run `command args` with separate streams, a timeout (exit 124) and an abort signal (exit 130). Never throws. */
export function runProcess(command: string, args: string[], opts: ProcessOptions): Promise<ProcessResult> {
	return new Promise((resolve) => {
		if (opts.signal?.aborted) return resolve({ code: 130, stdout: "", stderr: "aborted before start" });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(command, args, {
				cwd: opts.cwd,
				shell: false,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, ...(opts.env ?? {}) },
			});
		} catch (error) {
			return resolve({ code: 127, stdout: "", stderr: `failed to spawn ${command}: ${String(error)}` });
		}
		const onAbort = () => {
			aborted = true;
			killTree(proc);
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(
			() => {
				timedOut = true;
				killTree(proc);
			},
			Math.max(1, opts.timeoutMs),
		);
		const cleanup = () => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
		};
		proc.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		proc.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		proc.on("error", (error) => {
			cleanup();
			resolve({ code: 127, stdout, stderr: `${stderr}\nspawn error: ${String(error)}`.trim() });
		});
		proc.on("close", (code) => {
			cleanup();
			if (aborted) return resolve({ code: 130, stdout, stderr: `${stderr}\n[aborted]`.trim() });
			if (timedOut) return resolve({ code: 124, stdout, stderr: `${stderr}\n[timed out after ${opts.timeoutMs} ms]`.trim() });
			resolve({ code: code ?? 0, stdout, stderr });
		});
	});
}

/** First executable named `name` on PATH, then in `extraDirs`. */
export function findBinary(name: string, extraDirs: string[] = []): string | undefined {
	const dirs = [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), ...extraDirs];
	for (const dir of dirs) {
		const candidate = path.join(dir, name);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {}
	}
	return undefined;
}

const HOME_BINS = () => [path.join(os.homedir(), ".bun", "bin"), path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".cargo", "bin")];

export interface ScriptRunnerOptions {
	/** Where inline scripts are written (<runDir>/tmp). */
	tmpDir: string;
	bun?: string;
	uv?: string;
}

/** `script:` nodes: inline text becomes a file under tmpDir; bun runs .ts/.js, uv runs .py (with --with deps). */
export function createScriptRunner(options: ScriptRunnerOptions): WorkflowRuntimeDeps["script"] {
	let counter = 0;
	return async (spec: ScriptSpec, opts) => {
		const runtime = spec.runtime;
		const binary = runtime === "bun" ? (options.bun ?? findBinary("bun", HOME_BINS())) : (options.uv ?? findBinary("uv", HOME_BINS()));
		if (!binary) return { code: 127, stdout: "", stderr: `${runtime} not found on PATH (install it or set scripts.${runtime} in the runtime)` };
		let file = spec.path;
		if (!file) {
			if (spec.inline === undefined) return { code: 2, stdout: "", stderr: "script node has neither inline text nor a path" };
			fs.mkdirSync(options.tmpDir, { recursive: true, mode: 0o700 });
			counter += 1;
			file = path.join(options.tmpDir, `script-${counter}${runtime === "bun" ? ".ts" : ".py"}`);
			fs.writeFileSync(file, spec.inline, { mode: 0o600 });
		}
		const argv = opts.argv ?? [];
		const args = runtime === "bun" ? ["run", file, ...argv] : ["run", ...(spec.deps ?? []).flatMap((dep) => ["--with", dep]), file, ...argv];
		return runProcess(binary, args, opts);
	};
}

// ═══ The full runtime ═══════════════════════════════════════════════════════

export interface RuntimeUi {
	confirm(title: string, body: string): Promise<boolean>;
	input?(title: string, placeholder?: string): Promise<string | undefined>;
	notify(text: string, level?: "info" | "warning" | "error"): void;
}

export interface WorkflowRuntimeHost {
	cwd: string;
	runId: string;
	runDir: string;
	loaded: LoadedWorkflow;
	store: RunStore;
	settings: StackSettings;
	runChild: typeof RunChild;
	resolveRole(role: SlotRole, node: NodeDoc): ResolvedRole;
	/** Absent in headless sessions: approvals are then rejected with a reason. */
	ui?: RuntimeUi;
	/** Runner-side web transport; takes precedence over ui. Never passed into a child. Requires `store` from openRunnerStore. */
	approver?: Approver;
	/** Hosted approvals: who may decide. Absent → every hosted decision is refused (actor_not_authorized). */
	actorPolicy?: ActorPolicy;
	/** Runner wall-clock TTL; defaults to 24 hours. */
	approvalTtlMs?: number;
	slotFor?(req: AgentRequest): ModelSlot | undefined;
	onRun?(run: AgentRun, req: AgentRequest): void;
	runWorkflow?: WorkflowRuntimeDeps["runWorkflow"];
	/** A direct MCP bridge (the TUI's catalog). Refused when `approver` is set: hosted runs use `sidecarMcp`. */
	mcpTool?: WorkflowRuntimeDeps["mcpTool"];
	/** mcpTool through the unit's sidecar socket only (runner-seams.ts createSidecarMcpTool). */
	sidecarMcp?: SidecarMcpOptions;
	/** The max-reasoning model of a model's family (the mechanical ladder's step 2); undefined → stay on the model. */
	familyMax?(model: string): string | undefined;
	signal?: AbortSignal;
	scripts?: { bun?: string; uv?: string };
}

const REJECT_WORDS = /^(n|no|reject|rejected|cancel|stop)\b/i;

/** The approval seam: confirm, then (when a response is wanted) one free-text answer; headless → rejected. */
export function createApproval(ui: RuntimeUi | undefined): WorkflowRuntimeDeps["approval"] {
	return async (message, opts) => {
		if (!ui) return { approved: false, response: "headless session: no approver available" };
		let approved: boolean;
		try {
			approved = await ui.confirm("Workflow approval", message);
		} catch {
			return { approved: false, response: "approval prompt unavailable" };
		}
		if (!opts?.captureResponse || !ui.input) return { approved };
		let response: string | undefined;
		try {
			response = await ui.input(approved ? "Response (optional)" : "Why not? (sent back to the workflow)", approved ? "" : "reason");
		} catch {
			response = undefined;
		}
		if (approved && response && REJECT_WORDS.test(response.trim())) approved = false;
		return { approved, response: response?.trim() || undefined };
	};
}

export function createWorkflowRuntime(host: WorkflowRuntimeHost): WorkflowRuntimeDeps {
	if (host.mcpTool && host.sidecarMcp) throw new Error("workflow runtime: pass mcpTool or sidecarMcp, not both");
	if (host.approver && host.mcpTool) throw new Error("workflow runtime: a hosted run reaches MCP only through the unit's sidecar socket (sidecarMcp); a direct mcpTool is refused");
	const sidecarMcpTool = host.sidecarMcp ? createSidecarMcpTool(host.sidecarMcp) : undefined;
	const artifactsDir = path.join(host.runDir, "artifacts");
	fs.mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
	const agent = createAgentRunner({ runChild: host.runChild, sessionsDir: path.join(host.runDir, "sessions"), cwd: host.cwd, slotFor: host.slotFor, onRun: host.onRun });
	const script = createScriptRunner({ tmpDir: path.join(host.runDir, "tmp"), bun: host.scripts?.bun, uv: host.scripts?.uv });
	const deps: WorkflowRuntimeDeps = {
		cwd: host.cwd,
		runId: host.runId,
		runDir: host.runDir,
		artifactsDir,
		workflowId: host.loaded.name,
		store: host.store,
		agent,
		bash: (command, opts) => runProcess("bash", ["-c", command], opts),
		script,
		approval: host.approver ? createHostedApproval({ ...host, approver: host.approver }) : createApproval(host.ui),
		notify: (text, level) => {
			try {
				host.ui?.notify(text, level);
			} catch {}
		},
		signal: host.signal,
		settings: host.settings,
		resolveRole: host.resolveRole,
		childTools: (req) => agentChildTools(req),
	};
	if (sidecarMcpTool) deps.mcpTool = sidecarMcpTool;
	else if (host.mcpTool) deps.mcpTool = host.mcpTool;
	if (host.runWorkflow) deps.runWorkflow = host.runWorkflow;
	if (host.familyMax) deps.familyMax = host.familyMax;
	return deps;
}
