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
 *   runProcess(command, args)    a subprocess with separate stdout/stderr, a timeout, an
 *                                AbortSignal and process-group kill — what `bash:` and
 *                                `script:` nodes run through.
 *   createWorkflowRuntime(host)  the full WorkflowRuntimeDeps: agent, bash (`bash -c`),
 *                                script (bun / uv run, inline text written under
 *                                <runDir>/tmp), approval (TUI confirm + input; headless →
 *                                rejected), notify, settings, resolveRole, runWorkflow.
 *
 * Nothing here imports pi: the host passes `runChild`, the UI seam and the role resolver
 * in, so tests drive it with fakes. mcpTool stays absent until the InfraNodus stage (P7).
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { hooksEnv } from "./child-hooks.ts";
import type { runChild as RunChild } from "./child-runner.ts";
import type { ModelSlot, Thinking } from "./model-stack.ts";
import type { RunStore } from "./run-store.ts";
import { type AgentRun, newRun, type Role, runError, runOk } from "./runtime.ts";
import type { StackSettings } from "./stack-config.ts";
import { THINKING_ORDER, normalizeThinking } from "./thinking.ts";
import type { AgentRequest, AgentResult, ProcessOptions, ProcessResult, ResolvedRole, RunResult, ScriptSpec, WorkflowRuntimeDeps } from "./workflow/executor.ts";
import type { LoadedWorkflow } from "./workflow/loader.ts";
import type { NodeDoc, SlotRole } from "./workflow/schema.ts";

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
}

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

/** The AgentResult a settled AgentRun means. */
export function resultOf(run: AgentRun): AgentResult {
	const ok = run.status === "done" && runOk(run);
	return {
		ok,
		text: run.text,
		sessionRef: run.sessionRef,
		usage: { tokensIn: run.tokensIn, tokensOut: run.tokensOut, costUsd: run.costUsd, tpsSeconds: run.tpsSeconds },
		error: ok ? undefined : run.status === "aborted" ? "aborted" : run.status === "timeout" ? "timed out" : runError(run),
		toolCalls: run.toolCalls,
		model: run.model,
	};
}

export function createAgentRunner(host: AgentRunnerHost): (req: AgentRequest) => Promise<AgentResult> {
	fs.mkdirSync(host.sessionsDir, { recursive: true, mode: 0o700 });
	return async (req) => {
		if (!req.model) {
			return { ok: false, text: "", usage: { tokensIn: 0, tokensOut: 0, costUsd: 0, tpsSeconds: 0 }, error: `${req.nodeId}: no model resolved for role ${req.role}`, toolCalls: 0 };
		}
		const slot = host.slotFor?.(req);
		const run = newRun(transcriptRole(req.role), req.model, slot);
		const thinking = normalizeThinking(req.model, asThinking(req.thinking)).effective;
		const resume = typeof req.context === "object" && req.context ? req.context.resume : undefined;
		try {
			await host.runChild({
				run,
				prompt: req.prompt,
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
				env: { ...(req.env ?? {}), ...hooksEnv(req.hooks) },
			});
		} catch (error) {
			run.status = "failed";
			run.errorMessage = error instanceof Error ? error.message : String(error);
		}
		try {
			host.onRun?.(run, req);
		} catch {
			/* bookkeeping never fails a node */
		}
		return resultOf(run);
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
	slotFor?(req: AgentRequest): ModelSlot | undefined;
	onRun?(run: AgentRun, req: AgentRequest): void;
	runWorkflow?(name: string, inputs: Record<string, unknown>): Promise<RunResult>;
	mcpTool?: WorkflowRuntimeDeps["mcpTool"];
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
		approval: createApproval(host.ui),
		notify: (text, level) => {
			try {
				host.ui?.notify(text, level);
			} catch {}
		},
		signal: host.signal,
		settings: host.settings,
		resolveRole: host.resolveRole,
	};
	if (host.mcpTool) deps.mcpTool = host.mcpTool;
	if (host.runWorkflow) deps.runWorkflow = host.runWorkflow;
	if (host.familyMax) deps.familyMax = host.familyMax;
	return deps;
}
