import { describe, expect, test } from "bun:test";
import { formatLayerPlan, formatRunPanel, formatStatusPanel, helpText, mermaidFor, parseInputValue, parseRunArgs, SUBCOMMANDS, tokenize, TYPE_GLYPH } from "../modules/cmd-workflow.ts";
import type { RunMeta } from "../modules/run-store.ts";
import type { RunResult } from "../modules/workflow/executor.ts";
import type { WorkflowDoc } from "../modules/workflow/schema.ts";

const DOC: WorkflowDoc = {
	apiVersion: "titan.harness/v1",
	name: "classify-and-fix",
	returns: "create-pr",
	phases: [{ title: "triage" }, { title: "build" }],
	nodes: [
		{ id: "fetch-issue", bash: "gh issue view $ARGUMENTS --json title,body,labels", phase: "triage" },
		{ id: "classify", depends_on: ["fetch-issue"], prompt: "Classify: $fetch-issue.output", role: "worker", phase: "triage", output_format: { type: "object", properties: { issue_type: { type: "string", enum: ["bug", "feature"] } }, required: ["issue_type"] } },
		{ id: "investigate", depends_on: ["classify"], when: "$classify.output.issue_type == 'bug'", prompt: "investigate", phase: "build" },
		{ id: "plan", depends_on: ["classify"], when: '$classify.output.issue_type == "feature"', prompt: "plan", phase: "build" },
		{ id: "implement", depends_on: ["investigate", "plan"], trigger_rule: "one_success", prompt: "implement" },
		{ id: "create-pr", depends_on: ["implement"], prompt: "pr", role: "builder" },
	],
};

describe("argument parsing", () => {
	test("tokenize honours double quotes, single quotes and backslash escapes", () => {
		expect(tokenize(`run classify-and-fix --args "fix the bug" --input 'k=a b'`)).toEqual(["run", "classify-and-fix", "--args", "fix the bug", "--input", "k=a b"]);
		expect(tokenize(`a\\ b "c \\"d\\"" ''`)).toEqual(["a b", 'c "d"', ""]);
		expect(tokenize("   ")).toEqual([]);
	});

	test("parseInputValue: JSON for non-strings, raw text otherwise", () => {
		expect(parseInputValue("123")).toBe(123);
		expect(parseInputValue("true")).toBe(true);
		expect(parseInputValue("null")).toBeNull();
		expect(parseInputValue('["a","b"]')).toEqual(["a", "b"]);
		expect(parseInputValue('{"n":1}')).toEqual({ n: 1 });
		expect(parseInputValue('"quoted"')).toBe('"quoted"');
		expect(parseInputValue("docs/spec.md")).toBe("docs/spec.md");
		expect(parseInputValue("")).toBe("");
	});

	test("run args: name, repeated --input (both spellings), --args, --dry-run, trailing text as arguments", () => {
		const parsed = parseRunArgs(`classify-and-fix --input issue=123 --input=tags='["a","b"]' --input spec="docs/my spec.md" --dry-run --args "fix the bug"`);
		expect(parsed).toEqual({ name: "classify-and-fix", inputs: { issue: 123, tags: ["a", "b"], spec: "docs/my spec.md" }, arguments: "fix the bug", dryRun: true, json: false, errors: [] });
		expect(parseRunArgs("classify-and-fix 123 needs a fix")).toMatchObject({ name: "classify-and-fix", arguments: "123 needs a fix", dryRun: false });
		expect(parseRunArgs("classify-and-fix --args explicit extra words")).toMatchObject({ arguments: "explicit" });
		expect(parseRunArgs("")).toEqual({ inputs: {}, dryRun: false, json: false, errors: [] });
		expect(parseRunArgs("proto --json")).toMatchObject({ name: "proto", json: true });
	});

	test("run args: malformed --input, dangling --args and unknown flags are errors", () => {
		expect(parseRunArgs("x --input novalue").errors).toEqual(['--input expects key=value (got "novalue")']);
		expect(parseRunArgs("x --input").errors).toEqual(["--input expects key=value"]);
		expect(parseRunArgs("x --input =v").errors[0]).toContain("key=value");
		expect(parseRunArgs("x --args").errors).toEqual(["--args expects a value"]);
		expect(parseRunArgs("x --parallel 4").errors).toEqual(["unknown flag --parallel"]);
	});
});

