/**
 * schema.ts — the titan workflow document (plan §3, D13): the Archon-compatible YAML DAG
 * subset for Pi, as TypeScript types plus the small pure helpers every other workflow
 * module shares.
 *
 *   WorkflowDoc                 the top level: apiVersion, name, inputs, returns, phases, titan {…}, nodes[]
 *   NodeDoc                     NodeBase & exactly one discriminator (command | prompt | bash | script |
 *                               loop | approval | cancel | verify | best_of | interleave | hypothesis |
 *                               mcp_tool | workflow)
 *   nodeType / isAiNode         discriminator lookup (undefined when a node has 0 or >1 of them)
 *   outputRefs(text)            the node ids a substitutable string reads as `$id.output[...]`
 *   parseWhen(expr)             the `when:` grammar — one parser shared by the validator (static
 *                               checks) and the scheduler (evaluation): comparisons == != < > <= >=
 *                               between `$id.output[.field…]` refs and literals ('str', "str", 12,
 *                               true, false, null), joined by && and ||, grouped with parentheses.
 *                               Every operand must sit in a comparison and every ref must be a node
 *                               output, so anything else fails closed at parse time.
 *   *_KEYS tables               the known keys per mapping, for the validator's unknown-key warnings
 *
 * Pure: no pi imports, no filesystem, no state.
 */

export const API_VERSION = "titan.harness/v1";

export const TRIGGER_RULES = ["all_success", "one_success", "none_failed_min_one_success", "all_done"] as const;
export type TriggerRule = (typeof TRIGGER_RULES)[number];

export type NodeType = "command" | "prompt" | "bash" | "script" | "loop" | "approval" | "cancel" | "verify" | "best_of" | "interleave" | "hypothesis" | "mcp_tool" | "workflow";
export const NODE_TYPES: NodeType[] = ["command", "prompt", "bash", "script", "loop", "approval", "cancel", "verify", "best_of", "interleave", "hypothesis", "mcp_tool", "workflow"];
/** Node types that spawn an AI child (the rest are bash, scripts, gates, runners and sub-workflows). */
export const AI_NODE_TYPES: NodeType[] = ["command", "prompt", "loop", "best_of", "interleave", "hypothesis"];
/** The only node types a `role: architect` node may be (plan §3.4, constraint 5: the architect never writes). */
export const ARCHITECT_NODE_TYPES: NodeType[] = ["prompt", "command", "approval"];

export const SLOT_ROLES = ["architect", "builder", "worker", "verifier", "auditor", "watchdog", "fusion", "judge", "fuser"] as const;
export type SlotRole = (typeof SLOT_ROLES)[number];

export const VERIFY_RUNNERS = ["kane", "testmu", "momentic", "cursor-cloud", "orca-browser", "bash"] as const;
export type VerifyRunner = (typeof VERIFY_RUNNERS)[number];
/** Runners that drive simulated users — what a platform-update ship node must have upstream. */
export const SIM_USER_RUNNERS: VerifyRunner[] = ["kane", "momentic", "orca-browser"];

export const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "Stop"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
export const ON_FAIL_ACTIONS = ["retry", "elevate", "reauthor", "cancel"] as const;
export const REVIEW_POLICIES = ["required", "optional", "none"] as const;
export const SCRIPT_RUNTIMES = ["bun", "uv"] as const;
export const INTERLEAVE_BY = ["files", "sections", "hypotheses"] as const;
export const ON_COMPACTION_MODES = ["halt-inspect", "summary-only", "off"] as const;
export const WATCHDOG_POLICIES = ["inherit", "off", "strict"] as const;
export const ISOLATION_MODES = ["none", "worktree"] as const;

export const ID_RE = /^[a-z0-9][a-z0-9-_]{0,31}$/;
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MODEL_RE = /^[^/\s]+\/[^\s]+$/;

/** The engine's substitution variables (substitute.ts owns the grammar; listed here for docs and validators). */
export const VARIABLE_NAMES = ["ARGUMENTS", "ARTIFACTS_DIR", "WORKFLOW_ID", "RUN_ID", "BASE_BRANCH", "CONTEXT", "LOOP_USER_INPUT", "REJECTION_REASON", "LOOP_COUNT"];
export const PI_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];
/** Tools a `role: architect` node may never hold — the validator errors on them in allowed_tools and injects them into denied_tools. */
export const WRITE_TOOLS = ["write", "edit", "bash"];
export const READONLY_TOOL_NAMES = ["read", "grep", "find", "ls"];

