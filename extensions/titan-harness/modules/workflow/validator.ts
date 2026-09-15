/**
 * validator.ts — load-time validation of a workflow document (plan §3.4, A6; P3 checklist:
 * every rule below has a red and a green fixture in tests/workflow-validator.test.ts).
 *
 * validateWorkflow(doc, ctx) never throws: one pass returns every error and warning it can
 * find, plus `normalized` — the document the engine should run. Today the normalized doc
 * differs from the input in one way: `role: architect` prompt/command nodes get
 * denied_tools write, edit, bash injected (constraint 5: the architect never writes), on
 * top of the hard errors that reject an architect declared as a bash/script/workflow/
 * verify/loop/best_of/interleave/mcp_tool node or holding a write tool in allowed_tools.
 *
 * Rule ids (ValidationIssue.rule) — errors unless marked (w):
 *   doc, steps, apiVersion, name, provider, nodes, unknown-key (w), type, inputs, returns,
 *   phases, phase, trigger, titan, evidence, model (unknown → error, unauthed → w),
 *   thinking (bad level → error, above the ceiling → w "requested X / effective Y"), id,
 *   node-type, depends_on, cycle, ref, ref-order (w), when, when-field (w), trigger_rule,
 *   retry, command, prompt, bash, script (deps on bun → w), loop, approval, cancel, verify,
 *   best_of, interleave, hypothesis, mcp_tool, workflow, role, architect, tools (w),
 *   review, callsign, hooks (unknown event → w), context, ignored-key (w),
 *   platform-update, persona, output_format
 *
 * ctx.commandDirs / scriptDirs / personaDirs are ROOTS: a command `x` resolves to
 * <root>/commands/x.md (or <root>/x.md), a named script to <root>/scripts/x.{ts,js,py}
 * (or <root>/x.*), a persona to <root>/personas/x.md; one subfolder level is allowed.
 * The loader passes [workflowDir, <cwd>/.titan, ~/.pi/titan-harness, <package>/.pi/titan-harness].
 *
 * Node built-ins and the yaml dependency only; no pi imports.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveThinking } from "../model-stack.ts";
import { normalizeThinking } from "../thinking.ts";
import { resolveRef } from "./json-schema.ts";
import {
	AI_ONLY_NODE_KEYS,
	API_VERSION,
	APPROVAL_KEYS,
	ARCHITECT_NODE_TYPES,
	BEST_OF_KEYS,
	FAN_OUT_KEYS,
	HOOK_EVENTS,
	HOOK_RESPONSE_KEYS,
	HOOK_RULE_KEYS,
	HOOK_SPECIFIC_KEYS,
	HYPOTHESIS_ITEM_KEYS,
	HYPOTHESIS_KEYS,
	ID_RE,
	INPUT_KEYS,
	INTERLEAVE_BY,
	INTERLEAVE_KEYS,
	ISOLATION_MODES,
	LOOP_KEYS,
	MCP_TOOL_KEYS,
	MIMEOGRAPH_KEYS,
	MODEL_RE,
	NAME_RE,
	NODE_EVIDENCE_KEYS,
	NODE_KEYS,
	nodeTypesOf,
	ON_COMPACTION_MODES,
	ON_FAIL_ACTIONS,
	ON_FAIL_KEYS,
	ON_REJECT_KEYS,
	outputRefs,
	parseWhen,
	PHASE_KEYS,
	RETRY_KEYS,
	REVIEW_POLICIES,
	SCRIPT_RUNTIMES,
	SIM_USER_RUNNERS,
	SLOT_ROLES,
	SUBAGENTS_KEYS,
	TITAN_BUDGET_KEYS,
	TITAN_EVIDENCE_KEYS,
	TITAN_KEYS,
	TITAN_WATCHDOG_KEYS,
	TOP_LEVEL_KEYS,
	TRIGGER_KEYS,
	TRIGGER_RULES,
	type JsonSchema,
	type NodeType,
	type WhenAst,
	type WorkflowDoc,
	VERIFY_RUNNERS,
	WATCHDOG_POLICIES,
	WORKFLOW_NODE_KEYS,
	WRITE_TOOLS,
} from "./schema.ts";

// The when-grammar parser lives in schema.ts (pure, dependency-free); re-exported here so
// `import { parseWhen } from "./validator.ts"` also works for the scheduler.
export { outputRefs, parseWhen } from "./schema.ts";

export interface ValidationIssue {
	rule: string;
	node?: string;
	message: string;
}

export interface ValidationResult {
	ok: boolean;
	errors: ValidationIssue[];
	warnings: ValidationIssue[];
	/** The document to execute (architect denied_tools injected). Present whenever the input was a mapping; meaningful when `ok`. */
	normalized?: WorkflowDoc;
}

export interface ValidateContext {
	/** The workflow directory: `name` must equal its basename (skipped when empty). */
	dir: string;
	commandDirs: string[];
	scriptDirs: string[];
	personaDirs?: string[];
	modelStatus?: (model: string) => "ok" | "unauthed" | "unknown";
	thinkingCeiling?: (model: string, requested: string) => string;
	/** Names a `workflow:` node may call; unchecked when absent. */
	workflowNames?: string[];
}

// ═══ Small helpers ═══════════════════════════════════════════════════════════

const isMapping = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const isFile = (file: string): boolean => {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
};
const show = (value: unknown): string => {
	const text = JSON.stringify(value);
	return text === undefined ? String(value) : text.length > 80 ? `${text.slice(0, 77)}…` : text;
};
const list = (values: readonly string[]): string => values.join(", ");

const FILE_NAME_RE = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?$/;
const INPUT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const SCRIPT_EXTENSIONS: Array<[string, "bun" | "uv"]> = [
	[".ts", "bun"],
	[".js", "bun"],
	[".py", "uv"],
];

