/**
 * structured-output.ts — structured output v1 (plan D12): the JSON Schema is appended
 * to the prompt, the answer is parsed tolerantly, validated with json-schema.ts and,
 * when invalid, re-asked at most MAX_SCHEMA_RETRIES times with the errors appended
 * (nodes/ai.ts runs that loop). v2 (a child-side terminating `submit_result` tool) is
 * P7 and keeps this module as its fallback.
 *
 *   schemaPromptSuffix(schema)   the text appended to an AI prompt ($ref schemas are shown resolved)
 *   parseStructured(text, schema) strip prose and fences, take the LAST balanced {…} block
 *                                that parses, validate → {ok, value} | {ok: false, errors, raw}
 *   extractJsonObject(text)      the tolerant extraction on its own
 *   formatSchemaErrors(errors)   "path: message; path: message" for re-ask prompts and node errors
 *
 * Pure: no filesystem, no pi.
 */
import type { JsonSchema } from "./schema.ts";
import { type SchemaError, resolveRef, validateJson } from "./json-schema.ts";

/** How many times an invalid answer is re-asked before the node fails (Archon's Pi behaviour). */
export const MAX_SCHEMA_RETRIES = 3;

/** The schema as the model should see it: a `$ref` is shown resolved when the registry knows it. */
export function displaySchema(schema: JsonSchema): JsonSchema {
	if (schema.$ref) return resolveRef(schema.$ref) ?? schema;
	return schema;
}

/** Appended to every prompt that declares `output_format`. */
export function schemaPromptSuffix(schema: JsonSchema): string {
	return `\n\nRespond with ONLY one JSON object matching this schema (no fences, no prose before or after it):\n${JSON.stringify(displaySchema(schema), null, 2)}`;
}

/** Index of the `}` that closes the `{` at `start` (JSON-string aware), or -1 when unbalanced. */
function matchBrace(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * The last top-level `{…}` block that parses to a JSON object. Fences and prose are
 * ignored because only balanced brace ranges are tried; an outer object wins over the
 * objects nested inside it because the scan jumps past a block that parsed.
 */
export function extractJsonObject(text: string): { value: Record<string, unknown>; raw: string } | undefined {
	let found: { value: Record<string, unknown>; raw: string } | undefined;
	let i = 0;
	while (i < text.length) {
		if (text[i] !== "{") {
			i++;
			continue;
		}
		const end = matchBrace(text, i);
		if (end < 0) {
			i++;
			continue;
		}
		const raw = text.slice(i, end + 1);
		try {
			const value = JSON.parse(raw) as unknown;
			if (value && typeof value === "object" && !Array.isArray(value)) {
				found = { value: value as Record<string, unknown>, raw };
				i = end + 1;
				continue;
			}
		} catch {
			/* not JSON at this brace — an inner block may still be */
		}
		i++;
	}
	return found;
}

/** "issue_type: must be one of bug, feature; (root): missing required property x". */
export function formatSchemaErrors(errors: SchemaError[]): string {
	return errors.map((e) => `${e.path || "(root)"}: ${e.message}`).join("; ");
}

/** Parse + validate one model answer against `schema` (see the header). */
export function parseStructured(text: string, schema: JsonSchema): { ok: true; value: unknown } | { ok: false; errors: SchemaError[]; raw: string } {
	const extracted = extractJsonObject(text);
	if (!extracted) return { ok: false, errors: [{ path: "", message: "no JSON object found in the answer" }], raw: text };
	const errors = validateJson(extracted.value, schema);
	if (errors.length) return { ok: false, errors, raw: extracted.raw };
	return { ok: true, value: extracted.value };
}
