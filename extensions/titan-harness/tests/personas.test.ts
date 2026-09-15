import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../modules/hash-chain.ts";
import { PACKAGE_PERSONAS_DIR, listPersonas, loadPersona, mimeographPersonaNames, mimeographPlan, parsePersonaText, personaAppend, personaPromptHash, personaRoots } from "../modules/personas.ts";
import { RunStore } from "../modules/run-store.ts";
import { FULL_TOOLS, READONLY_TOOLS } from "../modules/runtime.ts";
import { DEFAULT_STACK_SETTINGS } from "../modules/stack-config.ts";
import { type AgentRequest, type AgentResult, type RunResult, type WorkflowRuntimeDeps, executeWorkflow } from "../modules/workflow/executor.ts";
import type { LoadedWorkflow } from "../modules/workflow/loader.ts";
import { mimeographSpec } from "../modules/workflow/nodes/ai.ts";
import type { NodeDoc, WorkflowDoc } from "../modules/workflow/schema.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-personas-"));
	dirs.push(dir);
	return dir;
};

/** Model/provider identities that must never appear in a persona's system append. */
const MODEL_TOKENS = /\b(gpt|claude|gemini|grok|qwen|opus|sonnet|fable|astra|muse|openai|anthropic|antigravity|xai|cerebras|openrouter)\b/i;
const PROVIDER_ID = /\b(openai-codex|anthropic|antigravity|xai|cerebras|openrouter)\/\S+/;

const persona = (lens: string, extra = "", body = "Body.") => `---\nlens: ${lens}\nbias: toward tests\nstyle: terse\n${extra}---\n${body}\n`;

describe("persona files", () => {
	test("the eight shipped personas load, carry distinct lenses and never name a model", () => {
		const shipped = listPersonas([PACKAGE_PERSONAS_DIR]);
		expect(shipped.map((p) => p.name)).toEqual(["contrarian", "cursor-cloud-swe", "evidence-auditor", "implementer", "researcher", "sim-user", "test-author", "workflow-architect"]);
		expect(new Set(shipped.map((p) => p.lens)).size).toBe(8);
		for (const p of shipped) {
			const append = personaAppend(p);
			expect(append).toContain(`# Persona: ${p.name}`);
			expect(append).toContain(`- Lens: ${p.lens}`);
			expect(append).not.toMatch(MODEL_TOKENS);
			expect(append).not.toMatch(PROVIDER_ID);
			expect(p.sha256).toHaveLength(64);
		}
	});

	test("parsePersonaText: frontmatter, quotes, model/thinking validation", () => {
		const p = parsePersonaText(persona('"a lens"', "model: stub/x\nthinking: high\n", "Do the thing."), "x");
		expect(p).toMatchObject({ name: "x", lens: "a lens", bias: "toward tests", style: "terse", model: "stub/x", thinking: "high", body: "Do the thing." });
		expect(() => parsePersonaText("no frontmatter", "y")).toThrow("no frontmatter");
		expect(() => parsePersonaText("---\nbias: b\nstyle: s\n---\n", "y")).toThrow('missing frontmatter "lens"');
		expect(() => parsePersonaText(persona("l", "model: notamodel\n"), "y")).toThrow("provider/id");
		expect(() => parsePersonaText(persona("l", "thinking: turbo\n"), "y")).toThrow("thinking must be one of");
	});

	test("roots: a project persona shadows the package one; a missing name throws; listing merges", () => {
		const cwd = scratch();
		const roots = personaRoots(cwd, { user: join(cwd, "no-user") });
		expect(roots[0]).toBe(join(cwd, ".titan", "personas"));
		expect(roots[2]).toBe(PACKAGE_PERSONAS_DIR);
		mkdirSync(join(cwd, ".titan", "personas"), { recursive: true });
		writeFileSync(join(cwd, ".titan", "personas", "implementer.md"), persona("project lens", "", "Project body."));
		writeFileSync(join(cwd, ".titan", "personas", "local-only.md"), persona("local lens"));
		expect(loadPersona("implementer", roots).lens).toBe("project lens");
		expect(loadPersona("contrarian", roots).lens).not.toBe("project lens");
		expect(() => loadPersona("nope", roots)).toThrow('persona "nope" not found');
		expect(() => loadPersona("../etc", roots)).toThrow("not found");
		const names = listPersonas(roots).map((p) => p.name);
		expect(names).toContain("local-only");
		expect(names.filter((n) => n === "implementer")).toHaveLength(1);
	});

	test("two personas on one model → different prompt hashes; the same persona is stable", () => {
		const base = ["seat prompt"];
		const a = loadPersona("implementer", [PACKAGE_PERSONAS_DIR]);
		const b = loadPersona("contrarian", [PACKAGE_PERSONAS_DIR]);
		expect(personaPromptHash(a, base)).not.toBe(personaPromptHash(b, base));
		expect(personaPromptHash(a, base)).toBe(personaPromptHash(loadPersona("implementer", [PACKAGE_PERSONAS_DIR]), base));
	});

	test("mimeographPlan: k × m grid with mg-n callsigns; a persona's own model pins its row", () => {
		const a = parsePersonaText(persona("a"), "a");
		const b = parsePersonaText(persona("b", "model: stub/pinned\nthinking: low\n"), "b");
		const cells = mimeographPlan("brief", [a, b], ["stub/x", "stub/y"]);
		expect(cells).toEqual([
			{ callsign: "mg-1", persona: "a", model: "stub/x" },
			{ callsign: "mg-2", persona: "a", model: "stub/y" },
			{ callsign: "mg-3", persona: "b", model: "stub/pinned", thinking: "low" },
		]);
		expect(() => mimeographPlan("", [a], ["stub/x"])).toThrow("brief is empty");
		expect(() => mimeographPlan("brief", [], ["stub/x"])).toThrow("at least one persona");
		expect(() => mimeographPlan("brief", [a], [])).toThrow("at least one model");
		expect(mimeographPersonaNames("implementer, contrarian,implementer")).toEqual(["implementer", "contrarian"]);
		expect(mimeographPersonaNames({ personas: ["a", "b"] })).toEqual(["a", "b"]);
		expect(mimeographSpec({ id: "n", prompt: "p", mimeograph: "a,b" } as NodeDoc)).toEqual({ personas: ["a", "b"] });
		expect(mimeographSpec({ id: "n", prompt: "p", mimeograph: { personas: ["a"], models: ["stub/x"], judge: "stub/j" } } as NodeDoc)).toEqual({ personas: ["a"], models: ["stub/x"], judge: "stub/j" });
	});
});

