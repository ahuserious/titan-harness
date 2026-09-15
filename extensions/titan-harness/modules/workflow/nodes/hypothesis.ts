/**
 * nodes/hypothesis.ts — `hypothesis: {hypotheses[], decide_by}` nodes (plan A11, P4).
 *
 * Decisions come from evidence LINKS, never from prose. Links are read from every
 * dependency output that carries `links: [{hypothesis, relation, evidence, weight?}]`
 * (relation supports | challenges | inconclusive | context) plus an optional static
 * `links` list on the spec itself; each link is appended to <runDir>/hypotheses.jsonl
 * (chained) together with the final decision row. Links naming an undeclared hypothesis
 * are ignored with a warning.
 *
 * `decide_by` grammar (own tiny parser, fail closed):
 *   most_supported                       the hypothesis with the highest supports weight
 *                                        (ties → no decision)
 *   supports(h1) > challenges(h1)        comparisons between calls / numbers, with
 *   supports(h1) >= 2 && challenges(h1) == 0      == != < <= > >=, && ||, parentheses
 * Functions: supports(id), challenges(id), inconclusive(id), context(id), weight(id)
 * (weighted sums, link weight default 1; weight = supports − challenges) and
 * count_supports(id) … count_context(id) for raw counts. A rule that mentions `$h` is
 * evaluated with `$h` bound to each hypothesis in declaration order and decides for the
 * first one it holds for; a rule naming ids explicitly is evaluated once and, when true,
 * decides for the first declared hypothesis it names. Output:
 *   { decision: id | null, tallies: {id: {supports, challenges, inconclusive, context,
 *     weight, counts}}, links: n, rule, reason }
 * No links → failed "no evidence links" (never retried); no hypothesis satisfies the rule
 * → failed "undecided". Success requires a decision.
 */
import type { HypothesisRelation, HypothesisRow } from "../../run-store.ts";
import type { NodeHandler, NodeOutcome } from "../executor.ts";
import type { HypothesisSpec } from "../schema.ts";

export const RELATIONS: HypothesisRelation[] = ["supports", "challenges", "inconclusive", "context"];

export interface EvidenceLink {
	hypothesis: string;
	relation: HypothesisRelation;
	evidence: string;
	weight: number;
	source: string;
}

export interface Tally {
	supports: number;
	challenges: number;
	inconclusive: number;
	context: number;
	/** supports − challenges (weighted). */
	weight: number;
	counts: Record<HypothesisRelation, number>;
}

const isRelation = (value: unknown): value is HypothesisRelation => typeof value === "string" && (RELATIONS as string[]).includes(value);

/** Every well-formed link inside `value` (an object with `links[]`, or a bare array of links). */
export function extractLinks(value: unknown, source: string): EvidenceLink[] {
	const raw = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { links?: unknown }).links) ? ((value as { links: unknown[] }).links as unknown[]) : [];
	const links: EvidenceLink[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const link = item as Record<string, unknown>;
		const hypothesis = typeof link.hypothesis === "string" ? link.hypothesis.trim() : typeof link.id === "string" ? link.id.trim() : "";
		if (!hypothesis || !isRelation(link.relation)) continue;
		const weight = typeof link.weight === "number" && Number.isFinite(link.weight) && link.weight >= 0 ? link.weight : 1;
		links.push({ hypothesis, relation: link.relation, evidence: typeof link.evidence === "string" ? link.evidence : JSON.stringify(link.evidence ?? ""), weight, source });
	}
	return links;
}

/** Weighted tallies per declared hypothesis. */
export function tallyLinks(ids: string[], links: EvidenceLink[]): Record<string, Tally> {
	const tallies: Record<string, Tally> = {};
	for (const id of ids) tallies[id] = { supports: 0, challenges: 0, inconclusive: 0, context: 0, weight: 0, counts: { supports: 0, challenges: 0, inconclusive: 0, context: 0 } };
	for (const link of links) {
		const tally = tallies[link.hypothesis];
		if (!tally) continue;
		tally[link.relation] += link.weight;
		tally.counts[link.relation] += 1;
	}
	for (const tally of Object.values(tallies)) tally.weight = tally.supports - tally.challenges;
	return tallies;
}

// ── decide_by parser ────────────────────────────────────────────────────────

type Token = { kind: "num"; value: number } | { kind: "call"; fn: string; arg: string } | { kind: "op"; value: string } | { kind: "lp" } | { kind: "rp" };

