import { describe, expect, test } from "bun:test";
import {
	DECLARED_BANNER,
	INFRANODUS_SERVER,
	type InfranodusBridge,
	TOOL_HINT,
	TOOL_MEMORY,
	TOOL_ONTOLOGY,
	TOOL_OPTIMIZE,
	contextSentence,
	describeStage,
	normalizeGraphName,
	ontologyStage,
	relationsToStatements,
	rememberRelations,
	wordCount,
} from "../modules/infranodus.ts";

interface Recorded {
	server: string;
	tool: string;
	args: Record<string, unknown>;
}

/** A bridge that records calls and answers from a script keyed by tool name. */
function fakeBridge(script: Record<string, unknown | Error> = {}): InfranodusBridge & { calls: Recorded[] } {
	const calls: Recorded[] = [];
	return {
		calls,
		async mcpTool(server, tool, args) {
			calls.push({ server, tool, args });
			const answer = script[tool];
			if (answer instanceof Error) throw answer;
			return answer ?? { tool, ok: true };
		},
	};
}

const FIRST_PERSON = /\b(I|me|my|we|our|you|your)\b/i;

describe("contextSentence", () => {
	test.each([
		["short purpose", "Build an ontology"],
		["already long", "The titan harness terraform stage builds an ontology of the project entity documents to seed planning gap analysis and cross-run memory relations for the roadmap"],
		["first person", "I want to analyse my project so we can plan our roadmap"],
		["empty", ""],
		["very long", Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ")],
	])("%s → 15–25 third-person words", (_label, purpose) => {
		const sentence = contextSentence(purpose);
		const count = wordCount(sentence);
		expect(count).toBeGreaterThanOrEqual(15);
		expect(count).toBeLessThanOrEqual(25);
		expect(sentence).not.toMatch(FIRST_PERSON);
		expect(sentence.endsWith(".")).toBe(true);
		expect(contextSentence(purpose)).toBe(sentence); // deterministic
	});
});

describe("graph names and statements", () => {
	test("normalizeGraphName: lowercase, dashes, ≤ 28 chars, never empty", () => {
		expect(normalizeGraphName("Triarc Dev / Terraform Entity Ontology 2026")).toBe("triarc-dev-terraform-entity");
		expect(normalizeGraphName("titan---memory")).toBe("titan-memory");
		expect(normalizeGraphName("!!!")).toBe("titan-memory");
		expect(normalizeGraphName("a".repeat(40)).length).toBe(28);
	});

	test("relationsToStatements marks both entities with wikilinks and skips incomplete rows", () => {
		expect(
			relationsToStatements([
				{ from: "auth module", to: "session store", relation: "depends on", note: "run 42" },
				{ from: "", to: "x", relation: "r" },
				{ from: "a", to: "b", relation: " uses " },
			]),
		).toEqual(["[[auth module]] depends on [[session store]] — run 42", "[[a]] uses [[b]]"]);
	});
});

describe("ontologyStage", () => {
	test("sequences ontology → hint → optimize with the same text and a valid context; observed confidence", async () => {
		const bridge = fakeBridge({ [TOOL_ONTOLOGY]: { ontologyStatements: ["[[a]] relates to [[b]]"] }, [TOOL_HINT]: { hint: "topics" }, [TOOL_OPTIMIZE]: { state: "focused" } });
		const result = await ontologyStage(bridge, "line one\nline two", { purpose: "Condense the entity document into an ontology for the roadmap", graphName: "My Graph", save: true, mode: "codebase", chunkSize: 4000 });
		expect(result.confidence).toBe("observed");
		expect(result.ontology).toEqual({ ontologyStatements: ["[[a]] relates to [[b]]"] });
		expect(result.hint).toEqual({ hint: "topics" });
		expect(result.reasoning).toEqual({ state: "focused" });
		expect(result.graphName).toBe("my-graph");
		expect(result.calls.map((c) => [c.tool, c.ok])).toEqual([
			[TOOL_ONTOLOGY, true],
			[TOOL_HINT, true],
			[TOOL_OPTIMIZE, true],
		]);
		expect(bridge.calls.map((c) => c.tool)).toEqual([TOOL_ONTOLOGY, TOOL_HINT, TOOL_OPTIMIZE]);
		expect(bridge.calls.every((c) => c.server === INFRANODUS_SERVER)).toBe(true);
		const first = bridge.calls[0].args;
		expect(first.text).toBe("line one\nline two");
		expect(first.saveGraph).toBe(true);
		expect(first.graphName).toBe("my-graph");
		expect(first.ontologyMode).toBe("codebase");
		expect(first.chunkSize).toBe(4000);
		for (const call of bridge.calls) {
			const context = call.args.context as string;
			expect(wordCount(context)).toBeGreaterThanOrEqual(15);
			expect(wordCount(context)).toBeLessThanOrEqual(25);
			expect(call.args.text).toBe("line one\nline two");
		}
		expect(describeStage(result)).toBe("confidence observed · 3/3 calls ok · graph my-graph");
	});

	test("a disabled or failing server → declared confidence with the reason and the banner, no further calls, never throws", async () => {
		const bridge = fakeBridge({ [TOOL_ONTOLOGY]: new Error("MCP server infranodus disabled: missing env INFRANODUS_API_KEY") });
		const result = await ontologyStage(bridge, "some text");
		expect(result.confidence).toBe("declared");
		expect(result.reason).toContain("missing env INFRANODUS_API_KEY");
		expect(result.banner).toBe(DECLARED_BANNER);
		expect(result.ontology).toBeUndefined();
		expect(bridge.calls).toHaveLength(1);
		expect(result.calls[0]).toMatchObject({ tool: TOOL_ONTOLOGY, ok: false });
		expect(describeStage(result)).toContain("confidence declared · 0/1 calls ok");
		const empty = await ontologyStage(bridge, "   ");
		expect(empty.confidence).toBe("declared");
		expect(empty.reason).toBe("no text to analyse");
		expect(bridge.calls).toHaveLength(1); // nothing sent for empty text
	});

	test("hint/optimize failures and toggles do not demote an observed ontology", async () => {
		const bridge = fakeBridge({ [TOOL_ONTOLOGY]: { ok: 1 }, [TOOL_OPTIMIZE]: new Error("rate limited") });
		const result = await ontologyStage(bridge, "text", { hint: false });
		expect(result.confidence).toBe("observed");
		expect(result.hint).toBeUndefined();
		expect(result.reasoning).toBeUndefined();
		expect(result.calls.map((c) => [c.tool, c.ok])).toEqual([
			[TOOL_ONTOLOGY, true],
			[TOOL_OPTIMIZE, false],
		]);
		expect(result.calls[1].error).toBe("rate limited");
		expect(bridge.calls[0].args.saveGraph).toBe(false);
		expect(bridge.calls[0].args.graphName).toBeUndefined();
	});
});

describe("rememberRelations", () => {
	test("writes wikilink statements to memory_add_relations with a normalized graph name; failures are reported, not thrown", async () => {
		const bridge = fakeBridge({ [TOOL_MEMORY]: { graph: "ok" } });
		const result = await rememberRelations(bridge, [{ from: "feature X", to: "module Y", relation: "implemented in" }], "Triarc Dev Memory");
		expect(result).toMatchObject({ ok: true, graphName: "triarc-dev-memory", statements: 1, result: { graph: "ok" } });
		const args = bridge.calls[0].args;
		expect(args.graphName).toBe("triarc-dev-memory");
		expect(args.statements).toEqual(["[[feature X]] implemented in [[module Y]]"]);
		expect(args.modifyAnalyzedText).toBe("none");
		expect(wordCount(args.context as string)).toBeLessThanOrEqual(25);
		const failing = fakeBridge({ [TOOL_MEMORY]: new Error("MCP server infranodus disabled: missing env INFRANODUS_API_KEY") });
		const failed = await rememberRelations(failing, [{ from: "a", to: "b", relation: "r" }], "g");
		expect(failed.ok).toBe(false);
		expect(failed.reason).toContain("INFRANODUS_API_KEY");
		const none = await rememberRelations(bridge, [], "g");
		expect(none).toEqual({ ok: false, graphName: "g", statements: 0, reason: "no relations" });
	});
});
