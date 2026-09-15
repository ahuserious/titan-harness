/**
 * infranodus.ts — the InfraNodus reasoning-ontology stage (plan D14, A13, §5.7):
 * tool-call orchestration only, no graph structures, scoring or store of its own.
 *
 *   ontologyStage(bridge, text)   generate_ontology_graph → generate_contextual_hint →
 *                                 optimize_reasoning over the same text; the result carries
 *                                 `confidence: "observed"` when the ontology call succeeded
 *                                 and `"declared"` (with the reason) when the server is
 *                                 disabled, unkeyed or failing — it never throws, so a
 *                                 /terraform run degrades to a declared ontology banner.
 *   rememberRelations(bridge, …)  memory_add_relations for cross-run memory
 *                                 ("[[from]] relation [[to]]" statements, graph name
 *                                 normalized to InfraNodus's 28-char lowercase-dash rule).
 *
 * Every InfraNodus tool requires a `context` string of 15–25 third-person words;
 * contextSentence() builds one deterministically. The bridge is anything with
 * `mcpTool(server, tool, args)` — createMcpToolBridge() from mcp-client.ts in production,
 * a recorder in tests. Credentials never pass through here: the key lives in the MCP
 * server's environment (INFRANODUS_API_KEY, imported by /titan-doctor).
 */

export const INFRANODUS_SERVER = "infranodus";
export const TOOL_ONTOLOGY = "generate_ontology_graph";
export const TOOL_HINT = "generate_contextual_hint";
export const TOOL_OPTIMIZE = "optimize_reasoning";
export const TOOL_MEMORY = "memory_add_relations";
export const DECLARED_BANNER = "InfraNodus ontology unavailable — this section is declared (model-written), not graph-derived.";

