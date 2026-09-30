/**
 * child-runner.ts — how one child agent (or gate process) actually runs.
 *
 * runChild spawns a clean-room `pi --mode json -p` subprocess and streams its JSON
 * events into a live AgentRun; runProc runs a plain subprocess (the validation gate).
 * Both use process groups with close-aware SIGTERM→SIGKILL escalation so Escape,
 * timeout, or session shutdown reaches every tool/bash descendant.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { briefArg, runOk, type AgentRun } from "./runtime.ts";
import { childToolsFor, readStackSettings, STACK_CHILD_ENV, subagentCapHint } from "./stack-config.ts";
import { DynamicSemaphore } from "./concurrency.ts";
import { BUDGET_REFUSED_EXIT, turnBudgetEnv } from "./turn-budget.ts";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const MODULE_DIR: string = typeof __dirname !== "undefined" && __dirname ? __dirname : path.dirname(fileURLToPath(import.meta.url));
/** The child-side per-turn budget guard (extensions/titan-budget-guard.ts), loaded into every budgeted child with --extension. */
export const BUDGET_GUARD_EXTENSION = path.resolve(MODULE_DIR, "..", "..", "titan-budget-guard.ts");

/** What a budgeted child's guard wrote to its state file (turn-budget.ts TurnBudgetGuard.snapshot). */
export interface BudgetGuardState {
	state: "armed" | "turn" | "refused";
	start?: { usdMicros?: number; tokens?: number };
	spent?: { usdMicros: number; tokens: number };
	/** The worst case of a turn that was sent but whose end the guard never saw. */
	pending?: { usdMicros: number; tokens: number };
	left?: { usdMicros?: number; tokens?: number };
	turns?: number;
	refusal?: { reason: string; dimension?: "usd" | "tokens"; remaining?: number; needed?: number };
}

export function readBudgetGuardState(statePath: string | undefined): BudgetGuardState | undefined {
	if (!statePath) return undefined;
	try {
		const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
		return parsed && typeof parsed === "object" && typeof parsed.state === "string" ? (parsed as BudgetGuardState) : undefined;
	} catch {
		return undefined;
	}
}

const KILL_GRACE_MS = 5_000; // SIGTERM → SIGKILL escalation window

/**
 * The one cap on live titan children (settings.maxConcurrentChildren, default 8).
 * Fan-out numbers are pool sizes; this is how many processes may run at once.
 */
export const childSlots = new DynamicSemaphore(() => {
	const raw = (readStackSettings() as any).maxConcurrentChildren;
	return typeof raw === "number" && Number.isFinite(raw) ? raw : 8;
});

/** Locate the running pi binary so we can re-invoke it as a child. */
export function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1]; // the entry script pi itself was launched with
	const isBunVirtual = script?.startsWith("/$bunfs/root/"); // bun-compiled binaries mount a virtual fs
	// Best case: re-run the exact same entry script with the same runtime.
	if (script && !isBunVirtual && fs.existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	// A compiled pi binary (execPath IS pi): invoke it directly.
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	// Last resort: whatever `pi` resolves to on PATH.
	return { command: "pi", args };
}

/** A live in-flight spend cap (workflow budgets): micro-USD and/or tokensIn+tokensOut; an absent dimension is uncapped. */
export interface SpendCap {
	usdMicros?: number;
	tokens?: number;
}

/**
 * May the watchdog pre-empt this child (halt it, run an inspector on the architect's model,
 * then re-dispatch)? Not when a workflow budget meters the call (`spendCap` set): the
 * inspector and the re-dispatch would spend outside the call's reservation, so pre-emption
 * is refused for budgeted calls and the child simply runs on under its in-flight cap.
 */
export function watchdogPreemptionAllowed(opts: { spendCap?: unknown }): boolean {
	return !opts.spendCap;
}

/**
 * True when the run has reached `cap` in any capped dimension (observed spend ≥ cap — at the
 * cap there is no room for another message), or, given the largest single message seen so far,
 * when one more message of that size would pass the cap. The child is then stopped before it
 * starts its next model turn, so a child whose messages do not grow never passes its cap.
 */
