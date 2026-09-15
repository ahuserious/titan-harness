/**
 * scheduler.ts — layered DAG scheduling for workflow docs (plan D1, §3.3 trigger rules,
 * Archon `when` grammar).
 *
 *   layers(doc)        Kahn layering: layer 0 = nodes with no depends_on, layer n = nodes
 *                      whose every dependency sits in an earlier layer; document order is
 *                      kept inside a layer. Throws on a cycle or an unresolvable dependency.
 *   readiness(node, statuses)
 *                      the node's trigger_rule against its dependencies' statuses:
 *                        all_success                  every dep success; any failed/skipped/cancelled → skip
 *                        one_success                  once every dep settled, ≥ 1 success → run, else skip
 *                        none_failed_min_one_success  any failed/cancelled → skip; once settled, ≥ 1 success → run
 *                        all_done                     every dep settled → run
 *                      "wait" while a dependency is still pending/running/waiting.
 *   evaluateWhen(expr, outputs)
 *                      `when:` expressions: comparisons (== != < > <= >=) between
 *                      `$id.output[.field…]` refs and literals ('str', "str", 12, -1.5,
 *                      true, false, null), combined with && || ! and parentheses. A bare
 *                      ref or literal is tested for truthiness. Any unresolved ref, type
 *                      clash in an ordering or parse error yields {value: false, error}
 *                      — the condition fails closed.
 *
 * Pure: no filesystem, no pi.
 */
import type { NodeDoc, TriggerRule, WorkflowDoc } from "./schema.ts";

export type NodeStatus = "pending" | "running" | "success" | "failed" | "skipped" | "cancelled" | "waiting";

/** Statuses that will never change again. */
export const SETTLED: ReadonlySet<NodeStatus> = new Set<NodeStatus>(["success", "failed", "skipped", "cancelled"]);

/** Topological layers in stable document order (see the header). */
export function layers(doc: WorkflowDoc): string[][] {
	const nodes = doc.nodes ?? [];
	const known = new Set(nodes.map((n) => n.id));
	const placed = new Set<string>();
	const result: string[][] = [];
	let remaining = nodes.slice();
	while (remaining.length) {
		const layer = remaining.filter((n) => (n.depends_on ?? []).every((dep) => placed.has(dep)));
		if (layer.length === 0) {
			const stuck = remaining.map((n) => n.id).join(", ");
			const missing = remaining.flatMap((n) => (n.depends_on ?? []).filter((dep) => !known.has(dep)));
			throw new Error(missing.length ? `unresolvable depends_on: ${[...new Set(missing)].join(", ")} (nodes ${stuck})` : `dependency cycle among nodes: ${stuck}`);
		}
		for (const n of layer) placed.add(n.id);
		result.push(layer.map((n) => n.id));
		remaining = remaining.filter((n) => !placed.has(n.id));
	}
	return result;
}

/** The node's readiness under its trigger rule (default all_success). */
export function readiness(node: NodeDoc, statuses: Record<string, NodeStatus>): "run" | "skip" | "wait" {
	const deps = node.depends_on ?? [];
	if (deps.length === 0) return "run";
	const rule: TriggerRule = node.trigger_rule ?? "all_success";
	const states = deps.map((dep) => statuses[dep] ?? "pending");
	const settled = states.every((s) => SETTLED.has(s));
	const successes = states.filter((s) => s === "success").length;
	const failures = states.filter((s) => s === "failed" || s === "cancelled").length;
	const skips = states.filter((s) => s === "skipped").length;
	switch (rule) {
		case "all_success":
			if (failures > 0 || skips > 0) return "skip";
			return settled ? "run" : "wait";
		case "one_success":
			if (!settled) return "wait";
			return successes > 0 ? "run" : "skip";
		case "none_failed_min_one_success":
			if (failures > 0) return "skip";
			if (!settled) return "wait";
			return successes > 0 ? "run" : "skip";
		case "all_done":
			return settled ? "run" : "wait";
		default:
			return "skip";
	}
}

// ═══ when: expressions ═══════════════════════════════════════════════════════

type Token =
	| { kind: "op"; value: string }
	| { kind: "ref"; value: string }
	| { kind: "string"; value: string }
	| { kind: "number"; value: number }
	| { kind: "ident"; value: string };

class WhenError extends Error {}

function tokenize(expr: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < expr.length) {
		const ch = expr[i];
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		const two = expr.slice(i, i + 2);
		if (two === "==" || two === "!=" || two === "<=" || two === ">=" || two === "&&" || two === "||") {
			tokens.push({ kind: "op", value: two });
			i += 2;
			continue;
		}
		if ("()<>!".includes(ch)) {
			tokens.push({ kind: "op", value: ch });
			i++;
			continue;
		}
		if (ch === "$") {
			const m = /^\$[A-Za-z0-9_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*/.exec(expr.slice(i));
			if (!m) throw new WhenError(`bad reference at ${i}`);
			tokens.push({ kind: "ref", value: m[0] });
			i += m[0].length;
			continue;
		}
		if (ch === "'" || ch === '"') {
			let j = i + 1;
			let out = "";
			while (j < expr.length && expr[j] !== ch) {
				if (expr[j] === "\\" && j + 1 < expr.length) {
					j++;
				}
				out += expr[j];
				j++;
			}
			if (j >= expr.length) throw new WhenError(`unterminated string starting at ${i}`);
			tokens.push({ kind: "string", value: out });
			i = j + 1;
			continue;
		}
		const num = /^-?\d+(?:\.\d+)?/.exec(expr.slice(i));
		if (num) {
			tokens.push({ kind: "number", value: Number(num[0]) });
			i += num[0].length;
			continue;
		}
		const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(expr.slice(i));
		if (ident) {
			if (!["true", "false", "null"].includes(ident[0])) throw new WhenError(`unknown identifier "${ident[0]}" (references start with $)`);
			tokens.push({ kind: "ident", value: ident[0] });
			i += ident[0].length;
			continue;
		}
		throw new WhenError(`unexpected "${ch}" at ${i}`);
	}
	return tokens;
}

