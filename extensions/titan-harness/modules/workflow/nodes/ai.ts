/**
 * nodes/ai.ts — the AI node (`prompt:`; `command:` delegates here) and the agent-call
 * builder shared by every AI-driven node (loop iterations, approval on_reject rework,
 * the P4 patterns).
 *
 * One call = substitute the prompt (prompt mode) → append the schema suffix when the node
 * declares `output_format` → resolve role/model/thinking/callsign from the live shape via
 * deps.resolveRole (a node's own model/thinking/callsign/system prompts override) →
 * tools → context → deps.agent through ctx.runAgent (which records the ledger row and
 * the agent record). With `output_format` the answer is parsed and validated; an invalid
 * answer is re-asked at most MAX_SCHEMA_RETRIES times with the errors appended, resuming
 * the same session when the child reported one, and the node fails after that.
 *
 * Tools: `allowed_tools` (empty list → "none", the factory maps it to --no-tools), else
 * the role's tools from the shape, else FULL_TOOLS; `denied_tools` removed; role
 * "architect" is ALWAYS read-only — anything outside READONLY_TOOLS (write, edit, bash,
 * and unknown/MCP tool names, which P3 cannot classify) is dropped, and a request that
 * asked only for write tools gets the read-only set instead (constraint 5, plan §3.4).
 *
 * Context: fresh (default) | shared (resume the previous node's session, see
 * NodeContext.previousSessionRef) | {resume: <nodeId>} (that node's session). A missing
 * session falls back to fresh with a warning. Roles default to "worker".
 */
import { FULL_TOOLS, READONLY_TOOLS } from "../../runtime.ts";
import type { AgentRequest, AgentResult, NodeContext, NodeHandler, NodeOutcome } from "../executor.ts";
import type { JsonSchema, NodeDoc, SlotRole } from "../schema.ts";
import { MAX_SCHEMA_RETRIES, formatSchemaErrors, parseStructured, schemaPromptSuffix } from "../structured-output.ts";

export const DEFAULT_ROLE: SlotRole = "worker";
export const READONLY_TOOL_SET: ReadonlySet<string> = new Set(READONLY_TOOLS.split(","));

export interface AgentCallOptions {
	outputSchema?: JsonSchema;
	/** Overrides node.context. */
	context?: AgentRequest["context"];
	/** A raw session ref to resume (iteration and rework chains); wins over `context`. */
	resume?: string;
	label?: string;
	role?: SlotRole;
}

export interface AgentCallResult extends AgentResult {
	/** The parsed object when `outputSchema` was given and the answer validated. */
	value?: unknown;
	/** Agent calls made (1 + re-asks). */
	calls: number;
	/** The final prompt text sent. */
	prompt: string;
}

