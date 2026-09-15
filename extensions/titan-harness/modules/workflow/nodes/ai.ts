/**
 * nodes/ai.ts — the AI node (`prompt:`; `command:` delegates here) and the agent-call
 * builder shared by every AI-driven node (loop iterations, approval on_reject rework,
 * the P4 patterns).
 *
 * One call = substitute the prompt (prompt mode) → append the schema suffix when the node
 * declares `output_format` → resolve role/model/thinking/callsign from the live shape via
 * deps.resolveRole (a node's own model/thinking/callsign/system prompts override; a
 * persona's `model`/`thinking` sit between the node and the seat) → tools → context →
 * deps.agent through ctx.runAgent (which records the ledger row and the agent record).
 *
 * Structured output: with `output_format` the runtime (workflow-runtime.ts) exports the
 * schema to the child and names a terminating `submit_result` tool; when the child
 * recorded a typed object it arrives as `result.value` (v2) and is validated directly,
 * otherwise the answer text is parsed (v1). An invalid answer is re-asked at most
 * MAX_SCHEMA_RETRIES times with the errors appended, resuming the same session when the
 * child reported one, and the node fails after that.
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
 *
 * Personas (plan A12, personas.ts): `persona: <name>` appends personas/<name>.md to the
 * system prompt — never the user prompt, never a model name. `mimeograph:` runs the same
 * brief once per persona × model in fresh sessions (callsigns mg-1..n), archives every
 * answer under artifacts/nodes/<id>/mimeograph/, and a judge (best_of's anonymous
 * "Candidate n" prompt, JUDGE_SCHEMA) picks the winner, which becomes the node output.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { sha256 } from "../../hash-chain.ts";
import { type Persona, loadPersona, mimeographPersonaNames, mimeographPlan, personaAppend, personaRoots } from "../../personas.ts";
import { FULL_TOOLS, READONLY_TOOLS } from "../../runtime.ts";
import { type AgentRequest, type AgentResult, type NodeContext, type NodeHandler, type NodeOutcome, runLimited } from "../executor.ts";
import { validateJson } from "../json-schema.ts";
import type { JsonSchema, MimeographSpec, NodeDoc, SlotRole } from "../schema.ts";
import { MAX_SCHEMA_RETRIES, formatSchemaErrors, parseStructured, schemaPromptSuffix } from "../structured-output.ts";
import { JUDGE_SCHEMA, type JudgeVerdict, judgePrompt, judgeSeat } from "./best-of.ts";

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
	/** Ladder overrides (plan §5.3 b): win over the node's own model/thinking for this call. */
	model?: string;
	thinking?: string;
	/** Force a fresh session for this call (ladder step 3), whatever `context`/`resume` say. */
	freshSession?: boolean;
	/** A loaded persona for this call (mimeograph cells); default = the node's `persona:`. */
	persona?: Persona;
	/** Callsign override (mimeograph cells, judges). */
	callsign?: string;
}

export interface AgentCallResult extends AgentResult {
	/** The parsed object when `outputSchema` was given and the answer validated. */
	value?: unknown;
	/** Agent calls made (1 + re-asks). */
	calls: number;
	/** The final prompt text sent. */
	prompt: string;
}

/** What the runtime returns when the child recorded a typed object (structured output v2). */
type StructuredResult = AgentResult & { value?: unknown };

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

/** The node's `persona:` loaded from the project/user/package roots; throws when missing. */
export function nodePersona(ctx: NodeContext): Persona | undefined {
	const name = ctx.node.persona;
	if (!name) return undefined;
	return loadPersona(name, personaRoots(ctx.deps.cwd));
}

