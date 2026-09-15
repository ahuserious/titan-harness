import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWorkflowCommands } from "../modules/cmd-workflow.ts";
import { RunStore } from "../modules/run-store.ts";
import { readStackSettings } from "../modules/stack-config.ts";
import { DW_VERSION, exportDynamicWorkflow, jsLiteral, promptToTemplate, whenToJs } from "../modules/workflow/export-dw.ts";
import { loadWorkflow } from "../modules/workflow/loader.ts";
import type { WorkflowDoc } from "../modules/workflow/schema.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-export-"));
	dirs.push(dir);
	return dir;
};

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;
const GLOBALS = ["agent", "parallel", "checkpoint", "judgePanel", "workflow", "phase", "log", "args", "cwd", "budget", "retry", "verify"];

/** The body pi-dynamic-workflows runs: everything after the meta literal, compiled as an async function over the runtime globals. */
function compileBody(script: string): { meta: Record<string, unknown>; fn: (...args: unknown[]) => Promise<unknown> } {
	const start = script.indexOf("export const meta = ");
	expect(start).toBeGreaterThanOrEqual(0);
	const metaEnd = script.indexOf("\n}\n", start);
	const metaText = script.slice(start + "export const meta = ".length, metaEnd + 2);
	const meta = JSON.parse(metaText); // a pure literal parses as JSON
	const body = script.slice(metaEnd + 3);
	return { meta, fn: new AsyncFunction(...GLOBALS, body) };
}

