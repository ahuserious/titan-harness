/**
 * json-schema.ts — the minimal JSON Schema validator behind `output_format` and typed inputs:
 * enough of draft-7 for structured node output and workflow inputs, with no dependency.
 *
 *   validateJson(value, schema)   → [] when the value conforms, else one {path, message} per
 *                                   violation (`$`, `$.items[2].name`). Supported keywords:
 *                                   type (a name or a list; "integer" is a whole number, "number"
 *                                   any finite number), properties, required, items, enum,
 *                                   additionalProperties (false | schema), minimum/maximum,
 *                                   minLength/maxLength, $ref (titan://schemas/… only)
 *   validateSchema(schema)       → definition errors in supported keywords, including nested refs
 *   validateInput(value, spec)   → value errors for an input's type shorthand and schema
 *   resolveRef(ref)               → the built-in schema a `titan://schemas/<name>` ref names
 *   AUDIT_VERDICT_SCHEMA          the auditor's verdict block (prompts/SYSTEM_PROMPT_AUDITOR.md),
 *                                   reachable as `output_format: { $ref: "titan://schemas/audit-verdict" }`
 *
 * Unknown keywords are ignored, as JSON Schema itself ignores them. Pure: no pi, no filesystem.
 */
import { JSON_SCHEMA_TYPES, type InputSpec, type JsonSchema } from "./schema.ts";

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
	if (expected === "number" || expected === "integer") {
		return typeof value === "number" && Number.isFinite(value) && (expected === "number" || Number.isInteger(value));
	}
	if (expected === actual) return true;
	return false;
}

function describe(value: unknown): string {
	const text = JSON.stringify(value);
	if (text === undefined) return String(value);
	return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

const MAX_REF_DEPTH = 32;

/** Validate the supported schema vocabulary before checking defaults or caller values. */
export function validateSchema(schema: unknown, path = "$", ancestors = new Set<object>()): SchemaError[] {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [{ path, message: "schema must be a mapping" }];
	if (ancestors.has(schema)) return [{ path, message: "schema must not contain a cycle" }];
	const next = new Set(ancestors).add(schema);
	const record = schema as Record<string, unknown>;
	const errors: SchemaError[] = [];
	const error = (key: string, message: string) => errors.push({ path: `${path}.${key}`, message });
	if (record.type !== undefined) {
		const types = Array.isArray(record.type) ? record.type : [record.type];
		if (!types.length || types.some((type) => !JSON_SCHEMA_TYPES.some((name) => name === type))) error("type", `expected a JSON Schema type name or non-empty list (${JSON_SCHEMA_TYPES.join(", ")}); found ${JSON.stringify(record.type)}`);
	}
	if (record.$ref !== undefined && !resolveRef(record.$ref as string)) error("$ref", `unresolvable $ref ${JSON.stringify(record.$ref)}`);
	if (record.enum !== undefined && !Array.isArray(record.enum)) error("enum", "must be a list");
	if (record.required !== undefined && (!Array.isArray(record.required) || record.required.some((key) => typeof key !== "string"))) error("required", "must be a list of property names");
	for (const key of ["minimum", "maximum", "minLength", "maxLength"]) {
		const value = record[key];
		if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || (key.endsWith("Length") && (!Number.isInteger(value) || value < 0)))) error(key, "must be a finite number (a non-negative integer for lengths)");
	}
	if (record.properties !== undefined) {
		if (!record.properties || typeof record.properties !== "object" || Array.isArray(record.properties)) error("properties", "must be a mapping");
		else for (const [key, sub] of Object.entries(record.properties)) errors.push(...validateSchema(sub, `${path}.properties.${key}`, next));
	}
	if (record.items !== undefined) errors.push(...validateSchema(record.items, `${path}.items`, next));
	if (record.additionalProperties !== undefined && typeof record.additionalProperties !== "boolean") errors.push(...validateSchema(record.additionalProperties, `${path}.additionalProperties`, next));
	return errors;
}

/** Both declarations constrain the value; keep shorthand effective even for draft-7 $ref schemas. */
export function validateInput(value: unknown, spec: InputSpec): SchemaError[] {
	const errors = spec.type === undefined ? [] : validateJson(value, { type: spec.type });
	if (spec.schema !== undefined) {
		for (const error of validateJson(value, spec.schema)) {
			if (!errors.some((existing) => existing.path === error.path && existing.message === error.message)) errors.push(error);
		}
	}
	return errors;
}

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