/** One AgentRequest for `prompt` (already substituted; the schema suffix is appended here when `opts.outputSchema` is set). */
export function buildAgentRequest(ctx: NodeContext, prompt: string, opts: AgentCallOptions = {}): AgentRequest {
	const node = ctx.node;
	const role = opts.role ?? node.role ?? DEFAULT_ROLE;
	const resolved = ctx.deps.resolveRole(role, node);
	const persona = opts.persona ?? nodePersona(ctx);
	const callsign = opts.callsign ?? (node.callsign && node.callsign !== "pool" ? node.callsign : resolved.callsign);
	// Review-before-report: an architect sees builder output only through review frames, so an
	// upstream builder/worker output without a passing frame is named as UNVERIFIED in the prompt.
	const unverified = role === "architect" && typeof ctx.unverifiedUpstream === "function" ? ctx.unverifiedUpstream() : [];
	const lead = unverified.length && !prompt.startsWith("[titan] upstream output") ? `[titan] upstream output ${unverified.join(", ")} is UNVERIFIED (no review frame)\n\n` : "";
	return {
		nodeId: node.id,
		role,
		callsign,
		model: opts.model ?? node.model ?? persona?.model ?? resolved.model,
		thinking: opts.thinking ?? node.thinking ?? persona?.thinking ?? resolved.thinking,
		prompt: `${lead}${prompt}${opts.outputSchema ? schemaPromptSuffix(opts.outputSchema) : ""}`,
		systemPrompt: node.system_prompt ?? resolved.systemPrompt,
		appendSystemPrompts: [...(resolved.appendSystemPrompts ?? []), ...listOf(node.append_system_prompt), ...(persona ? [personaAppend(persona)] : [])],
		tools: resolveTools(node, role, resolved.tools),
		context: opts.freshSession ? "fresh" : resolveContext(ctx, opts),
		hooks: node.hooks,
		outputSchema: opts.outputSchema,
		timeoutMs: ctx.timeoutMs("ai"),
		env: { ...ctx.env },
		label: opts.label ?? `${ctx.deps.workflowId}/${node.id}`,
	};
}

const emptyUsage = (): AgentResult["usage"] => ({ tokensIn: 0, tokensOut: 0, costUsd: 0, tpsSeconds: 0 });
const addUsage = (acc: AgentResult["usage"], usage?: AgentResult["usage"]): void => {
	if (!usage) return;
	acc.tokensIn += usage.tokensIn || 0;
	acc.tokensOut += usage.tokensOut || 0;
	acc.costUsd += usage.costUsd || 0;
	acc.tpsSeconds += usage.tpsSeconds || 0;
};

/** Run one agent call for `prompt` (substituted text), with the structured-output re-ask loop when `opts.outputSchema` is set. */
export async function callAgent(ctx: NodeContext, prompt: string, opts: AgentCallOptions = {}): Promise<AgentCallResult> {
	const usage: AgentResult["usage"] = emptyUsage();
	const schema = opts.outputSchema;
	let request = buildAgentRequest(ctx, prompt, opts);
	let calls = 0;
	for (;;) {
		const result: StructuredResult = await ctx.runAgent(request);
		calls++;
		addUsage(usage, result.usage);
		const merged: AgentCallResult = { ...result, usage, calls, prompt: request.prompt };
		if (!result.ok || !schema) return merged;
		// v2: the child's submit_result object; v1: the last JSON object in the answer text.
		let errors: string;
		let raw: string;
		if (result.value !== undefined) {
			const problems = validateJson(result.value, schema);
			if (!problems.length) return { ...merged, value: result.value };
			errors = formatSchemaErrors(problems);
			raw = JSON.stringify(result.value);
		} else {
			const parsed = parseStructured(result.text, schema);
			if (parsed.ok) return { ...merged, value: parsed.value };
			errors = formatSchemaErrors(parsed.errors);
			raw = parsed.raw;
		}
		if (calls > MAX_SCHEMA_RETRIES) {
			return { ...merged, ok: false, error: `structured output invalid after ${MAX_SCHEMA_RETRIES} re-asks: ${errors}` };
		}
		ctx.notify(`${ctx.node.id}: answer did not match output_format (${errors}) — re-asking ${calls}/${MAX_SCHEMA_RETRIES}`, "warning");
		const lead = `Your previous answer was not valid for the required schema: ${errors}.`;
		if (result.sessionRef) {
			request = buildAgentRequest(ctx, lead, { ...opts, resume: result.sessionRef });
		} else {
			request = buildAgentRequest(ctx, `${prompt}\n\n${lead}\nPrevious answer:\n${raw.slice(0, 4000)}`, opts);
		}
	}
}

// ═══ Mimeographs ═════════════════════════════════════════════════════════════

export interface MimeographCandidate {
	index: number;
	callsign: string;
	persona: string;
	model: string;
	thinking?: string;
	ok: boolean;
	text: string;
	error?: string;
	sessionRef?: string;
	sha256: string;
	usage?: AgentResult["usage"];
}