// ═══ Executor wiring (stub agent, no pi) ═════════════════════════════════════

type Answer = string | ((req: AgentRequest, n: number) => Partial<AgentResult>);

function harness(cwd: string, answers: Record<string, Answer[]> = {}) {
	const store = new RunStore(scratch());
	const { runId, dir: runDir } = store.open({ projectSlug: RunStore.projectSlug(cwd), cwd, workflow: { name: "t", sha256: sha256("t") }, command: "workflow" });
	const calls: AgentRequest[] = [];
	const counts = new Map<string, number>();
	const deps: WorkflowRuntimeDeps = {
		cwd,
		runId,
		runDir,
		artifactsDir: join(runDir, "artifacts"),
		workflowId: "t",
		store,
		settings: DEFAULT_STACK_SETTINGS,
		async agent(req) {
			calls.push(req);
			const key = req.callsign?.startsWith("mg-") || req.callsign?.endsWith("-judge") ? req.callsign : req.nodeId;
			const n = (counts.get(key) ?? 0) + 1;
			counts.set(key, n);
			const base: AgentResult = { ok: true, text: `${key} says hi`, sessionRef: `sess-${key}-${n}`, usage: { tokensIn: 10, tokensOut: 5, costUsd: 0.001, tpsSeconds: 1 }, toolCalls: 0, model: req.model };
			const scripted = answers[key]?.shift();
			if (scripted === undefined) return base;
			if (typeof scripted === "string") return { ...base, text: scripted };
			return { ...base, ...scripted(req, n) };
		},
		async bash() {
			return { code: 0, stdout: "", stderr: "" };
		},
		async script() {
			return { code: 0, stdout: "", stderr: "" };
		},
		async approval() {
			return { approved: true };
		},
		notify() {},
		resolveRole(role) {
			return { model: `stub/${role}`, thinking: "medium", callsign: `${role}-1`, appendSystemPrompts: ["seat append"], tools: role === "architect" ? READONLY_TOOLS : FULL_TOOLS };
		},
	};
	const run = (nodes: NodeDoc[]): Promise<RunResult> => {
		const doc: WorkflowDoc = { apiVersion: "titan.harness/v1", name: "t", nodes };
		const loaded = { doc, normalized: doc, name: "t", dir: cwd, path: join(cwd, "t.yaml"), sha256: sha256("t"), source: "project", commands: {}, scripts: {}, validation: { ok: true, errors: [], warnings: [] } } as LoadedWorkflow;
		return executeWorkflow(loaded, deps, {});
	};
	return { deps, calls, run, runDir };
}