export function overSpendCap(run: Pick<AgentRun, "costUsd" | "tokensIn" | "tokensOut">, cap: SpendCap | undefined, largestMessage: SpendCap = {}): boolean {
	if (!cap) return false;
	if (typeof cap.usdMicros === "number" && usdMicrosOf(run.costUsd) + (largestMessage.usdMicros ?? 0) >= cap.usdMicros) return true;
	if (typeof cap.tokens === "number" && run.tokensIn + run.tokensOut + (largestMessage.tokens ?? 0) >= cap.tokens) return true;
	return false;
}

/** True only when observed spend has PASSED `cap` in a capped dimension (the guarded-child backstop). */
export function overSpendCapStrict(run: Pick<AgentRun, "costUsd" | "tokensIn" | "tokensOut">, cap: SpendCap | undefined): boolean {
	if (!cap) return false;
	if (typeof cap.usdMicros === "number" && usdMicrosOf(run.costUsd) > cap.usdMicros) return true;
	if (typeof cap.tokens === "number" && run.tokensIn + run.tokensOut > cap.tokens) return true;
	return false;
}

/**
 * What the child's guard charged in each dimension it bounded (spent + the worst case of a turn whose end it never
 * saw). The guard charges a turn's planned worst case for every dimension the turn did not report, so this is ≥ the
 * spend the parent observed from the same events: settlement takes the larger (workflow-runtime.ts resultOf).
 */
export function guardCharged(guard: BudgetGuardState | undefined): { usdMicros?: number; tokens?: number } | undefined {
	if (!guard || !guard.spent) return undefined;
	const out: { usdMicros?: number; tokens?: number } = {};
	const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
	if (guard.start?.usdMicros !== undefined) out.usdMicros = n(guard.spent.usdMicros) + n(guard.pending?.usdMicros);
	if (guard.start?.tokens !== undefined) out.tokens = n(guard.spent.tokens) + n(guard.pending?.tokens);
	return out;
}

/** USD → micro-USD rounded up (budget.ts usdToMicrosCeil; duplicated to keep child-runner free of workflow imports). */
const usdMicrosOf = (usd: number): number => Math.max(0, Math.ceil(Math.round(usd * 1e9) / 1e3));

/**
 * Spawn one `pi --mode json -p` child agent and stream its JSON events into `run`.
 * Final answer = last assistant text part. The child writes its session into a
 * throwaway --session-dir under the run's /tmp artifacts dir.
 */
/**
 * The child's final tool list: the /stack policy (childToolsFor) over the command's request,
 * plus `extraTools` appended AFTER it. `--tools` is a strict allowlist across built-in AND
 * extension tools and `--no-tools` disables extension tools too, so a node that must reach
 * `submit_result` (structured output v2) names it here and it survives subagentTools=off.
 */
export function effectiveChildTools(requested: string | "none", extraTools?: string[]): string | "none" {
	const extra = [...new Set((extraTools ?? []).map((t) => t.trim()).filter(Boolean))];
	const policy = childToolsFor(requested);
	if (policy === "none") return extra.length ? extra.join(",") : "none";
	return [...new Set([...policy.split(","), ...extra])].join(",");
}

