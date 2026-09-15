import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyPostToolUse,
	applyPreToolUse,
	applyStop,
	CHILD_ENV,
	childModeFromEnv,
	hookLine,
	hooksEnv,
	matchesRule,
	NODE_HOOKS_ENV,
	NODE_RESULT_PATH_ENV,
	NODE_SCHEMA_ENV,
	parseHooksEnv,
	parseSchemaEnv,
	replaceInput,
	schemaEnv,
	SUBMIT_RESULT_ACK,
	SUBMIT_RESULT_INSTRUCTION,
	SUBMIT_RESULT_TOOL,
	submitResultParameters,
	unwrapResult,
	writeResult,
} from "../modules/child-hooks.ts";
import childHooksExtension from "../../titan-child-hooks.ts";

const dirs: string[] = [];
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-child-hooks-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const deny = (matcher: string | undefined, reason = "no shell here") => ({
	...(matcher === undefined ? {} : { matcher }),
	response: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" as const, permissionDecisionReason: reason } },
});
const HOOKS = {
	PreToolUse: [deny("Bash"), { matcher: "read", response: { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "stay focused" } } }],
	PostToolUse: [{ matcher: "read", response: { systemMessage: "do not modify anything" } }],
	Stop: [{ matcher: "write", response: { continue: false, stopReason: "writes end the node" } }],
};

/** A recording stand-in for Pi's ExtensionAPI: what the child extension registered, and the handlers to drive. */
function fakePi() {
	const handlers = new Map<string, Function>();
	const tools: any[] = [];
	const calls: string[] = [];
	const pi = {
		on: (event: string, handler: Function) => {
			calls.push(`on:${event}`);
			handlers.set(event, handler);
		},
		registerTool: (def: any) => {
			calls.push(`tool:${def.name}`);
			tools.push(def);
		},
		registerCommand: () => calls.push("command"),
		registerShortcut: () => calls.push("shortcut"),
	};
	return { pi: pi as any, handlers, tools, calls };
}

const ENV_KEYS = [CHILD_ENV, NODE_HOOKS_ENV, NODE_SCHEMA_ENV, NODE_RESULT_PATH_ENV];
function withEnv(values: Record<string, string | undefined>, fn: () => void) {
	const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	for (const key of ENV_KEYS) delete process.env[key];
	for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value;
	try {
		fn();
	} finally {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key]!;
		}
	}
}