/** The `mimeograph:` field normalized to its spec form. */
export function mimeographSpec(node: NodeDoc): MimeographSpec | undefined {
	const raw = node.mimeograph;
	if (raw === undefined) return undefined;
	if (typeof raw === "string") return { personas: mimeographPersonaNames(raw) };
	return { ...raw, personas: mimeographPersonaNames(raw) };
}

function archiveMimeograph(ctx: NodeContext, candidates: MimeographCandidate[]): string {
	const dir = path.join(ctx.deps.artifactsDir, "nodes", ctx.node.id, "mimeograph");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	for (const candidate of candidates) {
		const body = candidate.ok ? candidate.text : `[failed] ${candidate.error ?? ""}\n`;
		fs.writeFileSync(path.join(dir, `${candidate.index}.md`), body.endsWith("\n") ? body : `${body}\n`, { mode: 0o600 });
		const meta = { index: candidate.index, callsign: candidate.callsign, persona: candidate.persona, model: candidate.model, thinking: candidate.thinking, ok: candidate.ok, sha256: candidate.sha256, sessionRef: candidate.sessionRef };
		fs.writeFileSync(path.join(dir, `${candidate.index}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
	}
	return dir;
}

/** The judge turn over the anonymous candidates, re-asked when the verdict is invalid or out of range (same bounds as callAgent). */
async function judgeMimeograph(ctx: NodeContext, spec: MimeographSpec, alive: MimeographCandidate[], usage: AgentResult["usage"]): Promise<{ verdict?: JudgeVerdict; error?: string; calls: number; prompt: string }> {
	const seat = judgeSeat(spec.judge);
	const brief = judgePrompt(spec.criteria, alive.map((c) => ({ index: c.index, text: c.text })));
	const label = `${ctx.deps.workflowId}/${ctx.node.id}/judge`;
	let calls = 0;
	let resume: string | undefined;
	let prompt = brief;
	for (;;) {
		const call = await callAgent(ctx, prompt, { role: seat.role, model: seat.model, outputSchema: JUDGE_SCHEMA, context: "fresh", resume, callsign: `${ctx.node.id}-judge`, label });
		calls += call.calls;
		addUsage(usage, call.usage);
		if (!call.ok) return { error: `judge failed: ${call.error ?? "agent failed"}`, calls, prompt: brief };
		const verdict = call.value as JudgeVerdict;
		if (Number.isInteger(verdict.winner) && alive.some((c) => c.index === verdict.winner)) return { verdict, calls, prompt: brief };
		const reason = `winner must be one of ${alive.map((c) => c.index).join(", ")}`;
		if (calls > MAX_SCHEMA_RETRIES) return { error: `judge verdict invalid after ${MAX_SCHEMA_RETRIES} re-asks: ${reason}`, calls, prompt: brief };
		ctx.notify(`${ctx.node.id}: judge verdict invalid (${reason}) — re-asking ${calls}/${MAX_SCHEMA_RETRIES}`, "warning");
		resume = call.sessionRef;
		prompt = resume ? `Your previous verdict was not valid: ${reason}.` : `${brief}\n\nYour previous verdict was not valid: ${reason}.`;
	}
}

/** Same brief × k personas × m models, fresh sessions, archived, judged; the winner's text is the node output. */
export async function runMimeograph(ctx: NodeContext, prompt: string, spec: MimeographSpec): Promise<NodeOutcome> {
	const roots = personaRoots(ctx.deps.cwd);
	let personas: Persona[];
	try {
		personas = spec.personas.map((name) => loadPersona(name, roots));
	} catch (error) {
		return { status: "failed", output: undefined, error: `mimeograph: ${error instanceof Error ? error.message : String(error)}`, retryable: false };
	}
	const role = ctx.node.role ?? DEFAULT_ROLE;
	const seatModel = ctx.node.model ?? ctx.deps.resolveRole(role, ctx.node).model;
	const models = spec.models?.length ? spec.models : [seatModel];
	let cells: ReturnType<typeof mimeographPlan>;
	try {
		cells = mimeographPlan(prompt, personas, models);
	} catch (error) {
		return { status: "failed", output: undefined, error: `mimeograph: ${error instanceof Error ? error.message : String(error)}`, retryable: false };
	}
	const usage = emptyUsage();
	const candidates: MimeographCandidate[] = [];
	const limit = ctx.deps.settings.maxConcurrentChildren ?? 8;
	let aborted: unknown;
	await runLimited(
		cells.map((cell, i) => async () => {
			try {
				const persona = personas.find((p) => p.name === cell.persona)!;
				const request = buildAgentRequest(ctx, prompt, { persona, model: cell.model, thinking: cell.thinking, context: "fresh", callsign: cell.callsign, label: `${ctx.deps.workflowId}/${ctx.node.id}/${cell.callsign}` });
				const result = await ctx.runAgent(request);
				const text = result.text ?? "";
				candidates.push({ index: i + 1, callsign: cell.callsign, persona: cell.persona, model: cell.model, thinking: cell.thinking, ok: result.ok && text.trim().length > 0, text, error: result.ok ? undefined : (result.error ?? "agent failed"), sessionRef: result.sessionRef, sha256: sha256(text), usage: result.usage });
				addUsage(usage, result.usage);
			} catch (error) {
				aborted ??= error;
				throw error;
			}
		}),
		limit,
	);
	if (aborted) throw aborted;
	candidates.sort((a, b) => a.index - b.index);
	const archive = archiveMimeograph(ctx, candidates);
	const alive = candidates.filter((c) => c.ok);
	ctx.log("mimeograph.cells", { personas: personas.map((p) => p.name), models, cells: cells.length, ok: alive.length, failed: candidates.length - alive.length, archive });
	if (!alive.length) {
		return { status: "failed", output: undefined, error: `mimeograph: all ${cells.length} cells failed (${candidates.map((c) => c.error ?? "?").join("; ")})`, usage, meta: { cells: cells.length, candidates: 0, archive } };
	}
	const judged = await judgeMimeograph(ctx, spec, alive, usage);
	if (!judged.verdict) {
		return { status: "failed", output: undefined, error: `mimeograph: ${judged.error}`, usage, meta: { cells: cells.length, candidates: alive.length, judgeCalls: judged.calls, archive } };
	}
	const winner = alive.find((c) => c.index === judged.verdict!.winner)!;
	ctx.log("mimeograph.verdict", { winner: winner.index, callsign: winner.callsign, persona: winner.persona, summary: judged.verdict.summary, scores: judged.verdict.scores ?? [] });
	return {
		status: "success",
		output: winner.text,
		text: winner.text,
		usage,
		sessionRef: winner.sessionRef,
		meta: { cells: cells.length, candidates: alive.length, winner: winner.index, winnerCallsign: winner.callsign, winnerPersona: winner.persona, scores: judged.verdict.scores ?? [], summary: judged.verdict.summary, judgeCalls: judged.calls, archive },
	};
}

// ═══ The node ════════════════════════════════════════════════════════════════

/** Run `source` (a prompt template or command body) as this node's AI turn. */
export async function runAiPrompt(ctx: NodeContext, source: string): Promise<NodeOutcome> {
	const prompt = ctx.subst(source, "prompt");
	const mimeo = mimeographSpec(ctx.node);
	if (mimeo) return runMimeograph(ctx, prompt, mimeo);
	const schema = ctx.node.output_format;
	let call: AgentCallResult;
	try {
		call = await callAgent(ctx, prompt, { outputSchema: schema });
	} catch (error) {
		// A missing or malformed persona is a document problem, not a transient one.
		if (error instanceof Error && /persona/.test(error.message)) return { status: "failed", output: undefined, error: error.message, retryable: false };
		throw error;
	}
	if (!call.ok) {
		return { status: "failed", output: undefined, text: call.text, error: call.error ?? "agent failed", usage: call.usage, sessionRef: call.sessionRef, meta: { calls: call.calls, model: call.model } };
	}
	return { status: "success", output: schema ? call.value : call.text, text: call.text, usage: call.usage, sessionRef: call.sessionRef, meta: { calls: call.calls, model: call.model } };
}

/** `prompt:` nodes. */
export const runAiNode: NodeHandler = (ctx) => runAiPrompt(ctx, (ctx.node as { prompt: string }).prompt);