/** A `script:` value is inline code when it holds a newline or any shell metacharacter (Archon's rule); otherwise it names a file. */
export function isInlineScript(text: string): boolean {
	return /[\n;(){}&|<>$`"' ]/.test(text);
}

/** <root>/commands/<name>.md, else <root>/<name>.md, first root wins. */
export function findCommandFile(name: string, roots: string[]): string | undefined {
	if (!FILE_NAME_RE.test(name)) return undefined;
	for (const root of roots) {
		for (const candidate of [path.join(root, "commands", `${name}.md`), path.join(root, `${name}.md`)]) if (isFile(candidate)) return candidate;
	}
	return undefined;
}

/** <root>/scripts/<name>.{ts,js,py}, else <root>/<name>.*; the extension names the runtime. */
export function findScriptFile(name: string, roots: string[]): { path: string; runtime: "bun" | "uv" } | undefined {
	if (!FILE_NAME_RE.test(name)) return undefined;
	for (const root of roots) {
		for (const base of [path.join(root, "scripts", name), path.join(root, name)]) {
			for (const [ext, runtime] of SCRIPT_EXTENSIONS) if (isFile(base + ext)) return { path: base + ext, runtime };
		}
	}
	return undefined;
}

/** <root>/personas/<name>.md, else <root>/<name>.md. */
export function findPersonaFile(name: string, roots: string[]): string | undefined {
	if (!FILE_NAME_RE.test(name)) return undefined;
	for (const root of roots) {
		for (const candidate of [path.join(root, "personas", `${name}.md`), path.join(root, `${name}.md`)]) if (isFile(candidate)) return candidate;
	}
	return undefined;
}

function hasFunction(value: unknown, depth = 0): boolean {
	if (typeof value === "function") return true;
	if (!value || typeof value !== "object" || depth > 16) return false;
	return Object.values(value as object).some((member) => hasFunction(member, depth + 1));
}

/** Plain-data deep clone (YAML documents are plain data; functions are copied by reference and rejected elsewhere). */
function clone<T>(value: T): T {
	if (Array.isArray(value)) return value.map((item) => clone(item)) as unknown as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, member] of Object.entries(value as Record<string, unknown>)) out[key] = clone(member);
		return out as T;
	}
	return value;
}

const unique = (values: string[]): string[] => values.filter((value, index) => values.indexOf(value) === index);

class Issues {
	readonly errors: ValidationIssue[] = [];
	readonly warnings: ValidationIssue[] = [];
	error(rule: string, message: string, node?: string): void {
		this.errors.push(node ? { rule, node, message } : { rule, message });
	}
	warn(rule: string, message: string, node?: string): void {
		this.warnings.push(node ? { rule, node, message } : { rule, message });
	}
}

/** Kahn layering over known ids in document order; nodes left unplaced sit on or below a cycle. */
function kahnLayers(order: string[], deps: Map<string, string[]>): { layers: string[][]; unplaced: string[] } {
	const indegree = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const id of order) {
		indegree.set(id, 0);
		dependents.set(id, []);
	}
	for (const id of order) {
		for (const dep of deps.get(id) ?? []) {
			if (!indegree.has(dep)) continue; // unknown ids are reported separately
			indegree.set(id, indegree.get(id)! + 1);
			dependents.get(dep)!.push(id); // a self-edge keeps its own indegree at ≥ 1 forever → unplaced
		}
	}
	const layers: string[][] = [];
	const placed = new Set<string>();
	let frontier = order.filter((id) => indegree.get(id) === 0);
	while (frontier.length) {
		layers.push(frontier);
		const ready = new Set<string>();
		for (const id of frontier) {
			placed.add(id);
			for (const child of dependents.get(id)!) {
				indegree.set(child, indegree.get(child)! - 1);
				if (indegree.get(child) === 0) ready.add(child);
			}
		}
		frontier = order.filter((id) => ready.has(id));
	}
	return { layers, unplaced: order.filter((id) => !placed.has(id)) };
}

/** Every id reachable from `start` over `edges` (start excluded unless it reaches itself). */
function reachable(start: string, edges: Map<string, string[]>): Set<string> {
	const seen = new Set<string>();
	const stack = [...(edges.get(start) ?? [])];
	while (stack.length) {
		const id = stack.pop()!;
		if (seen.has(id)) continue;
		seen.add(id);
		stack.push(...(edges.get(id) ?? []));
	}
	return seen;
}

function whenRefs(ast: WhenAst): Array<{ node: string; path: string[] }> {
	if (ast.kind === "compare") return [ast.left, ast.right].flatMap((operand) => (operand.kind === "ref" ? [{ node: operand.node, path: operand.path }] : []));
	return ast.items.flatMap(whenRefs);
}

// ═══ The validator ═══════════════════════════════════════════════════════════

export function validateWorkflow(doc: unknown, ctx: ValidateContext): ValidationResult {
	const issues = new Issues();
	const done = (normalized?: WorkflowDoc): ValidationResult => ({ ok: issues.errors.length === 0, errors: issues.errors, warnings: issues.warnings, ...(normalized ? { normalized } : {}) });
	if (!isMapping(doc)) {
		issues.error("doc", `the workflow must be a YAML mapping with apiVersion, name and nodes; found ${Array.isArray(doc) ? "a list" : show(doc)}`);
		return done();
	}
	const top = doc;
	const commandDirs = ctx.commandDirs ?? [];
	const scriptDirs = ctx.scriptDirs ?? [];

	// ── model / thinking helpers (shared by the top level, titan.watchdog and every node) ──
	const checkModel = (model: unknown, where: string, node?: string): string | undefined => {
		if (typeof model !== "string" || !MODEL_RE.test(model.trim())) {
			issues.error("model", `${where} must be provider/id (for example cerebras/qwen-3.8-27b); found ${show(model)}`, node);
			return undefined;
		}
		const id = model.trim();
		if (ctx.modelStatus) {
			const status = ctx.modelStatus(id);
			if (status === "unknown") issues.error("model", `${where} ${id} is not in Pi's model registry`, node);
			else if (status === "unauthed") issues.warn("model", `${where} ${id} has no credentials in Pi (its slot fallback applies at run time)`, node);
		}
		return id;
	};
	const checkThinking = (thinking: unknown, model: string | undefined, where: string, node?: string): void => {
		const requested = typeof thinking === "string" && thinking.trim() ? resolveThinking(thinking) : undefined;
		if (!requested) {
			issues.error("thinking", `${where} must be one of off, minimal, low, medium, high, xhigh, max; found ${show(thinking)}`, node);
			return;
		}
		if (!model) return;
		const effective = ctx.thinkingCeiling ? ctx.thinkingCeiling(model, requested) : normalizeThinking(model, requested).effective;
		if (effective !== requested) issues.warn("thinking", `${where}: requested ${requested} / effective ${effective} on ${model}`, node);
	};

	// ── top level ──
	if (top.steps !== undefined) issues.error("steps", "`steps:` is not supported — use nodes: (Archon retired the steps format)");
	if (top.apiVersion !== API_VERSION) issues.error("apiVersion", `apiVersion must be ${API_VERSION}; found ${show(top.apiVersion)}`);
	if (typeof top.name !== "string" || !NAME_RE.test(top.name)) issues.error("name", `name must match ^[a-z0-9][a-z0-9-]{0,63}$; found ${show(top.name)}`);
	else if (ctx.dir && path.basename(path.resolve(ctx.dir)) !== top.name) issues.error("name", `name ${show(top.name)} must equal the workflow directory name ${show(path.basename(path.resolve(ctx.dir)))}`);
	if (top.provider !== undefined && top.provider !== "pi") issues.error("provider", `provider must be absent or "pi" (titan runs every node as a Pi child); found ${show(top.provider)}`);
	for (const key of Object.keys(top)) if (!TOP_LEVEL_KEYS.has(key) && key !== "steps") issues.warn("unknown-key", `top-level key ${show(key)} is unknown and ignored`);
	if (top.description !== undefined && typeof top.description !== "string") issues.error("type", `description must be a string; found ${show(top.description)}`);
	if (top.version !== undefined && (!isInt(top.version) || top.version < 1)) issues.error("type", `version must be a positive integer; found ${show(top.version)}`);
	if (top.returns !== undefined && !isText(top.returns)) issues.error("returns", `returns must name a node id; found ${show(top.returns)}`);
	const topModel = top.model !== undefined ? checkModel(top.model, "model") : undefined;
	if (top.thinking !== undefined) checkThinking(top.thinking, topModel, "thinking");

	if (top.inputs !== undefined) {
		if (!isMapping(top.inputs)) issues.error("inputs", `inputs must be a mapping of name → {required, default, description}; found ${show(top.inputs)}`);
		else {
			for (const [name, spec] of Object.entries(top.inputs)) {
				if (!INPUT_NAME_RE.test(name)) issues.error("inputs", `input name ${show(name)} must match ^[A-Za-z_][A-Za-z0-9_-]*$`);
				if (spec === null || spec === undefined) continue; // `spec:` with no body = optional input
				if (!isMapping(spec)) {
					issues.error("inputs", `inputs.${name} must be a mapping {required, default, description}; found ${show(spec)}`);
					continue;
				}
				for (const key of Object.keys(spec)) if (!INPUT_KEYS.has(key)) issues.warn("unknown-key", `inputs.${name}.${key} is unknown and ignored`);
				if (spec.required !== undefined && typeof spec.required !== "boolean") issues.error("inputs", `inputs.${name}.required must be boolean`);
				if (spec.description !== undefined && typeof spec.description !== "string") issues.error("inputs", `inputs.${name}.description must be a string`);
				if (spec.required === true && spec.default !== undefined) issues.warn("inputs", `inputs.${name} is required and also has a default; the default never applies`);
			}
		}
	}

	const phaseTitles = new Set<string>();
	let phasesDeclared = false;
	if (top.phases !== undefined) {
		if (!Array.isArray(top.phases)) issues.error("phases", `phases must be a list of {title, detail?}; found ${show(top.phases)}`);
		else {
			phasesDeclared = true;
			top.phases.forEach((phase, index) => {
				if (!isMapping(phase) || !isText(phase.title)) {
					issues.error("phases", `phases[${index}] must be a mapping with a non-empty title; found ${show(phase)}`);
					return;
				}
				for (const key of Object.keys(phase)) if (!PHASE_KEYS.has(key)) issues.warn("unknown-key", `phases[${index}].${key} is unknown and ignored`);
				if (phase.detail !== undefined && typeof phase.detail !== "string") issues.error("phases", `phases[${index}].detail must be a string`);
				if (phaseTitles.has(phase.title)) issues.error("phases", `phase title ${show(phase.title)} is declared twice`);
				phaseTitles.add(phase.title);
			});
		}
	}

	if (top.trigger !== undefined) {
		if (!isMapping(top.trigger)) issues.error("trigger", `trigger must be a mapping {cron | every | event, entity_profile?}; found ${show(top.trigger)}`);
		else {
			const trigger = top.trigger;
			for (const key of Object.keys(trigger)) if (!TRIGGER_KEYS.has(key)) issues.warn("unknown-key", `trigger.${key} is unknown and ignored`);
			if (trigger.cron !== undefined) {
				const fields = typeof trigger.cron === "string" ? trigger.cron.trim().split(/\s+/) : [];
				if (fields.length < 5 || fields.length > 6 || !fields.every((f) => /^[\d*,/-]+$|^[A-Za-z]{3}(?:-[A-Za-z]{3})?$/.test(f))) issues.error("trigger", `trigger.cron must have 5 or 6 fields; found ${show(trigger.cron)}`);
			}
			if (trigger.every !== undefined && (typeof trigger.every !== "string" || !/^\d+(ms|s|m|h|d)$/.test(trigger.every.trim()))) issues.error("trigger", `trigger.every must look like 30s, 15m, 6h or 1d; found ${show(trigger.every)}`);
			if (trigger.event !== undefined && !isText(trigger.event)) issues.error("trigger", `trigger.event must be a non-empty string`);
			if (trigger.entity_profile !== undefined && !isText(trigger.entity_profile)) issues.error("trigger", `trigger.entity_profile must be a non-empty string`);
			if (trigger.cron === undefined && trigger.every === undefined && trigger.event === undefined) issues.error("trigger", "trigger needs one of cron, every or event");
		}
	}

	let tier: string | undefined;
	const requiredEvidence: string[] = [];
	if (top.titan !== undefined) {
		if (!isMapping(top.titan)) issues.error("titan", `titan must be a mapping; found ${show(top.titan)}`);
		else {
			const titan = top.titan;
			for (const key of Object.keys(titan)) if (!TITAN_KEYS.has(key)) issues.warn("unknown-key", `titan.${key} is unknown and ignored`);
			if (titan.level !== undefined && (!isInt(titan.level) || titan.level < 0 || titan.level > 3)) issues.error("titan", `titan.level must be an integer between 0 and 3; found ${show(titan.level)}`);
			if (titan.shape !== undefined && !isText(titan.shape)) issues.error("titan", `titan.shape must be a shape codename such as level-3`);
			if (titan.tier !== undefined) {
				if (isText(titan.tier)) tier = titan.tier.trim();
				else issues.error("titan", `titan.tier must be a tier name; found ${show(titan.tier)}`);
			}
			if (titan.modes !== undefined && !isStringList(titan.modes)) issues.error("titan", `titan.modes must be a list of strings; found ${show(titan.modes)}`);
			if (titan.personas !== undefined && !isStringList(titan.personas)) issues.error("titan", `titan.personas must be a list of persona names; found ${show(titan.personas)}`);
			if (titan.parent_run !== undefined && !isText(titan.parent_run)) issues.error("titan", `titan.parent_run must be the run id this workflow repairs or elevates; found ${show(titan.parent_run)}`);
			if (titan.elevation !== undefined && titan.elevation !== "default" && !isMapping(titan.elevation)) issues.error("titan", `titan.elevation must be "default" or a ladder mapping {fail_1, fail_2, fail_3}; found ${show(titan.elevation)}`);
			if (titan.evidence !== undefined) {
				if (!isMapping(titan.evidence)) issues.error("titan", `titan.evidence must be a mapping {require: [kinds], dir}`);
				else {
					for (const key of Object.keys(titan.evidence)) if (!TITAN_EVIDENCE_KEYS.has(key)) issues.warn("unknown-key", `titan.evidence.${key} is unknown and ignored`);
					if (titan.evidence.require !== undefined) {
						if (isStringList(titan.evidence.require)) requiredEvidence.push(...titan.evidence.require);
						else issues.error("titan", `titan.evidence.require must be a list of evidence kinds`);
					}
					if (titan.evidence.dir !== undefined && !isText(titan.evidence.dir)) issues.error("titan", `titan.evidence.dir must be a path`);
				}
			}
			if (titan.watchdog !== undefined) {
				if (!isMapping(titan.watchdog)) issues.error("titan", `titan.watchdog must be a mapping`);
				else {
					const watchdog = titan.watchdog;
					for (const key of Object.keys(watchdog)) if (!TITAN_WATCHDOG_KEYS.has(key)) issues.warn("unknown-key", `titan.watchdog.${key} is unknown and ignored`);
					if (watchdog.enabled !== undefined && typeof watchdog.enabled !== "boolean") issues.error("titan", `titan.watchdog.enabled must be boolean`);
					const watchdogModel = watchdog.model !== undefined ? checkModel(watchdog.model, "titan.watchdog.model") : undefined;
					if (watchdog.thinking !== undefined) checkThinking(watchdog.thinking, watchdogModel, "titan.watchdog.thinking");
					for (const key of ["cadence_tools", "stalemate_repeats"] as const) {
						if (watchdog[key] !== undefined && (!isInt(watchdog[key]) || (watchdog[key] as number) < 1)) issues.error("titan", `titan.watchdog.${key} must be a positive integer`);
					}
					if (watchdog.inspector_timeout_ms !== undefined && (!isInt(watchdog.inspector_timeout_ms) || watchdog.inspector_timeout_ms < 0)) issues.error("titan", `titan.watchdog.inspector_timeout_ms must be a non-negative integer`);
					if (watchdog.on_compaction !== undefined && !(ON_COMPACTION_MODES as readonly unknown[]).includes(watchdog.on_compaction)) issues.error("titan", `titan.watchdog.on_compaction must be one of ${list(ON_COMPACTION_MODES)}; found ${show(watchdog.on_compaction)}`);
				}
			}
			if (titan.budget !== undefined) {
				if (!isMapping(titan.budget)) issues.error("titan", `titan.budget must be a mapping {usd, tokens, max_concurrent_children, context_budget}`);
				else {
					const budget = titan.budget;
					for (const key of Object.keys(budget)) if (!TITAN_BUDGET_KEYS.has(key)) issues.warn("unknown-key", `titan.budget.${key} is unknown and ignored`);
					if (budget.usd !== undefined && (typeof budget.usd !== "number" || !(budget.usd >= 0))) issues.error("titan", `titan.budget.usd must be a non-negative number`);
					if (budget.tokens !== undefined && (!isInt(budget.tokens) || budget.tokens < 0)) issues.error("titan", `titan.budget.tokens must be a non-negative integer`);
					if (budget.context_budget !== undefined && (!isInt(budget.context_budget) || budget.context_budget < 1)) issues.error("titan", `titan.budget.context_budget must be a positive integer`);
					if (budget.max_concurrent_children !== undefined && (!isInt(budget.max_concurrent_children) || budget.max_concurrent_children < 1 || budget.max_concurrent_children > 16)) {
						issues.error("titan", `titan.budget.max_concurrent_children must be an integer between 1 and 16; found ${show(budget.max_concurrent_children)}`);
					}
				}
			}
		}
	}

	// ── nodes: identity and type ──
	if (!Array.isArray(top.nodes) || top.nodes.length === 0) {
		issues.error("nodes", top.nodes === undefined ? "nodes is required: a non-empty list of nodes" : `nodes must be a non-empty list; found ${show(top.nodes)}`);
		return done();
	}
	const rawNodes = top.nodes as unknown[];
	const nodes = new Map<string, Record<string, unknown>>();
	const types = new Map<string, NodeType>();
	const order: string[] = [];
	rawNodes.forEach((raw, index) => {
		if (!isMapping(raw)) {
			issues.error("nodes", `nodes[${index}] must be a mapping; found ${show(raw)}`);
			return;
		}
		const id = typeof raw.id === "string" ? raw.id : undefined;
		const label = id ?? `nodes[${index}]`;
		if (!id || !ID_RE.test(id)) issues.error("id", `${id === undefined ? `nodes[${index}]` : `node id ${show(raw.id)}`} must match ^[a-z0-9][a-z0-9-_]{0,31}$`, id);
		if (id && nodes.has(id)) {
			issues.error("id", `node id ${show(id)} is used more than once`, id);
			return;
		}
		const present = nodeTypesOf(raw);
		if (present.length !== 1) {
			issues.error("node-type", `exactly one of command, prompt, bash, script, loop, approval, cancel, verify, best_of, interleave, hypothesis, mcp_tool, workflow is required; found ${present.length ? list(present) : "none"}`, label);
		}
		if (id) {
			nodes.set(id, raw);
			order.push(id);
			if (present.length === 1) types.set(id, present[0]);
		}
	});
	const typeOf = (id: string): NodeType | undefined => types.get(id);
	const roleOf = (id: string): string | undefined => {
		const role = nodes.get(id)?.role;
		return typeof role === "string" ? role : undefined;
	};
	const schemaOf = (id: string): JsonSchema | undefined => {
		const format = nodes.get(id)?.output_format;
		if (!isMapping(format)) return undefined;
		if (typeof format.$ref === "string") return resolveRef(format.$ref);
		return format as JsonSchema;
	};
	const hasOutputFormat = (id: string): boolean => isMapping(nodes.get(id)?.output_format);

	if (isText(top.returns) && !nodes.has(top.returns)) issues.error("returns", `returns names ${show(top.returns)}, which is not a node`);
	const returnsId = isText(top.returns) && nodes.has(top.returns) ? top.returns : undefined;

	// ── graph ──
	const deps = new Map<string, string[]>();
	for (const id of order) {
		const node = nodes.get(id)!;
		const raw = node.depends_on;
		if (raw === undefined) {
			deps.set(id, []);
			continue;
		}
		if (!isStringList(raw)) {
			issues.error("depends_on", `depends_on must be a list of node ids; found ${show(raw)}`, id);
			deps.set(id, []);
			continue;
		}
		for (const dep of raw) {
			if (!nodes.has(dep)) issues.error("depends_on", `depends_on names unknown node ${show(dep)}`, id);
			else if (dep === id) issues.error("cycle", `node depends on itself`, id);
		}
		deps.set(id, unique(raw.filter((dep) => nodes.has(dep))));
	}
	const { layers, unplaced } = kahnLayers(order, deps);
	if (unplaced.length) {
		// the members of a cycle are the unplaced nodes that reach themselves; the rest only sit downstream of one
		const restricted = new Map<string, string[]>(unplaced.map((id) => [id, (deps.get(id) ?? []).filter((dep) => unplaced.includes(dep))]));
		const members = unplaced.filter((id) => reachable(id, restricted).has(id));
		if (members.length && !members.every((id) => (deps.get(id) ?? []).includes(id) && (deps.get(id) ?? []).length === 1)) {
			issues.error("cycle", `dependency cycle among ${list(members)}`);
		}
	}
	const dependents = new Map<string, string[]>(order.map((id) => [id, []]));
	for (const id of order) for (const dep of deps.get(id) ?? []) dependents.get(dep)?.push(id);
	const ancestors = new Map<string, Set<string>>(order.map((id) => [id, reachable(id, deps)]));
	const descendants = new Map<string, Set<string>>(order.map((id) => [id, reachable(id, dependents)]));
	const layerOf = new Map<string, string[]>();
	for (const layer of layers) for (const id of layer) layerOf.set(id, layer);

	// ── per node ──
	const callsigns = new Map<string, string>();
	const producedEvidence = new Set<string>();
	for (const id of order) {
		const node = nodes.get(id)!;
		const type = typeOf(id);
		const role = node.role;

		for (const key of Object.keys(node)) {
			if (!NODE_KEYS.has(key)) issues.warn("unknown-key", `node key ${show(key)} is unknown and ignored`, id);
			else if ((key === "runtime" || key === "deps") && type !== undefined && type !== "script") issues.warn("ignored-key", `${key} only applies to script nodes`, id);
			else if (AI_ONLY_NODE_KEYS.has(key) && (type === "bash" || type === "script")) issues.warn("ignored-key", `${key} is ignored on ${type} nodes (no AI is invoked)`, id);
		}

		// base fields
		if (node.when !== undefined && typeof node.when !== "string") issues.error("when", `when must be an expression string; found ${show(node.when)}`, id);
		if (node.trigger_rule !== undefined && !(TRIGGER_RULES as readonly unknown[]).includes(node.trigger_rule)) issues.error("trigger_rule", `trigger_rule must be one of ${list(TRIGGER_RULES)}; found ${show(node.trigger_rule)}`, id);
		for (const key of ["idle_timeout", "timeout", "context_budget"] as const) {
			if (node[key] !== undefined && (!isInt(node[key]) || (node[key] as number) < 1)) issues.error("type", `${key} must be a positive integer; found ${show(node[key])}`, id);
		}
		if (node.retry !== undefined) {
			if (type === "loop") issues.error("retry", "retry is not allowed on loop nodes (max_iterations is the loop's budget)", id);
			if (!isMapping(node.retry)) issues.error("retry", `retry must be a mapping {max_attempts, delay_ms}; found ${show(node.retry)}`, id);
			else {
				for (const key of Object.keys(node.retry)) if (!RETRY_KEYS.has(key)) issues.warn("unknown-key", `retry.${key} is unknown and ignored`, id);
				if (node.retry.max_attempts !== undefined && (!isInt(node.retry.max_attempts) || node.retry.max_attempts < 1 || node.retry.max_attempts > 10)) issues.error("retry", `retry.max_attempts must be an integer between 1 and 10; found ${show(node.retry.max_attempts)}`, id);
				if (node.retry.delay_ms !== undefined && (!isInt(node.retry.delay_ms) || node.retry.delay_ms < 0)) issues.error("retry", `retry.delay_ms must be a non-negative integer; found ${show(node.retry.delay_ms)}`, id);
			}
		}
		if (node.phase !== undefined) {
			if (!isText(node.phase)) issues.error("phase", `phase must be a phase title; found ${show(node.phase)}`, id);
			else if (phasesDeclared && !phaseTitles.has(node.phase)) issues.error("phase", `phase ${show(node.phase)} is not declared in phases (${list([...phaseTitles])})`, id);
		}
		if (role !== undefined && !(SLOT_ROLES as readonly unknown[]).includes(role)) issues.error("role", `role must be one of ${list(SLOT_ROLES)}; found ${show(role)}`, id);
		if (node.callsign !== undefined) {
			if (!isText(node.callsign)) issues.error("callsign", `callsign must be "pool" or a name; found ${show(node.callsign)}`, id);
			else if (node.callsign !== "pool") {
				const owner = callsigns.get(node.callsign);
				if (owner) issues.error("callsign", `callsign ${show(node.callsign)} is also used by node ${owner}; callsigns are unique per workflow`, id);
				else callsigns.set(node.callsign, id);
			}
		}
		if (node.persona !== undefined) {
			if (!isText(node.persona)) issues.error("persona", `persona must be a persona name; found ${show(node.persona)}`, id);
			else if (ctx.personaDirs && !findPersonaFile(node.persona, ctx.personaDirs)) issues.error("persona", `persona ${show(node.persona)} not found as personas/${node.persona}.md under ${list(ctx.personaDirs)}`, id);
		}
		for (const key of ["tier", "output_type", "system_prompt"] as const) {
			if (node[key] !== undefined && typeof node[key] !== "string") issues.error("type", `${key} must be a string; found ${show(node[key])}`, id);
		}
		if (node.mimeograph !== undefined) {
			// A comma-separated persona list, or {personas, models?, judge?, criteria?} (plan A12; personas.ts).
			const mimeo = node.mimeograph as unknown;
			if (isText(mimeo)) {
				if (ctx.personaDirs) for (const name of mimeo.split(",").map((n) => n.trim()).filter(Boolean)) if (!findPersonaFile(name, ctx.personaDirs)) issues.error("persona", `mimeograph persona ${show(name)} not found as personas/${name}.md under ${list(ctx.personaDirs)}`, id);
			} else if (isMapping(mimeo)) {
				for (const key of Object.keys(mimeo)) if (!MIMEOGRAPH_KEYS.has(key)) issues.warn("unknown-key", `mimeograph.${key} is unknown and ignored`, id);
				if (!isStringList(mimeo.personas) || !mimeo.personas.length) issues.error("type", `mimeograph.personas must be a non-empty list of persona names; found ${show(mimeo.personas)}`, id);
				else if (ctx.personaDirs) for (const name of mimeo.personas) if (!findPersonaFile(name, ctx.personaDirs)) issues.error("persona", `mimeograph persona ${show(name)} not found as personas/${name}.md under ${list(ctx.personaDirs)}`, id);
				if (mimeo.models !== undefined) {
					if (!isStringList(mimeo.models) || !mimeo.models.length) issues.error("type", `mimeograph.models must be a non-empty list of provider/id models; found ${show(mimeo.models)}`, id);
					else for (const model of mimeo.models) if (!MODEL_RE.test(model)) issues.error("model", `mimeograph model ${show(model)} is not provider/id`, id);
				}
				for (const key of ["judge", "criteria"] as const) if (mimeo[key] !== undefined && typeof mimeo[key] !== "string") issues.error("type", `mimeograph.${key} must be a string; found ${show(mimeo[key])}`, id);
			} else issues.error("type", `mimeograph must be a comma-separated persona list or a mapping {personas, models, judge, criteria}; found ${show(mimeo)}`, id);
		}
		if (node.append_system_prompt !== undefined && typeof node.append_system_prompt !== "string" && !isStringList(node.append_system_prompt)) issues.error("type", `append_system_prompt must be a string or a list of strings`, id);
		if (node.evidence !== undefined) {
			if (!isMapping(node.evidence)) issues.error("evidence", `evidence must be a mapping {produces: [kinds], require: [kinds]}; found ${show(node.evidence)}`, id);
			else {
				for (const key of Object.keys(node.evidence)) if (!NODE_EVIDENCE_KEYS.has(key)) issues.warn("unknown-key", `evidence.${key} is unknown and ignored`, id);
				for (const key of ["produces", "require"] as const) {
					if (node.evidence[key] !== undefined && !isStringList(node.evidence[key])) issues.error("evidence", `evidence.${key} must be a list of evidence kinds`, id);
				}
				if (isStringList(node.evidence.produces)) for (const kind of node.evidence.produces) producedEvidence.add(kind);
			}
		}
		if (node.review !== undefined && !(REVIEW_POLICIES as readonly unknown[]).includes(node.review)) issues.error("review", `review must be one of ${list(REVIEW_POLICIES)}; found ${show(node.review)}`, id);
		if (node.on_fail !== undefined) {
			if (!isMapping(node.on_fail) || !(ON_FAIL_ACTIONS as readonly unknown[]).includes(node.on_fail.action)) issues.error("on_fail", `on_fail must be {action: ${ON_FAIL_ACTIONS.join(" | ")}, max?}; found ${show(node.on_fail)}`, id);
			else {
				for (const key of Object.keys(node.on_fail)) if (!ON_FAIL_KEYS.has(key)) issues.warn("unknown-key", `on_fail.${key} is unknown and ignored`, id);
				if (node.on_fail.max !== undefined && (!isInt(node.on_fail.max) || node.on_fail.max < 1 || node.on_fail.max > 10)) issues.error("on_fail", `on_fail.max must be an integer between 1 and 10; found ${show(node.on_fail.max)}`, id);
			}
		}
		if (node.watchdog !== undefined && (!isMapping(node.watchdog) || (node.watchdog.policy !== undefined && !(WATCHDOG_POLICIES as readonly unknown[]).includes(node.watchdog.policy)))) {
			issues.error("type", `watchdog must be {policy: ${WATCHDOG_POLICIES.join(" | ")}}; found ${show(node.watchdog)}`, id);
		}
		if (node.budget !== undefined) {
			if (!isMapping(node.budget)) issues.error("type", `budget must be a mapping {usd, tokens}; found ${show(node.budget)}`, id);
			else {
				if (node.budget.usd !== undefined && (typeof node.budget.usd !== "number" || !(node.budget.usd >= 0))) issues.error("type", `budget.usd must be a non-negative number`, id);
				if (node.budget.tokens !== undefined && (!isInt(node.budget.tokens) || node.budget.tokens < 0)) issues.error("type", `budget.tokens must be a non-negative integer`, id);
			}
		}
		if (node.isolation !== undefined && !(ISOLATION_MODES as readonly unknown[]).includes(node.isolation)) issues.error("type", `isolation must be none or worktree; found ${show(node.isolation)}`, id);
		if (node.anonymize !== undefined && typeof node.anonymize !== "boolean") issues.error("type", `anonymize must be boolean`, id);
		const nodeModel = node.model !== undefined ? checkModel(node.model, "model", id) : topModel;
		if (node.thinking !== undefined) checkThinking(node.thinking, nodeModel, "thinking", id);
		if (node.context !== undefined) {
			if (node.context === "shared") {
				const layer = layerOf.get(id) ?? [];
				if (layer.length > 1) issues.error("context", `context: shared is not allowed in a parallel layer (with ${list(layer.filter((other) => other !== id))}); use context: fresh or {resume: <id>}`, id);
			} else if (isMapping(node.context) && Object.keys(node.context).length === 1 && typeof node.context.resume === "string") {
				const target = node.context.resume;
				if (!nodes.has(target)) issues.error("context", `context.resume names unknown node ${show(target)}`, id);
				else if (target === id) issues.error("context", `context.resume may not name the node itself`, id);
				else if (!ancestors.get(id)?.has(target)) issues.warn("context", `context.resume names ${target}, which is not upstream of this node; its session may not exist yet`, id);
			} else if (node.context !== "fresh") issues.error("context", `context must be fresh, shared or {resume: <node id>}; found ${show(node.context)}`, id);
		}
		if (node.output_format !== undefined) {
			if (!isMapping(node.output_format)) issues.error("output_format", `output_format must be a JSON Schema mapping; found ${show(node.output_format)}`, id);
			else if (node.output_format.$ref !== undefined && (typeof node.output_format.$ref !== "string" || !resolveRef(node.output_format.$ref))) issues.error("output_format", `output_format.$ref ${show(node.output_format.$ref)} is not a known titan://schemas/… reference`, id);
			else if (node.output_format.type !== undefined && typeof node.output_format.type !== "string" && !isStringList(node.output_format.type)) issues.error("output_format", `output_format.type must be a type name or a list of type names`, id);
		}
		for (const key of ["allowed_tools", "denied_tools"] as const) {
			if (node[key] === undefined) continue;
			if (!isStringList(node[key])) {
				issues.error("tools", `${key} must be a list of tool names; found ${show(node[key])}`, id);
				continue;
			}
			for (const tool of node[key] as string[]) if (/^[A-Z]/.test(tool)) issues.warn("tools", `${key} names ${show(tool)}; Pi tool names are lowercase (read, bash, edit, write, grep, find, ls or an MCP tool name)`, id);
		}
		if (node.hooks !== undefined) checkHooks(node.hooks, id);
		for (const key of ["mcp", "skills"] as const) if (node[key] !== undefined && !isStringList(node[key])) issues.error("type", `${key} must be a list of names; found ${show(node[key])}`, id);
		if (node.subagents !== undefined) {
			if (!isMapping(node.subagents)) issues.error("type", `subagents must be a mapping {enabled, tools, cap}; found ${show(node.subagents)}`, id);
			else {
				for (const key of Object.keys(node.subagents)) if (!SUBAGENTS_KEYS.has(key)) issues.warn("unknown-key", `subagents.${key} is unknown and ignored`, id);
				if (node.subagents.enabled !== undefined && typeof node.subagents.enabled !== "boolean") issues.error("type", `subagents.enabled must be boolean`, id);
				if (node.subagents.tools !== undefined && !isStringList(node.subagents.tools)) issues.error("type", `subagents.tools must be a list of tool names`, id);
				if (node.subagents.cap !== undefined && (!isInt(node.subagents.cap) || node.subagents.cap < 0)) issues.error("type", `subagents.cap must be a non-negative integer`, id);
			}
		}

		// the architect never writes (constraint 5)
		if (role === "architect") {
			if (type !== undefined && !ARCHITECT_NODE_TYPES.includes(type)) issues.error("architect", `role: architect nodes may only be prompt, command or approval nodes (the architect never writes); found a ${type} node`, id);
			if (isStringList(node.allowed_tools)) {
				const writes = node.allowed_tools.filter((tool) => WRITE_TOOLS.includes(tool));
				if (writes.length) issues.error("architect", `role: architect may not hold write tools; allowed_tools contains ${list(writes)} (read-only tools are read, grep, find, ls)`, id);
			}
		}

		// type-specific fields
		const texts: Array<{ field: string; text: string }> = [];
		const collect = (field: string, value: unknown): void => {
			if (typeof value === "string") texts.push({ field, text: value });
		};
		switch (type) {
			case "command": {
				if (!isText(node.command)) issues.error("command", `command must name a command file; found ${show(node.command)}`, id);
				else if (!FILE_NAME_RE.test(node.command)) issues.error("command", `command ${show(node.command)} must be a bare name (commands/<name>.md, one subfolder level allowed)`, id);
				else if (!findCommandFile(node.command, commandDirs)) issues.error("command", `command file commands/${node.command}.md not found under ${commandDirs.length ? list(commandDirs) : "(no command roots)"}`, id);
				break;
			}
			case "prompt":
				if (!isText(node.prompt)) issues.error("prompt", `prompt must be a non-empty string; found ${show(node.prompt)}`, id);
				collect("prompt", node.prompt);
				break;
			case "bash":
				if (!isText(node.bash)) issues.error("bash", `bash must be a non-empty command string; found ${show(node.bash)}`, id);
				collect("bash", node.bash);
				break;
			case "script": {
				if (!isText(node.script)) issues.error("script", `script must be inline code or a script name; found ${show(node.script)}`, id);
				const runtime = node.runtime;
				if (!(SCRIPT_RUNTIMES as readonly unknown[]).includes(runtime)) issues.error("script", `script nodes require runtime: bun or runtime: uv; found ${show(runtime)}`, id);
				if (node.deps !== undefined) {
					if (!isStringList(node.deps)) issues.error("script", `deps must be a list of package specs; found ${show(node.deps)}`, id);
					else if (runtime === "bun") issues.warn("script", `deps is uv-only and ignored with runtime: bun (bun installs imports itself)`, id);
				}
				if (isText(node.script)) {
					if (isInlineScript(node.script)) collect("script", node.script);
					else {
						const found = findScriptFile(node.script, scriptDirs);
						if (!found) issues.error("script", `named script ${show(node.script)} not found as scripts/${node.script}.{ts,js,py} under ${scriptDirs.length ? list(scriptDirs) : "(no script roots)"}`, id);
						else if ((SCRIPT_RUNTIMES as readonly unknown[]).includes(runtime) && found.runtime !== runtime) issues.error("script", `named script ${show(node.script)} resolves to ${found.path} (${path.extname(found.path)} → ${found.runtime}) but runtime is ${String(runtime)}`, id);
					}
				}
				break;
			}
			case "loop": {
				const loop = node.loop;
				if (!isMapping(loop)) {
					issues.error("loop", `loop must be a mapping {prompt, until | until_bash, max_iterations, …}; found ${show(loop)}`, id);
					break;
				}
				for (const key of Object.keys(loop)) if (!LOOP_KEYS.has(key)) issues.warn("unknown-key", `loop.${key} is unknown and ignored`, id);
				if (!isText(loop.prompt)) issues.error("loop", `loop.prompt must be a non-empty string`, id);
				if (!isInt(loop.max_iterations) || loop.max_iterations < 1 || loop.max_iterations > 10) issues.error("loop", `loop.max_iterations must be an integer between 1 and 10; found ${show(loop.max_iterations)}`, id);
				if (loop.until !== undefined && !isText(loop.until)) issues.error("loop", `loop.until must be a non-empty completion token`, id);
				if (loop.until_bash !== undefined && !isText(loop.until_bash)) issues.error("loop", `loop.until_bash must be a non-empty command`, id);
				if (!isText(loop.until) && !isText(loop.until_bash)) issues.error("loop", `loop needs a completion condition: until (a token) and/or until_bash (exit 0 = done)`, id);
				for (const key of ["fresh_context", "interactive"] as const) if (loop[key] !== undefined && typeof loop[key] !== "boolean") issues.error("loop", `loop.${key} must be boolean`, id);
				if (loop.interactive === true && !isText(loop.gate_message)) issues.error("loop", `loop.gate_message is required when loop.interactive is true`, id);
				if (loop.gate_message !== undefined && typeof loop.gate_message !== "string") issues.error("loop", `loop.gate_message must be a string`, id);
				collect("loop.prompt", loop.prompt);
				collect("loop.until_bash", loop.until_bash);
				break;
			}
			case "approval": {
				const approval = node.approval;
				if (!isMapping(approval)) {
					issues.error("approval", `approval must be a mapping {message, capture_response?, on_reject?, preset_key?}; found ${show(approval)}`, id);
					break;
				}
				for (const key of Object.keys(approval)) if (!APPROVAL_KEYS.has(key)) issues.warn("unknown-key", `approval.${key} is unknown and ignored`, id);
				if (!isText(approval.message)) issues.error("approval", `approval.message is required and must be non-empty`, id);
				if (approval.capture_response !== undefined && typeof approval.capture_response !== "boolean") issues.error("approval", `approval.capture_response must be boolean`, id);
				if (approval.preset_key !== undefined && !isText(approval.preset_key)) issues.error("approval", `approval.preset_key must be a preset name`, id);
				if (approval.on_reject !== undefined) {
					if (!isMapping(approval.on_reject) || !isText(approval.on_reject.prompt)) issues.error("approval", `approval.on_reject must be {prompt, max_attempts?} with a non-empty prompt; found ${show(approval.on_reject)}`, id);
					else {
						for (const key of Object.keys(approval.on_reject)) if (!ON_REJECT_KEYS.has(key)) issues.warn("unknown-key", `approval.on_reject.${key} is unknown and ignored`, id);
						const max = approval.on_reject.max_attempts;
						if (max !== undefined && (!isInt(max) || max < 1 || max > 10)) issues.error("approval", `approval.on_reject.max_attempts must be an integer between 1 and 10; found ${show(max)}`, id);
						collect("approval.on_reject.prompt", approval.on_reject.prompt);
					}
				}
				collect("approval.message", approval.message);
				break;
			}
			case "cancel":
				if (!isText(node.cancel)) issues.error("cancel", `cancel needs a non-empty reason; found ${show(node.cancel)}`, id);
				collect("cancel", node.cancel);
				break;
			case "verify": {
				const verify = node.verify;
				if (!isMapping(verify)) {
					issues.error("verify", `verify must be a mapping {runner, objective, …}; found ${show(verify)}`, id);
					break;
				}
				if (!(VERIFY_RUNNERS as readonly unknown[]).includes(verify.runner)) issues.error("verify", `verify.runner must be one of ${list(VERIFY_RUNNERS)}; found ${show(verify.runner)}`, id);
				if (verify.devices !== undefined && !isStringList(verify.devices)) issues.error("verify", `verify.devices must be a list of device names`, id);
				if (verify.headless !== undefined && typeof verify.headless !== "boolean") issues.error("verify", `verify.headless must be boolean`, id);
				const require = isMapping(node.evidence) ? node.evidence.require : undefined;
				if (!isStringList(require) || require.length === 0) issues.error("verify", `verify nodes need evidence.require with at least one evidence kind (fail closed: no hard evidence, no verification)`, id);
				for (const [key, value] of Object.entries(verify)) collect(`verify.${key}`, value);
				break;
			}
			case "best_of": {
				const spec = node.best_of;
				if (!isMapping(spec)) {
					issues.error("best_of", `best_of must be a mapping {n, prompt, judge?, criteria?}; found ${show(spec)}`, id);
					break;
				}
				for (const key of Object.keys(spec)) if (!BEST_OF_KEYS.has(key)) issues.warn("unknown-key", `best_of.${key} is unknown and ignored`, id);
				if (!isInt(spec.n) || spec.n < 2 || spec.n > 8) issues.error("best_of", `best_of.n must be an integer between 2 and 8; found ${show(spec.n)}`, id);
				if (!isText(spec.prompt)) issues.error("best_of", `best_of.prompt must be a non-empty string`, id);
				for (const key of ["judge", "criteria"] as const) if (spec[key] !== undefined && typeof spec[key] !== "string") issues.error("best_of", `best_of.${key} must be a string`, id);
				collect("best_of.prompt", spec.prompt);
				collect("best_of.criteria", spec.criteria);
				break;
			}
			case "interleave": {
				const spec = node.interleave;
				if (!isMapping(spec)) {
					issues.error("interleave", `interleave must be a mapping {segments, prompt, by?, synthesize?, reauthor?}; found ${show(spec)}`, id);
					break;
				}
				for (const key of Object.keys(spec)) if (!INTERLEAVE_KEYS.has(key)) issues.warn("unknown-key", `interleave.${key} is unknown and ignored`, id);
				const segments = spec.segments;
				const okCount = isInt(segments) && segments >= 2 && segments <= 16;
				const okList = isStringList(segments) && segments.length >= 2 && segments.length <= 16 && segments.every(isText);
				if (!okCount && !okList) issues.error("interleave", `interleave.segments must be an integer between 2 and 16 or a list of 2-16 segment names; found ${show(segments)}`, id);
				if (spec.by !== undefined && !(INTERLEAVE_BY as readonly unknown[]).includes(spec.by)) issues.error("interleave", `interleave.by must be one of ${list(INTERLEAVE_BY)}; found ${show(spec.by)}`, id);
				for (const key of ["synthesize", "reauthor"] as const) if (spec[key] !== undefined && typeof spec[key] !== "boolean") issues.error("interleave", `interleave.${key} must be boolean`, id);
				if (!isText(spec.prompt)) issues.error("interleave", `interleave.prompt must be a non-empty string`, id);
				collect("interleave.prompt", spec.prompt);
				break;
			}
			case "hypothesis": {
				const spec = node.hypothesis;
				if (!isMapping(spec)) {
					issues.error("hypothesis", `hypothesis must be a mapping {hypotheses: [{id, claim, predicts?}], decide_by}; found ${show(spec)}`, id);
					break;
				}
				for (const key of Object.keys(spec)) if (!HYPOTHESIS_KEYS.has(key)) issues.warn("unknown-key", `hypothesis.${key} is unknown and ignored`, id);
				if (!Array.isArray(spec.hypotheses) || spec.hypotheses.length === 0) issues.error("hypothesis", `hypothesis.hypotheses must list at least one {id, claim}`, id);
				else {
					const seen = new Set<string>();
					spec.hypotheses.forEach((item, index) => {
						if (!isMapping(item) || !isText(item.id) || !isText(item.claim)) {
							issues.error("hypothesis", `hypothesis.hypotheses[${index}] must be {id, claim, predicts?} with non-empty id and claim`, id);
							return;
						}
						for (const key of Object.keys(item)) if (!HYPOTHESIS_ITEM_KEYS.has(key)) issues.warn("unknown-key", `hypothesis.hypotheses[${index}].${key} is unknown and ignored`, id);
						if (item.predicts !== undefined && typeof item.predicts !== "string") issues.error("hypothesis", `hypothesis.hypotheses[${index}].predicts must be a string`, id);
						if (seen.has(item.id)) issues.error("hypothesis", `hypothesis id ${show(item.id)} is used twice`, id);
						seen.add(item.id);
					});
				}
				if (!isText(spec.decide_by)) issues.error("hypothesis", `hypothesis.decide_by is required (how the evidence links decide)`, id);
				break;
			}
			case "mcp_tool": {
				const spec = node.mcp_tool;
				if (!isMapping(spec)) {
					issues.error("mcp_tool", `mcp_tool must be a mapping {server, tool, args?}; found ${show(spec)}`, id);
					break;
				}
				for (const key of Object.keys(spec)) if (!MCP_TOOL_KEYS.has(key)) issues.warn("unknown-key", `mcp_tool.${key} is unknown and ignored`, id);
				if (!isText(spec.server)) issues.error("mcp_tool", `mcp_tool.server must name an MCP server`, id);
				if (!isText(spec.tool)) issues.error("mcp_tool", `mcp_tool.tool must name a tool`, id);
				if (spec.args !== undefined && !isMapping(spec.args)) issues.error("mcp_tool", `mcp_tool.args must be a mapping`, id);
				if (isMapping(spec.args)) for (const [key, value] of Object.entries(spec.args)) collect(`mcp_tool.args.${key}`, value);
				break;
			}
			case "workflow": {
				const spec = node.workflow;
				if (!isMapping(spec)) {
					issues.error("workflow", `workflow must be a mapping {name, fan_out?, isolation?}; found ${show(spec)}`, id);
					break;
				}
				for (const key of Object.keys(spec)) if (!WORKFLOW_NODE_KEYS.has(key)) issues.warn("unknown-key", `workflow.${key} is unknown and ignored`, id);
				if (typeof spec.name !== "string" || !NAME_RE.test(spec.name)) issues.error("workflow", `workflow.name must be a workflow name; found ${show(spec.name)}`, id);
				else if (spec.name === top.name) issues.error("workflow", `a workflow may not call itself`, id);
				else if (ctx.workflowNames && !ctx.workflowNames.includes(spec.name)) issues.error("workflow", `workflow ${show(spec.name)} is not installed (known: ${ctx.workflowNames.length ? list(ctx.workflowNames) : "none"})`, id);
				if (spec.isolation !== undefined && spec.isolation !== "worktree") issues.error("workflow", `workflow.isolation must be worktree when set; found ${show(spec.isolation)}`, id);
				if (spec.fan_out !== undefined) {
					if (!isMapping(spec.fan_out) || !isText(spec.fan_out.source) || !isText(spec.fan_out.as)) issues.error("workflow", `workflow.fan_out must be {source, as, join?} with non-empty source and as; found ${show(spec.fan_out)}`, id);
					else {
						for (const key of Object.keys(spec.fan_out)) if (!FAN_OUT_KEYS.has(key)) issues.warn("unknown-key", `workflow.fan_out.${key} is unknown and ignored`, id);
						if (spec.fan_out.join !== undefined && !(TRIGGER_RULES as readonly unknown[]).includes(spec.fan_out.join)) issues.error("workflow", `workflow.fan_out.join must be one of ${list(TRIGGER_RULES)}; found ${show(spec.fan_out.join)}`, id);
						collect("workflow.fan_out.source", spec.fan_out.source);
					}
				}
				break;
			}
			default:
				break; // node-type already reported
		}

		// $id.output references in substitutable text
		for (const { field, text } of texts) {
			for (const ref of outputRefs(text)) {
				if (ref === id) issues.error("ref", `${field} reads $${id}.output — a node cannot read its own output`, id);
				else if (!nodes.has(ref)) issues.error("ref", `${field} reads $${ref}.output but there is no node ${show(ref)}`, id);
				else if (!ancestors.get(id)?.has(ref)) issues.warn("ref-order", `${field} reads $${ref}.output but ${ref} is not upstream of this node (add it to depends_on, directly or through the chain); the value may be unresolved at run time`, id);
			}
		}

		// when: grammar, then graph
		if (typeof node.when === "string") {
			const parsed = parseWhen(node.when);
			if (!parsed.ok) issues.error("when", `when ${show(node.when)} does not parse: ${parsed.error}`, id);
			else {
				for (const ref of parsed.refs) {
					if (ref === id) issues.error("when", `when reads $${id}.output — a node cannot route on its own output`, id);
					else if (!nodes.has(ref)) issues.error("ref", `when reads $${ref}.output but there is no node ${show(ref)}`, id);
					else if (!hasOutputFormat(ref)) issues.error("when", `when may only read nodes with output_format; ${ref} has none`, id);
					else if (!ancestors.get(id)?.has(ref)) issues.warn("ref-order", `when reads $${ref}.output but ${ref} is not upstream of this node; the condition will fail closed (skip) when the value is missing`, id);
				}
				for (const { node: ref, path: fieldPath } of whenRefs(parsed.ast!)) {
					const schema = nodes.has(ref) ? schemaOf(ref) : undefined;
					if (!schema?.properties || !fieldPath.length) continue;
					if (fieldPath[0] in schema.properties) continue;
					if (schema.additionalProperties === true || isMapping(schema.additionalProperties)) continue;
					issues.warn("when-field", `when reads $${ref}.output.${fieldPath.join(".")} but ${ref}'s output_format declares only ${list(Object.keys(schema.properties))}`, id);
				}
			}
		}
	}

	// ── graph-wide rules ──
	for (const kind of unique(requiredEvidence)) {
		if (!producedEvidence.has(kind)) issues.error("evidence", `titan.evidence.require lists ${show(kind)} but no node declares it in evidence.produces`);
	}
	const returnsAncestors = returnsId ? ancestors.get(returnsId) : undefined;
	for (const id of order) {
		const node = nodes.get(id)!;
		if (node.role !== "builder" || (node.review !== undefined && node.review !== "required")) continue;
		const reviewers = [...(descendants.get(id) ?? [])].filter((other) => roleOf(other) === "auditor" || typeOf(other) === "verify");
		const beforeReturns = returnsId ? reviewers.filter((other) => other === returnsId || returnsAncestors?.has(other)) : reviewers;
		if (!beforeReturns.length) {
			issues.error("review", `builder node has review: required (the default for builders) but no auditor or verify node follows it${returnsId ? ` before returns (${returnsId})` : ""}; add one or set review: optional`, id);
		}
	}
	if (tier === "platform-update") {
		for (const id of order) {
			const shipLike = id.startsWith("ship") || (roleOf(id) === "fuser" && id === returnsId);
			if (!shipLike) continue;
			const simUser = [...(ancestors.get(id) ?? [])].some((other) => {
				const verify = nodes.get(other)?.verify;
				return typeOf(other) === "verify" && isMapping(verify) && (SIM_USER_RUNNERS as readonly unknown[]).includes(verify.runner);
			});
			if (!simUser) issues.error("platform-update", `tier platform-update: ship node needs a simulated-user verify ancestor (runner ${list(SIM_USER_RUNNERS)}) — 100 % of shipped features must be exercised before shipping`, id);
		}
	}

	// ── normalized document ──
	const normalized = clone(top) as unknown as WorkflowDoc;
	for (const node of (normalized.nodes as unknown[]) ?? []) {
		if (!isMapping(node) || node.role !== "architect") continue;
		const present = nodeTypesOf(node);
		if (present.length !== 1 || (present[0] !== "prompt" && present[0] !== "command")) continue;
		node.denied_tools = unique([...(isStringList(node.denied_tools) ? node.denied_tools : []), ...WRITE_TOOLS]);
	}
	return done(normalized);

	function checkHooks(hooks: unknown, node: string): void {
		if (!isMapping(hooks)) {
			issues.error("hooks", `hooks must be a mapping of PreToolUse / PostToolUse / Stop rule lists; found ${show(hooks)}`, node);
			return;
		}
		for (const [event, rules] of Object.entries(hooks)) {
			if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
				issues.warn("hooks", `hooks.${event} is ignored on Pi (only PreToolUse, PostToolUse and Stop run in a titan child)`, node);
				continue;
			}
			if (!Array.isArray(rules)) {
				issues.error("hooks", `hooks.${event} must be a list of {matcher?, response} rules; found ${show(rules)}`, node);
				continue;
			}
			rules.forEach((rule, index) => {
				const label = `hooks.${event}[${index}]`;
				if (!isMapping(rule)) {
					issues.error("hooks", `${label} must be a mapping {matcher?, response}`, node);
					return;
				}
				for (const key of Object.keys(rule)) if (!HOOK_RULE_KEYS.has(key)) issues.warn("unknown-key", `${label}.${key} is unknown and ignored`, node);
				if (rule.matcher !== undefined) {
					if (typeof rule.matcher !== "string") issues.error("hooks", `${label}.matcher must be a regex string`, node);
					else {
						try {
							new RegExp(rule.matcher);
						} catch (error) {
							issues.error("hooks", `${label}.matcher is not a valid regex: ${error instanceof Error ? error.message : String(error)}`, node);
						}
					}
				}
				if (!isMapping(rule.response)) {
					issues.error("hooks", `${label}.response is required and must be a static mapping (hook responses are data, never code)`, node);
					return;
				}
				const response = rule.response;
				if (hasFunction(response)) issues.error("hooks", `${label}.response must be static data (no functions)`, node);
				for (const key of Object.keys(response)) if (!HOOK_RESPONSE_KEYS.has(key)) issues.warn("unknown-key", `${label}.response.${key} is unknown and ignored`, node);
				if (response.continue !== undefined && typeof response.continue !== "boolean") issues.error("hooks", `${label}.response.continue must be boolean`, node);
				if (response.stopReason !== undefined && typeof response.stopReason !== "string") issues.error("hooks", `${label}.response.stopReason must be a string`, node);
				if (response.systemMessage !== undefined && typeof response.systemMessage !== "string") issues.error("hooks", `${label}.response.systemMessage must be a string`, node);
				if (response.decision !== undefined && response.decision !== "approve" && response.decision !== "block") issues.error("hooks", `${label}.response.decision must be approve or block`, node);
				if (response.hookSpecificOutput !== undefined) {
					if (!isMapping(response.hookSpecificOutput)) {
						issues.error("hooks", `${label}.response.hookSpecificOutput must be a mapping`, node);
						return;
					}
					const specific = response.hookSpecificOutput;
					for (const key of Object.keys(specific)) if (!HOOK_SPECIFIC_KEYS.has(key)) issues.warn("unknown-key", `${label}.response.hookSpecificOutput.${key} is unknown and ignored`, node);
					if (specific.hookEventName !== undefined && specific.hookEventName !== event) issues.error("hooks", `${label}.response.hookSpecificOutput.hookEventName must be ${event}; found ${show(specific.hookEventName)}`, node);
					if (specific.permissionDecision !== undefined && !["deny", "allow", "ask"].includes(specific.permissionDecision as string)) issues.error("hooks", `${label}.response.hookSpecificOutput.permissionDecision must be deny, allow or ask`, node);
					if (specific.updatedInput !== undefined && !isMapping(specific.updatedInput)) issues.error("hooks", `${label}.response.hookSpecificOutput.updatedInput must be a mapping`, node);
				}
			});
		}
	}
}