function tokenize(rule: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < rule.length) {
		const ch = rule[i];
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		if (ch === "(") {
			tokens.push({ kind: "lp" });
			i++;
			continue;
		}
		if (ch === ")") {
			tokens.push({ kind: "rp" });
			i++;
			continue;
		}
		const op = rule.slice(i).match(/^(>=|<=|==|!=|&&|\|\||>|<)/);
		if (op) {
			tokens.push({ kind: "op", value: op[1] });
			i += op[1].length;
			continue;
		}
		const num = rule.slice(i).match(/^-?\d+(\.\d+)?/);
		if (num) {
			tokens.push({ kind: "num", value: Number(num[0]) });
			i += num[0].length;
			continue;
		}
		const call = rule.slice(i).match(/^([a-z_]+)\(\s*(\$h|[A-Za-z0-9_\-.]+)\s*\)/);
		if (call) {
			tokens.push({ kind: "call", fn: call[1], arg: call[2] });
			i += call[0].length;
			continue;
		}
		throw new Error(`decide_by: unexpected "${rule.slice(i, i + 12)}" at ${i}`);
	}
	return tokens;
}

type Ast = { t: "num"; value: number } | { t: "call"; fn: string; arg: string } | { t: "cmp"; op: string; left: Ast; right: Ast } | { t: "and"; left: Ast; right: Ast } | { t: "or"; left: Ast; right: Ast };

function parse(tokens: Token[]): Ast {
	let pos = 0;
	const peek = () => tokens[pos];
	const take = () => tokens[pos++];
	const primary = (): Ast => {
		const token = take();
		if (!token) throw new Error("decide_by: unexpected end of rule");
		if (token.kind === "num") return { t: "num", value: token.value };
		if (token.kind === "call") return { t: "call", fn: token.fn, arg: token.arg };
		if (token.kind === "lp") {
			const inner = orExpr();
			const close = take();
			if (!close || close.kind !== "rp") throw new Error("decide_by: missing )");
			return inner;
		}
		throw new Error("decide_by: expected a number, a call or (");
	};
	const comparison = (): Ast => {
		const left = primary();
		const token = peek();
		if (token && token.kind === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(token.value)) {
			take();
			const right = primary();
			return { t: "cmp", op: token.value, left, right };
		}
		return left;
	};
	const andExpr = (): Ast => {
		let left = comparison();
		while (peek()?.kind === "op" && (peek() as { value: string }).value === "&&") {
			take();
			left = { t: "and", left, right: comparison() };
		}
		return left;
	};
	const orExpr = (): Ast => {
		let left = andExpr();
		while (peek()?.kind === "op" && (peek() as { value: string }).value === "||") {
			take();
			left = { t: "or", left, right: andExpr() };
		}
		return left;
	};
	const ast = orExpr();
	if (pos !== tokens.length) throw new Error("decide_by: trailing tokens");
	return ast;
}

const FUNCTIONS = new Set(["supports", "challenges", "inconclusive", "context", "weight", "count_supports", "count_challenges", "count_inconclusive", "count_context"]);

function evaluate(ast: Ast, tallies: Record<string, Tally>, bound: string | undefined): number | boolean {
	switch (ast.t) {
		case "num":
			return ast.value;
		case "call": {
			if (!FUNCTIONS.has(ast.fn)) throw new Error(`decide_by: unknown function ${ast.fn}`);
			const id = ast.arg === "$h" ? bound : ast.arg;
			if (!id) throw new Error("decide_by: $h used without a bound hypothesis");
			const tally = tallies[id];
			if (!tally) throw new Error(`decide_by: unknown hypothesis ${id}`);
			if (ast.fn === "weight") return tally.weight;
			if (ast.fn.startsWith("count_")) return tally.counts[ast.fn.slice(6) as HypothesisRelation];
			return tally[ast.fn as HypothesisRelation];
		}
		case "cmp": {
			const left = evaluate(ast.left, tallies, bound);
			const right = evaluate(ast.right, tallies, bound);
			if (typeof left !== "number" || typeof right !== "number") throw new Error("decide_by: comparisons need numbers");
			switch (ast.op) {
				case "==":
					return left === right;
				case "!=":
					return left !== right;
				case "<":
					return left < right;
				case "<=":
					return left <= right;
				case ">":
					return left > right;
				default:
					return left >= right;
			}
		}
		case "and":
			return Boolean(evaluate(ast.left, tallies, bound)) && Boolean(evaluate(ast.right, tallies, bound));
		case "or":
			return Boolean(evaluate(ast.left, tallies, bound)) || Boolean(evaluate(ast.right, tallies, bound));
	}
}

function namedIds(ast: Ast, acc: string[] = []): string[] {
	if (ast.t === "call") {
		if (ast.arg !== "$h" && !acc.includes(ast.arg)) acc.push(ast.arg);
	} else if (ast.t !== "num") {
		namedIds(ast.left, acc);
		namedIds(ast.right, acc);
	}
	return acc;
}

