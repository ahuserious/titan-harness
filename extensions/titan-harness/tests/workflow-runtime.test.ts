import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NODE_HOOKS_ENV } from "../modules/child-hooks.ts";
import { RunStore } from "../modules/run-store.ts";
import type { AgentRun } from "../modules/runtime.ts";
import { DEFAULT_STACK_SETTINGS } from "../modules/stack-config.ts";
import type { AgentRequest } from "../modules/workflow/executor.ts";
import type { LoadedWorkflow } from "../modules/workflow/loader.ts";
import { createAgentRunner, createApproval, createScriptRunner, createWorkflowRuntime, findBinary, resultOf, runProcess, transcriptRole } from "../modules/workflow-runtime.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-wf-runtime-"));
	dirs.push(dir);
	return dir;
};

const request = (over: Partial<AgentRequest> = {}): AgentRequest => ({
	nodeId: "n1",
	role: "worker",
	model: "cerebras/qwen-3.8-27b",
	thinking: "xhigh",
	prompt: "hello",
	tools: "read,grep",
	context: "fresh",
	timeoutMs: 1000,
	...over,
});

/** A fake runChild: settles the run the way child-runner would, and records what it was asked. */
function fakeRunChild(behaviour: "done" | "failed" | "aborted" | "throw" = "done") {
	const calls: any[] = [];
	const runChild = async (opts: any): Promise<AgentRun> => {
		calls.push(opts);
		if (behaviour === "throw") throw new Error("spawn exploded");
		const run = opts.run as AgentRun;
		run.sessionRef = `sess-${calls.length}`;
		run.tokensIn = 10;
		run.tokensOut = 5;
		run.costUsd = 0.001;
		run.tpsSeconds = 0.5;
		run.toolCalls = 1;
		if (behaviour === "done") {
			run.text = "OK";
			run.status = "done";
		} else if (behaviour === "failed") {
			run.status = "failed";
			run.exitCode = 1;
			run.errorMessage = "provider said no";
		} else {
			run.status = "aborted";
			run.exitCode = 130;
		}
		return run;
	};
	return { runChild: runChild as any, calls };
}