const listOf = (value: string | string[] | undefined): string[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const splitTools = (tools: string | undefined): string[] => (tools && tools !== "none" ? tools.split(",").map((t) => t.trim()).filter(Boolean) : []);

/** The child's tool list (see the header). */
export function resolveTools(node: NodeDoc, role: SlotRole, roleTools?: string): string | "none" {
	const explicit = Array.isArray(node.allowed_tools);
	let list = explicit ? [...new Set((node.allowed_tools as string[]).map((t) => t.trim()).filter(Boolean))] : splitTools(roleTools).length ? splitTools(roleTools) : splitTools(FULL_TOOLS);
	if (Array.isArray(node.denied_tools) && node.denied_tools.length) {
		const denied = new Set(node.denied_tools);
		list = list.filter((t) => !denied.has(t));
	}
	if (role === "architect") {
		const readonly = list.filter((t) => READONLY_TOOL_SET.has(t));
		list = readonly.length || (explicit && (node.allowed_tools as string[]).length === 0) ? readonly : [...READONLY_TOOL_SET];
	}
	return list.length ? list.join(",") : "none";
}

/** fresh | {resume} for this call (see the header). */
export function resolveContext(ctx: NodeContext, opts: AgentCallOptions): AgentRequest["context"] {
	if (opts.resume) return { resume: opts.resume };
	const requested = opts.context ?? ctx.node.context ?? "fresh";
	if (requested === "fresh") return "fresh";
	if (requested === "shared") {
		const ref = ctx.previousSessionRef();
		if (ref) return { resume: ref };
		ctx.notify(`${ctx.node.id}: context shared but no previous session to resume — starting fresh`, "warning");
		return "fresh";
	}
	const ref = ctx.results[requested.resume]?.sessionRef;
	if (ref) return { resume: ref };
	ctx.notify(`${ctx.node.id}: context resume "${requested.resume}" has no session — starting fresh`, "warning");
	return "fresh";
}

/** One AgentRequest for `prompt` (already substituted; the schema suffix is appended here when `opts.outputSchema` is set). */
export function buildAgentRequest(ctx: NodeContext, prompt: string, opts: AgentCallOptions = {}): AgentRequest {
	const node = ctx.node;
	const role = opts.role ?? node.role ?? DEFAULT_ROLE;
	const resolved = ctx.deps.resolveRole(role, node);
	const callsign = node.callsign && node.callsign !== "pool" ? node.callsign : resolved.callsign;
	return {
		nodeId: node.id,
		role,
		callsign,
		model: node.model ?? resolved.model,
		thinking: node.thinking ?? resolved.thinking,
		prompt: opts.outputSchema ? `${prompt}${schemaPromptSuffix(opts.outputSchema)}` : prompt,
		systemPrompt: node.system_prompt ?? resolved.systemPrompt,
		appendSystemPrompts: [...(resolved.appendSystemPrompts ?? []), ...listOf(node.append_system_prompt)],
		tools: resolveTools(node, role, resolved.tools),
		context: resolveContext(ctx, opts),
		hooks: node.hooks,
		outputSchema: opts.outputSchema,
		timeoutMs: ctx.timeoutMs("ai"),
		env: { ...ctx.env },
		label: opts.label ?? `${ctx.deps.workflowId}/${node.id}`,
	};
}

const addUsage = (acc: AgentResult["usage"], usage?: AgentResult["usage"]): void => {
	if (!usage) return;
	acc.tokensIn += usage.tokensIn || 0;
	acc.tokensOut += usage.tokensOut || 0;
	acc.costUsd += usage.costUsd || 0;
	acc.tpsSeconds += usage.tpsSeconds || 0;
};

/** Run one agent call for `prompt` (substituted text), with the structured-output re-ask loop when `opts.outputSchema` is set. */
export async function callAgent(ctx: NodeContext, prompt: string, opts: AgentCallOptions = {}): Promise<AgentCallResult> {
	const usage: AgentResult["usage"] = { tokensIn: 0, tokensOut: 0, costUsd: 0, tpsSeconds: 0 };
	const schema = opts.outputSchema;
	let request = buildAgentRequest(ctx, prompt, opts);
	let calls = 0;
	for (;;) {
		const result = await ctx.runAgent(request);
		calls++;
		addUsage(usage, result.usage);
		const merged: AgentCallResult = { ...result, usage, calls, prompt: request.prompt };
		if (!result.ok || !schema) return merged;
		const parsed = parseStructured(result.text, schema);
		if (parsed.ok) return { ...merged, value: parsed.value };
		const errors = formatSchemaErrors(parsed.errors);
		if (calls > MAX_SCHEMA_RETRIES) {
			return { ...merged, ok: false, error: `structured output invalid after ${MAX_SCHEMA_RETRIES} re-asks: ${errors}` };
		}
		ctx.notify(`${ctx.node.id}: answer did not match output_format (${errors}) — re-asking ${calls}/${MAX_SCHEMA_RETRIES}`, "warning");
		const lead = `Your previous answer was not valid for the required schema: ${errors}.`;
		if (result.sessionRef) {
			request = buildAgentRequest(ctx, lead, { ...opts, resume: result.sessionRef });
		} else {
			request = buildAgentRequest(ctx, `${prompt}\n\n${lead}\nPrevious answer:\n${parsed.raw.slice(0, 4000)}`, opts);
		}
	}
}

/** Run `source` (a prompt template or command body) as this node's AI turn. */
export async function runAiPrompt(ctx: NodeContext, source: string): Promise<NodeOutcome> {
	const prompt = ctx.subst(source, "prompt");
	const schema = ctx.node.output_format;
	const call = await callAgent(ctx, prompt, { outputSchema: schema });
	if (!call.ok) {
		return { status: "failed", output: undefined, text: call.text, error: call.error ?? "agent failed", usage: call.usage, sessionRef: call.sessionRef, meta: { calls: call.calls, model: call.model } };
	}
	return { status: "success", output: schema ? call.value : call.text, text: call.text, usage: call.usage, sessionRef: call.sessionRef, meta: { calls: call.calls, model: call.model } };
}

/** `prompt:` nodes. */
export const runAiNode: NodeHandler = (ctx) => runAiPrompt(ctx, (ctx.node as { prompt: string }).prompt);
