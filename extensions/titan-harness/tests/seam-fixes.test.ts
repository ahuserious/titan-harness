/**
 * N3-10 seam fixes (reported by lane N1 from real /workflow runs):
 *   1. McpClient kept the caller's explicit `undefined` timeouts over its defaults, so every
 *      bridge-built client timed out on initialize at once ("after undefined ms").
 *   2. The /stack child policy (childSubagents/childExa) widened an explicit allowed_tools,
 *      and agent.start recorded the requested list instead of the list the child held.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBMIT_RESULT_TOOL } from "../modules/child-hooks.ts";
import { effectiveChildTools } from "../modules/child-runner.ts";
import { sha256 } from "../modules/hash-chain.ts";
import { createMcpToolBridge, DEFAULT_CALL_TIMEOUT_MS, DEFAULT_START_TIMEOUT_MS, McpClient, type McpServerConfig } from "../modules/mcp-client.ts";
import { EVENTS_FILE, RunStore } from "../modules/run-store.ts";
import type { AgentRun } from "../modules/runtime.ts";
import { childToolsFor, DEFAULT_STACK_SETTINGS, EXA_TOOL_NAMES, type StackSettings, SUBAGENT_TOOL } from "../modules/stack-config.ts";
import { agentChildTools, createAgentRunner } from "../modules/workflow-runtime.ts";
import { type RunResult, type WorkflowRuntimeDeps, executeWorkflow } from "../modules/workflow/executor.ts";
import type { LoadedWorkflow } from "../modules/workflow/loader.ts";
import type { NodeDoc, WorkflowDoc } from "../modules/workflow/schema.ts";

const FAKE_SERVER = join(import.meta.dir, "fixtures", "mcp", "fake-server.mjs");
const READONLY = ["read", "grep", "find", "ls"];
/** N1's bench policy: child Exa on, child subagents for all, fan-out 4. */
const BENCH: StackSettings = { ...DEFAULT_STACK_SETTINGS, subagentTools: true, childExa: true, childSubagents: "all", subagentFanOut: 4 };
const TOOLS_OFF: StackSettings = { ...BENCH, subagentTools: false };

const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (closers.length) await closers.pop()!();
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-seam-"));
	dirs.push(dir);
	return dir;
};
const fakeConfig = (): McpServerConfig => ({ name: "fake", transport: "stdio", command: process.execPath, args: [FAKE_SERVER], env: {}, envNames: [], disabled: false, sources: [] });

// ═══ Bug 1: McpClient default timeouts ═══════════════════════════════════════

describe("McpClient: explicit undefined options keep the defaults", () => {
	test("timeoutMs/startTimeoutMs undefined → DEFAULT_*; explicit values still win", () => {
		const unset = new McpClient(fakeConfig(), { timeoutMs: undefined, startTimeoutMs: undefined });
		expect((unset as any).opts.timeoutMs).toBe(DEFAULT_CALL_TIMEOUT_MS);
		expect((unset as any).opts.startTimeoutMs).toBe(DEFAULT_START_TIMEOUT_MS);
		const set = new McpClient(fakeConfig(), { timeoutMs: 1234, startTimeoutMs: 5678 });
		expect((set as any).opts.timeoutMs).toBe(1234);
		expect((set as any).opts.startTimeoutMs).toBe(5678);
	});

	test("a bridge built without timeouts initialises and calls the fake server", async () => {
		const bridge = createMcpToolBridge({ catalog: [fakeConfig()] }); // timeoutMs/startTimeoutMs undefined, as in production
		closers.push(() => bridge.close());
		expect(await bridge.mcpTool("fake", "echo", { a: 1 })).toEqual({ echoed: { a: 1 } });
		expect(bridge.status()[0]).toMatchObject({ server: "fake", state: "running", calls: 1 });
	});

	test("an mcp_tool node against the fake server initialises and succeeds through the engine", async () => {
		const bridge = createMcpToolBridge({ catalog: [fakeConfig()], timeoutMs: undefined, startTimeoutMs: undefined });
		closers.push(() => bridge.close());
		const e = engine(scratch(), BENCH, { mcpTool: (server, tool, args) => bridge.mcpTool(server, tool, args) });
		const result = await e.run([{ id: "identity", mcp_tool: { server: "fake", tool: "echo", args: { who: "me" } } } as NodeDoc]);
		expect(result.status).toBe("completed");
		expect(result.nodes.identity.output).toEqual({ echoed: { who: "me" } });
	});
});

// ═══ Bug 2: explicit allowed_tools is final ═════════════════════════════════