// ═══ Document types ══════════════════════════════════════════════════════════

export interface JsonSchema {
	type?: string | string[];
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	enum?: unknown[];
	additionalProperties?: boolean | JsonSchema;
	description?: string;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	$ref?: string;
}

export interface InputSpec {
	required?: boolean;
	default?: unknown;
	description?: string;
}

export interface WorkflowTitan {
	level?: number;
	shape?: string;
	tier?: string;
	modes?: string[];
	evidence?: { require?: string[]; dir?: string };
	elevation?: "default" | { fail_1?: unknown; fail_2?: unknown; fail_3?: unknown };
	watchdog?: {
		enabled?: boolean;
		model?: string;
		thinking?: string;
		cadence_tools?: number;
		stalemate_repeats?: number;
		on_compaction?: "halt-inspect" | "summary-only" | "off";
		inspector_timeout_ms?: number;
	};
	budget?: { usd?: number; tokens?: number; max_concurrent_children?: number; context_budget?: number };
	personas?: string[];
}

export interface WorkflowDoc {
	apiVersion: string;
	name: string;
	description?: string;
	version?: number;
	inputs?: Record<string, InputSpec>;
	returns?: string;
	phases?: Array<{ title: string; detail?: string }>;
	provider?: "pi";
	model?: string;
	thinking?: string;
	trigger?: { cron?: string; every?: string; event?: string; entity_profile?: string };
	titan?: WorkflowTitan;
	nodes: NodeDoc[];
}

export interface HookRule {
	matcher?: string;
	response: {
		hookSpecificOutput?: {
			hookEventName?: string;
			permissionDecision?: "deny" | "allow" | "ask";
			permissionDecisionReason?: string;
			updatedInput?: Record<string, unknown>;
			additionalContext?: string;
		};
		systemMessage?: string;
		continue?: boolean;
		stopReason?: string;
		decision?: "approve" | "block";
	};
}

export interface HooksDoc {
	PreToolUse?: HookRule[];
	PostToolUse?: HookRule[];
	Stop?: HookRule[];
}

export interface NodeBase {
	id: string;
	depends_on?: string[];
	when?: string;
	trigger_rule?: TriggerRule;
	idle_timeout?: number;
	timeout?: number;
	retry?: { max_attempts?: number; delay_ms?: number };
	phase?: string;
	role?: SlotRole;
	callsign?: string;
	persona?: string;
	mimeograph?: string;
	tier?: string;
	evidence?: { produces?: string[]; require?: string[] };
	review?: "required" | "optional" | "none";
	on_fail?: { action: "retry" | "elevate" | "reauthor" | "cancel"; max?: number };
	watchdog?: { policy?: "inherit" | "off" | "strict" };
	budget?: { usd?: number; tokens?: number };
	context_budget?: number;
	isolation?: "none" | "worktree";
	anonymize?: boolean;
	model?: string;
	thinking?: string;
	context?: "fresh" | "shared" | { resume: string };
	output_format?: JsonSchema;
	allowed_tools?: string[];
	denied_tools?: string[];
	system_prompt?: string;
	append_system_prompt?: string | string[];
	hooks?: HooksDoc;
	mcp?: string[];
	skills?: string[];
	subagents?: { enabled?: boolean; tools?: string[]; cap?: number };
	output_type?: string;
}

export interface LoopSpec {
	prompt: string;
	until?: string;
	until_bash?: string;
	max_iterations: number;
	fresh_context?: boolean;
	interactive?: boolean;
	gate_message?: string;
}

export interface ApprovalSpec {
	message: string;
	capture_response?: boolean;
	on_reject?: { prompt: string; max_attempts?: number };
	preset_key?: string;
}

export interface VerifySpec {
	runner: VerifyRunner;
	objective?: string;
	devices?: string[];
	headless?: boolean;
	command?: string;
	repo?: string;
	ref?: string;
	[k: string]: unknown;
}

export interface BestOfSpec {
	n: number;
	judge?: string;
	criteria?: string;
	prompt: string;
}

export interface InterleaveSpec {
	segments: number | string[];
	by?: "files" | "sections" | "hypotheses";
	synthesize?: boolean;
	reauthor?: boolean;
	prompt: string;
}

export interface HypothesisSpec {
	hypotheses: Array<{ id: string; claim: string; predicts?: string }>;
	decide_by: string;
}