export function runChild(opts: {
	run: AgentRun; // mutated live
	prompt: string;
	systemPrompt?: string;
	appendSystemPrompts?: string[]; // appended AFTER the base prompt (override or pi default) via pi's repeatable flag
	tools: string | "none";
	thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	sessionDir: string;
	sessionId?: string; // stable per-role session — the agent keeps its context across commands
	fork?: string; // fork this session FILE (copy-on-write) — the child inherits the host's full context
	resume?: string; // resume this session id inside sessionDir (later auto-validate rounds re-enter the fork)
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal; // escape key — kill this child and settle it as "aborted"
	priority?: boolean; // reviewers/inspectors bypass the concurrency cap so they never wait behind the children they review
	env?: Record<string, string>; // extra child environment (workflow nodes: ARTIFACTS_DIR, TITAN_NODE_*); never overrides the child marker
	extraTools?: string[]; // extension tools appended AFTER the /stack policy (structured output v2: `submit_result` must survive subagentTools=off and --no-tools)
	onUsage?: (run: AgentRun) => "continue" | "halt"; // watchdog pre-emption: consulted after every usage update and child compaction event; "halt" kills the child at its next tool_execution_end (run.preempted = true)
	spendCap?: () => SpendCap | undefined; // workflow budgets: read at spawn and handed to the child's per-turn guard (titan-budget-guard.ts bounds every model turn BEFORE it is sent); re-read after every usage update as the parent-side backstop kill (run.budgetHalted = true)
}): Promise<AgentRun> {
	const run = opts.run;
	// Workflow budgets: the child-side guard. The cap at spawn is what this child may spend (its reservation, held
	// exclusively in every scope); the guard clamps each model turn's output cap so the turn's worst case fits, or
	// refuses the turn before the request is sent. A cap that cannot be read refuses the call before spawn.
	let guardEnv: Record<string, string> = {};
	let guardArgs: string[] = [];
	if (opts.spendCap) {
		let cap: SpendCap | undefined;
		try {
			cap = opts.spendCap();
		} catch {
			cap = { usdMicros: 0, tokens: 0 };
		}
		if (cap && (cap.usdMicros !== undefined || cap.tokens !== undefined)) {
			run.budgetStatePath = path.join(opts.sessionDir, `budget-guard-${randomUUID()}.json`);
			guardEnv = turnBudgetEnv(cap, run.budgetStatePath);
			guardArgs = ["--extension", BUDGET_GUARD_EXTENSION];
		}
	}
	run.thinking = opts.thinking;
	// Children load the host's extensions so extension-registered providers (for
	// example antigravity/*) resolve inside them. Recursion is guarded by the
	// STACK_CHILD_ENV marker: every titan-harness extension returns early in a
	// child, so no harness commands, pickers, or status bars run there. Skills and
	// context files stay off — the child's contract comes from the prompt files.
	const args: string[] = [
		"--mode",
		"json",
		"-p",
		"--session-dir",
		opts.sessionDir,
		"--no-skills",
		"--no-context-files",
		"--thinking",
		opts.thinking,
		"--model",
		run.model,
		...guardArgs,
	];
	// Session identity, in precedence order: fork the host > resume an earlier fork > pinned per-role id.
	if (opts.fork) args.push("--fork", opts.fork);
	else if (opts.resume) args.push("--session", opts.resume);
	else if (opts.sessionId) args.push("--session-id", opts.sessionId);
	if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
	// Appends ride pi's own --append-system-prompt (repeatable): they land after the
	// base prompt whether that base is our override or pi's default — the one way to
	// append to a default this process never builds.
	for (const append of opts.appendSystemPrompts ?? []) {
		if (append.trim()) args.push("--append-system-prompt", append);
	}
	// Tier-3 delegation contract for this child: the /stack subagent fan-out cap and the
	// "subagents never spawn subagents" rule travel as an appended system prompt.
	const capHint = subagentCapHint(readStackSettings());
	if (capHint) args.push("--append-system-prompt", capHint);
	// /stack "subagent tools" OFF forces every child to run tool-less, whatever the
	// command asked for; ON keeps the command's own read-only/full-tools contract.
	const effectiveTools = effectiveChildTools(opts.tools, opts.extraTools);
	if (effectiveTools === "none") args.push("--no-tools");
	else args.push("--tools", effectiveTools);
	args.push(opts.prompt);

	return childSlots.acquire({ priority: opts.priority, signal: opts.signal }).then(
		(lease) => runChildWithLease(opts, args, lease, guardEnv),
		() => {
			// Aborted while queued behind the cap: settle without spawning.
			run.notDispatched = true;
			run.status = "aborted";
			run.startedAt = Date.now();
			run.endedAt = run.startedAt;
			run.ms = 0;
			run.exitCode = 130;
			return run;
		},
	);
}