describe("createAgentRunner", () => {
	test("maps a request onto runChild: fresh session id, normalized thinking, hooks env, priority for reviewers", async () => {
		const dir = scratch();
		const fake = fakeRunChild();
		const seen: Array<[AgentRun, AgentRequest]> = [];
		const agent = createAgentRunner({ runChild: fake.runChild, sessionsDir: join(dir, "sessions"), cwd: dir, onRun: (run, req) => seen.push([run, req]) });
		const hooks = { PreToolUse: [{ matcher: "bash", response: { hookSpecificOutput: { permissionDecision: "deny" as const } } }] };
		const result = await agent(request({ role: "auditor", hooks, env: { TITAN_NODE_ID: "n1" } }));
		expect(result).toMatchObject({ ok: true, text: "OK", sessionRef: "sess-1", toolCalls: 1, model: "cerebras/qwen-3.8-27b" });
		expect(result.usage).toEqual({ tokensIn: 10, tokensOut: 5, costUsd: 0.001, tpsSeconds: 0.5 });
		const call = fake.calls[0];
		expect(call.thinking).toBe("high"); // xhigh↘high on qwen
		expect(call.sessionDir).toBe(join(dir, "sessions"));
		expect(typeof call.sessionId).toBe("string");
		expect(call.resume).toBeUndefined();
		expect(call.priority).toBe(true);
		expect(call.tools).toBe("read,grep");
		expect(call.env.TITAN_NODE_ID).toBe("n1");
		expect(JSON.parse(call.env[NODE_HOOKS_ENV]).PreToolUse).toHaveLength(1);
		expect(call.run.role).toBe("AUDITOR");
		expect(existsSync(join(dir, "sessions"))).toBe(true);
		expect(seen).toHaveLength(1);
	});

	test("a resume context re-enters the session instead of minting an id; workers are not priority", async () => {
		const dir = scratch();
		const fake = fakeRunChild();
		const agent = createAgentRunner({ runChild: fake.runChild, sessionsDir: join(dir, "s"), cwd: dir });
		await agent(request({ context: { resume: "sess-9" } }));
		expect(fake.calls[0].resume).toBe("sess-9");
		expect(fake.calls[0].sessionId).toBeUndefined();
		expect(fake.calls[0].priority).toBe(false);
		expect(fake.calls[0].run.role).toBe("BUILDER");
	});

	test("failed, aborted and thrown children become ok:false with a reason; a missing model never spawns", async () => {
		const dir = scratch();
		for (const [behaviour, needle] of [
			["failed", "provider said no"],
			["aborted", "aborted"],
			["throw", "spawn exploded"],
		] as const) {
			const fake = fakeRunChild(behaviour);
			const agent = createAgentRunner({ runChild: fake.runChild, sessionsDir: join(dir, behaviour), cwd: dir });
			const result = await agent(request());
			expect(result.ok).toBe(false);
			expect(result.error).toContain(needle);
		}
		const fake = fakeRunChild();
		const agent = createAgentRunner({ runChild: fake.runChild, sessionsDir: join(dir, "none"), cwd: dir });
		const result = await agent(request({ model: undefined }));
		expect(result.ok).toBe(false);
		expect(result.error).toContain("no model resolved");
		expect(fake.calls).toHaveLength(0);
	});

	test("transcriptRole and resultOf", () => {
		expect(transcriptRole("architect")).toBe("ARCHITECT");
		expect(transcriptRole("judge")).toBe("FUSION");
		expect(transcriptRole("builder")).toBe("BUILDER");
		expect(transcriptRole("verifier")).toBe("VALIDATOR");
		const run = { status: "timeout", text: "", tokensIn: 0, tokensOut: 0, costUsd: 0, tpsSeconds: 0, toolCalls: 0, model: "a/b", exitCode: 124 } as unknown as AgentRun;
		expect(resultOf(run)).toMatchObject({ ok: false, error: "timed out" });
	});
});

describe("runProcess", () => {
	test("separates stdout and stderr, passes env and cwd, reports the exit code", async () => {
		const dir = scratch();
		const result = await runProcess("bash", ["-c", 'echo "out $TITAN_X"; echo err >&2; pwd; exit 3'], { cwd: dir, timeoutMs: 5000, env: { TITAN_X: "y" } });
		expect(result.code).toBe(3);
		expect(result.stdout).toContain("out y");
		expect(result.stdout).toContain(dir);
		expect(result.stderr.trim()).toBe("err");
	});

	test("a timeout kills the process (124) and an abort settles it as 130", async () => {
		const dir = scratch();
		const slow = await runProcess("bash", ["-c", "sleep 5; echo late"], { cwd: dir, timeoutMs: 200 });
		expect(slow.code).toBe(124);
		expect(slow.stderr).toContain("timed out");
		const controller = new AbortController();
		const pending = runProcess("bash", ["-c", "sleep 5"], { cwd: dir, timeoutMs: 5000, signal: controller.signal });
		setTimeout(() => controller.abort(), 100);
		const aborted = await pending;
		expect(aborted.code).toBe(130);
		controller.abort();
		const never = await runProcess("bash", ["-c", "echo x"], { cwd: dir, timeoutMs: 1000, signal: controller.signal });
		expect(never.code).toBe(130);
	});

	test("a missing binary is exit 127, not an exception", async () => {
		const result = await runProcess("/definitely/not/here", [], { cwd: scratch(), timeoutMs: 1000 });
		expect(result.code).toBe(127);
		expect(result.stderr).toContain("spawn error");
	});
});

