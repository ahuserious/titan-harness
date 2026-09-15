import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NODE_RESULT_PATH_ENV, NODE_SCHEMA_ENV, SUBMIT_RESULT_INSTRUCTION, SUBMIT_RESULT_TOOL } from "../modules/child-hooks.ts";
import { effectiveChildTools } from "../modules/child-runner.ts";
import { sha256 } from "../modules/hash-chain.ts";
import { RunStore } from "../modules/run-store.ts";
import type { AgentRun } from "../modules/runtime.ts";
import { DEFAULT_STACK_SETTINGS, readStackSettings } from "../modules/stack-config.ts";
import { createAgentRunner, resolveSchemaRefs } from "../modules/workflow-runtime.ts";
import { type AgentRequest, type RunResult, type WorkflowRuntimeDeps, executeWorkflow } from "../modules/workflow/executor.ts";
import type { LoadedWorkflow } from "../modules/workflow/loader.ts";
import type { NodeDoc, WorkflowDoc } from "../modules/workflow/schema.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-so-v2-"));
	dirs.push(dir);
	return dir;
};

const ANSWER_SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };

type Script = { file?: unknown; text?: string; fail?: string };

/** A fake runChild: writes the v2 result file when the script says so, else answers with text (v1). */
function fakeRunChild(scripts: Script[]) {
	const calls: any[] = [];
	const runChild = async (opts: any): Promise<AgentRun> => {
		calls.push(opts);
		const script = scripts.shift() ?? { text: "plain answer" };
		const run = opts.run as AgentRun;
		run.sessionRef = `sess-${calls.length}`;
		run.tokensIn = 20;
		run.tokensOut = 4;
		run.exitCode = 0;
		if (script.fail) {
			run.status = "failed";
			run.exitCode = 1;
			run.errorMessage = script.fail;
			return run;
		}
		if (script.file !== undefined) {
			const file = opts.env[NODE_RESULT_PATH_ENV];
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, `${JSON.stringify(script.file)}\n`);
			run.text = ""; // a child that stops right after submit_result has no closing prose
			run.status = "failed"; // exactly what child-runner's runOk() would settle on for empty text
			return run;
		}
		run.text = script.text ?? "";
		run.status = run.text.trim() ? "done" : "failed";
		return run;
	};
	return { runChild: runChild as any, calls };
}

const request = (over: Partial<AgentRequest> = {}): AgentRequest => ({ nodeId: "n1", role: "worker", model: "cerebras/qwen-3.8-27b", thinking: "medium", prompt: "Answer.", tools: "none", context: "fresh", timeoutMs: 1000, outputSchema: ANSWER_SCHEMA, ...over });

describe("createAgentRunner — structured output v2", () => {
	test("exports the schema and result path, names submit_result, ends the prompt with the instruction and reads the typed object back", async () => {
		const dir = scratch();
		const fake = fakeRunChild([{ file: { answer: "42" } }]);
		const agent = createAgentRunner({ runChild: fake.runChild, sessionsDir: join(dir, "sessions"), cwd: dir });
		const result = await agent(request());
		expect(result.ok).toBe(true);
		expect(result.value).toEqual({ answer: "42" });
		expect(result.text).toBe(JSON.stringify({ answer: "42" }));
		expect(result.resultPath).toBe(join(dir, "sessions", "..", "results", "n1-1.json"));
		const call = fake.calls[0];
		expect(JSON.parse(call.env[NODE_SCHEMA_ENV])).toEqual(ANSWER_SCHEMA);
		expect(call.env[NODE_RESULT_PATH_ENV]).toBe(result.resultPath);
		expect(call.extraTools).toEqual([SUBMIT_RESULT_TOOL]);
		expect(call.tools).toBe("none");
		expect(call.prompt.endsWith(SUBMIT_RESULT_INSTRUCTION)).toBe(true);
		// A second call for the same node gets its own file.
		const again = await agent(request());
		expect(again.resultPath).toBe(join(dir, "sessions", "..", "results", "n1-2.json"));
	});

	test("no result file → the v1 text path (value absent, nothing promoted); a failed child stays failed even with a stale file", async () => {
		const dir = scratch();
		const fake = fakeRunChild([{ text: '{"answer": "text"}' }, { fail: "provider down" }]);
		const agent = createAgentRunner({ runChild: fake.runChild, sessionsDir: join(dir, "sessions"), cwd: dir });
		const v1 = await agent(request());
		expect(v1.ok).toBe(true);
		expect(v1.value).toBeUndefined();
		expect(v1.text).toBe('{"answer": "text"}');
		expect(existsSync(v1.resultPath!)).toBe(false);
		const failed = await agent(request());
		expect(failed.ok).toBe(false);
		expect(failed.error).toContain("provider down");
		expect(failed.value).toBeUndefined();
	});

	test("requests without a schema carry no v2 env, no extra tool and an untouched prompt", async () => {
		const dir = scratch();
		const fake = fakeRunChild([{ text: "hi" }]);
		const agent = createAgentRunner({ runChild: fake.runChild, sessionsDir: join(dir, "sessions"), cwd: dir });
		const result = await agent(request({ outputSchema: undefined }));
		expect(result.ok).toBe(true);
		expect(result.value).toBeUndefined();
		expect(result.resultPath).toBeUndefined();
		expect(fake.calls[0].env[NODE_SCHEMA_ENV]).toBeUndefined();
		expect(fake.calls[0].extraTools).toBeUndefined();
		expect(fake.calls[0].prompt).toBe("Answer.");
	});

	test("titan://schemas/* refs are resolved before the schema reaches the child", () => {
		const resolved = resolveSchemaRefs({ $ref: "titan://schemas/audit-verdict" });
		expect(resolved.$ref).toBeUndefined();
		expect(resolved.properties?.verdict).toBeDefined();
		const nested = resolveSchemaRefs({ type: "object", properties: { audit: { $ref: "titan://schemas/audit-verdict" }, items: { type: "array", items: { $ref: "titan://schemas/audit-verdict" } } } });
		expect(nested.properties?.audit.$ref).toBeUndefined();
		expect((nested.properties?.items.items as any).properties?.verdict).toBeDefined();
		expect(resolveSchemaRefs({ $ref: "titan://schemas/unknown" })).toEqual({ $ref: "titan://schemas/unknown" });
	});
});