function runChildWithLease(opts: Parameters<typeof runChild>[0], args: string[], lease: { release(): void }, guardEnv: Record<string, string> = {}): Promise<AgentRun> {
	const run = opts.run;
	return new Promise<AgentRun>((resolve) => {
		const started = Date.now();
		let buffer = "";
		let timedOut = false;
		let aborted = false;
		let closed = false;
		// Already stopped before this stage began (e.g. escape during the previous agent):
		// settle without spawning, so an abort never starts new model work.
		if (opts.signal?.aborted) {
			run.notDispatched = true;
			run.status = "aborted";
			run.startedAt = started;
			run.endedAt = started;
			run.ms = 0;
			run.exitCode = 130;
			lease.release();
			resolve(run);
			return;
		}
		run.status = "working";
		run.startedAt = started;
		run.endedAt = undefined;
		run.ms = 0;
		run.text = "";
		run.streamText = "";
		run.streamThinking = "";
		run.exitCode = 0;
		run.stopReason = undefined;
		run.errorMessage = undefined;
		run.stderr = "";
		run.flowMark = run.flow.length;
		// TPS segment 1 opens at spawn: child startup + prompt assembly + the first
		// provider round-trip all count as response time (the tps extension's
		// turn_start fallback has the same shape). Tool execution is excluded by
		// re-opening the segment at every tool_execution_end below.
		run.tpsSegmentStart = performance.now();

		// Watchdog pre-emption: a "halt" verdict is honoured at the next tool boundary, never mid-stream.
		let haltRequested = false;
		const checkUsage = () => {
			if (haltRequested || !opts.onUsage) return;
			try {
				if (opts.onUsage(run) === "halt") haltRequested = true;
			} catch {
				/* the watchdog never breaks a child */
			}
		};
		// Workflow budgets, parent-side BACKSTOP (the child's guard bounds every turn before it is sent): a child at
		// its cap, or one message short of passing it, is killed at once (not at a tool boundary). A budgeted child
		// that reports usage without its guard armed (the guard writes its state file at load, before any turn) is
		// unguarded and is killed too.
		const largestMessage = { usdMicros: 0, tokens: 0 };
		let guardArmed = !run.budgetStatePath;
		const checkSpend = () => {
			if (!opts.spendCap || run.budgetHalted || closed) return;
			if (!guardArmed) guardArmed = readBudgetGuardState(run.budgetStatePath) !== undefined;
			if (!guardArmed) {
				run.budgetHalted = true;
				run.budgetUnguarded = true;
				killChild();
				return;
			}
			let cap: SpendCap | undefined;
			try {
				cap = opts.spendCap();
			} catch {
				// A cap that cannot be read is treated as reached (fail closed).
				run.budgetHalted = true;
				killChild();
				return;
			}
			// With the guard armed every turn was bounded before it was sent, so the backstop only fires on a real
			// overshoot (observed > cap). The look-ahead heuristic would race the guard's own refusal.
			if (run.budgetStatePath ? overSpendCapStrict(run, cap) : overSpendCap(run, cap, largestMessage)) {
				run.budgetHalted = true;
				killChild();
			}
		};
		// One line of the child's JSON event stream → the relevant AgentRun mutation.
		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return; // non-JSON noise on stdout — ignore
			}
			if (event.type === "session" && typeof event.id === "string") {
				run.sessionRef = event.id; // remember the child's session so later rounds can resume it
			} else if (event.type === "message_end" && event.message?.role === "assistant") {
				const msg = event.message;
				let finalizedText = "";
				for (const part of msg.content ?? []) {
					// A turn's reasoning arrives as `thinking` parts (pi-ai ThinkingContent) — a
					// different shape from `text`, which is why it was invisible before.
					if (part.type === "thinking" && part.thinking?.trim()) {
						run.flow.push({ type: "thinking", text: part.thinking });
					}
					if (part.type === "text" && part.text) finalizedText += part.text;
				}
				if (finalizedText.trim()) {
					run.text = finalizedText;
					run.flow.push({ type: "text", text: finalizedText });
				}
				run.streamText = "";
				run.streamThinking = "";
				if (msg.stopReason) run.stopReason = msg.stopReason;
				if (msg.errorMessage) run.errorMessage = msg.errorMessage;
				if (msg.usage) {
					// Only a real reading counts as usage: children emit an opening message_end whose usage fields are all null.
					const u = msg.usage;
					if ([u.input, u.output, u.cacheRead, u.cacheWrite, u.cost?.total].some((v) => typeof v === "number" && Number.isFinite(v) && v > 0)) run.usageSeen = true;
					const before = { usdMicros: usdMicrosOf(run.costUsd), tokens: run.tokensIn + run.tokensOut };
					// Prompt tokens = input + cacheRead + cacheWrite (pi's own definition, see
					// core/cache-stats.ts). cacheWrite is NOT optional accounting: on a cold
					// cache the WHOLE prompt is billed as a write and `input` is only the few
					// uncached tokens — dropping it renders a real 10k-token prompt as "in 3".
					run.tokensIn += (msg.usage.input || 0) + (msg.usage.cacheRead || 0) + (msg.usage.cacheWrite || 0);
					run.tokensOut += msg.usage.output || 0;
					// TPS: close the response segment ONLY when this message carried output
					// tokens — children emit an opening message_end with null usage, and
					// counting its near-instant segment would deflate every reading.
					if ((msg.usage.output || 0) > 0) {
						const now = performance.now();
						if (run.tpsSegmentStart !== undefined) run.tpsSeconds += Math.max(0, now - run.tpsSegmentStart) / 1000;
						run.tpsSegmentStart = now;
					}
					if (msg.usage.cost?.total) run.costUsd += msg.usage.cost.total;
					// Matches pi's calculateContextTokens: `totalTokens || input+output+read+write`
					// (|| not ??, so a provider reporting 0 falls through to the sum).
					const ctxTokens =
						msg.usage.totalTokens || (msg.usage.input || 0) + (msg.usage.cacheRead || 0) + (msg.usage.cacheWrite || 0) + (msg.usage.output || 0);
					// Children emit an opening message_end whose usage fields are all null; this is
					// an assignment, not a sum, so counting one would clobber a real reading with 0.
					if (ctxTokens > 0) run.ctxTokens = ctxTokens;
					largestMessage.usdMicros = Math.max(largestMessage.usdMicros, usdMicrosOf(run.costUsd) - before.usdMicros);
					largestMessage.tokens = Math.max(largestMessage.tokens, run.tokensIn + run.tokensOut - before.tokens);
					checkUsage();
					checkSpend();
				}
			} else if (event.type === "tool_execution_start") {
				run.toolCalls++;
				const name: string = event.toolName ?? "?";
				run.toolNames.push(name);
				const arg = briefArg(event.args);
				run.toolEvents.push({ name, argument: arg });
				run.flow.push({ type: "tool", label: arg ? `${name} ${arg}` : name });
			} else if (event.type === "compaction_start") {
				run.compactionSeen = true; // the child is about to summarize its own context — the watchdog decides
				checkUsage();
			} else if (event.type === "tool_execution_end") {
				// TPS: tool time is NOT response time — the next provider segment starts here.
				run.tpsSegmentStart = performance.now();
				if (haltRequested && !closed && !run.preempted) {
					run.preempted = true;
					killChild();
				}
			} else if (event.type === "message_update" && event.message?.role === "assistant") {
				let t = "";
				let think = "";
				for (const part of event.message.content ?? []) {
					if (part.type === "text" && part.text) t += part.text;
					else if (part.type === "thinking" && part.thinking) think += part.thinking;
				}
				if (t) run.streamText = t;
				// Streaming the reasoning is what makes a long opening turn look ALIVE: an agent
				// at xhigh on a big session can think for minutes before its first token of text,
				// and rendering nothing made it read as hung.
				if (think) run.streamThinking = think;
			}
		};

		const settle = () => {
			run.endedAt = Date.now();
			run.ms = run.endedAt - started;
			// abort wins over runOk: a killed child may still have emitted usable text, but the
			// user asked it to stop — reporting "done" would silently accept a partial answer.
			run.status = aborted ? "aborted" : runOk(run) ? "done" : timedOut ? "timeout" : "failed";
			if (run.preempted) {
				run.status = "aborted";
				run.stopReason = "preempted";
			}
			// The child's guard refused a model turn (the request was never sent): a hard budget refusal.
			const guard = readBudgetGuardState(run.budgetStatePath);
			if (guard) run.budgetGuard = guard;
			if (run.budgetStatePath && (guard?.state === "refused" || run.exitCode === BUDGET_REFUSED_EXIT)) {
				run.budgetRefusal = guard?.refusal ?? { reason: `child exited ${BUDGET_REFUSED_EXIT} (budget refusal) without a readable guard state` };
				run.status = "failed";
				run.stopReason = "budget_refused";
				run.errorMessage = `budget refused a model turn: ${run.budgetRefusal.reason}`;
			}
			if (run.budgetHalted) {
				run.status = "aborted";
				run.stopReason = "budget";
				run.errorMessage = run.budgetUnguarded
					? "stopped: a budgeted child reported usage without its per-turn budget guard armed"
					: "stopped: observed spend exceeded the workflow budget's in-flight cap";
			}
			run.streamText = "";
			run.streamThinking = "";
		};

		const invocation = piInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: opts.cwd,
			shell: false,
			detached: process.platform !== "win32", // own process group so cancellation reaches tool/bash descendants
			stdio: ["ignore", "pipe", "pipe"],
			// Children still make their real model API calls — this only skips startup chores.
			env: { ...process.env, ...(opts.env ?? {}), ...guardEnv, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", [STACK_CHILD_ENV]: "1" },
		});

		// Line-buffer stdout: events arrive one JSON object per line, possibly split across chunks.
		proc.stdout?.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || ""; // keep the trailing partial line for the next chunk
			for (const line of lines) processLine(line);
		});
		proc.stderr?.on("data", (data: Buffer) => {
			run.stderr += data.toString();
		});
		const signalTree = (signal: NodeJS.Signals) => {
			try {
				if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, signal);
				else proc.kill(signal);
			} catch {
				try { proc.kill(signal); } catch {}
			}
		};
		// SIGTERM, then SIGKILL after the grace period. ChildProcess.killed only means a
		// signal was sent, so escalation tracks the close/error event explicitly.
		const killChild = () => {
			signalTree("SIGTERM");
			setTimeout(() => {
				if (!closed) {
					signalTree("SIGKILL");
				}
			}, KILL_GRACE_MS);
		};
		const onAbort = () => {
			aborted = true;
			killChild();
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		const cleanup = () => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
		};

		proc.on("close", (code) => {
			closed = true;
			if (buffer.trim()) processLine(buffer); // flush a final unterminated line
			run.exitCode = aborted ? 130 : timedOut ? 124 : (code ?? 0);
			cleanup();
			settle();
			lease.release();
			resolve(run);
		});
		proc.on("error", (err) => {
			closed = true;
			run.stderr += `\nspawn error: ${String(err)}`;
			run.exitCode = 1;
			cleanup();
			settle();
			lease.release();
			resolve(run);
		});

		// Wall-clock timeout uses the exact same close-aware escalation as escape.
		const timer = setTimeout(() => {
			timedOut = true;
			killChild();
		}, opts.timeoutMs);
	});
}