/** Resolve `decide_by` over the tallies (see the header). Throws on a malformed rule or an unknown hypothesis/function. */
export function decide(rule: string, ids: string[], tallies: Record<string, Tally>): { decision: string | null; reason: string } {
	const trimmed = rule.trim();
	if (!trimmed) throw new Error("decide_by: empty rule");
	if (trimmed === "most_supported") {
		const ranked = ids.map((id) => ({ id, supports: tallies[id]?.supports ?? 0 })).sort((a, b) => b.supports - a.supports);
		if (!ranked.length || ranked[0].supports <= 0) return { decision: null, reason: "no hypothesis has supporting evidence" };
		if (ranked.length > 1 && ranked[1].supports === ranked[0].supports) return { decision: null, reason: `tie between ${ranked.filter((r) => r.supports === ranked[0].supports).map((r) => r.id).join(", ")}` };
		return { decision: ranked[0].id, reason: `most supported (weight ${ranked[0].supports})` };
	}
	const ast = parse(tokenize(trimmed));
	if (trimmed.includes("$h")) {
		for (const id of ids) if (evaluate(ast, tallies, id) === true) return { decision: id, reason: `first hypothesis satisfying ${trimmed}` };
		return { decision: null, reason: `no hypothesis satisfies ${trimmed}` };
	}
	const named = namedIds(ast).filter((id) => ids.includes(id));
	const holds = evaluate(ast, tallies, undefined) === true;
	if (!holds) return { decision: null, reason: `${trimmed} is false` };
	if (!named.length) return { decision: null, reason: `${trimmed} names no declared hypothesis` };
	return { decision: named[0], reason: `${trimmed} holds` };
}

/** `hypothesis:` nodes. */
export const runHypothesisNode: NodeHandler = async (ctx): Promise<NodeOutcome> => {
	const spec = (ctx.node as { hypothesis: HypothesisSpec }).hypothesis;
	const ids = (spec?.hypotheses ?? []).map((h) => h.id);
	if (!ids.length || typeof spec.decide_by !== "string") {
		return { status: "failed", output: undefined, error: "hypothesis: hypotheses[] and decide_by are required", retryable: false };
	}
	const links: EvidenceLink[] = [];
	for (const dep of ctx.node.depends_on ?? []) links.push(...extractLinks(ctx.outputs[dep], dep));
	links.push(...extractLinks((spec as unknown as { links?: unknown }).links, ctx.node.id));
	const unknown = links.filter((l) => !ids.includes(l.hypothesis));
	if (unknown.length) ctx.notify(`${ctx.node.id}: ${unknown.length} link(s) name undeclared hypotheses (${[...new Set(unknown.map((l) => l.hypothesis))].join(", ")}) — ignored`, "warning");
	const known = links.filter((l) => ids.includes(l.hypothesis));
	const store = ctx.deps.store;
	for (const link of known) {
		const row: HypothesisRow = { type: "link", nodeId: ctx.node.id, hypothesis: link.hypothesis, relation: link.relation, evidence: link.evidence, weight: link.weight, source: link.source };
		store.appendHypothesisLink(ctx.deps.runDir, row);
	}
	if (!known.length) {
		return { status: "failed", output: undefined, error: "hypothesis: no evidence links — decisions come from links, not prose", retryable: false, meta: { hypotheses: ids, links: 0 } };
	}
	const tallies = tallyLinks(ids, known);
	let verdict: { decision: string | null; reason: string };
	try {
		verdict = decide(spec.decide_by, ids, tallies);
	} catch (error) {
		return { status: "failed", output: undefined, error: error instanceof Error ? error.message : String(error), retryable: false, meta: { hypotheses: ids, links: known.length } };
	}
	store.appendHypothesisLink(ctx.deps.runDir, { type: "decision", nodeId: ctx.node.id, hypothesis: verdict.decision, rule: spec.decide_by, reason: verdict.reason, tallies, links: known.length });
	ctx.log("hypothesis.decision", { decision: verdict.decision, rule: spec.decide_by, reason: verdict.reason, links: known.length });
	const output = { decision: verdict.decision, tallies, links: known.length, rule: spec.decide_by, reason: verdict.reason };
	if (!verdict.decision) {
		return { status: "failed", output, error: `hypothesis: undecided — ${verdict.reason}`, retryable: false, meta: { hypotheses: ids, links: known.length } };
	}
	const claim = spec.hypotheses.find((h) => h.id === verdict.decision)?.claim ?? "";
	return { status: "success", output, text: `${verdict.decision}: ${claim}\n${verdict.reason}\n${JSON.stringify(output, null, 2)}\n`, meta: { hypotheses: ids, links: known.length, decision: verdict.decision } };
};
