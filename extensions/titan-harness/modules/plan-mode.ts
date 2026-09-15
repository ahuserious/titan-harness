/**
 * plan-mode.ts — titan's read-only plan mode (plan §2 H6, D11; P7).
 *
 * A transliteration of Pi's plan-mode example extension
 * (packages/coding-agent/examples/extensions/plan-mode/{index,utils}.ts, MIT, Pi coding
 * agent 0.85.1) into a deps-seam module with no pi imports, so the host owns the
 * registrations and tests drive it with fakes. Semantics kept verbatim:
 *
 *   - built-in edit/write are removed from the active tools while plan mode is on
 *     (and blocked again at tool_call as belt-and-braces);
 *   - bash is filtered through the read-only allowlist (isSafeCommand);
 *   - `[PLAN MODE ACTIVE]` context is injected before the agent starts and filtered out
 *     of the context once plan mode is off;
 *   - a numbered plan under a "Plan:" header is extracted into todo items; during
 *     execution `[DONE:n]` markers complete steps and a widget shows progress;
 *   - state persists through deps.persist (the host writes a custom session entry) and
 *     comes back through restore().
 *
 * Titan additions: `/plan` routes to `/ultraplan` when the active shape declares
 * `plan_command: /ultraplan` (level 3), unless the argument is off|on|toggle; and
 * `/ultraplan` itself enables plan mode for the duration of the fusion (writes blocked).
 */

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

export interface PlanModeState {
	enabled: boolean;
	executing: boolean;
	todos: TodoItem[];
	toolsBefore?: string[];
}

export interface PlanModeDeps {
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
	notify(text: string, level?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
	setWidget(key: string, lines: string[] | undefined): void;
	persist(state: PlanModeState): void;
	/** The active shape's plan command (e.g. "/ultraplan" at level 3); undefined → plain plan mode. */
	planCommand?(): string | undefined;
	/** Runs /ultraplan with the given arguments when `/plan` routes there. */
	runUltraplan?(args: string, ctx: any): Promise<void>;
}

export const PLAN_STATUS_KEY = "titan-plan-mode";
export const PLAN_WIDGET_KEY = "titan-plan-todos";
export const PLAN_CONTEXT_TYPE = "titan-plan-mode-context";
export const PLAN_EXECUTION_TYPE = "titan-plan-execution-context";
export const PLAN_MODE_MARKER = "[PLAN MODE ACTIVE]";

/** Tools plan mode keeps or adds (read-only); edit/write are removed. */
export const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
export const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
export const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write"]);
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

// ═══ Pure helpers (ported from the example's utils.ts) ═══════════════════════

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

/** True only for allowlisted read-only commands with no destructive token. */
export function isSafeCommand(command: string): boolean {
	const destructive = DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
	const safe = SAFE_PATTERNS.some((pattern) => pattern.test(command));
	return !destructive && safe;
}

export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i, "")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length > 0) cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	if (cleaned.length > 50) cleaned = `${cleaned.slice(0, 47)}...`;
	return cleaned;
}

/** Numbered steps under a "Plan:" header → todo items (renumbered 1..n). */
export function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	const header = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!header) return items;
	const section = message.slice(message.indexOf(header[0]) + header[0].length);
	const numbered = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;
	for (const match of section.matchAll(numbered)) {
		const text = match[2].trim().replace(/\*{1,2}$/, "").trim();
		if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
			const cleaned = cleanStepText(text);
			if (cleaned.length > 3) items.push({ step: items.length + 1, text: cleaned, completed: false });
		}
	}
	return items;
}

export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

/** Marks `[DONE:n]` steps complete in place; returns how many markers the text carried. */
export function markCompletedSteps(text: string, items: TodoItem[]): number {
	const done = extractDoneSteps(text);
	for (const step of done) {
		const item = items.find((todo) => todo.step === step);
		if (item) item.completed = true;
	}
	return done.length;
}

const unique = (names: string[]): string[] => [...new Set(names)];

/** The active tools while plan mode is on: everything but edit/write, plus the read-only set. */
export function planModeTools(active: string[]): string[] {
	return unique([...active.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)), ...PLAN_MODE_TOOLS]);
}

/** The active tools after plan mode: the normal set plus whatever plan mode did not manage. */
export function normalModeTools(active: string[]): string[] {
	return unique([...NORMAL_MODE_TOOLS, ...active.filter((name) => !PLAN_MANAGED_TOOLS.has(name))]);
}