describe("effectiveChildTools", () => {
	test("submit_result survives --no-tools and the subagentTools policy; a list gets it appended once", () => {
		expect(effectiveChildTools("none", [SUBMIT_RESULT_TOOL])).toBe(SUBMIT_RESULT_TOOL);
		expect(effectiveChildTools("none", [])).toBe("none");
		expect(effectiveChildTools("none")).toBe("none");
		const listed = effectiveChildTools("read,grep", [SUBMIT_RESULT_TOOL, SUBMIT_RESULT_TOOL]);
		if (readStackSettings().subagentTools) {
			expect(listed.split(",")).toContain("read");
			expect(listed.split(",").filter((t) => t === SUBMIT_RESULT_TOOL)).toHaveLength(1);
		} else {
			expect(listed).toBe(SUBMIT_RESULT_TOOL);
		}
	});
});

// ═══ Through the engine ══════════════════════════════════════════════════════

function engine(cwd: string, scripts: Script[]) {
	const store = new RunStore(scratch());
	const { runId, dir: runDir } = store.open({ projectSlug: RunStore.projectSlug(cwd), cwd, workflow: { name: "t", sha256: sha256("t") }, command: "workflow" });
	const fake = fakeRunChild(scripts);
	const agent = createAgentRunner({ runChild: fake.runChild, sessionsDir: join(runDir, "sessions"), cwd });
	const notices: string[] = [];
	const deps: WorkflowRuntimeDeps = {
		cwd,
		runId,
		runDir,
		artifactsDir: join(runDir, "artifacts"),
		workflowId: "t",
		store,
		settings: DEFAULT_STACK_SETTINGS,
		agent,
		async bash() {
			return { code: 0, stdout: "", stderr: "" };
		},
		async script() {
			return { code: 0, stdout: "", stderr: "" };
		},
		async approval() {
			return { approved: true };
		},
		notify(text) {
			notices.push(text);
		},
		resolveRole(role) {
			return { model: "stub/model", thinking: "medium", callsign: `${role}-1`, appendSystemPrompts: [], tools: "read,grep,find,ls" };
		},
	};
	const run = (nodes: NodeDoc[]): Promise<RunResult> => {
		const doc: WorkflowDoc = { apiVersion: "titan.harness/v1", name: "t", nodes };
		const loaded = { doc, normalized: doc, name: "t", dir: cwd, path: join(cwd, "t.yaml"), sha256: sha256("t"), source: "project", commands: {}, scripts: {}, validation: { ok: true, errors: [], warnings: [] } } as LoadedWorkflow;
		return executeWorkflow(loaded, deps, {});
	};
	return { run, fake, notices, runDir };
}

describe("output_format nodes through the engine", () => {
	test("v2: the typed object becomes the node output with zero re-asks, even for allowed_tools: []", async () => {
		const cwd = scratch();
		const e = engine(cwd, [{ file: { answer: "typed" } }]);
		const result = await e.run([{ id: "q", prompt: "Answer.", output_format: ANSWER_SCHEMA, allowed_tools: [] }] as NodeDoc[]);
		expect(result.status).toBe("completed");
		expect(result.nodes.q.output).toEqual({ answer: "typed" });
		expect(e.fake.calls).toHaveLength(1);
		expect(e.fake.calls[0].tools).toBe("none");
		expect(e.fake.calls[0].extraTools).toEqual([SUBMIT_RESULT_TOOL]);
		expect(e.notices.some((n) => n.includes("re-asking"))).toBe(false);
	});

	test("v2: an object that misses the schema is re-asked in the same session, then accepted", async () => {
		const cwd = scratch();
		const e = engine(cwd, [{ file: { wrong: 1 } }, { file: { answer: "fixed" } }]);
		const result = await e.run([{ id: "q", prompt: "Answer.", output_format: ANSWER_SCHEMA }] as NodeDoc[]);
		expect(result.status).toBe("completed");
		expect(result.nodes.q.output).toEqual({ answer: "fixed" });
		expect(e.fake.calls).toHaveLength(2);
		expect(e.fake.calls[1].resume).toBe("sess-1");
		expect(e.fake.calls[1].prompt).toContain("not valid for the required schema");
		expect(e.notices.some((n) => n.includes("re-asking 1/3"))).toBe(true);
	});

	test("v1 fallback: a JSON answer in the text still becomes the output with one call", async () => {
		const cwd = scratch();
		const e = engine(cwd, [{ text: 'Here you go:\n{"answer": "from text"}' }]);
		const result = await e.run([{ id: "q", prompt: "Answer.", output_format: ANSWER_SCHEMA }] as NodeDoc[]);
		expect(result.status).toBe("completed");
		expect(result.nodes.q.output).toEqual({ answer: "from text" });
		expect(e.fake.calls).toHaveLength(1);
	});
});