describe("createScriptRunner", () => {
	test("inline bun scripts run from tmpDir with argv; a missing runtime is 127", async () => {
		const dir = scratch();
		const bun = findBinary("bun", [join(process.env.HOME ?? "", ".bun", "bin")]);
		if (!bun) return; // no bun on this machine: nothing to assert (the suite itself runs on bun, so this is theoretical)
		const script = createScriptRunner({ tmpDir: join(dir, "tmp"), bun });
		const result = await script({ runtime: "bun", inline: 'console.log(JSON.stringify({ argv: process.argv.slice(2), env: process.env.TITAN_NODE_ID }))' }, { cwd: dir, timeoutMs: 20000, env: { TITAN_NODE_ID: "s1" }, argv: ["a b"] });
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toEqual({ argv: ["a b"], env: "s1" });
		expect(existsSync(join(dir, "tmp", "script-1.ts"))).toBe(true);
		const missing = createScriptRunner({ tmpDir: join(dir, "tmp"), uv: "/no/such/uv" });
		const uv = await missing({ runtime: "uv", inline: "print(1)" }, { cwd: dir, timeoutMs: 1000 });
		expect(uv.code).toBe(127);
		const neither = await script({ runtime: "bun" }, { cwd: dir, timeoutMs: 1000 });
		expect(neither.code).toBe(2);
	});
});

describe("createApproval", () => {
	test("headless → rejected with a reason; confirm + input drive the answer", async () => {
		expect(await createApproval(undefined)("go?")).toEqual({ approved: false, response: "headless session: no approver available" });
		const prompts: string[] = [];
		const ui = {
			confirm: async (_title: string, body: string) => {
				prompts.push(body);
				return body.includes("yes");
			},
			input: async (title: string) => (title.startsWith("Why") ? "needs tests" : "ship it"),
			notify: () => {},
		};
		const approval = createApproval(ui);
		expect(await approval("say yes")).toEqual({ approved: true });
		expect(await approval("say yes", { captureResponse: true })).toEqual({ approved: true, response: "ship it" });
		expect(await approval("say no", { captureResponse: true })).toEqual({ approved: false, response: "needs tests" });
		expect(prompts).toHaveLength(3);
		const rejecting = createApproval({ ...ui, input: async () => "no, redo it" });
		expect(await rejecting("say yes", { captureResponse: true })).toEqual({ approved: false, response: "no, redo it" });
	});
});

describe("createWorkflowRuntime", () => {
	test("assembles the deps: artifacts dir, bash over runProcess, notify via the ui seam, optional bridges", async () => {
		const dir = scratch();
		const store = new RunStore(join(dir, "runs"));
		const opened = store.open({ projectSlug: "p", cwd: dir, command: "workflow", status: "running" });
		const loaded = { name: "wf", doc: { nodes: [] } } as unknown as LoadedWorkflow;
		const notes: string[] = [];
		const fake = fakeRunChild();
		const deps = createWorkflowRuntime({
			cwd: dir,
			runId: opened.runId,
			runDir: opened.dir,
			loaded,
			store,
			settings: DEFAULT_STACK_SETTINGS,
			runChild: fake.runChild,
			resolveRole: () => ({ model: "a/b", thinking: "high", callsign: "x", appendSystemPrompts: [], tools: "read" }),
			ui: { confirm: async () => true, notify: (text) => notes.push(text) },
		});
		expect(deps.artifactsDir).toBe(join(opened.dir, "artifacts"));
		expect(existsSync(deps.artifactsDir)).toBe(true);
		expect(deps.workflowId).toBe("wf");
		expect(deps.mcpTool).toBeUndefined();
		expect(deps.runWorkflow).toBeUndefined();
		const bash = await deps.bash("printf '%s' \"$ARTIFACTS_DIR\"", { cwd: dir, timeoutMs: 5000, env: { ARTIFACTS_DIR: deps.artifactsDir } });
		expect(bash).toEqual({ code: 0, stdout: deps.artifactsDir, stderr: "" });
		deps.notify("hi", "warning");
		expect(notes).toEqual(["hi"]);
		expect(await deps.approval("ok?")).toEqual({ approved: true });
		const result = await deps.agent(request());
		expect(result.ok).toBe(true);
		expect(fake.calls[0].sessionDir).toBe(join(opened.dir, "sessions"));
		expect(readFileSync(join(opened.dir, "run.json"), "utf8")).toContain("workflow");
	});
});