describe("childToolsFor: an explicit list is final", () => {
	test("[read,grep,find,ls] with the bench policy gives exactly those 4 tools", () => {
		expect(childToolsFor(READONLY.join(","), { final: true, settings: BENCH })).toBe(READONLY.join(","));
		expect(effectiveChildTools(READONLY.join(","), [], { final: true, settings: BENCH })).toBe(READONLY.join(","));
	});

	test("the tools-off policy still narrows an explicit list", () => {
		expect(childToolsFor(READONLY.join(","), { final: true, settings: TOOLS_OFF })).toBe("none");
		expect(effectiveChildTools(READONLY.join(","), [SUBMIT_RESULT_TOOL], { final: true, settings: TOOLS_OFF })).toBe(SUBMIT_RESULT_TOOL);
	});

	test("a list that was not declared explicitly still gets the policy additions", () => {
		const widened = (childToolsFor(READONLY.join(","), { settings: BENCH }) as string).split(",");
		expect(widened).toEqual([...READONLY, SUBAGENT_TOOL, ...EXA_TOOL_NAMES]);
		const off = { ...BENCH, childExa: false, childSubagents: "off" as const };
		expect(childToolsFor(READONLY.join(","), { settings: off })).toBe(READONLY.join(","));
	});
});

describe("workflow nodes: effective child tools and the agent.start record", () => {
	test("allowed_tools [read,grep,find,ls] → the child gets exactly those, and agent.start records them", async () => {
		const e = engine(scratch(), BENCH);
		const result = await e.run([{ id: "brief", prompt: "Summarise.", allowed_tools: READONLY } as NodeDoc]);
		expect(result.status).toBe("completed");
		expect(e.calls[0].toolsFinal).toBe(true);
		expect(e.calls[0].resolvedTools).toBe(READONLY.join(","));
		const start = e.events().find((ev) => ev.type === "agent.start")!;
		expect(start.data.tools).toBe(READONLY.join(","));
	});

	test("a node without allowed_tools gets the policy additions, and agent.start records the widened list", async () => {
		const e = engine(scratch(), BENCH);
		const result = await e.run([{ id: "free", prompt: "Research." } as NodeDoc]);
		expect(result.status).toBe("completed");
		const expected = [...READONLY, SUBAGENT_TOOL, ...EXA_TOOL_NAMES].join(",");
		expect(e.calls[0].toolsFinal).toBeUndefined();
		expect(e.calls[0].resolvedTools).toBe(expected);
		const start = e.events().find((ev) => ev.type === "agent.start")!;
		expect(start.data.tools).toBe(expected);
		expect(start.data.requestedTools).toBe(READONLY.join(","));
	});

	test("an output_format node records submit_result in its effective list", async () => {
		const e = engine(scratch(), BENCH, {}, JSON.stringify({ answer: "x" }));
		await e.run([{ id: "typed", prompt: "Answer.", allowed_tools: ["read"], output_format: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } } as NodeDoc]);
		const start = e.events().find((ev) => ev.type === "agent.start")!;
		expect(start.data.tools).toBe(`read,${SUBMIT_RESULT_TOOL}`);
		expect(agentChildTools({ tools: "read", toolsFinal: true, outputSchema: { type: "object" } }, BENCH)).toBe(`read,${SUBMIT_RESULT_TOOL}`);
	});
});

// ═══ Engine harness ══════════════════════════════════════════════════════════

function engine(cwd: string, settings: StackSettings, extra: Partial<WorkflowRuntimeDeps> = {}, answer = "done") {
	const store = new RunStore(scratch());
	const { runId, dir: runDir } = store.open({ projectSlug: RunStore.projectSlug(cwd), cwd, workflow: { name: "t", sha256: sha256("t") }, command: "workflow" });
	const calls: any[] = [];
	const runChild = (async (opts: any): Promise<AgentRun> => {
		calls.push(opts);
		const run = opts.run as AgentRun;
		run.text = answer;
		run.exitCode = 0;
		run.status = "done";
		return run;
	}) as any;
	const deps: WorkflowRuntimeDeps = {
		cwd,
		runId,
		runDir,
		artifactsDir: join(runDir, "artifacts"),
		workflowId: "t",
		store,
		settings,
		agent: createAgentRunner({ runChild, sessionsDir: join(runDir, "sessions"), cwd }),
		childTools: (req) => agentChildTools(req, settings),
		async bash() {
			return { code: 0, stdout: "", stderr: "" };
		},
		async script() {
			return { code: 0, stdout: "", stderr: "" };
		},
		async approval() {
			return { approved: true };
		},
		notify() {},
		resolveRole(role) {
			return { model: "stub/model", thinking: "medium", callsign: `${role}-1`, appendSystemPrompts: [], tools: READONLY.join(",") };
		},
		...extra,
	};
	const run = (nodes: NodeDoc[]): Promise<RunResult> => {
		const doc: WorkflowDoc = { apiVersion: "titan.harness/v1", name: "t", nodes };
		const loaded = { doc, normalized: doc, name: "t", dir: cwd, path: join(cwd, "t.yaml"), sha256: sha256("t"), source: "project", commands: {}, scripts: {}, validation: { ok: true, errors: [], warnings: [] } } as LoadedWorkflow;
		return executeWorkflow(loaded, deps, {});
	};
	const events = (): Array<{ type: string; data: Record<string, any> }> =>
		readFileSync(join(runDir, EVENTS_FILE), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	return { run, calls, events };
}