describe("child mode gate", () => {
	test("inactive in the host, inactive in a plain child, active only with hooks or a schema", () => {
		expect(childModeFromEnv({ [NODE_HOOKS_ENV]: JSON.stringify(HOOKS) }).active).toBe(false);
		expect(childModeFromEnv({ [CHILD_ENV]: "1" }).active).toBe(false);
		expect(childModeFromEnv({ [CHILD_ENV]: "0", [NODE_HOOKS_ENV]: JSON.stringify(HOOKS) }).active).toBe(false);
		const hooksOnly = childModeFromEnv({ [CHILD_ENV]: "1", [NODE_HOOKS_ENV]: JSON.stringify(HOOKS) });
		expect(hooksOnly.active).toBe(true);
		expect(hooksOnly.hooks?.PreToolUse).toHaveLength(2);
		expect(hooksOnly.schema).toBeUndefined();
		expect(hooksOnly.problems).toEqual([]);
		const both = childModeFromEnv({ [CHILD_ENV]: "1", [NODE_HOOKS_ENV]: JSON.stringify(HOOKS), [NODE_SCHEMA_ENV]: JSON.stringify({ type: "string" }), [NODE_RESULT_PATH_ENV]: "/tmp/x/result.json" });
		expect(both).toMatchObject({ active: true, schema: { type: "string" }, resultPath: "/tmp/x/result.json" });
	});

	test("malformed hooks and a schema without a result path are reported and ignored", () => {
		const bad = childModeFromEnv({ [CHILD_ENV]: "1", [NODE_HOOKS_ENV]: "{not json" });
		expect(bad.active).toBe(false);
		expect(bad.problems[0]).toContain(NODE_HOOKS_ENV);
		const noPath = childModeFromEnv({ [CHILD_ENV]: "1", [NODE_SCHEMA_ENV]: JSON.stringify({ type: "object" }) });
		expect(noPath.active).toBe(false);
		expect(noPath.problems[0]).toContain(NODE_RESULT_PATH_ENV);
		const notObject = childModeFromEnv({ [CHILD_ENV]: "1", [NODE_SCHEMA_ENV]: "[1,2]", [NODE_RESULT_PATH_ENV]: "/tmp/r.json" });
		expect(notObject.active).toBe(false);
		expect(notObject.problems[0]).toContain(NODE_SCHEMA_ENV);
		// hooks still register when only the schema half is broken
		const mixed = childModeFromEnv({ [CHILD_ENV]: "1", [NODE_HOOKS_ENV]: JSON.stringify(HOOKS), [NODE_SCHEMA_ENV]: "nope" });
		expect(mixed.active).toBe(true);
		expect(mixed.hooks).toBeDefined();
		expect(mixed.schema).toBeUndefined();
	});

	test("env round trip: hooksEnv/parseHooksEnv prune junk, schemaEnv/parseSchemaEnv carry the schema and path", () => {
		expect(hooksEnv(undefined)).toEqual({});
		expect(hooksEnv({})).toEqual({});
		expect(hooksEnv({ PreToolUse: [] })).toEqual({});
		const env = hooksEnv({ ...HOOKS, Bogus: [{ response: {} }], PostToolUse: [...HOOKS.PostToolUse, { matcher: "x" } as any, "junk" as any] } as any);
		const parsed = parseHooksEnv(env[NODE_HOOKS_ENV]);
		expect(parsed).toEqual(HOOKS);
		expect(Object.keys(parsed!)).toEqual(["PreToolUse", "PostToolUse", "Stop"]);
		expect(parseHooksEnv(undefined)).toBeUndefined();
		expect(parseHooksEnv("")).toBeUndefined();
		expect(parseHooksEnv("42")).toBeUndefined();
		const schema = { type: "object", properties: { issue_type: { type: "string", enum: ["bug", "feature"] } }, required: ["issue_type"] };
		const senv = schemaEnv(schema, "/runs/r1/artifacts/nodes/classify.result.json");
		expect(senv).toEqual({ [NODE_SCHEMA_ENV]: JSON.stringify(schema), [NODE_RESULT_PATH_ENV]: "/runs/r1/artifacts/nodes/classify.result.json" });
		expect(parseSchemaEnv(senv[NODE_SCHEMA_ENV])).toEqual(schema);
		expect(parseSchemaEnv("null")).toBeUndefined();
	});
});

describe("matchers", () => {
	test("anchored, case-insensitive regex; omitted or * matches all; invalid regex compares literally", () => {
		expect(matchesRule({ response: {} }, "bash")).toBe(true);
		expect(matchesRule({ matcher: "*", response: {} }, "anything")).toBe(true);
		expect(matchesRule({ matcher: "", response: {} }, "anything")).toBe(true);
		expect(matchesRule({ matcher: "Bash", response: {} }, "bash")).toBe(true);
		expect(matchesRule({ matcher: "bash", response: {} }, "bashful")).toBe(false);
		expect(matchesRule({ matcher: "Write|Edit", response: {} }, "edit")).toBe(true);
		expect(matchesRule({ matcher: "Write|Edit", response: {} }, "read")).toBe(false);
		expect(matchesRule({ matcher: "web_.*_exa", response: {} }, "web_search_exa")).toBe(true);
		expect(matchesRule({ matcher: "(", response: {} }, "(")).toBe(true);
		expect(matchesRule({ matcher: "(", response: {} }, "bash")).toBe(false);
	});
});

