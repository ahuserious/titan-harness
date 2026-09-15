/**
 * child-hooks.ts — the pure logic behind titan's NARROW child mode (plan D12, §7 P3).
 *
 * A workflow node's static `hooks` (PreToolUse / PostToolUse / Stop rules) and its
 * `output_format` schema travel to the `pi --mode json -p` child as environment
 * variables. extensions/titan-child-hooks.ts reads them and registers the only Pi
 * primitives that implement them — `tool_call` / `tool_result` handlers and the
 * terminating `submit_result` tool — and nothing else, so the recursion guard that keeps
 * every other titan extension out of children stays intact. This module has no pi
 * imports: everything here is a pure function over the env, the rules and a tool event,
 * and is what tests/child-hooks.test.ts exercises.
 *
 * Environment (the executor sets these on AgentRequest.env; the factory forwards `env`
 * to runChild, which spreads it over the child's environment; the child extension reads it):
 *   TITAN_HARNESS_CHILD=1     the child marker every titan extension returns early on
 *                             (stack-config.ts STACK_CHILD_ENV) — required here as well
 *   TITAN_NODE_HOOKS          JSON of the node's HooksDoc ({PreToolUse?, PostToolUse?, Stop?})
 *   TITAN_NODE_SCHEMA         JSON schema of the node's output_format — becomes the
 *                             parameters of `submit_result`. `$ref` must be resolved by the
 *                             executor before it is serialised (a child has no schema
 *                             registry); a leftover `$ref` degrades to "any" so the tool
 *                             still registers instead of failing the node.
 *   TITAN_NODE_RESULT_PATH    the file `submit_result` writes (canonical JSON, parent
 *                             directory created) — required with TITAN_NODE_SCHEMA
 * Without TITAN_HARNESS_CHILD=1 AND at least one of TITAN_NODE_HOOKS / TITAN_NODE_SCHEMA,
 * `childModeFromEnv().active` is false and the extension registers nothing.
 *
 * Archon hook responses → Pi primitives (the static subset the validator accepts):
 *   PreToolUse   permissionDecision deny → tool_call { block, reason }
 *                permissionDecision ask  → block as well (a headless child has nobody to ask)
 *                decision: block          → block
 *                continue: false          → { block, terminate, reason: stopReason }
 *                updatedInput             → REPLACES the tool's arguments (in place)
 *                additionalContext / systemMessage → stashed and appended to that call's
 *                tool_result as "[hook] …" text (Pi has no pre-execution message slot)
 *                deny always wins over allow, whatever the rule order.
 *   PostToolUse  systemMessage / additionalContext → "[hook] …" text blocks appended to
 *                the result content; decision: block → isError on the result (+ a line);
 *                continue: false → the child's NEXT tool call is blocked with terminate
 *                (a tool_result patch cannot stop the agent by itself).
 *   Stop         continue: false → the next tool call matching `matcher` is blocked with
 *                { terminate: true, reason: stopReason }. Pi has no cancellable "about to
 *                stop" event, so this is the closest primitive: an emergency stop at the
 *                next (matching) tool call. decision / systemMessage on Stop are ignored.
 *   Matchers are regexes anchored to the whole tool name and matched case-insensitively,
 *   so Archon's `Bash` / `Write|Edit` match Pi's `bash` / `write` / `edit`; an omitted or
 *   `*` matcher matches every tool; an invalid regex falls back to a literal comparison.
 *   `submit_result` itself is exempt from every rule, so a deny-all matcher can never
 *   strand a node without its result.
 *
 * Wiring the lead owns (the child cannot do these for itself):
 *   - `--tools` is a STRICT allowlist across built-in AND extension tools, and
 *     `--no-tools` disables extension tools too (Pi sdk.js allowedToolNames): a node with
 *     output_format must carry `submit_result` in its --tools list (an `allowed_tools: []`
 *     node becomes `--tools submit_result`, never --no-tools). childToolsFor()'s
 *     subagentTools=off → "none" short-circuit must not apply to a schema node either.
 *   - The node prompt should end with SUBMIT_RESULT_INSTRUCTION. The tool's
 *     promptGuidelines carry the same sentence, but only Pi's default system prompt renders
 *     the Guidelines section (a --system-prompt override drops it).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalJson } from "./hash-chain.ts";
import type { HookRule, HooksDoc, JsonSchema } from "./workflow/schema.ts";

/** Env var names (TITAN_HARNESS_CHILD mirrors stack-config.ts STACK_CHILD_ENV; kept literal so this module stays import-light). */
export const CHILD_ENV = "TITAN_HARNESS_CHILD";
export const NODE_HOOKS_ENV = "TITAN_NODE_HOOKS";
export const NODE_SCHEMA_ENV = "TITAN_NODE_SCHEMA";
export const NODE_RESULT_PATH_ENV = "TITAN_NODE_RESULT_PATH";

