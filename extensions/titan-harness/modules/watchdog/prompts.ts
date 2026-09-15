/**
 * watchdog/prompts.ts — loads the watchdog prompt files and fills their placeholders.
 *
 * Files live in extensions/titan-harness/prompts/ (the same directory prompt-library.ts
 * reads): SYSTEM_PROMPT_WATCHDOG.md, USER_PROMPT_WATCHDOG_COMPACTION.md,
 * USER_PROMPT_RESUME.md. Placeholders are `{{NAME}}`; an unknown placeholder stays
 * visible so a missing input is never silently blank. Bounded inputs use
 * LIMITS.maxReviewInputChars (24,000) — the reviewer never sees more than that.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS } from "./state.ts";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROMPT_DIR = [path.join(MODULE_DIR, "..", "..", "prompts"), path.join(MODULE_DIR, "..", "prompts")].find((candidate) => fs.existsSync(candidate)) ?? path.join(MODULE_DIR, "..", "..", "prompts");

export const SYSTEM_PROMPT_WATCHDOG = "SYSTEM_PROMPT_WATCHDOG.md";
export const USER_PROMPT_WATCHDOG_COMPACTION = "USER_PROMPT_WATCHDOG_COMPACTION.md";
export const USER_PROMPT_RESUME = "USER_PROMPT_RESUME.md";

const cache = new Map<string, string>();

export function loadPrompt(file: string): string {
	const cached = cache.get(file);
	if (cached !== undefined) return cached;
	let text: string;
	try {
		text = fs.readFileSync(path.join(PROMPT_DIR, file), "utf8").trim();
	} catch (error) {
		throw new Error(`titan-harness: missing prompt file prompts/${file}: ${String(error)}`);
	}
	cache.set(file, text);
	return text;
}

/** Replace `{{KEY}}` placeholders; unknown keys are left as-is. */
export function render(template: string, values: Record<string, string | undefined>): string {
	return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) => (values[key] !== undefined ? String(values[key]) : whole));
}

/** Keep the last `max` characters (the newest activity matters most) with an explicit marker. */
export function boundText(text: string, max: number = LIMITS.maxReviewInputChars): string {
	if (text.length <= max) return text;
	return `[… ${text.length - max} earlier characters elided …]\n${text.slice(-max)}`;
}

export function compactionPrompt(values: { STATE_BLOCK: string; ENTRIES: string; REASON: string }): string {
	return render(loadPrompt(USER_PROMPT_WATCHDOG_COMPACTION), { ...values, ENTRIES: boundText(values.ENTRIES) });
}

export function resumePrompt(values: { STATE_BLOCK: string; DIFF: string; FINDINGS: string; CARRY: string }): string {
	return render(loadPrompt(USER_PROMPT_RESUME), { ...values, DIFF: boundText(values.DIFF, Math.floor(LIMITS.maxReviewInputChars / 2)) });
}

export function inspectionPrompt(values: { STATE_BLOCK: string; TRANSCRIPT_TAIL: string; AGENT: string }): string {
	return [
		`Agent under inspection: ${values.AGENT}`,
		"",
		values.STATE_BLOCK,
		"",
		"## transcript tail (newest last)",
		boundText(values.TRANSCRIPT_TAIL),
		"",
		"Compare the transcript tail with the state block. Answer with ONE JSON object and nothing else:",
		'{"verdict": "clean" | "loss" | "hallucination", "reasons": ["…"], "carry": "what the next session must know, in ≤ 120 words"}',
		"clean = the transcript is consistent with the state block and no claimed result lacks evidence;",
		"loss = work or decisions in the block are missing from the transcript (or the reverse);",
		"hallucination = the transcript asserts results, files or test outcomes the block and the evidence ids do not support.",
	].join("\n");
}