describe("PreToolUse", () => {
	test("deny blocks with its reason; non-matching tools pass; empty rules are a no-op", () => {
		expect(applyPreToolUse(HOOKS.PreToolUse, "bash", { command: "rm -rf /" })).toEqual({ block: true, reason: "no shell here" });
		expect(applyPreToolUse(HOOKS.PreToolUse, "write", { path: "x" })).toEqual({});
		expect(applyPreToolUse(undefined, "bash", {})).toEqual({});
		expect(applyPreToolUse([], "bash", {})).toEqual({});
	});

	test("ask blocks too (headless child), decision: block blocks, and deny wins over allow whatever the order", () => {
		const ask = applyPreToolUse([{ response: { hookSpecificOutput: { permissionDecision: "ask" } } }], "bash", {});
		expect(ask.block).toBe(true);
		expect(ask.reason).toContain("headless");
		expect(applyPreToolUse([{ response: { decision: "block", stopReason: "nope" } }], "read", {})).toEqual({ block: true, reason: "nope" });
		const allowThenDeny = [{ matcher: "bash", response: { hookSpecificOutput: { permissionDecision: "allow" as const } } }, deny("bash", "later deny")];
		expect(applyPreToolUse(allowThenDeny, "bash", {})).toEqual({ block: true, reason: "later deny" });
		expect(applyPreToolUse([...allowThenDeny].reverse(), "bash", {})).toEqual({ block: true, reason: "later deny" });
	});

	test("continue: false blocks AND terminates with the stopReason", () => {
		const stop = applyPreToolUse([{ matcher: "bash", response: { continue: false, stopReason: "Shell access not permitted" } }], "bash", {});
		expect(stop).toEqual({ block: true, reason: "Shell access not permitted", terminate: true });
		expect(applyPreToolUse([{ response: { continue: false } }], "read", {})).toEqual({ block: true, reason: "stopped by hook", terminate: true });
		// a deny followed by a continue:false upgrades to terminate
		expect(applyPreToolUse([deny("bash"), { matcher: "bash", response: { continue: false, stopReason: "and stop" } }], "bash", {})).toEqual({ block: true, reason: "and stop", terminate: true });
	});

	test("updatedInput replaces the arguments (last wins) and context lines are collected for the result", () => {
		const rules = [
			{ matcher: "bash", response: { hookSpecificOutput: { updatedInput: { command: "echo first" }, additionalContext: "first context" } } },
			{ matcher: "bash", response: { hookSpecificOutput: { updatedInput: { command: "echo second", timeout: 5 } }, systemMessage: "be brief" } },
		];
		const out = applyPreToolUse(rules, "bash", { command: "rm -rf /", timeout: 99 });
		expect(out.block).toBeUndefined();
		expect(out.input).toEqual({ command: "echo second", timeout: 5 });
		expect(out.additionalContext).toBe(`${hookLine("first context")}\n${hookLine("be brief")}`);
		const input: Record<string, unknown> = { command: "rm -rf /", timeout: 99, extra: true };
		replaceInput(input, out.input!);
		expect(input).toEqual({ command: "echo second", timeout: 5 });
	});
});

describe("PostToolUse", () => {
	test("appends [hook] text blocks (stashed PreToolUse context first) and leaves other tools untouched", () => {
		const content = [{ type: "text", text: "file contents" }];
		const out = applyPostToolUse(HOOKS.PostToolUse, "read", content, hookLine("stay focused"));
		expect(out.changed).toBe(true);
		expect(out.systemMessage).toBe("do not modify anything");
		expect(out.content).toEqual([{ type: "text", text: "file contents" }, { type: "text", text: `${hookLine("stay focused")}\n${hookLine("do not modify anything")}` }]);
		expect(content).toHaveLength(1); // never mutated in place
		const untouched = applyPostToolUse(HOOKS.PostToolUse, "bash", content);
		expect(untouched).toEqual({ content, changed: false });
		expect(untouched.content).toBe(content);
	});

	test("additionalContext, decision: block → isError, continue: false → armed stop", () => {
		const rules = [
			{ response: { hookSpecificOutput: { additionalContext: "verify this output is relevant" } } },
			{ matcher: "bash", response: { decision: "block" as const, stopReason: "output rejected" } },
			{ matcher: "bash", response: { continue: false, stopReason: "enough" } },
		];
		const out = applyPostToolUse(rules, "bash", [{ type: "text", text: "ok" }]);
		expect(out).toMatchObject({ changed: true, isError: true, stop: "enough", additionalContext: "verify this output is relevant" });
		expect(out.systemMessage).toBeUndefined();
		const text = (out.content[1] as any).text as string;
		expect(text.split("\n")).toEqual([hookLine("verify this output is relevant"), hookLine("blocked: output rejected"), hookLine("stop: enough")]);
		expect(applyPostToolUse(rules, "read", []).content).toEqual([{ type: "text", text: hookLine("verify this output is relevant") }]);
	});
});

describe("Stop", () => {
	test("continue: false on a matching tool call blocks with terminate; anything else is ignored", () => {
		expect(applyStop(HOOKS.Stop, "write")).toEqual({ block: true, terminate: true, reason: "writes end the node" });
		expect(applyStop(HOOKS.Stop, "read")).toBeUndefined();
		expect(applyStop([{ response: { decision: "block" as const } }], "write")).toBeUndefined();
		expect(applyStop([{ response: { continue: false } }], "bash")).toEqual({ block: true, terminate: true, reason: "stopped by Stop hook" });
		expect(applyStop(undefined, "bash")).toBeUndefined();
	});
});

