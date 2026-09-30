/**
 * turn-budget.ts — the child-side per-turn spend bound for workflow budgets (N3-09 repair 3).
 *
 * The parent (child-runner.ts runChild) hands a budgeted child the amount it may still spend —
 * the call's live spend cap at spawn, which is the reservation it holds EXCLUSIVELY in every
 * budget scope — through the environment. extensions/titan-child-hooks.ts runs this guard on
 * Pi's `before_provider_request` hook, i.e. before EVERY paid model turn:
 *
 *   worst-case turn cost = input bound × the model's highest input rate
 *                        + max output tokens × the model's highest output rate
 *
 * The input bound is the UTF-8 byte length of the serialised provider payload plus a fixed
 * provider overhead. It is an upper bound ONLY for a text-only request whose whole billed input
 * is inside the payload: a byte-level BPE / byte-fallback tokenizer never emits more tokens
 * than the bytes it covers, and every message's JSON framing (`{"role":"…","content":…}`,
 * ≥ 20 bytes) out-sizes the provider's per-message framing tokens. So before the bound is used,
 * unboundedInput() REFUSES every request shape whose billed input is not the serialised text:
 * media (images, documents/PDFs, audio, video, files — billed by pixels/pages/seconds, not
 * bytes), references to content held elsewhere (image/file URLs, file ids, Gemini fileData /
 * inlineData / cachedContent, Responses previous_response_id / conversation / stored prompts),
 * server-side tools that fetch or run content inside one request (web search/fetch, code
 * execution, file search, computer use, MCP servers), multi-candidate sampling (n /
 * candidateCount > 1) and premium pricing modifiers the catalogue does not price (service
 * tiers, fast mode, data-residency surcharges, predicted outputs, audio output).
 * The output cap in the payload is CLAMPED (never raised) so the worst case fits what is left;
 * when even MIN_OUTPUT_TOKENS cannot fit, or the turn cannot be bounded at all (no model, no
 * pricing under a USD cap, an API whose output-cap field is unknown), the turn is REFUSED:
 * the extension records the refusal in the state file and exits the child before the request
 * is sent. After each turn the remainder drops by the reported usage — or by the turn's worst
 * case when the provider reported none or the turn errored/aborted mid-stream.
 *
 * Reasoning/thinking tokens are billed as output and are inside the provider's output cap
 * (Anthropic max_tokens with thinking.budget_tokens < max_tokens, OpenAI max_output_tokens /
 * max_completion_tokens). Google's thinking budget is treated as NOT inside maxOutputTokens,
 * so a thinking Gemini turn splits the room in half between the two.
 *
 * Pure: no Pi imports, no process access (the extension owns env, files and exit).
 */

/** Env the parent sets on a budgeted child. */
export const BUDGET_USD_ENV = "TITAN_BUDGET_USD_MICROS";
export const BUDGET_TOKENS_ENV = "TITAN_BUDGET_TOKENS";
/** The file the child's guard writes: "armed" at load (the parent requires it), then every turn's tally, then any refusal. */
export const BUDGET_STATE_ENV = "TITAN_BUDGET_STATE_PATH";
/** Exit code of a child whose guard refused a model turn (the request was never sent). */
export const BUDGET_REFUSED_EXIT = 86;
/** The smallest output cap worth sending (OpenAI Responses rejects < 16). */
export const MIN_OUTPUT_TOKENS = 16;
/** Tokens a provider may add around the payload (tool-use preambles, message framing). */
export const PROVIDER_OVERHEAD_TOKENS = 1024;
/** Anthropic's minimum thinking budget; below it thinking is switched off for the turn. */
const ANTHROPIC_MIN_THINKING = 1024;

export type BudgetDimensionName = "usd" | "tokens";

export interface TurnBudgetEnv {
	/** Set when any budget variable is present (malformed values make the guard refuse every turn). */
	active: boolean;
	usdMicros?: number;
	tokens?: number;
	statePath?: string;
	problems: string[];
}

const nonNegInt = (raw: string | undefined): number | undefined | null => {
	if (raw === undefined || raw.trim() === "") return undefined;
	if (!/^\d+$/.test(raw.trim())) return null;
	const n = Number(raw.trim());
	return Number.isSafeInteger(n) ? n : null;
};