describe("mermaid graph", () => {
	test("flowchart TD with glyphs, phases as subgraphs, when/trigger labels, returns as a stadium, edges from depends_on", () => {
		const graph = mermaidFor(DOC);
		const lines = graph.split("\n");
		expect(lines[0]).toBe("flowchart TD");
		expect(graph).toContain('subgraph n_phase_triage["triage"]');
		expect(graph).toContain(`n_fetch_issue["${TYPE_GLYPH.bash} fetch-issue (bash)"]`);
		expect(graph).toContain(`n_classify["${TYPE_GLYPH.prompt} classify (prompt · worker)"]`);
		expect(graph).toContain(`n_investigate["${TYPE_GLYPH.prompt} investigate (prompt) when $classify.output.issue_type == 'bug'"]`);
		expect(graph).toContain("when $classify.output.issue_type == #quot;feature#quot;");
		expect(graph).toContain(`n_implement["${TYPE_GLYPH.prompt} implement (prompt) one_success"]`);
		expect(graph).toContain(`n_create_pr(["${TYPE_GLYPH.prompt} create-pr (prompt · builder)"])`);
		for (const edge of ["n_fetch_issue --> n_classify", "n_classify --> n_investigate", "n_classify --> n_plan", "n_investigate --> n_implement", "n_plan --> n_implement", "n_implement --> n_create_pr"]) expect(lines).toContain(`  ${edge}`);
		// subgraph members are indented under their phase; nodes without a known phase are top-level
		const triageStart = lines.indexOf('  subgraph n_phase_triage["triage"]');
		expect(lines[triageStart + 1]).toContain("n_fetch_issue");
		expect(lines[triageStart + 2]).toContain("n_classify");
		expect(lines[triageStart + 3]).toBe("  end");
		expect(graph.match(/subgraph /g)).toHaveLength(2);
		// labels are the only quoted text and never carry a raw quote inside (" → #quot;)
		for (const line of lines) expect([0, 2]).toContain((line.match(/"/g) ?? []).length);
	});

	test("draws even a broken document: missing deps become dashed phantom nodes, unknown types get a placeholder glyph", () => {
		const graph = mermaidFor({ nodes: [{ id: "end", depends_on: ["ghost"], bash: "true", prompt: "both" } as any, { id: "solo" } as any] });
		expect(graph).toContain('n_end["▢ end (?)"]');
		expect(graph).toContain('n_ghost["? ghost (missing)"] -.-> n_end');
		expect(graph).toContain('n_solo["▢ solo (?)"]');
		expect(mermaidFor({ nodes: [] })).toBe("flowchart TD");
	});
});

describe("panels", () => {
	const result: RunResult = {
		runId: "run-20260915T010203Z-abc123",
		status: "completed",
		returns: { url: "https://example.test/pr/1" },
		nodes: {
			"create-pr": { nodeId: "create-pr", type: "prompt", status: "success", output: { url: "x" }, startedAt: "2026-09-15T01:02:10.000Z", endedAt: "2026-09-15T01:02:14.500Z", attempts: 1, usage: { tokensIn: 1200, tokensOut: 300, costUsd: 0.0123, tpsSeconds: 3 } },
			"fetch-issue": { nodeId: "fetch-issue", type: "bash", status: "success", output: "{}", startedAt: "2026-09-15T01:02:03.000Z", endedAt: "2026-09-15T01:02:03.400Z", attempts: 1 },
			plan: { nodeId: "plan", type: "prompt", status: "skipped", output: undefined, startedAt: "2026-09-15T01:02:05.000Z", endedAt: "2026-09-15T01:02:05.000Z", attempts: 0 },
			investigate: { nodeId: "investigate", type: "prompt", status: "failed", output: undefined, startedAt: "2026-09-15T01:02:05.000Z", endedAt: "2026-09-15T01:02:09.000Z", attempts: 2, error: "child exited 1 | pipes must be escaped" },
		},
	};

	test("run panel: headline, node table in start order, returns JSON, artifacts dir", () => {
		const panel = formatRunPanel(result, { name: "classify-and-fix", artifactsDir: "/runs/x/artifacts", elapsedMs: 11_500, inputs: { issue: 123 } });
		expect(panel).toContain("**classify-and-fix** · `run-20260915T010203Z-abc123` · ✓ completed · 11.5s");
		expect(panel).toContain("inputs: `{\"issue\":123}`");
		const rows = panel.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| node"));
		expect(rows.map((row) => row.split("|")[1].trim())).toEqual(["fetch-issue", "investigate", "plan", "create-pr"]);
		expect(rows[0]).toBe(`| fetch-issue | ${TYPE_GLYPH.bash} bash | ✓ success | 1 | 0.4s |  |`);
		expect(rows[1]).toBe(`| investigate | ${TYPE_GLYPH.prompt} prompt | ✗ failed | 2 | 4.0s | child exited 1 \\| pipes must be escaped |`);
		expect(rows[2]).toContain("| ⤼ skipped | 0 | 0.0s |");
		expect(rows[3]).toContain("| 1 | 4.5s | 1500 tok · $0.0123 |");
		expect(panel).toContain("**returns**\n```json\n{\n  \"url\": \"https://example.test/pr/1\"\n}\n```");
		expect(panel).toContain("artifacts: `/runs/x/artifacts`");
		expect(panel).not.toContain("**error:**");
	});

	test("run panel: failed/cancelled runs show the error and cope with no nodes", () => {
		const failed = formatRunPanel({ runId: "r", status: "failed", nodes: {}, error: "elevation: implement failed 3 times" });
		expect(failed).toContain("✗ failed");
		expect(failed).toContain("_no nodes ran_");
		expect(failed).toContain("**error:** elevation: implement failed 3 times");
		expect(formatRunPanel({ runId: "r", status: "cancelled", nodes: {} })).toContain("⊘ cancelled");
	});

	test("status panel: headline, totals, last 20 events, live marker, embedded result", () => {
		const run: RunMeta = { runId: "run-1", projectSlug: "p", cwd: "/p", command: "workflow", workflow: { name: "classify-and-fix", sha256: "abc" }, status: "running", startedAt: "2026-09-15T01:02:03.000Z", currentPhase: "build" };
		const events = Array.from({ length: 25 }, (_, i) => ({ seq: i + 1, ts: `2026-09-15T01:02:${String(3 + i).padStart(2, "0")}.123Z`, prev: "", hash: "", runId: "run-1", type: i === 0 ? "run.start" : "node.end", data: i === 0 ? { workflow: "classify-and-fix" } : { nodeId: `n${i}`, status: i % 2 ? "success" : "failed", error: i % 2 ? undefined : "boom" }, ...(i === 3 ? { agentId: "b1" } : {}) }));
		const panel = formatStatusPanel(run, events, { totals: "Σ 12k tok · $0.10", live: { elapsedMs: 4200 } });
		expect(panel).toContain("**classify-and-fix** · `run-1` · ◐ running · 4.2s");
		expect(panel).toContain("started 2026-09-15T01:02:03.000Z · phase build");
		expect(panel).toContain("Σ 12k tok · $0.10");
		expect(panel).toContain("_last 20 of 25 events_");
		const rows = panel.split("\n").filter((line) => /^\| \d+ \|/.test(line));
		expect(rows).toHaveLength(20);
		expect(rows[0]).toBe("| 6 | 01:02:08Z | node.end | n5 · success |");
		expect(rows[19]).toBe("| 25 | 01:02:27Z | node.end | n24 · failed · error: boom |");
		expect(panel).not.toContain("(b1)"); // seq 4 fell outside the tail
		const finished = formatStatusPanel({ ...run, status: "completed", endedAt: "2026-09-15T01:03:00.000Z" }, events.slice(0, 4), { result: { runId: "run-1", status: "completed", nodes: {} } });
		expect(finished).toContain("· completed");
		expect(finished).toContain("· ended 2026-09-15T01:03:00.000Z");
		expect(finished).toContain("| 4 | 01:02:06Z | node.end (b1) | n3 · success |");
		expect(finished).toContain("| 1 | 01:02:03Z | run.start | {\"workflow\":\"classify-and-fix\"} |");
		expect(finished).toContain("_no nodes ran_");
		expect(formatStatusPanel(run, [])).toContain("_no events yet_");
	});

	test("layer plan lists topological layers with glyphs, roles, when and trigger rules", () => {
		const plan = formatLayerPlan(DOC);
		expect(plan.split("\n")).toEqual([
			`1. ${TYPE_GLYPH.bash} fetch-issue`,
			`2. ${TYPE_GLYPH.prompt} classify · worker`,
			`3. ${TYPE_GLYPH.prompt} investigate · when $classify.output.issue_type == 'bug'  |  ${TYPE_GLYPH.prompt} plan · when $classify.output.issue_type == "feature"`,
			`4. ${TYPE_GLYPH.prompt} implement · one_success`,
			`5. ${TYPE_GLYPH.prompt} create-pr · builder`,
		]);
		expect(formatLayerPlan({ ...DOC, nodes: [] })).toBe("(no nodes)");
	});

	test("help names every subcommand", () => {
		const help = helpText();
		for (const verb of SUBCOMMANDS) expect(help).toContain(`/workflow ${verb}`);
	});
});