/** The `[PLAN MODE ACTIVE]` context message body (verbatim from the example, titan header). */
export const PLAN_MODE_CONTEXT = `${PLAN_MODE_MARKER}
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- Built-in edit and write tools are disabled
- Other currently active tools remain available
- Bash is restricted to an allowlist of read-only commands

Ask clarifying questions using the questionnaire tool when it is available.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`;

const ROUTE_EXEMPT = new Set(["off", "on", "toggle"]);

export interface PlanMode {
	state(): PlanModeState;
	enabled(): boolean;
	executing(): boolean;
	todos(): TodoItem[];
	enable(ctx: any): void;
	disable(ctx: any): void;
	toggle(ctx: any): void;
	/** `/plan [args]`: routes to /ultraplan when the shape says so, otherwise toggles plan mode. */
	handlePlanCommand(args: string, ctx: any): Promise<"ultraplan" | "toggled">;
	/** tool_call hook: block edit/write and non-allowlisted bash while plan mode is on. */
	onToolCall(event: { toolName: string; input: Record<string, unknown> }): { block: true; reason: string } | undefined;
	/** before_agent_start hook: inject the plan-mode or execution context. */
	onBeforeAgentStart(): { message: { customType: string; content: string; display: false } } | undefined;
	/** context hook: drop stale plan-mode context once plan mode is off. */
	onContext<T extends { role?: string; content?: unknown; customType?: string }>(messages: T[]): T[];
	/** Assistant text after a turn: extracts Plan: steps (plan mode) or marks [DONE:n] (execution). Returns what changed. */
	onAssistantMessage(text: string): { extracted: number; marked: number };
	/** Leave plan mode and start executing the extracted plan with full tools. */
	startExecution(ctx: any): TodoItem | undefined;
	/** True (and clears execution) when every step is complete. */
	completeIfDone(ctx: any): boolean;
	restore(entry: Partial<PlanModeState> | undefined, ctx?: any): void;
	statusText(): string | undefined;
	todosText(): string;
	updateUi(ctx?: any): void;
}