export function turnBudgetFromEnv(env: Record<string, string | undefined>): TurnBudgetEnv {
	const problems: string[] = [];
	const usdRaw = env[BUDGET_USD_ENV];
	const tokRaw = env[BUDGET_TOKENS_ENV];
	if (usdRaw === undefined && tokRaw === undefined) return { active: false, problems };
	const out: TurnBudgetEnv = { active: true, problems };
	const usd = nonNegInt(usdRaw);
	const tokens = nonNegInt(tokRaw);
	if (usd === null) problems.push(`${BUDGET_USD_ENV} is not a non-negative integer`);
	else if (usd !== undefined) out.usdMicros = usd;
	if (tokens === null) problems.push(`${BUDGET_TOKENS_ENV} is not a non-negative integer`);
	else if (tokens !== undefined) out.tokens = tokens;
	const statePath = env[BUDGET_STATE_ENV]?.trim();
	if (statePath) out.statePath = statePath;
	return out;
}

/** The pricing/limits the guard needs from a Pi model (pi-ai Model). */
export interface PricedModel {
	api?: string;
	provider?: string;
	id?: string;
	maxTokens?: number;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; tiers?: Array<{ input?: number; output?: number; cacheRead?: number; cacheWrite?: number }> };
}

const finitePos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const finiteNonNeg = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * Highest per-token rates in micro-USD (pi prices are USD per million tokens, i.e. micro-USD per
 * token). Input takes the max of input, cache read, cache write and a 1h cache write (2× input)
 * over the base rates and every tier. Undefined when either rate is missing or zero.
 */
export function worstRates(model: PricedModel | undefined, longCacheWrites = true): { input: number; output: number } | undefined {
	const cost = model?.cost;
	if (!cost) return undefined;
	let input = 0;
	let output = 0;
	for (const r of [cost, ...(Array.isArray(cost.tiers) ? cost.tiers : [])]) {
		if (!r) continue;
		for (const v of [r.input, r.cacheRead, r.cacheWrite, longCacheWrites && finiteNonNeg(r.input) ? r.input * 2 : undefined]) if (finiteNonNeg(v)) input = Math.max(input, v);
		if (finiteNonNeg(r.output)) output = Math.max(output, r.output);
	}
	if (!finitePos(cost.input) || !finitePos(cost.output)) return undefined;
	return { input, output };
}

/** Content-part types billed by something other than their serialised bytes (pixels, pages, seconds, fetched content). */
const MEDIA_PART_TYPES = new Set([
	"image", "image_url", "input_image", "image_file", "document", "file", "input_file", "input_audio", "audio", "video", "input_video",
	"container_upload", "server_tool_use", "web_search_tool_result", "web_fetch_tool_result", "code_execution_tool_result", "mcp_tool_use", "mcp_tool_result",
]);
/** Keys that carry media or point at content the payload does not contain. */
const REFERENCE_KEYS = new Set([
	"image_url", "file_id", "file_url", "file_data", "fileUri", "file_uri", "fileData", "inlineData", "inline_data", "input_audio", "video_url", "audio_url",
]);
/** Keys of a media block (Bedrock Converse) — only when the value looks like media ({ format | source | data | url }). */
const MEDIA_BLOCK_KEYS = new Set(["image", "document", "video", "audio"]);
/** Top-level request keys that pull in context or pricing the payload does not bound. */
const UNBOUNDED_TOP_KEYS = [
	"previous_response_id", "conversation", "prompt", "cachedContent", "cached_content", "mcp_servers", "container",
	"web_search_options", "prediction", "audio", "speed", "inference_geo", "best_of",
];
const STANDARD_SERVICE_TIERS = new Set(["auto", "default", "standard", "standard_only"]);
/** Tool-entry keys of a plain client-side function tool (every other entry shape is a server/built-in tool). */
const FUNCTION_TOOL_KEYS = new Set(["functionDeclarations", "function_declarations", "toolSpec", "cachePoint", "function"]);

/**
 * Why this request's billed input cannot be bounded by its serialised size (undefined when it can).
 * Deliberately fail-closed: an unrecognised part type carrying non-text content, or a tool that is
 * not a plain function tool, refuses the turn rather than being guessed at.
 */