export type NodeDoc = NodeBase &
	(
		| { command: string }
		| { prompt: string }
		| { bash: string }
		| { script: string; runtime: "bun" | "uv"; deps?: string[] }
		| { loop: LoopSpec }
		| { approval: ApprovalSpec }
		| { cancel: string }
		| { verify: VerifySpec }
		| { best_of: BestOfSpec }
		| { interleave: InterleaveSpec }
		| { hypothesis: HypothesisSpec }
		| { mcp_tool: { server: string; tool: string; args?: Record<string, unknown> } }
		| { workflow: { name: string; fan_out?: { source: string; as: string; join?: TriggerRule }; isolation?: "worktree" } }
	);

// ═══ Known keys (unknown-key warnings live in the validator) ═════════════════

export const TOP_LEVEL_KEYS = new Set(["apiVersion", "name", "description", "version", "inputs", "returns", "phases", "provider", "model", "thinking", "trigger", "titan", "nodes"]);
export const INPUT_KEYS = new Set(["required", "default", "description"]);
export const PHASE_KEYS = new Set(["title", "detail"]);
export const TRIGGER_KEYS = new Set(["cron", "every", "event", "entity_profile"]);
export const TITAN_KEYS = new Set(["level", "shape", "tier", "modes", "evidence", "elevation", "watchdog", "budget", "personas"]);
export const TITAN_EVIDENCE_KEYS = new Set(["require", "dir"]);
export const TITAN_WATCHDOG_KEYS = new Set(["enabled", "model", "thinking", "cadence_tools", "stalemate_repeats", "on_compaction", "inspector_timeout_ms"]);
export const TITAN_BUDGET_KEYS = new Set(["usd", "tokens", "max_concurrent_children", "context_budget"]);
export const NODE_BASE_KEYS = new Set([
	"id", "depends_on", "when", "trigger_rule", "idle_timeout", "timeout", "retry", "phase", "role", "callsign", "persona", "mimeograph", "tier",
	"evidence", "review", "on_fail", "watchdog", "budget", "context_budget", "isolation", "anonymize", "model", "thinking", "context", "output_format",
	"allowed_tools", "denied_tools", "system_prompt", "append_system_prompt", "hooks", "mcp", "skills", "subagents", "output_type",
]);
/** Keys that only mean something on an AI node — a loader warning when they sit on bash/script (Archon does the same). */
export const AI_ONLY_NODE_KEYS = new Set(["model", "thinking", "context", "output_format", "allowed_tools", "denied_tools", "system_prompt", "append_system_prompt", "hooks", "mcp", "skills", "subagents"]);
export const NODE_KEYS = new Set([...NODE_BASE_KEYS, ...NODE_TYPES, "runtime", "deps"]);
export const NODE_EVIDENCE_KEYS = new Set(["produces", "require"]);
export const RETRY_KEYS = new Set(["max_attempts", "delay_ms"]);
export const ON_FAIL_KEYS = new Set(["action", "max"]);
export const SUBAGENTS_KEYS = new Set(["enabled", "tools", "cap"]);
export const LOOP_KEYS = new Set(["prompt", "until", "until_bash", "max_iterations", "fresh_context", "interactive", "gate_message"]);
export const APPROVAL_KEYS = new Set(["message", "capture_response", "on_reject", "preset_key"]);
export const ON_REJECT_KEYS = new Set(["prompt", "max_attempts"]);
export const BEST_OF_KEYS = new Set(["n", "judge", "criteria", "prompt"]);
export const INTERLEAVE_KEYS = new Set(["segments", "by", "synthesize", "reauthor", "prompt"]);
export const HYPOTHESIS_KEYS = new Set(["hypotheses", "decide_by"]);
export const HYPOTHESIS_ITEM_KEYS = new Set(["id", "claim", "predicts"]);
export const MCP_TOOL_KEYS = new Set(["server", "tool", "args"]);
export const WORKFLOW_NODE_KEYS = new Set(["name", "fan_out", "isolation"]);
export const FAN_OUT_KEYS = new Set(["source", "as", "join"]);
export const HOOK_RULE_KEYS = new Set(["matcher", "response", "timeout"]);
export const HOOK_RESPONSE_KEYS = new Set(["hookSpecificOutput", "systemMessage", "continue", "stopReason", "decision"]);
export const HOOK_SPECIFIC_KEYS = new Set(["hookEventName", "permissionDecision", "permissionDecisionReason", "updatedInput", "additionalContext", "updatedMCPToolOutput"]);