// ═══ Files and formatting ════════════════════════════════════════════════════

/**
 * Read a YAML workflow file and validate it. `ctx` defaults: dir = the file's directory,
 * commandDirs = scriptDirs = [dir]. A YAML syntax error is reported as rule "yaml".
 */
export function validateFile(file: string, ctx?: Partial<ValidateContext>): ValidationResult & { path: string; doc?: unknown } {
	const resolved = path.resolve(file);
	const dir = ctx?.dir ?? path.dirname(resolved);
	const full: ValidateContext = { ...ctx, dir, commandDirs: ctx?.commandDirs ?? [dir], scriptDirs: ctx?.scriptDirs ?? [dir] };
	let text: string;
	try {
		text = fs.readFileSync(resolved, "utf8");
	} catch (error) {
		return { ok: false, errors: [{ rule: "file", message: `cannot read ${resolved}: ${error instanceof Error ? error.message : String(error)}` }], warnings: [], path: resolved };
	}
	let doc: unknown;
	try {
		doc = parseYaml(text);
	} catch (error) {
		return { ok: false, errors: [{ rule: "yaml", message: `YAML parse failed: ${error instanceof Error ? error.message : String(error)}` }], warnings: [], path: resolved };
	}
	return { ...validateWorkflow(doc, full), path: resolved, doc };
}

/** Human-readable issue list: a summary line, then `✗ [rule] node: message` / `⚠ …` lines. */
export function formatIssues(result: Pick<ValidationResult, "ok" | "errors" | "warnings">): string {
	const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
	const header = result.errors.length === 0 ? (result.warnings.length ? `valid with ${count(result.warnings.length, "warning")}` : "valid") : `invalid: ${count(result.errors.length, "error")}${result.warnings.length ? `, ${count(result.warnings.length, "warning")}` : ""}`;
	const line = (glyph: string, issue: ValidationIssue): string => `  ${glyph} [${issue.rule}]${issue.node ? ` ${issue.node}:` : ""} ${issue.message}`;
	return [header, ...result.errors.map((issue) => line("✗", issue)), ...result.warnings.map((issue) => line("⚠", issue))].join("\n");
}
