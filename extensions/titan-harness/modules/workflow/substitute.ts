/**
 * substitute.ts — the `$variable` / `$inputs.key` / `$node.output.field` substitution
 * grammar shared by every node body (plan §3.2–3.3, Archon vocabulary D13).
 *
 * Grammar (one token = `$` + a name + an optional dotted chain):
 *   $ARGUMENTS $ARTIFACTS_DIR $WORKFLOW_ID $RUN_ID $BASE_BRANCH $CONTEXT
 *   $LOOP_USER_INPUT $REJECTION_REASON $LOOP_COUNT          run-level variables
 *   $inputs.<key> / $input.<key>[.<field>…]                 workflow inputs
 *   $<nodeId>.output[.<field>[.<field>…]]                   a settled node's output
 *
 * Resolution is strict at the base (an unknown variable, input key or node output is an
 * UNKNOWN ref: the text is left untouched and reported through `onUnknown`) and strict
 * on objects (a missing key on an object is unknown too), but a chain stops at the first
 * primitive: `$inputs.name.txt` renders the input followed by the literal `.txt`, because
 * a string has no fields. Array elements are addressed by index (`$list.output.0`).
 * A variable that is known but unset (`$ARGUMENTS` with no arguments) renders as "".
 *
 * Rendering by mode:
 *   prompt  strings verbatim, objects as pretty JSON (2 spaces), scalars via String()
 *   bash    EVERY value single-quote shell-escaped (`'…'`, embedded quotes as '\''), objects compact JSON
 *   script  strings verbatim, objects compact JSON (assign directly: `const data = $node.output;`)
 *   raw     same as script
 *
 * Pure: no filesystem, no pi.
 */

export type SubstituteMode = "prompt" | "bash" | "script" | "raw";

export interface SubstitutionContext {
	inputs: Record<string, unknown>;
	outputs: Record<string, unknown>;
	artifactsDir: string;
	workflowId: string;
	runId: string;
	arguments?: string;
	baseBranch?: string;
	context?: string;
	loopUserInput?: string;
	rejectionReason?: string;
	loopCount?: number;
}

/** Variable name → the SubstitutionContext field it renders. */
export const VARIABLE_FIELDS: Record<string, keyof SubstitutionContext> = {
	ARGUMENTS: "arguments",
	ARTIFACTS_DIR: "artifactsDir",
	WORKFLOW_ID: "workflowId",
	RUN_ID: "runId",
	BASE_BRANCH: "baseBranch",
	CONTEXT: "context",
	LOOP_USER_INPUT: "loopUserInput",
	REJECTION_REASON: "rejectionReason",
	LOOP_COUNT: "loopCount",
};

/** One `$…` token: the whole match plus its name and dotted chain. */
const TOKEN = /\$([A-Za-z0-9_][A-Za-z0-9_-]*)((?:\.[A-Za-z0-9_-]+)*)/g;

/** Result of resolving one token: how many characters of the token were consumed and the value. */
export interface Resolution {
	found: boolean;
	value?: unknown;
	/** Chain segments that were not walked (a primitive was reached first) — rendered literally after the value. */
	rest: string;
}

function hasOwn(obj: unknown, key: string): obj is Record<string, unknown> {
	return obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Walk `segments` from `value`: objects and arrays descend (a missing key on an object is
 * a failure), a primitive stops the walk and returns the remaining segments as `rest`.
 */
function walk(value: unknown, segments: string[]): Resolution {
	let current = value;
	for (let i = 0; i < segments.length; i++) {
		const key = segments[i];
		if (current === null || typeof current !== "object") {
			return { found: true, value: current, rest: segments.slice(i).map((s) => `.${s}`).join("") };
		}
		if (Array.isArray(current)) {
			const index = /^\d+$/.test(key) ? Number(key) : -1;
			if (index < 0 || index >= current.length) return { found: false, rest: "" };
			current = current[index];
			continue;
		}
		if (!hasOwn(current, key) || current[key] === undefined) return { found: false, rest: "" };
		current = current[key];
	}
	return { found: true, value: current, rest: "" };
}

/**
 * Resolve one reference (`$ARGUMENTS`, `$inputs.spec`, `$classify.output.issue_type`).
 * `found: false` means the base is unknown or a key is missing on an object.
 */
export function resolveReference(ref: string, ctx: SubstitutionContext): Resolution {
	const match = /^\$([A-Za-z0-9_][A-Za-z0-9_-]*)((?:\.[A-Za-z0-9_-]+)*)$/.exec(ref.trim());
	if (!match) return { found: false, rest: "" };
	return resolveParts(match[1], match[2], ctx);
}

function resolveParts(name: string, chain: string, ctx: SubstitutionContext): Resolution {
	const segments = chain ? chain.slice(1).split(".") : [];
	const field = VARIABLE_FIELDS[name];
	if (field) {
		// variables never take a chain: `$RUN_ID.log` is the run id followed by ".log"
		const value = ctx[field];
		return { found: true, value: value === undefined ? "" : value, rest: chain };
	}
	if (name === "inputs" || name === "input") {
		if (segments.length === 0) return { found: false, rest: "" };
		const [key, ...more] = segments;
		if (!hasOwn(ctx.inputs, key) || ctx.inputs[key] === undefined) return { found: false, rest: "" };
		return walk(ctx.inputs[key], more);
	}
	if (segments[0] === "output") {
		if (!hasOwn(ctx.outputs, name) || ctx.outputs[name] === undefined) return { found: false, rest: "" };
		return walk(ctx.outputs[name], segments.slice(1));
	}
	return { found: false, rest: "" };
}

/** `'…'` with embedded single quotes closed, escaped and reopened — safe inside `bash -c`. */
export function shellQuote(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Render a resolved value for one mode (see the header table). */
export function renderValue(value: unknown, mode: SubstituteMode): string {
	let text: string;
	if (value === undefined) text = "";
	else if (typeof value === "string") text = value;
	else if (value === null || typeof value !== "object") text = String(value);
	else text = mode === "prompt" ? JSON.stringify(value, null, 2) : JSON.stringify(value);
	return mode === "bash" ? shellQuote(text) : text;
}

/**
 * Substitute every reference in `text`. Unknown refs are left byte-for-byte and reported
 * to `onUnknown` (once per occurrence, with the token text such as `$nope.output`).
 */
export function substitute(text: string, ctx: SubstitutionContext, mode: SubstituteMode, onUnknown?: (ref: string) => void): string {
	if (!text.includes("$")) return text;
	return text.replace(TOKEN, (token: string, name: string, chain: string) => {
		const resolved = resolveParts(name, chain, ctx);
		if (!resolved.found) {
			onUnknown?.(token);
			return token;
		}
		return renderValue(resolved.value, mode) + resolved.rest;
	});
}

/** Every distinct reference token in `text` (for validators and dry runs). */
export function listReferences(text: string): string[] {
	const seen = new Set<string>();
	for (const match of text.matchAll(TOKEN)) seen.add(match[0]);
	return [...seen];
}