export function unboundedInput(payload: Record<string, any>): string | undefined {
	for (const key of UNBOUNDED_TOP_KEYS) {
		if (payload[key] !== undefined && payload[key] !== null && payload[key] !== false) return `request field "${key}" adds input or pricing outside the payload`;
	}
	if (payload.service_tier !== undefined && !STANDARD_SERVICE_TIERS.has(String(payload.service_tier))) return `service_tier "${payload.service_tier}" is priced outside the catalogue`;
	if (Array.isArray(payload.modalities) && payload.modalities.some((m: unknown) => m !== "text")) return "non-text output modalities are priced outside the catalogue";
	for (const holder of [payload, payload.config, payload.generationConfig, payload.options]) {
		if (!isObj(holder)) continue;
		for (const key of ["n", "candidateCount", "candidate_count"]) if (holder[key] !== undefined && holder[key] !== null && holder[key] !== 1) return `${key}=${holder[key]}: more than one sampled candidate per turn`;
		if (holder.cachedContent !== undefined) return "request field \"cachedContent\" adds input outside the payload";
		if (holder.mediaResolution !== undefined || holder.media_resolution !== undefined) return "media resolution settings imply media input";
	}
	// Tools: only plain client-side function tools (their definitions are in the payload and billed as text).
	const toolLists = [payload.tools, payload.config?.tools, payload.toolConfig?.tools, payload.options?.tools].filter(Array.isArray) as unknown[][];
	for (const list of toolLists) {
		for (const tool of list) {
			if (!isObj(tool)) return "a tool entry is not an object";
			if (tool.type !== undefined) {
				if (tool.type !== "function" && tool.type !== "custom") return `server/built-in tool "${tool.type}" fetches or runs content inside the request`;
				continue;
			}
			if (typeof tool.name === "string") continue; // Anthropic custom tool (no type)
			const keys = Object.keys(tool);
			const bad = keys.find((k) => !FUNCTION_TOOL_KEYS.has(k));
			if (bad || keys.length === 0) return `tool entry "${bad ?? "{}"}" is not a plain function tool`;
		}
	}
	// Message content: walk everything except tool definitions (JSON schemas legitimately use "type").
	const stack: unknown[] = [];
	for (const [key, value] of Object.entries(payload)) if (key !== "tools" && key !== "toolConfig" && key !== "tool_choice") stack.push(value);
	if (isObj(payload.config)) for (const [key, value] of Object.entries(payload.config)) if (key !== "tools" && key !== "toolConfig" && key !== "responseSchema" && key !== "responseJsonSchema") stack.push(value);
	let visited = 0;
	while (stack.length) {
		const node = stack.pop();
		if (++visited > 1_000_000) return "payload too deep to inspect";
		if (Array.isArray(node)) {
			for (const v of node) stack.push(v);
			continue;
		}
		if (!isObj(node)) continue;
		if (typeof node.type === "string" && MEDIA_PART_TYPES.has(node.type)) {
			// A document whose source is plain text is billed as that text.
			const src = node.source;
			if (!(node.type === "document" && isObj(src) && (src.type === "text" || src.type === "content"))) return `content part "${node.type}" is billed by its media, not its serialised size`;
		}
		if (isObj(node.source) && node.source.type !== undefined && node.source.type !== "text" && node.source.type !== "content") return `content source "${node.source.type}" is billed by its media, not its serialised size`;
		for (const [key, value] of Object.entries(node)) {
			if (REFERENCE_KEYS.has(key) && value !== undefined && value !== null) return `content field "${key}" carries media or a reference to content outside the payload`;
			// Bedrock Converse media blocks: { image | document | video | audio: { format, source } }.
			if (MEDIA_BLOCK_KEYS.has(key) && isObj(value) && (value.source !== undefined || value.format !== undefined || value.data !== undefined || value.url !== undefined)) return `content block "${key}" is billed by its media, not its serialised size`;
			if (key === "tools" && node !== payload) continue;
			if (value && typeof value === "object") stack.push(value);
		}
	}
	return undefined;
}

/**
 * UTF-8 byte length of the serialised payload + provider overhead. An upper bound on billed input
 * tokens only once unboundedInput() has found nothing (planTurn checks it first).
 */