/** Resolve `$id.output[.field…]` against settled outputs; throws WhenError when anything is missing. */
function resolveRef(ref: string, outputs: Record<string, unknown>): unknown {
	const parts = ref.slice(1).split(".");
	const [id, output, ...fields] = parts;
	if (output !== "output") throw new WhenError(`unresolved reference ${ref} (expected $${id}.output…)`);
	if (!Object.prototype.hasOwnProperty.call(outputs, id) || outputs[id] === undefined) throw new WhenError(`unresolved reference ${ref}: node "${id}" has no output`);
	let current: unknown = outputs[id];
	for (const field of fields) {
		if (current === null || typeof current !== "object") throw new WhenError(`unresolved reference ${ref}: "${field}" on a ${current === null ? "null" : typeof current}`);
		if (Array.isArray(current)) {
			const index = /^\d+$/.test(field) ? Number(field) : -1;
			if (index < 0 || index >= current.length) throw new WhenError(`unresolved reference ${ref}: index ${field}`);
			current = current[index];
			continue;
		}
		const obj = current as Record<string, unknown>;
		if (!Object.prototype.hasOwnProperty.call(obj, field) || obj[field] === undefined) throw new WhenError(`unresolved reference ${ref}: missing field "${field}"`);
		current = obj[field];
	}
	return current;
}

function isPrimitive(v: unknown): boolean {
	return v === null || typeof v !== "object";
}

function equal(a: unknown, b: unknown): boolean {
	if (isPrimitive(a) && isPrimitive(b)) return a === b;
	return JSON.stringify(a) === JSON.stringify(b);
}

/** A finite number for numbers and numeric strings; undefined otherwise. */
function numeric(v: unknown): number | undefined {
	if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
	if (typeof v === "string" && v.trim() !== "") {
		const n = Number(v);
		return Number.isNaN(n) ? undefined : n;
	}
	return undefined;
}

/** < > <= >=: numeric when both sides are numbers or numeric strings, lexicographic for two strings, an error otherwise. */
function order(a: unknown, b: unknown, op: string): boolean {
	const x = numeric(a);
	const y = numeric(b);
	let left: number | string;
	let right: number | string;
	if (x !== undefined && y !== undefined) {
		left = x;
		right = y;
	} else if (typeof a === "string" && typeof b === "string") {
		left = a;
		right = b;
	} else {
		throw new WhenError(`cannot order ${JSON.stringify(a)} ${op} ${JSON.stringify(b)}`);
	}
	switch (op) {
		case "<":
			return left < right;
		case ">":
			return left > right;
		case "<=":
			return left <= right;
		default:
			return left >= right;
	}
}

class Parser {
	private pos = 0;
	constructor(
		private readonly tokens: Token[],
		private readonly outputs: Record<string, unknown>,
	) {}

	parse(): unknown {
		const value = this.or();
		if (this.pos < this.tokens.length) throw new WhenError(`unexpected token "${String(this.tokens[this.pos].value)}"`);
		return value;
	}

	private peekOp(...ops: string[]): string | undefined {
		const t = this.tokens[this.pos];
		return t && t.kind === "op" && ops.includes(t.value) ? t.value : undefined;
	}

	private or(): unknown {
		let left = this.and();
		while (this.peekOp("||")) {
			this.pos++;
			const right = this.and();
			left = Boolean(left) || Boolean(right);
		}
		return left;
	}

	private and(): unknown {
		let left = this.comparison();
		while (this.peekOp("&&")) {
			this.pos++;
			const right = this.comparison();
			left = Boolean(left) && Boolean(right);
		}
		return left;
	}

	private comparison(): unknown {
		const left = this.unary();
		const op = this.peekOp("==", "!=", "<", ">", "<=", ">=");
		if (!op) return left;
		this.pos++;
		const right = this.unary();
		if (op === "==") return equal(left, right);
		if (op === "!=") return !equal(left, right);
		return order(left, right, op);
	}

	private unary(): unknown {
		if (this.peekOp("!")) {
			this.pos++;
			return !this.unary();
		}
		return this.primary();
	}

	private primary(): unknown {
		const t = this.tokens[this.pos];
		if (!t) throw new WhenError("unexpected end of expression");
		if (t.kind === "op" && t.value === "(") {
			this.pos++;
			const inner = this.or();
			if (!this.peekOp(")")) throw new WhenError("missing )");
			this.pos++;
			return inner;
		}
		this.pos++;
		switch (t.kind) {
			case "ref":
				return resolveRef(t.value, this.outputs);
			case "string":
				return t.value;
			case "number":
				return t.value;
			case "ident":
				return t.value === "true" ? true : t.value === "false" ? false : null;
			default:
				throw new WhenError(`unexpected "${t.value}"`);
		}
	}
}

/** Evaluate a `when:` expression against settled outputs; fails closed (see the header). */
export function evaluateWhen(expr: string, outputs: Record<string, unknown>): { value: boolean; error?: string } {
	try {
		const tokens = tokenize(expr);
		if (tokens.length === 0) return { value: false, error: "empty expression" };
		const value = new Parser(tokens, outputs).parse();
		return { value: Boolean(value) };
	} catch (error) {
		return { value: false, error: error instanceof Error ? error.message : String(error) };
	}
}