export const SUBMIT_RESULT_TOOL = "submit_result";
/** The terminal sentence: the executor appends it to the node prompt; the tool's guidelines repeat it. */
export const SUBMIT_RESULT_INSTRUCTION = "Call submit_result exactly once with the final answer; after it, stop.";
/** What the tool answers the model with. */
export const SUBMIT_RESULT_ACK = "result recorded";
/** Prefix of every line a hook injects into a tool result. */
export const HOOK_PREFIX = "[hook]";

export type HookEvent = "PreToolUse" | "PostToolUse" | "Stop";
export const HOOK_EVENTS: HookEvent[] = ["PreToolUse", "PostToolUse", "Stop"];

/** One block of a tool result's content as Pi hands it to tool_result handlers; hooks only ever add text blocks. */
export interface ContentBlock {
	type: string;
	text?: string;
	[k: string]: unknown;
}

export interface PreToolUseOutcome {
	block?: boolean;
	reason?: string;
	terminate?: boolean;
	/** Full replacement for the tool arguments (the last matching updatedInput wins). */
	input?: Record<string, unknown>;
	/** "[hook] …" lines to append to this call's result, newline-joined. */
	additionalContext?: string;
}

export interface PostToolUseOutcome {
	content: ContentBlock[];
	/** false → the caller should return nothing (keep Pi's result untouched). */
	changed: boolean;
	systemMessage?: string;
	additionalContext?: string;
	isError?: boolean;
	/** Set → the child's next tool call must be blocked with terminate and this reason. */
	stop?: string;
}

export interface StopOutcome {
	block: true;
	terminate: true;
	reason: string;
}

export interface ChildMode {
	active: boolean;
	hooks?: HooksDoc;
	schema?: JsonSchema;
	resultPath?: string;
	/** Human-readable reasons a set variable was ignored (malformed JSON, missing result path). */
	problems: string[];
}

const isMapping = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** `[hook] text` — one line per injected message. */
export function hookLine(text: string): string {
	return `${HOOK_PREFIX} ${text.trim()}`;
}

/**
 * Does a rule apply to this tool? Regex anchored to the whole name, case-insensitive;
 * no matcher, an empty one or `*` match everything; an invalid regex compares literally.
 */
export function matchesRule(rule: HookRule, toolName: string): boolean {
	const matcher = typeof rule.matcher === "string" ? rule.matcher.trim() : "";
	if (!matcher || matcher === "*" || matcher === ".*") return true;
	try {
		return new RegExp(`^(?:${matcher})$`, "i").test(toolName);
	} catch {
		return matcher.toLowerCase() === toolName.toLowerCase();
	}
}

const matching = (rules: HookRule[] | undefined, toolName: string): HookRule[] =>
	(Array.isArray(rules) ? rules : []).filter((rule) => isMapping(rule) && isMapping(rule.response) && matchesRule(rule, toolName));

/** PreToolUse rules for one tool call: block/terminate, replace the input, or collect context for the result. */
export function applyPreToolUse(rules: HookRule[] | undefined, toolName: string, input: Record<string, unknown>): PreToolUseOutcome {
	const outcome: PreToolUseOutcome = {};
	const context: string[] = [];
	let blocked: { reason: string; terminate: boolean } | undefined;
	for (const rule of matching(rules, toolName)) {
		const response = rule.response;
		const specific = isMapping(response.hookSpecificOutput) ? response.hookSpecificOutput : {};
		const decision = specific.permissionDecision;
		const reason = (typeof specific.permissionDecisionReason === "string" && specific.permissionDecisionReason) || (typeof response.stopReason === "string" && response.stopReason) || "";
		if (response.continue === false) {
			blocked = { reason: reason || "stopped by hook", terminate: true };
			break;
		}
		if (decision === "deny" || decision === "ask" || response.decision === "block") {
			const fallback = decision === "ask" ? "hook asked for permission; a headless child cannot ask" : "denied by hook";
			if (!blocked) blocked = { reason: reason || fallback, terminate: false };
			continue; // deny wins — keep scanning only for a continue:false, which upgrades to terminate
		}
		if (isMapping(specific.updatedInput)) outcome.input = { ...specific.updatedInput };
		if (typeof specific.additionalContext === "string" && specific.additionalContext.trim()) context.push(hookLine(specific.additionalContext));
		if (typeof response.systemMessage === "string" && response.systemMessage.trim()) context.push(hookLine(response.systemMessage));
	}
	if (blocked) return { block: true, reason: blocked.reason, ...(blocked.terminate ? { terminate: true } : {}) };
	if (context.length) outcome.additionalContext = context.join("\n");
	void input; // the input is only read by matchers today; kept in the signature so rules can grow input-aware without a contract change
	return outcome;
}