// ═══ Discriminators ══════════════════════════════════════════════════════════

/** The node's type: the one discriminator key it carries; undefined when it has none or more than one. */
export function nodeType(node: unknown): NodeType | undefined {
	if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
	const present = nodeTypesOf(node as Record<string, unknown>);
	return present.length === 1 ? present[0] : undefined;
}

/** Every discriminator key a node carries (the validator reports all of them when there is more than one). */
export function nodeTypesOf(node: Record<string, unknown>): NodeType[] {
	return NODE_TYPES.filter((type) => node[type] !== undefined && node[type] !== null);
}

/** command | prompt | loop | best_of | interleave | hypothesis — the nodes that spawn an AI child. */
export function isAiNode(node: unknown): boolean {
	const type = nodeType(node);
	return type !== undefined && AI_NODE_TYPES.includes(type);
}

// ═══ Output references ═══════════════════════════════════════════════════════

const OUTPUT_REF_RE = /\$([A-Za-z0-9][A-Za-z0-9_-]*)\.output\b/g;

/** The node ids a substitutable string reads (`$fetch-issue.output`, `$classify.output.issue_type`), each once, in order. */
export function outputRefs(text: string): string[] {
	const ids: string[] = [];
	for (const match of text.matchAll(OUTPUT_REF_RE)) if (!ids.includes(match[1])) ids.push(match[1]);
	return ids;
}

// ═══ The `when:` grammar ═════════════════════════════════════════════════════

export type WhenOp = "==" | "!=" | "<" | ">" | "<=" | ">=";
export type WhenOperand = { kind: "ref"; node: string; path: string[]; text: string } | { kind: "literal"; value: string | number | boolean | null; text: string };
export type WhenAst = { kind: "compare"; op: WhenOp; left: WhenOperand; right: WhenOperand } | { kind: "and"; items: WhenAst[] } | { kind: "or"; items: WhenAst[] };

export interface WhenParse {
	ok: boolean;
	/** Node ids the expression reads, each once, in order of appearance. */
	refs: string[];
	ast?: WhenAst;
	error?: string;
}

type WhenToken =
	| { t: "lparen" | "rparen" | "and" | "or"; pos: number }
	| { t: "op"; v: WhenOp; pos: number }
	| { t: "ref"; node: string; path: string[]; text: string; pos: number }
	| { t: "literal"; value: string | number | boolean | null; text: string; pos: number };

class WhenSyntaxError extends Error {}

function tokenizeWhen(expr: string): WhenToken[] {
	const tokens: WhenToken[] = [];
	let i = 0;
	const fail = (message: string, pos: number): never => {
		throw new WhenSyntaxError(`${message} at ${pos}`);
	};
	while (i < expr.length) {
		const ch = expr[i];
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			i++;
			continue;
		}
		const pos = i;
		if (ch === "(") {
			tokens.push({ t: "lparen", pos });
			i++;
			continue;
		}
		if (ch === ")") {
			tokens.push({ t: "rparen", pos });
			i++;
			continue;
		}
		const two = expr.slice(i, i + 2);
		if (two === "&&" || two === "||") {
			tokens.push({ t: two === "&&" ? "and" : "or", pos });
			i += 2;
			continue;
		}
		if (two === "==" || two === "!=" || two === "<=" || two === ">=") {
			tokens.push({ t: "op", v: two as WhenOp, pos });
			i += 2;
			continue;
		}
		if (ch === "<" || ch === ">") {
			tokens.push({ t: "op", v: ch, pos });
			i++;
			continue;
		}
		if (ch === "=") fail("single '=' is not an operator (use ==)", pos);
		if (ch === "&" || ch === "|") fail(`single '${ch}' is not an operator (use ${ch}${ch})`, pos);
		if (ch === "!") fail("'!' is not supported (compare with != instead)", pos);
		if (ch === "'" || ch === '"') {
			let j = i + 1;
			let value = "";
			let closed = false;
			while (j < expr.length) {
				const c = expr[j];
				if (c === "\\" && j + 1 < expr.length) {
					const next = expr[j + 1];
					value += next === "n" ? "\n" : next === "t" ? "\t" : next;
					j += 2;
					continue;
				}
				if (c === ch) {
					closed = true;
					j++;
					break;
				}
				value += c;
				j++;
			}
			if (!closed) fail("unterminated string literal", pos);
			tokens.push({ t: "literal", value, text: expr.slice(i, j), pos });
			i = j;
			continue;
		}
		if (ch === "$") {
			const m = /^\$([A-Za-z0-9_-]+)((?:\.[A-Za-z0-9_-]+)*)/.exec(expr.slice(i));
			if (!m) fail("'$' must start a reference such as $node.output.field", pos);
			const text = m![0];
			const segments = m![2] ? m![2].slice(1).split(".") : [];
			if (segments[0] !== "output") fail(`unsupported reference ${text}: when may only read $<node>.output[.field]`, pos);
			tokens.push({ t: "ref", node: m![1], path: segments.slice(1), text, pos });
			i += text.length;
			continue;
		}
		const num = /^-?\d+(?:\.\d+)?/.exec(expr.slice(i));
		if (num) {
			tokens.push({ t: "literal", value: Number(num[0]), text: num[0], pos });
			i += num[0].length;
			continue;
		}
		const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(expr.slice(i));
		if (word) {
			const w = word[0];
			if (w === "true" || w === "false") tokens.push({ t: "literal", value: w === "true", text: w, pos });
			else if (w === "null") tokens.push({ t: "literal", value: null, text: w, pos });
			else fail(`unexpected identifier '${w}' (quote string literals: '${w}')`, pos);
			i += w.length;
			continue;
		}
		fail(`unexpected character '${ch}'`, pos);
	}
	return tokens;
}