describe("submit_result", () => {
	test("object schemas pass through, everything else is wrapped as { value }, $ref degrades to any", () => {
		const object = { type: "object", properties: { issue_type: { type: "string", enum: ["bug", "feature"] } }, required: ["issue_type"], additionalProperties: false };
		expect(submitResultParameters(object)).toEqual({ parameters: object, wrapped: false });
		expect(submitResultParameters({ type: "object" })).toEqual({ parameters: { type: "object", properties: {} }, wrapped: false });
		expect(submitResultParameters({ type: "string", minLength: 1 })).toEqual({ parameters: { type: "object", properties: { value: { type: "string", minLength: 1 } }, required: ["value"] }, wrapped: true });
		expect(submitResultParameters({ type: "array", items: { type: "number" } }).wrapped).toBe(true);
		expect(submitResultParameters({ $ref: "titan://schemas/audit-verdict" })).toEqual({ parameters: { type: "object", properties: { value: {} }, required: ["value"] }, wrapped: true });
		const nested = submitResultParameters({ type: "object", properties: { verdict: { $ref: "titan://schemas/audit-verdict" }, items: { type: "array", items: { $ref: "x" } } } });
		expect(nested.parameters).toEqual({ type: "object", properties: { verdict: {}, items: { type: "array", items: {} } } });
		expect(unwrapResult({ issue_type: "bug" }, false)).toEqual({ issue_type: "bug" });
		expect(unwrapResult({ value: "done" }, true)).toBe("done");
		expect(unwrapResult("not an object", true)).toBeUndefined();
	});

	test("writeResult creates the parent, writes canonical JSON with a newline, mode 0600, atomically", () => {
		const dir = scratch();
		const file = join(dir, "artifacts", "nodes", "classify.result.json");
		const text = writeResult(file, { z: 1, a: { y: [3, { b: 2, a: 1 }], x: "s" }, skipped: undefined });
		expect(text).toBe('{"a":{"x":"s","y":[3,{"a":1,"b":2}]},"z":1}\n');
		expect(readFileSync(file, "utf8")).toBe(text);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(existsSync(`${file}.tmp`)).toBe(false);
		writeResult(file, "second");
		expect(readFileSync(file, "utf8")).toBe('"second"\n');
	});
});

