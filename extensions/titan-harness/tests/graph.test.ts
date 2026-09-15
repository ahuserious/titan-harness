import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mermaidFor, registerWorkflowCommands } from "../modules/cmd-workflow.ts";
import { RunStore } from "../modules/run-store.ts";
import { graphHtml, layoutGraph, NODE_GLYPH, scriptJson, tolerantLayers } from "../modules/workflow/graph.ts";
import type { WorkflowDoc } from "../modules/workflow/schema.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-graph-"));
	dirs.push(dir);
	return dir;
};

const DOC: WorkflowDoc = {
	apiVersion: "titan.harness/v1",
	name: "classify-and-fix",
	returns: "create-pr",
	phases: [{ title: "triage" }, { title: "build" }],
	nodes: [
		{ id: "fetch-issue", bash: "gh issue view $ARGUMENTS --json title,body,labels", phase: "triage" },
		{ id: "classify", depends_on: ["fetch-issue"], prompt: "Classify: $fetch-issue.output", role: "worker", phase: "triage", output_format: { type: "object", properties: { issue_type: { type: "string", enum: ["bug", "feature"] } }, required: ["issue_type"] } },
		{ id: "investigate", depends_on: ["classify"], when: "$classify.output.issue_type == 'bug'", prompt: "investigate </script><!-- sneaky -->", phase: "build" },
		{ id: "plan", depends_on: ["classify"], when: '$classify.output.issue_type == "feature"', prompt: "plan", phase: "build" },
		{ id: "implement", depends_on: ["investigate", "plan"], trigger_rule: "one_success", prompt: "implement" },
		{ id: "create-pr", depends_on: ["implement"], prompt: "pr", role: "builder" },
	],
};

const TAGS = ["html", "head", "body", "header", "main", "div", "aside", "svg", "defs", "marker", "g", "details", "summary", "pre", "script", "style", "h1", "h2", "p"];
const count = (html: string, re: RegExp): number => (html.match(re) ?? []).length;

describe("layoutGraph", () => {
	test("layers run left to right by dependency depth; missing dependencies are phantoms in column 0; cycles keep drawing", () => {
		const layout = layoutGraph(DOC);
		const at = (id: string) => layout.nodes.find((node) => node.id === id)!;
		expect(at("fetch-issue").layer).toBe(0);
		expect(at("classify").layer).toBe(1);
		expect(at("investigate").layer).toBe(2);
		expect(at("plan").layer).toBe(2);
		expect(at("implement").layer).toBe(3);
		expect(at("create-pr").layer).toBe(4);
		expect(at("create-pr").x).toBeGreaterThan(at("implement").x);
		expect(at("plan").y).toBeGreaterThan(at("investigate").y);
		expect(at("create-pr").returns).toBe(true);
		expect(at("classify").glyph).toBe(NODE_GLYPH.prompt);
		expect(layout.edges).toHaveLength(6);
		expect(layout.width).toBeGreaterThan(layout.height);

		const broken: WorkflowDoc = { apiVersion: "titan.harness/v1", name: "broken", nodes: [{ id: "a", depends_on: ["ghost", "b"], prompt: "a" }, { id: "b", depends_on: ["a"], prompt: "b" }] };
		const layers = tolerantLayers(broken.nodes);
		expect(layers.back.size).toBe(1);
		const drawn = layoutGraph(broken);
		const ghost = drawn.nodes.find((node) => node.id === "ghost")!;
		expect(ghost).toMatchObject({ missing: true, layer: 0, type: "missing" });
		expect(drawn.nodes.find((node) => node.id === "a")!.layer).toBeGreaterThan(0);
		expect(drawn.edges.find((edge) => edge.from === "ghost")!.missing).toBe(true);
		expect(drawn.edges.some((edge) => edge.back)).toBe(true);
	});
});