/**
 * Parse a `when:` expression. Never throws: `{ ok: false, refs, error }` on any syntax
 * error, `{ ok: true, refs, ast }` otherwise. The validator checks `refs` against the
 * graph (known ids, output_format present); the scheduler evaluates `ast` against outputs.
 */
export function parseWhen(expr: string): WhenParse {
	const refs: string[] = [];
	const noteRef = (node: string): void => {
		if (!refs.includes(node)) refs.push(node);
	};
	if (typeof expr !== "string" || !expr.trim()) return { ok: false, refs, error: "empty when expression" };
	try {
		const tokens = tokenizeWhen(expr);
		let at = 0;
		const peek = (): WhenToken | undefined => tokens[at];
		const describe = (token: WhenToken | undefined): string =>
			!token ? "end of expression" : token.t === "op" ? `'${token.v}'` : token.t === "ref" || token.t === "literal" ? `'${token.text}'` : token.t === "and" ? "'&&'" : token.t === "or" ? "'||'" : token.t === "lparen" ? "'('" : "')'";
		const operand = (): WhenOperand => {
			const token = peek();
			if (token?.t === "ref") {
				at++;
				noteRef(token.node);
				return { kind: "ref", node: token.node, path: token.path, text: token.text };
			}
			if (token?.t === "literal") {
				at++;
				return { kind: "literal", value: token.value, text: token.text };
			}
			throw new WhenSyntaxError(`expected a $node.output reference or a literal, found ${describe(token)}${token ? ` at ${token.pos}` : ""}`);
		};
		const comparison = (): WhenAst => {
			const token = peek();
			if (token?.t === "lparen") {
				at++;
				const inner = or();
				const close = peek();
				if (close?.t !== "rparen") throw new WhenSyntaxError(`expected ')' , found ${describe(close)}${close ? ` at ${close.pos}` : ""}`);
				at++;
				return inner;
			}
			const left = operand();
			const op = peek();
			if (op?.t !== "op") throw new WhenSyntaxError(`expected a comparison operator after ${left.text}, found ${describe(op)}${op ? ` at ${op.pos}` : ""}`);
			at++;
			const right = operand();
			return { kind: "compare", op: op.v, left, right };
		};
		const and = (): WhenAst => {
			const items = [comparison()];
			while (peek()?.t === "and") {
				at++;
				items.push(comparison());
			}
			return items.length === 1 ? items[0] : { kind: "and", items };
		};
		const or = (): WhenAst => {
			const items = [and()];
			while (peek()?.t === "or") {
				at++;
				items.push(and());
			}
			return items.length === 1 ? items[0] : { kind: "or", items };
		};
		const ast = or();
		const rest = peek();
		if (rest) throw new WhenSyntaxError(`unexpected ${describe(rest)} at ${rest.pos}`);
		return { ok: true, refs, ast };
	} catch (error) {
		if (error instanceof WhenSyntaxError) return { ok: false, refs, error: error.message };
		throw error;
	}
}