/** Replace a mutable tool-arguments object in place (Pi reads the mutated `event.input`). */
export function replaceInput(target: Record<string, unknown>, next: Record<string, unknown>): void {
	for (const key of Object.keys(target)) delete target[key];
	Object.assign(target, next);
}

/**
 * PostToolUse rules for one finished tool call: append "[hook] …" text blocks (the stashed
 * PreToolUse context first), flag `isError` on decision: block, and arm a stop on continue: false.
 */
export function applyPostToolUse(rules: HookRule[] | undefined, toolName: string, content: ContentBlock[], stashed?: string): PostToolUseOutcome {
	const lines: string[] = [];
	if (stashed?.trim()) lines.push(stashed.trim());
	const outcome: PostToolUseOutcome = { content, changed: false };
	const messages: string[] = [];
	const contexts: string[] = [];
	for (const rule of matching(rules, toolName)) {
		const response = rule.response;
		const specific = isMapping(response.hookSpecificOutput) ? response.hookSpecificOutput : {};
		if (typeof response.systemMessage === "string" && response.systemMessage.trim()) {
			messages.push(response.systemMessage.trim());
			lines.push(hookLine(response.systemMessage));
		}
		if (typeof specific.additionalContext === "string" && specific.additionalContext.trim()) {
			contexts.push(specific.additionalContext.trim());
			lines.push(hookLine(specific.additionalContext));
		}
		const reason = (typeof response.stopReason === "string" && response.stopReason) || (typeof specific.permissionDecisionReason === "string" && specific.permissionDecisionReason) || "";
		if (response.decision === "block") {
			outcome.isError = true;
			lines.push(hookLine(`blocked: ${reason || "blocked by hook"}`));
		}
		if (response.continue === false && !outcome.stop) {
			outcome.stop = reason || "stopped by hook";
			lines.push(hookLine(`stop: ${outcome.stop}`));
		}
	}
	if (messages.length) outcome.systemMessage = messages.join("\n");
	if (contexts.length) outcome.additionalContext = contexts.join("\n");
	if (lines.length || outcome.isError) {
		outcome.changed = true;
		outcome.content = [...(Array.isArray(content) ? content : []), ...(lines.length ? [{ type: "text", text: lines.join("\n") }] : [])];
	}
	return outcome;
}

/** Stop rules: a matching `continue: false` blocks this tool call with terminate (Pi's closest primitive). */
export function applyStop(rules: HookRule[] | undefined, toolName: string): StopOutcome | undefined {
	for (const rule of matching(rules, toolName)) {
		if (rule.response.continue === false) {
			return { block: true, terminate: true, reason: (typeof rule.response.stopReason === "string" && rule.response.stopReason) || "stopped by Stop hook" };
		}
	}
	return undefined;
}

/** Keep only the three supported events, each an array of rules that carry an object `response`. */
function pruneHooks(value: unknown): HooksDoc | undefined {
	if (!isMapping(value)) return undefined;
	const doc: HooksDoc = {};
	let rules = 0;
	for (const event of HOOK_EVENTS) {
		const list = value[event];
		if (!Array.isArray(list)) continue;
		const kept = list.filter((rule): rule is HookRule => isMapping(rule) && isMapping(rule.response)).map((rule) => ({ ...(typeof rule.matcher === "string" ? { matcher: rule.matcher } : {}), response: rule.response }));
		if (kept.length) {
			doc[event] = kept;
			rules += kept.length;
		}
	}
	return rules ? doc : undefined;
}

/** The env the executor puts on an AgentRequest for a node with hooks ({} when there is nothing to enforce). */
export function hooksEnv(hooks: HooksDoc | undefined): Record<string, string> {
	const pruned = pruneHooks(hooks);
	return pruned ? { [NODE_HOOKS_ENV]: JSON.stringify(pruned) } : {};
}

/** The env for a node with output_format: the schema plus where `submit_result` must write. */
export function schemaEnv(schema: JsonSchema, resultPath: string): Record<string, string> {
	return { [NODE_SCHEMA_ENV]: JSON.stringify(schema), [NODE_RESULT_PATH_ENV]: resultPath };
}