/** Run a plain subprocess (the validation gate) and capture combined output. */
export function runProc(
	command: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ code: number; output: string; aborted?: boolean }> {
	return new Promise((resolve) => {
		let output = "";
		let timedOut = false;
		let aborted = false;
		// A gate can burn the full 120s timeout; escape must cut it short like any child.
		if (signal?.aborted) {
			resolve({ code: 130, output: "[stopped by user before the gate ran]", aborted: true });
			return;
		}
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(command, args, { cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			resolve({ code: 127, output: `failed to spawn ${command}: ${String(err)}` });
			return;
		}
		const killTree = () => {
			try {
				if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGKILL");
				else proc.kill("SIGKILL");
			} catch {
				try { proc.kill("SIGKILL"); } catch {}
			}
		};
		const onAbort = () => {
			aborted = true;
			killTree();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		proc.stdout?.on("data", (d: Buffer) => {
			output += d.toString();
		});
		proc.stderr?.on("data", (d: Buffer) => {
			output += d.toString();
		});
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		proc.on("close", (code) => {
			cleanup();
			if (aborted) {
				resolve({ code: 130, output: `${output}\n[stopped by user]`, aborted: true });
				return;
			}
			resolve({ code: timedOut ? 124 : (code ?? 0), output: timedOut ? `${output}\n[gate timed out]` : output });
		});
		proc.on("error", (err) => {
			cleanup();
			resolve({ code: 127, output: `${output}\nspawn error: ${String(err)}` });
		});
		const timer = setTimeout(() => {
			timedOut = true;
			killTree();
		}, timeoutMs);
	});
}