export function createPlanMode(deps: PlanModeDeps): PlanMode {
	const state: PlanModeState = { enabled: false, executing: false, todos: [] };

	const persist = () => {
		try {
			deps.persist({ enabled: state.enabled, executing: state.executing, todos: state.todos.map((todo) => ({ ...todo })), toolsBefore: state.toolsBefore });
		} catch {
			/* persistence is best effort */
		}
	};

	const enableTools = () => {
		if (state.toolsBefore === undefined) state.toolsBefore = deps.getActiveTools();
		deps.setActiveTools(planModeTools(state.toolsBefore));
	};

	const restoreTools = () => {
		deps.setActiveTools(state.toolsBefore ?? normalModeTools(deps.getActiveTools()));
		state.toolsBefore = undefined;
	};

	const statusText = (): string | undefined => {
		if (state.executing && state.todos.length) {
			const completed = state.todos.filter((todo) => todo.completed).length;
			return `📋 ${completed}/${state.todos.length}`;
		}
		if (state.enabled) return "⏸ plan";
		return undefined;
	};

	const updateUi = () => {
		try {
			deps.setStatus(PLAN_STATUS_KEY, statusText());
			if (state.executing && state.todos.length) {
				deps.setWidget(
					PLAN_WIDGET_KEY,
					state.todos.map((todo) => (todo.completed ? `☑ ${todo.text}` : `☐ ${todo.text}`)),
				);
			} else {
				deps.setWidget(PLAN_WIDGET_KEY, undefined);
			}
		} catch {
			/* UI is best effort */
		}
	};

	const enable = () => {
		if (state.enabled) return;
		state.enabled = true;
		state.executing = false;
		state.todos = [];
		enableTools();
		deps.notify("Plan mode enabled. Built-in write tools disabled.");
		updateUi();
		persist();
	};

	const disable = () => {
		if (!state.enabled) return;
		state.enabled = false;
		state.executing = false;
		state.todos = [];
		restoreTools();
		deps.notify("Plan mode disabled. Full access restored.");
		updateUi();
		persist();
	};

	const mode: PlanMode = {
		state: () => ({ enabled: state.enabled, executing: state.executing, todos: state.todos.map((todo) => ({ ...todo })), toolsBefore: state.toolsBefore ? [...state.toolsBefore] : undefined }),
		enabled: () => state.enabled,
		executing: () => state.executing,
		todos: () => state.todos.map((todo) => ({ ...todo })),
		enable: () => enable(),
		disable: () => disable(),
		toggle: () => (state.enabled ? disable() : enable()),
		async handlePlanCommand(args, ctx) {
			const trimmed = (args ?? "").trim();
			const word = trimmed.toLowerCase();
			if (deps.planCommand?.() === "/ultraplan" && deps.runUltraplan && !ROUTE_EXEMPT.has(word)) {
				await deps.runUltraplan(trimmed, ctx);
				return "ultraplan";
			}
			if (word === "on") enable();
			else if (word === "off") disable();
			else mode.toggle(ctx);
			return "toggled";
		},
		onToolCall(event) {
			if (!state.enabled) return undefined;
			if (PLAN_MODE_DISABLED_TOOLS.has(event.toolName)) {
				return { block: true, reason: `Plan mode: ${event.toolName} is disabled. Use /plan to disable plan mode first.` };
			}
			if (event.toolName === "bash") {
				const command = String(event.input?.command ?? "");
				if (!isSafeCommand(command)) {
					return { block: true, reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}` };
				}
			}
			return undefined;
		},
		onBeforeAgentStart() {
			if (state.enabled) return { message: { customType: PLAN_CONTEXT_TYPE, content: PLAN_MODE_CONTEXT, display: false } };
			if (state.executing && state.todos.length) {
				const remaining = state.todos.filter((todo) => !todo.completed).map((todo) => `${todo.step}. ${todo.text}`).join("\n");
				return {
					message: {
						customType: PLAN_EXECUTION_TYPE,
						content: `[EXECUTING PLAN - Full tool access enabled]\n\nRemaining steps:\n${remaining}\n\nExecute each step in order.\nAfter completing a step, include a [DONE:n] tag in your response.`,
						display: false,
					},
				};
			}
			return undefined;
		},
		onContext(messages) {
			if (state.enabled) return messages;
			return messages.filter((message) => {
				if (message.customType === PLAN_CONTEXT_TYPE) return false;
				if (message.role !== "user") return true;
				const content = message.content;
				if (typeof content === "string") return !content.includes(PLAN_MODE_MARKER);
				if (Array.isArray(content)) return !content.some((part) => part && typeof part === "object" && (part as { type?: string; text?: string }).type === "text" && String((part as { text?: string }).text ?? "").includes(PLAN_MODE_MARKER));
				return true;
			});
		},
		onAssistantMessage(text) {
			let extracted = 0;
			let marked = 0;
			if (state.executing && state.todos.length) {
				marked = markCompletedSteps(text, state.todos);
				if (marked) updateUi();
				persist();
			} else if (state.enabled) {
				const items = extractTodoItems(text);
				if (items.length) {
					state.todos = items;
					extracted = items.length;
					persist();
				}
			}
			return { extracted, marked };
		},
		startExecution() {
			const first = state.todos[0];
			if (!first) return undefined;
			state.enabled = false;
			state.executing = true;
			restoreTools();
			updateUi();
			persist();
			return { ...first };
		},
		completeIfDone() {
			if (!state.executing || !state.todos.length) return false;
			if (!state.todos.every((todo) => todo.completed)) return false;
			state.executing = false;
			state.todos = [];
			updateUi();
			persist();
			return true;
		},
		restore(entry) {
			if (!entry) return;
			state.enabled = entry.enabled ?? state.enabled;
			state.executing = entry.executing ?? state.executing;
			state.todos = Array.isArray(entry.todos) ? entry.todos.map((todo) => ({ ...todo })) : state.todos;
			state.toolsBefore = entry.toolsBefore ?? state.toolsBefore;
			if (state.enabled) enableTools();
			updateUi();
		},
		statusText,
		todosText() {
			if (!state.todos.length) return "No todos. Create a plan first with /plan";
			return `Plan Progress:\n${state.todos.map((todo, index) => `${index + 1}. ${todo.completed ? "✓" : "○"} ${todo.text}`).join("\n")}`;
		},
		updateUi: () => updateUi(),
	};
	return mode;
}