/** Parse TITAN_NODE_HOOKS; undefined when unset, malformed or empty after pruning. */
export function parseHooksEnv(raw: string | undefined): HooksDoc | undefined {
	if (!raw?.trim()) return undefined;
	try {
		return pruneHooks(JSON.parse(raw));
	} catch {
		return undefined;
	}
}

/** Parse TITAN_NODE_SCHEMA; undefined when unset, malformed or not an object. */
export function parseSchemaEnv(raw: string | undefined): JsonSchema | undefined {
	if (!raw?.trim()) return undefined;
	try {
		const parsed = JSON.parse(raw);
		return isMapping(parsed) ? (parsed as JsonSchema) : undefined;
	} catch {
		return undefined;
	}
}

/** The gate the child extension runs on: active only as a titan child that was handed hooks and/or a schema. */
export function childModeFromEnv(env: NodeJS.ProcessEnv = process.env): ChildMode {
	const problems: string[] = [];
	if (env[CHILD_ENV] !== "1") return { active: false, problems };
	const hooksRaw = env[NODE_HOOKS_ENV];
	const schemaRaw = env[NODE_SCHEMA_ENV];
	if (!hooksRaw && !schemaRaw) return { active: false, problems };
	const mode: ChildMode = { active: false, problems };
	if (hooksRaw) {
		const hooks = parseHooksEnv(hooksRaw);
		if (hooks) mode.hooks = hooks;
		else problems.push(`${NODE_HOOKS_ENV} is not a JSON hooks document with PreToolUse/PostToolUse/Stop rules; ignored`);
	}
	if (schemaRaw) {
		const schema = parseSchemaEnv(schemaRaw);
		const resultPath = env[NODE_RESULT_PATH_ENV]?.trim();
		if (!schema) problems.push(`${NODE_SCHEMA_ENV} is not a JSON schema object; submit_result not registered`);
		else if (!resultPath) problems.push(`${NODE_RESULT_PATH_ENV} is missing; submit_result not registered`);
		else {
			mode.schema = schema;
			mode.resultPath = resultPath;
		}
	}
	mode.active = !!mode.hooks || !!mode.schema;
	return mode;
}

const MAX_SCHEMA_DEPTH = 32;

/** A copy of the schema with every `$ref` dropped (→ "any"): the child has no registry to resolve them against. */
function stripRefs(schema: JsonSchema, depth = 0): JsonSchema {
	if (!isMapping(schema) || depth > MAX_SCHEMA_DEPTH) return {};
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "$ref") continue;
		if (key === "properties" && isMapping(value)) {
			out.properties = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, stripRefs(sub as JsonSchema, depth + 1)]));
		} else if ((key === "items" || key === "additionalProperties") && isMapping(value)) {
			out[key] = stripRefs(value as JsonSchema, depth + 1);
		} else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
			out[key] = value.map((sub) => stripRefs(sub as JsonSchema, depth + 1));
		} else {
			out[key] = value;
		}
	}
	return out as JsonSchema;
}

/**
 * The `parameters` of `submit_result`: an object schema is used as-is; anything else is
 * wrapped as { value: schema } so the tool call is always an object (what every provider
 * expects), and `unwrapResult` peels it back off before the result is written.
 */
export function submitResultParameters(schema: JsonSchema): { parameters: JsonSchema; wrapped: boolean } {
	const clean = stripRefs(schema);
	if (clean.type === "object") {
		return { parameters: { ...clean, properties: isMapping(clean.properties) ? clean.properties : {} }, wrapped: false };
	}
	return { parameters: { type: "object", properties: { value: clean }, required: ["value"] }, wrapped: true };
}

/** The value `submit_result` records: the arguments themselves, or their `value` when the schema was wrapped. */
export function unwrapResult(params: unknown, wrapped: boolean): unknown {
	if (!wrapped) return params;
	return isMapping(params) ? params.value : undefined;
}

let tmpCounter = 0;
/** Write the result as canonical JSON (+ newline) atomically, creating the parent directory; returns the text written. */
export function writeResult(resultPath: string, value: unknown): string {
	const text = `${canonicalJson(value)}\n`;
	fs.mkdirSync(path.dirname(resultPath), { recursive: true, mode: 0o700 });
	const tmp = `${resultPath}.${process.pid}.${++tmpCounter}.tmp`;
	fs.writeFileSync(tmp, text, { mode: 0o600 });
	fs.renameSync(tmp, resultPath);
	return text;
}
