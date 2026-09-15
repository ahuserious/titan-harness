import { describe, expect, test } from "bun:test";
import {
	createPlanMode,
	extractDoneSteps,
	extractTodoItems,
	isSafeCommand,
	markCompletedSteps,
	NORMAL_MODE_TOOLS,
	normalModeTools,
	PLAN_CONTEXT_TYPE,
	PLAN_EXECUTION_TYPE,
	PLAN_MODE_MARKER,
	PLAN_STATUS_KEY,
	PLAN_WIDGET_KEY,
	type PlanModeDeps,
	type PlanModeState,
	planModeTools,
} from "../modules/plan-mode.ts";

function fakeDeps(over: Partial<PlanModeDeps> & { active?: string[]; planCommand?: () => string | undefined } = {}) {
	let active = over.active ?? ["read", "bash", "edit", "write", "grep", "find", "ls", "subagent"];
	const calls: { setActiveTools: string[][]; notify: string[]; status: Array<string | undefined>; widget: Array<string[] | undefined>; persisted: PlanModeState[]; ultraplan: string[] } = { setActiveTools: [], notify: [], status: [], widget: [], persisted: [], ultraplan: [] };
	const deps: PlanModeDeps = {
		getActiveTools: () => [...active],
		setActiveTools: (names) => {
			active = [...names];
			calls.setActiveTools.push([...names]);
		},
		notify: (text) => calls.notify.push(text),
		setStatus: (key, text) => {
			expect(key).toBe(PLAN_STATUS_KEY);
			calls.status.push(text);
		},
		setWidget: (key, lines) => {
			expect(key).toBe(PLAN_WIDGET_KEY);
			calls.widget.push(lines);
		},
		persist: (state) => calls.persisted.push(state),
		planCommand: over.planCommand,
		runUltraplan: async (args) => {
			calls.ultraplan.push(args);
		},
	};
	return { deps, calls, active: () => active };
}

describe("isSafeCommand (ported allowlist)", () => {
	test.each([
		["cat package.json", true],
		["git status", true],
		["git log --oneline -5", true],
		["rg TODO src", true],
		["sed -n 1,20p file.ts", true],
		["ls -la", true],
		["rm -rf dist", false],
		["git commit -m x", false],
		["echo hi > out.txt", false],
		["cat a >> b", false],
		["npm install left-pad", false],
		["sudo ls", false],
		["vim file", false],
		["node build.js", false],
		["", false],
	])("%s → %s", (command, expected) => {
		expect(isSafeCommand(command)).toBe(expected);
	});
});

describe("plan extraction and completion markers", () => {
	test("numbered steps under Plan: become todos; bold/code stripped; short and command lines skipped", () => {
		const text = "Some analysis.\n\n**Plan:**\n1. Read the `config.ts` loader carefully\n2) Update the validator rules for hooks\n3. /skip\n4. ok\n5. Write tests for the new grammar and fixtures for every rule that changed today";
		const items = extractTodoItems(text);
		expect(items.map((item) => item.step)).toEqual([1, 2, 3]);
		expect(items[0].text).toBe("Config.ts loader carefully");
		// ported quirk: a bold word in the middle of a step ends the captured text at the closing ** (here "Read", too short → dropped)
		expect(extractTodoItems("Plan:\n1. **Read** the loader carefully\n2. Update the validator rules").map((item) => item.text)).toEqual(["Validator rules"]);
		expect(items[1].text).toBe("Validator rules for hooks");
		expect(items[2].text.endsWith("...")).toBe(true);
		expect(items[2].text.length).toBe(50);
		expect(extractTodoItems("no plan header here\n1. step one")).toEqual([]);
	});

	test("[DONE:n] markers complete matching steps", () => {
		const items = extractTodoItems("Plan:\n1. First step here\n2. Second step here\n3. Third step here");
		expect(extractDoneSteps("done [DONE:2] and [done:3] and [DONE:x]")).toEqual([2, 3]);
		expect(markCompletedSteps("[DONE:2]", items)).toBe(1);
		expect(items.map((item) => item.completed)).toEqual([false, true, false]);
	});

	test("tool sets: plan mode drops edit/write and adds the read-only set; normal mode restores", () => {
		expect(planModeTools(["read", "edit", "write", "subagent"])).toEqual(["read", "subagent", "bash", "grep", "find", "ls", "questionnaire"]);
		expect(normalModeTools(["read", "grep", "questionnaire", "subagent"])).toEqual([...NORMAL_MODE_TOOLS, "subagent"]);
	});
});