describe("titan-child-hooks extension", () => {
	test("registers nothing in the host, nothing in a plain child", () => {
		withEnv({ [NODE_HOOKS_ENV]: JSON.stringify(HOOKS), [NODE_SCHEMA_ENV]: "{}", [NODE_RESULT_PATH_ENV]: "/tmp/r.json" }, () => {
			const fake = fakePi();
			childHooksExtension(fake.pi);
			expect(fake.calls).toEqual([]);
		});
		withEnv({ [CHILD_ENV]: "1" }, () => {
			const fake = fakePi();
			childHooksExtension(fake.pi);
			expect(fake.calls).toEqual([]);
		});
	});

	test("hooks only: exactly tool_call + tool_result; deny blocks bash, context rides on the read result, Stop terminates at write", () => {
		withEnv({ [CHILD_ENV]: "1", [NODE_HOOKS_ENV]: JSON.stringify(HOOKS) }, () => {
			const fake = fakePi();
			childHooksExtension(fake.pi);
			expect(fake.calls).toEqual(["on:tool_call", "on:tool_result"]);
			const toolCall = fake.handlers.get("tool_call")!;
			const toolResult = fake.handlers.get("tool_result")!;
			expect(toolCall({ toolName: "bash", toolCallId: "c1", input: { command: "ls" } })).toEqual({ block: true, reason: "no shell here" });
			expect(toolCall({ toolName: "read", toolCallId: "c2", input: { path: "a.ts" } })).toBeUndefined();
			expect(toolResult({ toolName: "read", toolCallId: "c2", input: { path: "a.ts" }, content: [{ type: "text", text: "src" }] })).toEqual({
				content: [{ type: "text", text: "src" }, { type: "text", text: `${hookLine("stay focused")}\n${hookLine("do not modify anything")}` }],
			});
			// the stash is consumed: a second result for the same id carries only the PostToolUse line
			expect(toolResult({ toolName: "read", toolCallId: "c2", content: [] })).toEqual({ content: [{ type: "text", text: hookLine("do not modify anything") }] });
			expect(toolResult({ toolName: "grep", toolCallId: "c3", content: [{ type: "text", text: "hits" }] })).toBeUndefined();
			expect(toolCall({ toolName: "write", toolCallId: "c4", input: { path: "b.ts", content: "" } })).toEqual({ block: true, terminate: true, reason: "writes end the node" });
			// submit_result is exempt from every rule
			expect(toolCall({ toolName: SUBMIT_RESULT_TOOL, toolCallId: "c5", input: { value: 1 } })).toBeUndefined();
		});
	});

	test("updatedInput mutates event.input in place; a PostToolUse continue:false arms a terminating block for the next call", () => {
		const hooks = {
			PreToolUse: [{ matcher: "bash", response: { hookSpecificOutput: { updatedInput: { command: "echo safe" } } } }],
			PostToolUse: [{ matcher: "bash", response: { continue: false, stopReason: "one shell call only" } }],
		};
		withEnv({ [CHILD_ENV]: "1", [NODE_HOOKS_ENV]: JSON.stringify(hooks) }, () => {
			const fake = fakePi();
			childHooksExtension(fake.pi);
			const toolCall = fake.handlers.get("tool_call")!;
			const toolResult = fake.handlers.get("tool_result")!;
			const event = { toolName: "bash", toolCallId: "b1", input: { command: "rm -rf /", timeout: 9 } };
			expect(toolCall(event)).toBeUndefined();
			expect(event.input).toEqual({ command: "echo safe" });
			const patched = toolResult({ toolName: "bash", toolCallId: "b1", content: [{ type: "text", text: "safe" }] });
			expect(patched.content[1]).toEqual({ type: "text", text: hookLine("stop: one shell call only") });
			expect(toolCall({ toolName: "read", toolCallId: "b2", input: { path: "x" } })).toEqual({ block: true, terminate: true, reason: "one shell call only" });
		});
	});

	test("schema only: exactly one tool, submit_result, whose parameters are the schema and whose execute writes the file and terminates", async () => {
		const dir = scratch();
		const resultPath = join(dir, "nodes", "classify.result.json");
		const schema = { type: "object", properties: { issue_type: { type: "string", enum: ["bug", "feature"] } }, required: ["issue_type"] };
		await new Promise<void>((resolve, reject) => {
			withEnv({ [CHILD_ENV]: "1", [NODE_SCHEMA_ENV]: JSON.stringify(schema), [NODE_RESULT_PATH_ENV]: resultPath }, () => {
				const fake = fakePi();
				childHooksExtension(fake.pi);
				expect(fake.calls).toEqual([`tool:${SUBMIT_RESULT_TOOL}`]);
				const tool = fake.tools[0];
				expect(tool.parameters).toEqual(schema);
				expect(tool.description).toContain(SUBMIT_RESULT_INSTRUCTION);
				expect(tool.promptGuidelines).toContain(SUBMIT_RESULT_INSTRUCTION);
				tool.execute("t1", { issue_type: "bug" }).then((result: any) => {
					try {
						expect(result).toEqual({ content: [{ type: "text", text: SUBMIT_RESULT_ACK }], details: { path: resultPath, wrapped: false }, terminate: true });
						expect(readFileSync(resultPath, "utf8")).toBe('{"issue_type":"bug"}\n');
						resolve();
					} catch (error) {
						reject(error);
					}
				}, reject);
			});
		});
	});

	test("a wrapped (non-object) schema is unwrapped before it is written", async () => {
		const dir = scratch();
		const resultPath = join(dir, "answer.json");
		let execute: ((id: string, params: unknown) => Promise<any>) | undefined;
		withEnv({ [CHILD_ENV]: "1", [NODE_SCHEMA_ENV]: JSON.stringify({ type: "string" }), [NODE_RESULT_PATH_ENV]: resultPath }, () => {
			const fake = fakePi();
			childHooksExtension(fake.pi);
			expect(fake.tools[0].parameters).toEqual({ type: "object", properties: { value: { type: "string" } }, required: ["value"] });
			execute = fake.tools[0].execute;
		});
		const result = await execute!("t2", { value: "feature" });
		expect(result.details).toEqual({ path: resultPath, wrapped: true });
		expect(readFileSync(resultPath, "utf8")).toBe('"feature"\n');
	});

	test("both: hooks handlers plus the tool, in that order", () => {
		withEnv({ [CHILD_ENV]: "1", [NODE_HOOKS_ENV]: JSON.stringify(HOOKS), [NODE_SCHEMA_ENV]: JSON.stringify({ type: "object" }), [NODE_RESULT_PATH_ENV]: join(scratch(), "r.json") }, () => {
			const fake = fakePi();
			childHooksExtension(fake.pi);
			expect(fake.calls).toEqual(["on:tool_call", "on:tool_result", `tool:${SUBMIT_RESULT_TOOL}`]);
		});
	});
});