describe("exportDynamicWorkflow on the shipped classify-and-fix", () => {
	const loaded = loadWorkflow("classify-and-fix", scratch());
	const exported = exportDynamicWorkflow(loaded);

	test("the envelope: a pure-literal meta first, JavaScript only, no YAML, the bash node warned", () => {
		const { script, warnings, unsupported } = exported;
		const metaBlock = script.slice(script.indexOf("export const meta = "), script.indexOf("\n}\n") + 3);
		expect(metaBlock).not.toMatch(/\$\{|\+|\(|`/);
		expect(script.split("\n").filter((line) => !line.startsWith("//") && line.trim()).at(0)).toBe("export const meta = {");
		expect(script).not.toContain("apiVersion");
		expect(script).not.toMatch(/^\s*(nodes|depends_on|trigger_rule):/m);
		expect(script).not.toMatch(/\bimport\b|\brequire\(|Date\.now|Math\.random|new Date\(\)/);
		expect(script).toContain(`pi-dynamic-workflows ${DW_VERSION}`);
		expect(script).toContain("Classify this issue: ${str(out[\"fetch-issue\"])}");
		expect(script).toContain('label: "classify"');
		expect(script).toContain('model: "cerebras/qwen-3.8-27b"');
		expect(script).toContain("schema: {");
		expect(script).toContain('"issue_type"');
		expect(script).toContain("await parallel([");
		expect(script).toContain('field(out["classify"], ["issue_type"]) == "bug"');
		expect(script).toContain('ready(["investigate","plan"], "one_success")');
		expect(script).toContain("gh issue view ${ARGUMENTS} --json title,body,labels");
		expect(script.trim().endsWith('return out["create-pr"]')).toBe(true);
		expect(warnings).toEqual(["fetch-issue: bash node exported as an agent() that runs the command — pi-dynamic-workflows 3.10.1 has no bash() runtime global"]);
		expect(unsupported).toEqual([]);
		// Every agent() label is unique.
		const labels = [...script.matchAll(/label: "([^"]+)"/g)].map((match) => match[1]);
		expect(new Set(labels).size).toBe(labels.length);
		expect(labels).toEqual(["fetch-issue", "classify", "investigate", "plan", "implement", "create-pr"]);
	});

	test("the body compiles and routes like the DAG: bug → investigate, plan skipped, implement on one_success, returns the PR", async () => {
		const { meta, fn } = compileBody(exported.script);
		expect(meta).toEqual({ name: "classify-and-fix", description: "Classify a GitHub issue, then route to the appropriate handler" });
		const calls: Array<{ label: string; prompt: string }> = [];
		const agent = async (prompt: string, opts: { label: string; schema?: unknown }) => {
			calls.push({ label: opts.label, prompt });
			if (opts.label === "fetch-issue") return '{"title":"Crash on save"}';
			if (opts.label === "classify") return { issue_type: "bug" };
			if (opts.label === "create-pr") return "https://example.invalid/pr/1";
			return `${opts.label} done`;
		};
		const parallel = async (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map((thunk) => thunk()));
		const result = await fn(agent, parallel, async () => true, async () => undefined, async () => null, () => {}, () => {}, "123", "/repo");
		expect(result).toBe("https://example.invalid/pr/1");
		expect(calls.map((call) => call.label)).toEqual(["fetch-issue", "classify", "investigate", "implement", "create-pr"]);
		expect(calls[0].prompt).toContain("gh issue view 123 --json title,body,labels");
		expect(calls[1].prompt).toContain('Classify this issue: {"title":"Crash on save"}');
		expect(calls[2].prompt).toContain('{"title":"Crash on save"}');
		expect(calls[2].prompt).toContain("/repo/.titan/dw-artifacts/classify-and-fix/investigation.md");
		expect(calls[2].prompt).toContain("\nReproduce the problem"); // prompt lines keep their own indentation
		expect(calls[4].prompt).toContain("issue #123");
	});
});

describe("exportDynamicWorkflow on the other node types", () => {
	const doc: WorkflowDoc = {
		apiVersion: "titan.harness/v1",
		name: "patterns",
		description: "every node type",
		phases: [{ title: "plan" }, { title: "build" }, { title: "unused" }],
		inputs: { topic: { required: true } },
		returns: "ship",
		nodes: [
			{ id: "brief", command: "brief", phase: "plan", role: "architect" },
			{ id: "draft", depends_on: ["brief"], best_of: { n: 3, criteria: "clarity", prompt: "Draft about $inputs.topic using $brief.output" }, phase: "build" },
			{ id: "gate", depends_on: ["draft"], approval: { message: "Ship the draft?\n$draft.output" }, phase: "build" },
			{ id: "polish", depends_on: ["gate"], loop: { prompt: "polish", until: "DONE", max_iterations: 3 } },
			{ id: "check", depends_on: ["polish"], verify: { runner: "bash", command: "true" }, evidence: { require: ["log"] } },
			{ id: "facts", depends_on: ["check"], mcp_tool: { server: "infranodus", tool: "generate_ontology_graph", args: { text: "$draft.output" } } },
			{ id: "child", depends_on: ["facts"], workflow: { name: "publish" } },
			{ id: "ship", depends_on: ["child"], when: "$gate.output == true && $draft.output != null", prompt: "ship it: $draft.output $BASE_BRANCH $LOOP_COUNT" },
			{ id: "abort", depends_on: ["gate"], when: "$gate.output != true", cancel: "rejected by the reviewer" },
			{ id: "hyp", depends_on: ["abort"], hypothesis: { hypotheses: [{ id: "h1", claim: "x" }], decide_by: "most_supported" } },
			{ id: "seg", depends_on: ["hyp"], interleave: { segments: 2, prompt: "seg" } },
			{ id: "odd", depends_on: ["seg"], when: "not a valid when", prompt: "odd" },
		],
	};
	const exported = exportDynamicWorkflow({ name: "patterns", normalized: doc, commands: { brief: "Write a one-paragraph brief on $inputs.topic." } });

	test("approval → checkpoint, cancel → throw, best_of → parallel + judgePanel, workflow → workflow(), command bodies inlined, unsupported → TODO + warnings", () => {
		const { script, warnings, unsupported } = exported;
		expect(script).toContain('await checkpoint(`Ship the draft?\n${str(out["draft"])}`, { kind: "confirm" })');
		expect(script).toContain('throw new Error("approval rejected at gate")');
		expect(script).toContain("throw new Error(`cancelled: ${`rejected by the reviewer`}`)");
		expect(script).toContain("judgePanel(candidates_draft, { rubric: \"clarity\" })");
		expect(script.match(/label: "draft-c\d"/g)).toHaveLength(3);
		expect(script).toContain('await workflow("publish", INPUTS)');
		expect(script).toContain("Write a one-paragraph brief on ${str(INPUTS[\"topic\"])}.");
		expect(script).toContain('phase("plan")');
		expect(script).toContain('phase("build")');
		expect(script).not.toContain('"unused"');
		expect(script).toContain('field(out["gate"], []) == true && field(out["draft"], []) != null');
		expect(script).toContain("${str(INPUTS.base_branch)}");
		expect(script).toContain("$LOOP_COUNT"); // left as text, warned
		expect([...unsupported].sort()).toEqual(["check", "facts", "hyp", "polish", "seg"]); // emission order follows the layers
		for (const id of unsupported) expect(script).toContain(`// TODO(${id})`);
		expect(warnings).toEqual(
			expect.arrayContaining([
				expect.stringContaining("polish: loop nodes have no pi-dynamic-workflows equivalent"),
				expect.stringContaining("check: verify nodes"),
				expect.stringContaining("facts: mcp_tool nodes"),
				expect.stringContaining("hyp: hypothesis nodes"),
				expect.stringContaining("seg: interleave nodes"),
				expect.stringContaining('child: workflow node calls workflow("publish")'),
				expect.stringContaining('odd: when "not a valid when" could not be translated'),
				expect.stringContaining("ship: $LOOP_COUNT has no pi-dynamic-workflows equivalent"),
			]),
		);
		expect(warnings.some((text) => text.includes("draft"))).toBe(false); // best_of maps cleanly
		const { meta } = compileBody(script);
		expect(meta).toEqual({ name: "patterns", description: "every node type", phases: [{ title: "plan" }, { title: "build" }] });
	});

	test("the body compiles; a rejected checkpoint throws before anything downstream runs", async () => {
		const { fn } = compileBody(exported.script);
		const labels: string[] = [];
		const agent = async (_prompt: string, opts: { label: string }) => {
			labels.push(opts.label);
			return `${opts.label} ok`;
		};
		const parallel = async (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map((thunk) => thunk()));
		const judgePanel = async (attempts: unknown[]) => ({ index: 0, attempt: attempts[0], score: 1, judgments: [] });
		await expect(fn(agent, parallel, async () => false, judgePanel, async () => null, () => {}, () => {}, { topic: "x" }, "/repo")).rejects.toThrow("approval rejected at gate");
		expect(labels).toEqual(["brief", "draft-c1", "draft-c2", "draft-c3"]);
	});
});

describe("helpers", () => {
	test("promptToTemplate escapes backticks and ${ in prose and substitutes only known refs", () => {
		const warnings: string[] = [];
		const out = promptToTemplate("use `code` and ${literal} then $a.output.x.y, $ghost.output, $ARGUMENTS, $ARTIFACTS_DIR/f", new Set(["a"]), (text) => warnings.push(text), "n");
		expect(out).toBe('`use \\`code\\` and \\${literal} then ${str(field(out["a"], ["x","y"]))}, $ghost.output, ${ARGUMENTS}, ${ARTIFACTS_DIR}/f`');
		expect(warnings).toEqual([]);
	});

	test("whenToJs maps the strict grammar and reports what it cannot parse", () => {
		expect(whenToJs("$a.output.k >= 3 || ($b.output == 'x' && $c.output.n != null)")).toEqual({ ok: true, js: '(field(out["a"], ["k"]) >= 3 || (field(out["b"], []) == "x" && field(out["c"], ["n"]) != null))' });
		expect(whenToJs("$a.output")).toMatchObject({ ok: false });
		expect(jsLiteral("q\"uote")).toBe('"q\\"uote"');
	});
});

describe("/workflow schedule through the command", () => {
	test("list, recipe, arm and disarm read and write the schedules settings key", async () => {
		const cwd = scratch();
		const settingsPath = join(cwd, "titan-harness.json");
		mkdirSync(join(cwd, ".titan", "workflows", "nightly-digest"), { recursive: true });
		writeFileSync(join(cwd, ".titan", "workflows", "nightly-digest", "nightly-digest.yaml"), ["apiVersion: titan.harness/v1", "name: nightly-digest", "provider: pi", "trigger: { cron: '0 9 * * 1-5' }", "nodes:", "  - id: digest", "    prompt: summarize", ""].join("\n"));
		const panels: Array<[string, string]> = [];
		const notes: string[] = [];
		let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
		registerWorkflowCommands({ registerCommand: (_name: string, spec: any) => (handler = spec.handler) } as any, {
			cwd: () => cwd,
			runtime: () => {
				throw new Error("not used");
			},
			store: () => new RunStore(join(cwd, "runs")),
			notify: (_ctx, text) => notes.push(text),
			panel: (_ctx, title, markdown) => panels.push([title, markdown]),
			validateContext: () => ({}),
			settingsPath,
			lockRoot: join(cwd, "locks"),
			tickMs: 3_600_000,
		});
		const ctx = { cwd };
		await handler!("schedule", ctx);
		expect(panels.at(-1)![0]).toBe("◆ WORKFLOW — SCHEDULE");
		expect(panels.at(-1)![1]).toContain("| nightly-digest | no |");
		expect(panels.at(-1)![1]).toContain("not armed");
		await handler!("schedule recipe nightly-digest", ctx);
		expect(panels.at(-1)![1]).toContain("orca automations create");
		expect(panels.at(-1)![1]).toContain("--name titan-nightly-digest");
		expect(panels.at(-1)![1]).toContain(`--prompt 'pi -p "/workflow run nightly-digest"'`);
		await handler!("schedule arm nightly-digest", ctx);
		expect(notes.at(-1)).toContain("nightly-digest armed");
		expect(readStackSettings(settingsPath).schedules).toEqual({ "nightly-digest": { armed: true } });
		await handler!("schedule list", ctx);
		expect(panels.at(-1)![1]).toContain("| nightly-digest | yes |");
		expect(panels.at(-1)![1]).toContain("scheduler running");
		await handler!("schedule disarm nightly-digest", ctx);
		expect(readStackSettings(settingsPath).schedules).toEqual({ "nightly-digest": { armed: false } });
		await handler!("schedule list", ctx);
		expect(panels.at(-1)![1]).toContain("scheduler idle");
		await handler!("schedule arm classify-and-fix", ctx);
		expect(notes.at(-1)).toContain("has no trigger: block");
		await handler!("schedule arm", ctx);
		expect(notes.at(-1)).toContain("Usage: /workflow schedule arm <name>");
		expect(readFileSync(settingsPath, "utf8")).toContain('"schedules"');
	});
});