export function inputTokenBound(payload: unknown): number | undefined {
	let json: string | undefined;
	try {
		json = JSON.stringify(payload);
	} catch {
		return undefined;
	}
	if (typeof json !== "string") return undefined;
	return Buffer.byteLength(json, "utf8") + PROVIDER_OVERHEAD_TOKENS;
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** Where each API keeps its output cap, and how thinking shares it. */
interface CapSlot {
	read(p: Record<string, any>): number | undefined;
	write(p: Record<string, any>, cap: number): void;
	/** Google: thinking is outside the output cap → the room is split between them. */
	thinkingOutsideCap?: (p: Record<string, any>) => boolean;
	/** Clamp any thinking budget inside the cap (Anthropic-style budget < max_tokens). */
	fitThinking?: (p: Record<string, any>, cap: number, room: number) => void;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);

/** Anthropic-style `thinking: { type: "enabled", budget_tokens }` inside `holder`. */
const fitAnthropicThinking = (holder: Record<string, any> | undefined, cap: number): void => {
	const thinking = holder?.thinking;
	if (!isObj(thinking) || thinking.type !== "enabled" || !num(thinking.budget_tokens)) return;
	if (thinking.budget_tokens < cap) return;
	const budget = cap - 1;
	if (budget < ANTHROPIC_MIN_THINKING) delete holder!.thinking;
	else thinking.budget_tokens = budget;
};

const firstKey = (p: Record<string, any>, keys: string[]): string | undefined => keys.find((k) => p[k] !== undefined);

const CAP_SLOTS: Record<string, CapSlot> = {
	"anthropic-messages": {
		read: (p) => num(p.max_tokens),
		write: (p, cap) => {
			p.max_tokens = cap;
		},
		fitThinking: (p, cap) => fitAnthropicThinking(p, cap),
	},
	"openai-completions": {
		read: (p) => num(p.max_completion_tokens) ?? num(p.max_tokens),
		write: (p, cap) => {
			const key = firstKey(p, ["max_completion_tokens", "max_tokens"]) ?? "max_completion_tokens";
			p[key] = cap;
		},
		fitThinking: (p, cap) => {
			for (const key of ["thinking_token_budget", "thinking_budget", "thinking_budget_tokens"]) if (num(p[key]) && p[key] >= cap) p[key] = Math.max(0, cap - 1);
		},
	},
	"openai-responses": {
		read: (p) => num(p.max_output_tokens),
		write: (p, cap) => {
			p.max_output_tokens = cap;
		},
	},
	"mistral-conversations": {
		read: (p) => num(p.maxTokens) ?? num(p.max_tokens),
		write: (p, cap) => {
			p[firstKey(p, ["maxTokens", "max_tokens"]) ?? "maxTokens"] = cap;
		},
	},
	"bedrock-converse-stream": {
		read: (p) => num(p.inferenceConfig?.maxTokens),
		write: (p, cap) => {
			p.inferenceConfig = { ...(isObj(p.inferenceConfig) ? p.inferenceConfig : {}), maxTokens: cap };
		},
		fitThinking: (p, cap) => fitAnthropicThinking(isObj(p.additionalModelRequestFields) ? p.additionalModelRequestFields : undefined, cap),
	},
	"google-generative-ai": {
		read: (p) => num(p.config?.maxOutputTokens),
		write: (p, cap) => {
			p.config = { ...(isObj(p.config) ? p.config : {}), maxOutputTokens: cap };
		},
		thinkingOutsideCap: (p) => isObj(p.config?.thinkingConfig) && p.config.thinkingConfig.thinkingBudget !== 0,
		fitThinking: (p, _cap, room) => {
			const tc = p.config?.thinkingConfig;
			if (!isObj(tc) || tc.thinkingBudget === 0) return;
			// A level (no numeric budget) or an unbounded (-1) budget cannot be bounded: pin a number.
			delete tc.thinkingLevel;
			tc.thinkingBudget = num(tc.thinkingBudget) !== undefined ? Math.min(tc.thinkingBudget, room) : room;
		},
	},
	"pi-messages": {
		read: (p) => num(p.options?.maxTokens),
		write: (p, cap) => {
			p.options = { ...(isObj(p.options) ? p.options : {}), maxTokens: cap };
		},
	},
};
CAP_SLOTS["azure-openai-responses"] = CAP_SLOTS["openai-responses"];
CAP_SLOTS["openai-codex-responses"] = CAP_SLOTS["openai-responses"];
CAP_SLOTS["google-vertex"] = CAP_SLOTS["google-generative-ai"];

export const BOUNDED_APIS = Object.keys(CAP_SLOTS);

export interface TurnPlan {
	ok: true;
	payload: unknown;
	maxOutputTokens: number;
	inputBound: number;
	worst: { usdMicros: number; tokens: number };
}
export interface TurnRefusal {
	ok: false;
	reason: string;
	dimension?: BudgetDimensionName;
	remaining?: number;
	needed?: number;
}

export interface Remaining {
	usdMicros?: number;
	tokens?: number;
}

/**
 * Bound one provider request. `remaining` is what the child may still spend (an absent
 * dimension is uncapped). Returns the payload with its output cap clamped so the worst case
 * fits, or a refusal. The input payload is not mutated.
 */
export function planTurn(model: PricedModel | undefined, payload: unknown, remaining: Remaining): TurnPlan | TurnRefusal {
	const usdCapped = remaining.usdMicros !== undefined;
	const tokCapped = remaining.tokens !== undefined;
	if (!model) return { ok: false, reason: "no model: the turn cannot be priced" };
	const slot = model.api ? CAP_SLOTS[model.api] : undefined;
	if (!slot) return { ok: false, reason: `api ${model.api ?? "?"} has no known output-cap field: the turn cannot be bounded` };
	if (!isObj(payload)) return { ok: false, reason: "provider payload is not an object: the turn cannot be bounded" };
	const unbounded = unboundedInput(payload);
	if (unbounded) return { ok: false, reason: `the turn's input cannot be bounded before dispatch: ${unbounded}`, dimension: usdCapped ? "usd" : "tokens", remaining: usdCapped ? remaining.usdMicros : remaining.tokens };
	const inputBound = inputTokenBound(payload);
	if (inputBound === undefined) return { ok: false, reason: "provider payload is not serialisable: the turn cannot be bounded" };
	// A 1h cache write bills 2× input (pi-ai calculateCost); only possible when the payload asks for a 1h TTL.
	const rates = worstRates(model, /"ttl"\s*:\s*"1h"/.test(JSON.stringify(payload)));
	if (usdCapped && !rates) return { ok: false, reason: `model ${model.provider ?? "?"}/${model.id ?? "?"} has no input/output pricing: the turn cannot be priced under a USD budget`, dimension: "usd", remaining: remaining.usdMicros };
	let next: Record<string, any>;
	try {
		next = structuredClone(payload) as Record<string, any>;
	} catch {
		next = JSON.parse(JSON.stringify(payload));
	}
	const ceiling = slot.read(next) ?? num(model.maxTokens);
	if (ceiling === undefined) return { ok: false, reason: "no output cap in the payload or the model: the turn cannot be bounded" };
	// Output tokens the remainder can pay for after the worst-case input.
	let room = ceiling;
	if (usdCapped) {
		const inputCost = Math.ceil(inputBound * rates!.input);
		const left = remaining.usdMicros! - inputCost;
		const byUsd = Math.floor(left / rates!.output);
		if (byUsd < MIN_OUTPUT_TOKENS) return { ok: false, reason: "the remaining USD budget cannot pay for this turn's input plus the minimum output", dimension: "usd", remaining: remaining.usdMicros, needed: inputCost + Math.ceil(MIN_OUTPUT_TOKENS * rates!.output) };
		room = Math.min(room, byUsd);
	}
	if (tokCapped) {
		const byTokens = remaining.tokens! - inputBound;
		if (byTokens < MIN_OUTPUT_TOKENS) return { ok: false, reason: "the remaining token budget cannot hold this turn's input plus the minimum output", dimension: "tokens", remaining: remaining.tokens, needed: inputBound + MIN_OUTPUT_TOKENS };
		room = Math.min(room, byTokens);
	}
	// Google thinking is billed outside maxOutputTokens: split the room between the two.
	const split = slot.thinkingOutsideCap?.(next) === true;
	const cap = split ? Math.floor(room / 2) : room;
	if (cap < MIN_OUTPUT_TOKENS) return { ok: false, reason: "no room for the minimum output once thinking is bounded", dimension: usdCapped ? "usd" : "tokens", remaining: usdCapped ? remaining.usdMicros : remaining.tokens };
	slot.write(next, cap);
	slot.fitThinking?.(next, cap, split ? room - cap : cap);
	const outputWorst = split ? room : cap;
	const worst = {
		usdMicros: rates ? Math.ceil(inputBound * rates.input + outputWorst * rates.output) : 0,
		tokens: inputBound + outputWorst,
	};
	if (usdCapped && worst.usdMicros > remaining.usdMicros!) return { ok: false, reason: "internal: the clamped turn still exceeds the USD remainder", dimension: "usd", remaining: remaining.usdMicros, needed: worst.usdMicros };
	if (tokCapped && worst.tokens > remaining.tokens!) return { ok: false, reason: "internal: the clamped turn still exceeds the token remainder", dimension: "tokens", remaining: remaining.tokens, needed: worst.tokens };
	return { ok: true, payload: next, maxOutputTokens: cap, inputBound, worst };
}

/** A reported assistant usage block (pi-ai Usage). */
export interface ReportedUsage {
	input?: number | null;
	output?: number | null;
	cacheRead?: number | null;
	cacheWrite?: number | null;
	cost?: { total?: number | null } | null;
}

/**
 * The per-child guard: plan each turn against what is left, then charge what the turn used.
 * Every turn is bounded before it is sent, so spend never passes the starting remainder.
 */
export class TurnBudgetGuard {
	readonly start: Remaining;
	readonly left: Remaining;
	readonly spent = { usdMicros: 0, tokens: 0 };
	turns = 0;
	private pending: TurnPlan["worst"] | undefined;
	refusal: TurnRefusal | undefined;

	constructor(remaining: Remaining) {
		this.start = { ...remaining };
		this.left = { ...remaining };
	}

	beforeRequest(model: PricedModel | undefined, payload: unknown): TurnPlan | TurnRefusal {
		// A turn whose end was never observed (no message_end) is charged at its worst case before the next is planned.
		if (this.pending) this.charge(this.pending);
		const plan = planTurn(model, payload, this.left);
		if (!plan.ok) {
			this.refusal = plan;
			return plan;
		}
		this.pending = plan.worst;
		this.turns++;
		return plan;
	}

	/**
	 * An assistant message ended: charge its reported usage. Completeness is judged PER DIMENSION: tokens count as
	 * reported only when input, output, cacheRead and cacheWrite are all finite and ≥ 0 and sum above 0; USD only
	 * when cost.total is finite and > 0 (a $0 cost under a USD cap is an unpriced turn). A dimension that was not
	 * reported is charged at the turn's planned worst case, and an interrupted turn at max(reported, worst).
	 */
	afterTurn(usage: ReportedUsage | undefined, stopReason?: string): void {
		const worst = this.pending;
		this.pending = undefined;
		const parts = usage ? [usage.input, usage.output, usage.cacheRead, usage.cacheWrite] : [];
		const tokenSum = parts.reduce<number>((a, v) => a + (finiteNonNeg(v) ? v : 0), 0);
		const tokensKnown = !!usage && parts.every(finiteNonNeg) && tokenSum > 0;
		const costUsd = usage?.cost?.total;
		const usdKnown = finitePos(costUsd);
		const reported = { usdMicros: usdKnown ? Math.ceil(Math.round(costUsd * 1e9) / 1e3) : 0, tokens: tokensKnown ? Math.ceil(tokenSum) : 0 };
		if (!worst) {
			// No planned turn to fall back on (a message_end with no request seen): charge whatever was reported.
			this.charge({ usdMicros: usdKnown ? reported.usdMicros : 0, tokens: finiteNonNeg(tokenSum) ? Math.ceil(tokenSum) : 0 });
			return;
		}
		const interrupted = stopReason === "error" || stopReason === "aborted";
		const pick = (known: boolean, got: number, planned: number): number => (!known ? planned : interrupted ? Math.max(got, planned) : got);
		this.charge({ usdMicros: this.start.usdMicros === undefined && !usdKnown ? 0 : pick(usdKnown, reported.usdMicros, worst.usdMicros), tokens: pick(tokensKnown, reported.tokens, worst.tokens) });
	}

	private charge(amount: { usdMicros: number; tokens: number }): void {
		this.pending = undefined;
		this.spent.usdMicros += amount.usdMicros;
		this.spent.tokens += amount.tokens;
		if (this.left.usdMicros !== undefined) this.left.usdMicros -= amount.usdMicros;
		if (this.left.tokens !== undefined) this.left.tokens -= amount.tokens;
	}

	snapshot(state: "armed" | "turn" | "refused"): Record<string, unknown> {
		// `pending` = the worst case of a turn that was sent but whose end has not been seen (the parent settles it conservatively).
		return { v: 1, state, start: this.start, left: this.left, spent: this.spent, turns: this.turns, ...(this.pending ? { pending: this.pending } : {}), ...(this.refusal ? { refusal: this.refusal } : {}) };
	}
}

/** The env a parent sets for a budgeted child (only the capped dimensions). */
export function turnBudgetEnv(cap: Remaining, statePath: string): Record<string, string> {
	const env: Record<string, string> = { [BUDGET_STATE_ENV]: statePath };
	if (cap.usdMicros !== undefined) env[BUDGET_USD_ENV] = String(Math.max(0, Math.floor(cap.usdMicros)));
	if (cap.tokens !== undefined) env[BUDGET_TOKENS_ENV] = String(Math.max(0, Math.floor(cap.tokens)));
	return env;
}