export interface InfranodusBridge {
	mcpTool(server: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
}

export type StageConfidence = "observed" | "declared";

export interface StageCall {
	tool: string;
	ms: number;
	ok: boolean;
	error?: string;
}

export interface OntologyStageOptions {
	/** Save the ontology as an InfraNodus graph under this name (default: not saved). */
	graphName?: string;
	save?: boolean;
	hint?: boolean;
	optimize?: boolean;
	mode?: "general" | "codebase" | "procedural";
	chunkSize?: number;
	/** Why the stage runs, for the tools' `context` field (15–25 third-person words are derived from it). */
	purpose?: string;
	/** Server name in the catalog (default "infranodus"). */
	server?: string;
}

export interface OntologyStageResult {
	confidence: StageConfidence;
	ontology?: unknown;
	hint?: unknown;
	reasoning?: unknown;
	calls: StageCall[];
	reason?: string;
	graphName?: string;
	banner?: string;
}

export interface Relation {
	from: string;
	to: string;
	relation: string;
	note?: string;
}

export interface RememberResult {
	ok: boolean;
	graphName: string;
	statements: number;
	result?: unknown;
	reason?: string;
	call?: StageCall;
}

const FIRST_PERSON = /\b(I|I'm|I've|I'd|I'll|me|my|mine|we|we're|we've|we'd|we'll|us|our|ours|you|you're|your|yours)\b/i;
const CONTEXT_MIN = 15;
const CONTEXT_MAX = 25;
const CONTEXT_TAIL = "so the harness can ground planning, gap analysis and cross-run memory in graph structure rather than prose".split(" ");

/**
 * A `context` sentence InfraNodus accepts: 15–25 words, third person, no credentials.
 * Deterministic for a given purpose (tests pin it): first-person words are replaced,
 * short purposes are padded with a fixed tail, long ones are cut at 25 words.
 */
export function contextSentence(purpose: string): string {
	const cleaned = purpose
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.!?]+$/, "");
	let words = cleaned
		.split(" ")
		.filter(Boolean)
		.map((word) => (FIRST_PERSON.test(word) ? "the harness" : word))
		.join(" ")
		.split(" ")
		.filter(Boolean);
	if (!words.length) words = ["The", "titan", "harness", "runs", "an", "InfraNodus", "analysis", "stage"];
	if (words.length < CONTEXT_MIN) {
		for (const word of CONTEXT_TAIL) {
			if (words.length >= CONTEXT_MIN + 3) break;
			words.push(word);
		}
		while (words.length < CONTEXT_MIN) words.push("structure");
	}
	if (words.length > CONTEXT_MAX) words = words.slice(0, CONTEXT_MAX);
	const sentence = words.join(" ");
	return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/** Word count the way InfraNodus counts (whitespace-separated tokens). */
export function wordCount(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

/** InfraNodus graph names: lowercase, dashes for spaces, alphanumerics and dashes only, ≤ 28 characters. */
export function normalizeGraphName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
	const cut = slug.slice(0, 28).replace(/-+$/g, "");
	return cut || "titan-memory";
}

/** "[[from]] relation [[to]]" (+ " — note"), one statement per relation. */
export function relationsToStatements(relations: Relation[]): string[] {
	return relations
		.filter((r) => r && r.from?.trim() && r.to?.trim() && r.relation?.trim())
		.map((r) => `[[${r.from.trim()}]] ${r.relation.trim()} [[${r.to.trim()}]]${r.note?.trim() ? ` — ${r.note.trim()}` : ""}`);
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Timed, never-throwing call wrapper. */
async function timed(bridge: InfranodusBridge, server: string, tool: string, args: Record<string, unknown>): Promise<{ call: StageCall; value?: unknown }> {
	const started = Date.now();
	try {
		const value = await bridge.mcpTool(server, tool, args);
		return { call: { tool, ms: Date.now() - started, ok: true }, value };
	} catch (error) {
		return { call: { tool, ms: Date.now() - started, ok: false, error: errorText(error) } };
	}
}

/**
 * The reasoning-ontology stage. The ontology call decides the confidence; the hint and
 * optimize calls enrich it and their failures are recorded without demoting it.
 */
export async function ontologyStage(bridge: InfranodusBridge, text: string, opts: OntologyStageOptions = {}): Promise<OntologyStageResult> {
	const server = opts.server ?? INFRANODUS_SERVER;
	const context = contextSentence(opts.purpose ?? "The titan harness builds a reasoning ontology of the project documents to seed planning and gap analysis");
	const calls: StageCall[] = [];
	if (!text || !text.trim()) {
		return { confidence: "declared", calls, reason: "no text to analyse", banner: DECLARED_BANNER };
	}
	const graphName = opts.graphName ? normalizeGraphName(opts.graphName) : undefined;
	const ontologyArgs: Record<string, unknown> = { text, context, saveGraph: opts.save === true, includeAnalytics: true, includeStatements: true, includeGraph: false };
	if (opts.save && graphName) ontologyArgs.graphName = graphName;
	if (opts.mode) ontologyArgs.ontologyMode = opts.mode;
	if (opts.chunkSize) ontologyArgs.chunkSize = opts.chunkSize;
	const ontology = await timed(bridge, server, TOOL_ONTOLOGY, ontologyArgs);
	calls.push(ontology.call);
	if (!ontology.call.ok) {
		return { confidence: "declared", calls, reason: ontology.call.error, banner: DECLARED_BANNER, graphName };
	}
	const result: OntologyStageResult = { confidence: "observed", ontology: ontology.value, calls, graphName };
	if (opts.hint !== false) {
		const hint = await timed(bridge, server, TOOL_HINT, { text, context });
		calls.push(hint.call);
		if (hint.call.ok) result.hint = hint.value;
	}
	if (opts.optimize !== false) {
		const reasoning = await timed(bridge, server, TOOL_OPTIMIZE, { text, context });
		calls.push(reasoning.call);
		if (reasoning.call.ok) result.reasoning = reasoning.value;
	}
	return result;
}

/** Push relations into InfraNodus memory (memory_add_relations). Never throws. */
export async function rememberRelations(bridge: InfranodusBridge, relations: Relation[], graphName: string, opts: { purpose?: string; server?: string } = {}): Promise<RememberResult> {
	const server = opts.server ?? INFRANODUS_SERVER;
	const name = normalizeGraphName(graphName);
	const statements = relationsToStatements(relations);
	if (!statements.length) return { ok: false, graphName: name, statements: 0, reason: "no relations" };
	const context = contextSentence(opts.purpose ?? "The titan harness records relations learned during a run so later runs can recall them from graph memory");
	const outcome = await timed(bridge, server, TOOL_MEMORY, { graphName: name, statements, context, modifyAnalyzedText: "none", includeStatements: false, includeGraph: false });
	if (!outcome.call.ok) return { ok: false, graphName: name, statements: statements.length, reason: outcome.call.error, call: outcome.call };
	return { ok: true, graphName: name, statements: statements.length, result: outcome.value, call: outcome.call };
}

/** One-line summary for panels and terraform banners. */
export function describeStage(result: OntologyStageResult): string {
	const parts = [`confidence ${result.confidence}`, `${result.calls.filter((c) => c.ok).length}/${result.calls.length} calls ok`];
	if (result.graphName) parts.push(`graph ${result.graphName}`);
	if (result.reason) parts.push(`reason: ${result.reason}`);
	return parts.join(" · ");
}
