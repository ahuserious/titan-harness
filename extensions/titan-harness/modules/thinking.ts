/**
 * thinking.ts — requested → effective thinking (plan D7, §4.4).
 *
 * A shape may ask for `xhigh` on a model whose provider tops out at `high`. The value the
 * harness SENDS is the provider ceiling, but the operator's request is never lost: a slot
 * renders as `requested↘effective` (`xhigh↘high`) whenever the two differ.
 *
 * Two sources of truth, in order:
 *   1. Pi's registry entry for the model (`thinkingLevelMap`), applying exactly the rule
 *      Pi's own `getSupportedThinkingLevels` applies: a level mapped to `null` is
 *      unsupported, and `xhigh` / `max` count as supported only when the map names them
 *      explicitly (an absent entry for a lower level is pass-through).
 *   2. STATIC_CEILINGS — the ceilings the plan pins for models Pi ships no data for
 *      (Cerebras Qwen, Antigravity Gemini, xAI Grok 4.5), so a YAML shape can be
 *      normalized at load time before any provider is resolved.
 *
 * Pure: no pi APIs, no filesystem.
 */
import type { Thinking } from "./model-stack.ts";

export type ThinkingReason = "identity" | "provider_ceiling" | "unknown_model";
export type ThinkingNormalization = { requested: Thinking; effective: Thinking; reason: ThinkingReason };

/** Pi's thinking levels, ascending. */
export const THINKING_ORDER: Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The subset of a Pi registry `Model` that decides thinking support. */
export interface ThinkingRegistryModel {
	thinkingLevelMap?: Record<string, string | null>;
	reasoning?: boolean;
}

/**
 * Highest thinking level a provider accepts, for models Pi ships no map for (plan §4.4).
 * Keys are matched by full `provider/id`, then by the id after the provider, then by the
 * last path segment, so `openrouter/x-ai/grok-4.5` still finds `grok-4.5`.
 */
export const STATIC_CEILINGS: Record<string, Thinking> = {
	"antigravity/gemini-3.8-flash": "high",
	"google/gemini-3.8-flash": "high",
	"openrouter/google/gemini-3.8-flash": "high",
	"cerebras/qwen-3.8-27b": "high",
	"xai/grok-4.5": "high",
	"grok-4.5": "high",
	// bare ids: the same ceilings through any other provider (openrouter/…, vercel-ai-gateway/…)
	"gemini-3.8-flash": "high",
	"qwen-3.8-27b": "high",
};

const rank = (level: Thinking): number => THINKING_ORDER.indexOf(level);

/** The static ceiling for a model id, or undefined when the table does not know it. */
export function staticCeiling(model: string): Thinking | undefined {
	const id = model.trim().toLowerCase();
	if (STATIC_CEILINGS[id]) return STATIC_CEILINGS[id];
	const slash = id.indexOf("/");
	const afterProvider = slash >= 0 ? id.slice(slash + 1) : id;
	if (STATIC_CEILINGS[afterProvider]) return STATIC_CEILINGS[afterProvider];
	return STATIC_CEILINGS[id.slice(id.lastIndexOf("/") + 1)];
}

/** Levels a registry model accepts — Pi's `getSupportedThinkingLevels` rule, verbatim. */
export function supportedThinkingLevels(registryModel: ThinkingRegistryModel): Thinking[] {
	if (registryModel.reasoning === false) return ["off"];
	const map = registryModel.thinkingLevelMap ?? {};
	return THINKING_ORDER.filter((level) => {
		const mapped = map[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/**
 * Normalize a requested level for a model. With a registry model that carries a
 * `thinkingLevelMap` (or declares `reasoning: false`) the provider data decides; otherwise
 * the static table does; a model neither knows passes through as `unknown_model`.
 */
export function normalizeThinking(model: string, requested: Thinking, registryModel?: ThinkingRegistryModel): ThinkingNormalization {
	if (registryModel && (registryModel.thinkingLevelMap !== undefined || registryModel.reasoning === false)) {
		const supported = supportedThinkingLevels(registryModel);
		if (supported.length === 0 || supported.includes(requested)) return { requested, effective: requested, reason: "identity" };
		// Ceiling first: the highest supported level below the request. A floor only as the
		// last resort (a provider that rejects `off`), mirroring Pi's own clamp.
		const below = [...supported].reverse().find((level) => rank(level) < rank(requested));
		const above = supported.find((level) => rank(level) > rank(requested));
		return { requested, effective: below ?? above ?? requested, reason: "provider_ceiling" };
	}
	const ceiling = staticCeiling(model);
	if (!ceiling) return { requested, effective: requested, reason: "unknown_model" };
	if (rank(requested) <= rank(ceiling)) return { requested, effective: requested, reason: "identity" };
	return { requested, effective: ceiling, reason: "provider_ceiling" };
}

/** `xhigh` when nothing changed, `xhigh↘high` when a ceiling applied. Full words; the bar shortens. */
export function thinkingLabel(n: ThinkingNormalization): string {
	return n.requested === n.effective ? n.effective : `${n.requested}↘${n.effective}`;
}
