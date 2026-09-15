/**
 * json-schema.ts — the minimal JSON Schema validator behind `output_format` (plan A2, D12):
 * enough of draft-7 for structured node output, with no dependency.
 *
 *   validateJson(value, schema)   → [] when the value conforms, else one {path, message} per
 *                                   violation (`$`, `$.items[2].name`). Supported keywords:
 *                                   type (a name or a list; "integer" is a whole number, "number"
 *                                   any finite number), properties, required, items, enum,
 *                                   additionalProperties (false | schema), minimum/maximum,
 *                                   minLength/maxLength, $ref (titan://schemas/… only)
 *   resolveRef(ref)               → the built-in schema a `titan://schemas/<name>` ref names
 *   AUDIT_VERDICT_SCHEMA          the auditor's verdict block (prompts/SYSTEM_PROMPT_AUDITOR.md),
 *                                   reachable as `output_format: { $ref: "titan://schemas/audit-verdict" }`
 *
 * Unknown keywords are ignored, as JSON Schema itself ignores them. Pure: no pi, no filesystem.
 */
import type { JsonSchema } from "./schema.ts";

export interface SchemaError {
	path: string;
	message: string;
}

export const AUDIT_VERDICTS = ["PASS", "PASS_WITH_WARNINGS", "FAIL", "INCONCLUSIVE", "SAFETY", "SCOPE_VIOLATION"] as const;
export type AuditVerdict = (typeof AUDIT_VERDICTS)[number];
export const EVIDENCE_STATES = ["checked", "attested", "missing"] as const;

/**
 * One auditor verdict block. `verdict` is the field the auditor prompt emits; `status` is
 * accepted as an alias (the plan's §3.5 example routes on `$audit.output.status`), so a
 * `when:` may read either — a re-ask is never triggered by the spelling alone.
 */
export const AUDIT_VERDICT_SCHEMA: JsonSchema = {
	type: "object",
	description: "Auditor verdict block (prompts/SYSTEM_PROMPT_AUDITOR.md)",
	properties: {
		verdict: { type: "string", enum: [...AUDIT_VERDICTS] },
		status: { type: "string", enum: [...AUDIT_VERDICTS], description: "alias of verdict" },
		round: { type: "integer", minimum: 1 },
		summary: { type: "string" },
		checklist: { type: "object", description: "criterion → PASS | FAIL" },
		evidence_state: { type: "string", enum: [...EVIDENCE_STATES] },
		blocking: { type: "array", items: { type: ["object", "string"] } },
		warnings: { type: "array", items: { type: ["object", "string"] } },
	},
	required: ["verdict", "summary"],
};

export const SCHEMA_REF_PREFIX = "titan://schemas/";
const BUILTIN_SCHEMAS: Record<string, JsonSchema> = {
	"audit-verdict": AUDIT_VERDICT_SCHEMA,
};

/** The built-in schema a `titan://schemas/<name>` reference names; undefined for anything else. */
export function resolveRef(ref: string): JsonSchema | undefined {
	if (typeof ref !== "string" || !ref.startsWith(SCHEMA_REF_PREFIX)) return undefined;
	return BUILTIN_SCHEMAS[ref.slice(SCHEMA_REF_PREFIX.length)];
}

/** The JSON type name of a value, "integer" for whole numbers (which also satisfy "number"). */
export function jsonTypeOf(value: unknown): "null" | "array" | "object" | "string" | "integer" | "number" | "boolean" | "undefined" {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
	if (typeof value === "object") return "object";
	if (typeof value === "string" || typeof value === "boolean") return typeof value as "string" | "boolean";
	return "undefined";
}

function typeMatches(expected: string, actual: ReturnType<typeof jsonTypeOf>, value: unknown): boolean {
	if (expected === actual) return true;
	if (expected === "number") return actual === "integer" || (actual === "number" && Number.isFinite(value as number));
	return false;
}

function describe(value: unknown): string {
	const text = JSON.stringify(value);
	if (text === undefined) return String(value);
	return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

const MAX_REF_DEPTH = 32;

/** Every way `value` breaks `schema`; [] means it conforms. `path` names the value being checked (`$` = the root). */
export function validateJson(value: unknown, schema: JsonSchema, path = "$"): SchemaError[] {
	return check(value, schema, path, 0);
}

function check(value: unknown, schema: JsonSchema, path: string, depth: number): SchemaError[] {
	if (!schema || typeof schema !== "object") return [];
	if (schema.$ref !== undefined) {
		if (depth > MAX_REF_DEPTH) return [{ path, message: `$ref nesting deeper than ${MAX_REF_DEPTH}` }];
		const target = resolveRef(schema.$ref);
		if (!target) return [{ path, message: `unresolvable $ref ${JSON.stringify(schema.$ref)} (only ${SCHEMA_REF_PREFIX}<name> is supported)` }];
		return check(value, target, path, depth + 1);
	}
	const errors: SchemaError[] = [];
	const actual = jsonTypeOf(value);
	if (schema.type !== undefined) {
		const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
		if (!allowed.some((expected) => typeMatches(expected, actual, value))) {
			errors.push({ path, message: `expected ${allowed.join(" | ")}, found ${actual === "undefined" ? "undefined" : actual} (${describe(value)})` });
			return errors; // the keyword checks below assume the type matched
		}
	}
	if (schema.enum !== undefined) {
		if (!schema.enum.some((candidate) => sameJson(candidate, value))) {
			errors.push({ path, message: `expected one of ${schema.enum.map((c) => JSON.stringify(c)).join(", ")}, found ${describe(value)}` });
		}
	}
	if (typeof value === "number") {
		if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, message: `${value} is below the minimum ${schema.minimum}` });
		if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, message: `${value} is above the maximum ${schema.maximum}` });
	}
	if (typeof value === "string") {
		if (schema.minLength !== undefined && value.length < schema.minLength) errors.push({ path, message: `shorter than minLength ${schema.minLength}` });
		if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push({ path, message: `longer than maxLength ${schema.maxLength}` });
	}
	if (Array.isArray(value)) {
		if (schema.items) value.forEach((item, index) => errors.push(...check(item, schema.items!, `${path}[${index}]`, depth)));
	} else if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		for (const key of schema.required ?? []) {
			if (record[key] === undefined) errors.push({ path: `${path}.${key}`, message: "required property is missing" });
		}
		const properties = schema.properties ?? {};
		for (const [key, sub] of Object.entries(properties)) {
			if (record[key] !== undefined) errors.push(...check(record[key], sub, `${path}.${key}`, depth));
		}
		if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
			for (const key of Object.keys(record)) {
				if (key in properties) continue;
				if (schema.additionalProperties === false) errors.push({ path: `${path}.${key}`, message: "unexpected property" });
				else errors.push(...check(record[key], schema.additionalProperties, `${path}.${key}`, depth));
			}
		}
	}
	return errors;
}

/** Structural equality for enum membership (order-sensitive for arrays, key-insensitive for objects). */
function sameJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((item, index) => sameJson(item, (b as unknown[])[index]));
	const ka = Object.keys(a as object).sort();
	const kb = Object.keys(b as object).sort();
	return ka.length === kb.length && ka.every((key, index) => key === kb[index] && sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