describe("graphHtml", () => {
	test("self-contained: every node id, the node fields as JSON, no network references, balanced tags, one closing script tag", () => {
		const html = graphHtml(DOC, { mermaid: mermaidFor(DOC) });
		for (const node of DOC.nodes) expect(html).toContain(`data-id="${node.id}"`);
		expect(html).toContain(scriptJson({ "fetch-issue": DOC.nodes[0] }).slice(1, -1));
		expect(html).toContain('"when":"$classify.output.issue_type == \'bug\'"');
		expect(html).toContain('"trigger_rule":"one_success"');
		expect(/https?:\/\//.test(html)).toBe(false);
		expect(/<script[^>]*\ssrc=/.test(html)).toBe(false);
		expect(html).not.toContain("<link");
		expect(html).not.toContain("@import");
		expect(html.replace(/url\(#arrow\)/g, "")).not.toContain("url("); // the SVG marker reference is the only url(...)
		expect(count(html, /<\/script>/g)).toBe(1); // the prompt's </script> is escaped inside the JSON
		expect(html).toContain("\\u003c/script>");
		for (const tag of TAGS) expect([tag, count(html, new RegExp(`<${tag}[\\s>]`, "g"))]).toEqual([tag, count(html, new RegExp(`</${tag}>`, "g"))]);
		expect(html).toContain("flowchart TD");
		expect(html).toContain("<title>classify-and-fix — titan graph</title>");
		expect(html).toContain("phases: triage → build");
		expect(html).toContain("returns: create-pr");
	});

	test("a missing dependency draws a dashed phantom and the fallback Mermaid lists the edges", () => {
		const doc: WorkflowDoc = { apiVersion: "titan.harness/v1", name: "x", nodes: [{ id: "a", depends_on: ["ghost"], prompt: "a" }] };
		const html = graphHtml(doc);
		expect(html).toContain('class="node missing" data-id="ghost"');
		expect(html).toContain('class="edge missing"');
		expect(html).toContain("ghost --&gt; a");
	});
});

describe("/workflow graph --html and export --dw through the command", () => {
	test("graph --html writes the inspector; export --dw writes the pi-dynamic-workflows script; schedule arm/disarm persist to the settings file", async () => {
		const cwd = scratch();
		const settingsPath = join(cwd, "titan-harness.json");
		const store = new RunStore(join(cwd, "runs"));
		const panels: Array<[string, string]> = [];
		const notes: string[] = [];
		let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
		const pi = { registerCommand: (_name: string, spec: any) => (handler = spec.handler) } as any;
		registerWorkflowCommands(pi, {
			cwd: () => cwd,
			runtime: () => {
				throw new Error("not used");
			},
			store: () => store,
			notify: (_ctx, text) => notes.push(text),
			panel: (_ctx, title, markdown) => panels.push([title, markdown]),
			validateContext: () => ({}),
			settingsPath,
			lockRoot: join(cwd, "locks"),
			tickMs: 60_000,
		});
		const ctx = { cwd, ui: { setStatus: () => {} } };
		await handler!(`graph classify-and-fix --html --out ${join(cwd, "g.html")}`, ctx);
		expect(existsSync(join(cwd, "g.html"))).toBe(true);
		expect(readFileSync(join(cwd, "g.html"), "utf8")).toContain('data-id="classify"');
		expect(panels.at(-1)![0]).toContain("GRAPH");
		await handler!("graph classify-and-fix --html", ctx);
		expect(existsSync(join(cwd, ".titan", "plans", "graph-classify-and-fix.html"))).toBe(true);
		await handler!("export --dw classify-and-fix", ctx);
		const script = readFileSync(join(cwd, ".titan", "plans", "classify-and-fix.dw.mjs"), "utf8");
		expect(script.startsWith("// classify-and-fix")).toBe(true);
		expect(script).toContain("export const meta = {");
		expect(panels.at(-1)![0]).toContain("EXPORT --dw");
		await handler!("export classify-and-fix", ctx);
		expect(notes.at(-1)).toContain("Usage: /workflow export --dw");
		await handler!("graph classify-and-fix --bogus", ctx);
		expect(notes.at(-1)).toContain("unknown flag --bogus");
	});
});