describe("persona and mimeograph wiring in nodes/ai.ts", () => {
	test("persona: rides the system append (never the prompt) and its model/thinking sit under the node's own", async () => {
		const cwd = scratch();
		mkdirSync(join(cwd, ".titan", "personas"), { recursive: true });
		writeFileSync(join(cwd, ".titan", "personas", "pinned.md"), persona("pinned lens", "model: stub/pinned\nthinking: xhigh\n", "Pinned body."));
		const h = harness(cwd);
		const result = await h.run([
			{ id: "a", prompt: "hello", persona: "contrarian" },
			{ id: "b", prompt: "hello", persona: "pinned" },
			{ id: "c", prompt: "hello", persona: "pinned", model: "stub/node", thinking: "low" },
		] as NodeDoc[]);
		expect(result.status).toBe("completed");
		const [a, b, c] = ["a", "b", "c"].map((id) => h.calls.find((r) => r.nodeId === id)!);
		expect(a.appendSystemPrompts?.[0]).toBe("seat append");
		expect(a.appendSystemPrompts?.some((t) => t.startsWith("# Persona: contrarian"))).toBe(true);
		expect(a.prompt).not.toContain("Persona");
		expect(a.model).toBe("stub/worker");
		expect(b.model).toBe("stub/pinned");
		expect(b.thinking).toBe("xhigh");
		expect(b.appendSystemPrompts?.some((t) => t.includes("Pinned body."))).toBe(true);
		expect(c.model).toBe("stub/node");
		expect(c.thinking).toBe("low");
	});

	test("a missing persona fails the node without an agent call and without retries", async () => {
		const h = harness(scratch());
		const result = await h.run([{ id: "a", prompt: "hello", persona: "ghost", retry: { max_attempts: 3, delay_ms: 0 } }] as NodeDoc[]);
		expect(result.status).toBe("failed");
		expect(result.nodes.a.error).toContain('persona "ghost" not found');
		expect(result.nodes.a.attempts).toBe(1);
		expect(h.calls).toHaveLength(0);
	});

	test("mimeograph: k × m fresh cells with mg-n callsigns, an anonymous judge, the winner as output, every cell archived", async () => {
		const cwd = scratch();
		const h = harness(cwd, {
			"mg-1": ["alpha answer"],
			"mg-2": ["beta answer"],
			"mg-3": ["gamma answer"],
			"mg-4": ["delta answer"],
			"m-judge": [() => ({ text: '{"winner": 9, "summary": "oops"}' }), () => ({ text: '{"winner": 3, "summary": "gamma wins", "scores": [{"candidate": 3, "score": 9}]}' })],
		});
		const result = await h.run([{ id: "m", prompt: "Write the brief for $ARGUMENTS", mimeograph: { personas: ["implementer", "contrarian"], models: ["stub/x", "stub/y"], criteria: "clarity" } }] as NodeDoc[]);
		expect(result.status).toBe("completed");
		expect(result.nodes.m.output).toBe("gamma answer");
		const cells = h.calls.filter((r) => r.callsign?.startsWith("mg-"));
		expect(cells.map((r) => r.callsign)).toEqual(["mg-1", "mg-2", "mg-3", "mg-4"]);
		expect(cells.map((r) => r.model)).toEqual(["stub/x", "stub/y", "stub/x", "stub/y"]);
		expect(cells.every((r) => r.context === "fresh")).toBe(true);
		expect(cells[0].appendSystemPrompts?.some((t) => t.startsWith("# Persona: implementer"))).toBe(true);
		expect(cells[2].appendSystemPrompts?.some((t) => t.startsWith("# Persona: contrarian"))).toBe(true);
		expect(new Set(cells.map((r) => r.prompt)).size).toBe(1); // identical briefs
		const judges = h.calls.filter((r) => r.callsign === "m-judge");
		expect(judges).toHaveLength(2); // out-of-range verdict re-asked once
		expect(judges[0].role).toBe("judge");
		expect(judges[0].prompt).toContain("## Candidate 1");
		expect(judges[0].prompt).toContain("## Candidate 4");
		expect(judges[0].prompt).toContain("Criteria: clarity");
		expect(judges[0].prompt).not.toMatch(/stub\//);
		expect(judges[0].prompt).not.toMatch(/implementer|contrarian|mg-\d/);
		expect(judges[1].context).toEqual({ resume: "sess-m-judge-1" });
		const archive = join(h.runDir, "artifacts", "nodes", "m", "mimeograph");
		expect(readdirSync(archive).sort()).toEqual(["1.md", "1.meta.json", "2.md", "2.meta.json", "3.md", "3.meta.json", "4.md", "4.meta.json"]);
		expect(existsSync(join(h.runDir, "artifacts", "nodes", "m.md"))).toBe(true);
	});

	test("mimeograph: every cell failing delivers nothing and never calls the judge; a comma list uses the seat's model", async () => {
		const h = harness(scratch(), { "mg-1": [() => ({ ok: false, text: "", error: "down" })], "mg-2": [() => ({ ok: false, text: "", error: "down" })] });
		const result = await h.run([{ id: "m", prompt: "brief", mimeograph: "implementer,contrarian", retry: { max_attempts: 1, delay_ms: 0 } }] as NodeDoc[]);
		expect(result.status).toBe("failed");
		expect(result.nodes.m.error).toContain("all 2 cells failed");
		expect(h.calls.map((r) => r.callsign)).toEqual(["mg-1", "mg-2"]);
		expect(h.calls.every((r) => r.model === "stub/worker")).toBe(true);
	});
});