describe("createPlanMode", () => {
	test("toggle removes edit/write, sets the status, persists, and restores the previous tools on disable", () => {
		const { deps, calls, active } = fakeDeps();
		const mode = createPlanMode(deps);
		mode.toggle({});
		expect(mode.enabled()).toBe(true);
		expect(active()).not.toContain("edit");
		expect(active()).not.toContain("write");
		expect(active()).toContain("subagent");
		expect(active()).toContain("questionnaire");
		expect(calls.status.at(-1)).toBe("⏸ plan");
		expect(calls.persisted.at(-1)).toMatchObject({ enabled: true, executing: false, todos: [] });
		expect(calls.persisted.at(-1)?.toolsBefore).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls", "subagent"]);
		mode.toggle({});
		expect(mode.enabled()).toBe(false);
		expect(active()).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls", "subagent"]);
		expect(calls.status.at(-1)).toBeUndefined();
		expect(calls.notify).toEqual(["Plan mode enabled. Built-in write tools disabled.", "Plan mode disabled. Full access restored."]);
	});

	test("writes are blocked at tool_call while plan mode is on: edit/write always, bash unless allowlisted", () => {
		const { deps } = fakeDeps();
		const mode = createPlanMode(deps);
		expect(mode.onToolCall({ toolName: "write", input: { path: "x" } })).toBeUndefined();
		mode.enable({});
		expect(mode.onToolCall({ toolName: "write", input: { path: "x" } })).toMatchObject({ block: true });
		expect(mode.onToolCall({ toolName: "edit", input: {} })?.reason).toContain("disabled");
		expect(mode.onToolCall({ toolName: "bash", input: { command: "rm -rf /tmp/x" } })?.reason).toContain("not allowlisted");
		expect(mode.onToolCall({ toolName: "bash", input: { command: "git status" } })).toBeUndefined();
		expect(mode.onToolCall({ toolName: "read", input: {} })).toBeUndefined();
		mode.disable({});
		expect(mode.onToolCall({ toolName: "bash", input: { command: "rm -rf /tmp/x" } })).toBeUndefined();
	});

	test("context injection: plan-mode message while planning, remaining steps while executing, nothing otherwise; stale context filtered", () => {
		const { deps } = fakeDeps();
		const mode = createPlanMode(deps);
		expect(mode.onBeforeAgentStart()).toBeUndefined();
		mode.enable({});
		const injected = mode.onBeforeAgentStart();
		expect(injected?.message.customType).toBe(PLAN_CONTEXT_TYPE);
		expect(injected?.message.content.startsWith(PLAN_MODE_MARKER)).toBe(true);
		expect(injected?.message.display).toBe(false);
		// while enabled the context passes through untouched
		const messages = [
			{ role: "user", customType: PLAN_CONTEXT_TYPE, content: "x" },
			{ role: "user", content: `${PLAN_MODE_MARKER} hi` },
			{ role: "user", content: [{ type: "text", text: `${PLAN_MODE_MARKER} arr` }] },
			{ role: "user", content: "keep me" },
			{ role: "assistant", content: `${PLAN_MODE_MARKER} assistant text stays` },
		];
		expect(mode.onContext(messages)).toHaveLength(5);
		mode.onAssistantMessage("Plan:\n1. Inspect the loader module\n2. Patch the validator rules");
		expect(mode.todos()).toHaveLength(2);
		const first = mode.startExecution({});
		expect(first?.text).toBe("Inspect the loader module");
		expect(mode.enabled()).toBe(false);
		expect(mode.executing()).toBe(true);
		const filtered = mode.onContext(messages);
		expect(filtered.map((m) => m.content)).toEqual(["keep me", `${PLAN_MODE_MARKER} assistant text stays`]);
		const exec = mode.onBeforeAgentStart();
		expect(exec?.message.customType).toBe(PLAN_EXECUTION_TYPE);
		expect(exec?.message.content).toContain("1. Inspect the loader module");
		expect(exec?.message.content).toContain("2. Patch the validator rules");
	});

	test("execution: [DONE:n] marks steps, the widget follows, completeIfDone clears the plan", () => {
		const { deps, calls } = fakeDeps();
		const mode = createPlanMode(deps);
		mode.enable({});
		mode.onAssistantMessage("Plan:\n1. Inspect the loader module\n2. Patch the validator rules");
		mode.startExecution({});
		expect(calls.status.at(-1)).toBe("📋 0/2");
		expect(calls.widget.at(-1)).toEqual(["☐ Inspect the loader module", "☐ Patch the validator rules"]);
		expect(mode.onAssistantMessage("did it [DONE:1]")).toEqual({ extracted: 0, marked: 1 });
		expect(calls.status.at(-1)).toBe("📋 1/2");
		expect(mode.completeIfDone({})).toBe(false);
		mode.onAssistantMessage("[DONE:2]");
		expect(mode.completeIfDone({})).toBe(true);
		expect(mode.executing()).toBe(false);
		expect(mode.todos()).toEqual([]);
		expect(calls.widget.at(-1)).toBeUndefined();
		expect(mode.todosText()).toContain("No todos");
	});

	test("restore re-applies a persisted state and the plan-mode tools", () => {
		const { deps, active } = fakeDeps();
		const mode = createPlanMode(deps);
		mode.restore({ enabled: true, executing: false, todos: [{ step: 1, text: "A", completed: false }], toolsBefore: ["read", "edit", "write"] });
		expect(mode.enabled()).toBe(true);
		expect(active()).toEqual(["read", "bash", "grep", "find", "ls", "questionnaire"]);
		expect(mode.todosText()).toBe("Plan Progress:\n1. ○ A");
		mode.restore(undefined);
		expect(mode.enabled()).toBe(true);
	});

	test("/plan routes to /ultraplan when the shape's plan command says so; on|off|toggle never route", async () => {
		const routed = fakeDeps({ planCommand: () => "/ultraplan" });
		const mode = createPlanMode(routed.deps);
		expect(await mode.handlePlanCommand("ship the login flow", {})).toBe("ultraplan");
		expect(routed.calls.ultraplan).toEqual(["ship the login flow"]);
		expect(mode.enabled()).toBe(false);
		expect(await mode.handlePlanCommand("", {})).toBe("ultraplan"); // bare /plan at level 3
		expect(routed.calls.ultraplan).toEqual(["ship the login flow", ""]);
		expect(await mode.handlePlanCommand("on", {})).toBe("toggled");
		expect(mode.enabled()).toBe(true);
		expect(await mode.handlePlanCommand("off", {})).toBe("toggled");
		expect(mode.enabled()).toBe(false);
		expect(await mode.handlePlanCommand("toggle", {})).toBe("toggled");
		expect(mode.enabled()).toBe(true);

		const plain = fakeDeps({ planCommand: () => undefined });
		const plainMode = createPlanMode(plain.deps);
		expect(await plainMode.handlePlanCommand("anything", {})).toBe("toggled");
		expect(plain.calls.ultraplan).toEqual([]);
		expect(plainMode.enabled()).toBe(true);
	});
});
