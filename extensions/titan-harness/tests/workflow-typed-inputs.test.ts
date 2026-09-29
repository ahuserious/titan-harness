import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRunArgs, registerWorkflowCommands } from "../modules/cmd-workflow.ts";
import { resolveInputs, WorkflowInputError } from "../modules/workflow/executor.ts";
import { exportDynamicWorkflow } from "../modules/workflow/export-dw.ts";
import { graphHtml } from "../modules/workflow/graph.ts";
import type { InputSpec, WorkflowDoc } from "../modules/workflow/schema.ts";

const workflow = (inputs: WorkflowDoc["inputs"]): WorkflowDoc => ({
	apiVersion: "titan.harness/v1", name: "typed", inputs, nodes: [{ id: "work", bash: "echo ok" }],
});

describe("typed workflow inputs", () => {
	test.each<[string, InputSpec, unknown, unknown, string]>([
		["string", { type: "string" }, "hello", 3, "expected string"],
		["integer", { type: "integer" }, 3, 3.5, "expected integer"],
		["number", { type: "number" }, 3.5, "3.5", "expected number"],
		["boolean", { type: "boolean" }, false, "false", "expected boolean"],
		["null", { type: "null" }, null, false, "expected null"],
		["union", { type: ["string", "null"] }, null, 3, "expected string | null"],
		["enum", { schema: { enum: ["small", "large"] } }, "small", "medium", "expected one of"],
		["object", { schema: { type: "object", required: ["count"], properties: { count: { type: "integer" } }, additionalProperties: false } }, { count: 3 }, { count: "three" }, "$.count: expected integer"],
		["array", { type: "array", schema: { items: { type: "integer" } } }, [1, 2], [1, "two"], "$[1]: expected integer"],
		["bounds", { type: "integer", schema: { minimum: 1, maximum: 5 } }, 3, 0, "below the minimum"],
		["length", { type: "string", schema: { minLength: 1, maxLength: 5 } }, "hi", "", "shorter than minLength"],
		["ref", { schema: { $ref: "titan://schemas/audit-verdict" } }, { verdict: "PASS", summary: "ok" }, { verdict: "PASS" }, "$.summary: required property is missing"],
	])("%s accepts matching values and reports invalid input paths", (_label, spec, good, bad, message) => {
		const doc = workflow({ value: spec });
		expect(resolveInputs(doc, { value: good })).toEqual({ value: good });
		let failure: unknown;
		try { resolveInputs(doc, { value: bad }); } catch (error) { failure = error; }
		expect(failure).toBeInstanceOf(WorkflowInputError);
		expect((failure as WorkflowInputError).message).toContain(message);
		expect((failure as WorkflowInputError).message).toContain("value");
		expect((failure as WorkflowInputError).errors[0]).toMatchObject({ input: "value", path: expect.stringMatching(/^\$/), message: expect.any(String) });
	});

	test("merged defaults are validated and absent optional inputs are skipped", () => {
		const doc = workflow({ count: { type: "integer", default: 3 }, optional: { type: "boolean" }, nullable: { type: ["string", "null"], default: null } });
		expect(resolveInputs(doc)).toEqual({ count: 3, nullable: null });
		expect(resolveInputs(doc, { count: 4 })).toEqual({ count: 4, nullable: null });
		expect(() => resolveInputs(workflow({ count: { type: "integer", default: "bad" } }))).toThrow("count $: expected integer");
	});

	test("missing required inputs preserve their message and expose structured errors", () => {
		for (const names of [["one"], ["one", "two"]]) {
			const doc = workflow(Object.fromEntries(names.map((name) => [name, { required: true }])));
			try { resolveInputs(doc); throw new Error("expected refusal"); } catch (error) {
				expect(error).toBeInstanceOf(WorkflowInputError);
				expect((error as WorkflowInputError).message).toBe(`missing required input${names.length > 1 ? "s" : ""}: ${names.join(", ")}`);
				expect((error as WorkflowInputError).errors.map((issue) => issue.input)).toEqual(names);
			}
		}
	});

	test("missing and invalid inputs are all named in one refusal", () => {
		expect(() => resolveInputs(workflow({ missing: { required: true }, bad: { type: "integer" } }), { bad: "x" })).toThrow("missing required input: missing; invalid workflow inputs: bad $: expected integer");
	});

	test("untyped values and extra inputs pass through with existing default semantics", () => {
		const doc = workflow({ any: {}, fallback: { default: 4 }, required: { required: true, default: false }, bare: null as never });
		const extra = { nested: [1, false] };
		expect(resolveInputs(doc, { any: null, fallback: undefined, extra })).toEqual({ any: null, fallback: 4, required: false, extra });
		expect(resolveInputs(doc, { extra }).extra).toBe(extra);
	});

	test("CLI n=3 remains numeric and validates as an integer without new coercion", () => {
		const parsed = parseRunArgs("typed --input n=3 --input flag=false --input text=hello");
		expect(parsed.errors).toEqual([]);
		expect(resolveInputs(workflow({ n: { type: "integer" } }), parsed.inputs)).toEqual({ n: 3, flag: false, text: "hello" });
		expect(resolveInputs(workflow({ n: {} }), parsed.inputs).n).toBe(3);
		expect(() => resolveInputs(workflow({ n: { type: "string" } }), parsed.inputs)).toThrow("n $: expected string");
	});

	test("type shorthand still constrains a schema with a draft-7 $ref", () => {
		expect(() => resolveInputs(workflow({ value: { type: "string", schema: { $ref: "titan://schemas/audit-verdict" } } }), { value: { verdict: "PASS", summary: "ok" } })).toThrow("value $: expected string");
	});

	test("graph and dynamic-workflow export accept typed inputs", () => {
		const doc = workflow({ count: { type: "integer", default: 3 }, config: { schema: { type: "object" } } });
		expect(graphHtml(doc)).toContain("work");
		const exported = exportDynamicWorkflow({ name: doc.name, normalized: doc });
		expect(exported.unsupported).toEqual([]);
		expect(exported.script).toContain("const INPUTS");
	});

	test("/workflow run refuses invalid inputs before obtaining a store or runtime", async () => {
		const cwd = mkdtempSync(join(process.cwd(), ".typed-input-test-"));
		try {
			const dir = join(cwd, ".titan", "workflows", "typed");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "typed.yaml"), "apiVersion: titan.harness/v1\nname: typed\ninputs:\n  n: {type: integer}\nnodes:\n  - id: work\n    bash: echo ok\n");
			let handler: (args: string, ctx: unknown) => Promise<unknown> = async () => { throw new Error("not registered"); };
			const notices: string[] = [];
			let storeCalls = 0;
			let runtimeCalls = 0;
			const panels: string[] = [];
			registerWorkflowCommands({ registerCommand(_name: string, command: { handler: typeof handler }) { handler = command.handler; } } as never, {
				cwd: () => cwd,
				validateContext: () => ({}),
				notify: (_ctx, text) => { notices.push(text); },
				panel: (_ctx, _title, text) => { panels.push(text); },
				store: () => { storeCalls++; throw new Error("store must not be reached"); },
				runtime: () => { runtimeCalls++; throw new Error("runtime must not be reached"); },
			});
			await handler("run typed --input n=bad", {});
			await handler("run typed --input n=bad --dry-run", {});
			expect(notices).toHaveLength(2);
			for (const notice of notices) expect(notice).toContain("Not run: invalid workflow inputs: n $: expected integer");
			expect(storeCalls).toBe(0);
			expect(runtimeCalls).toBe(0);
			await handler("run typed --input n=3 --dry-run", {});
			expect(panels).toHaveLength(1);
			expect(panels[0]).toContain("layers");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
