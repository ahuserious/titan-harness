import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DECLARED_BANNER } from "../modules/infranodus.ts";
import { sha256 } from "../modules/hash-chain.ts";
import { RunStore } from "../modules/run-store.ts";
import { FULL_TOOLS, READONLY_TOOLS } from "../modules/runtime.ts";
import { DEFAULT_STACK_SETTINGS } from "../modules/stack-config.ts";
import {
	collectSources,
	createTerraform,
	DEFAULT_HARNESS_DEFAULTS,
	ensureHarnessDefaults,
	existingSections,
	harnessDefaultsBlock,
	parseHarnessDefaults,
	parseTerraformArgs,
	persistTerraform,
	readHarnessDefaults,
	registerTerraformCommand,
	renderSourcesTable,
	TERRAFORM_SECTIONS,
	terraformContract,
	terraformInputs,
} from "../modules/cmd-terraform.ts";
import { type AgentRequest, type AgentResult, executeWorkflow, type RunResult, type WorkflowRuntimeDeps } from "../modules/workflow/executor.ts";
import { loadWorkflow, packageRoot } from "../modules/workflow/loader.ts";
import { validateFile } from "../modules/workflow/validator.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-terraform-"));
	dirs.push(dir);
	return dir;
};
const SHIPPED = join(packageRoot(), ".pi", "titan-harness", "workflows", "terraform", "terraform.yaml");

// ═══ Fixtures ═══════════════════════════════════════════════════════════════

const ENTITY_TEXT = `## Domain
Acme sells widgets to hardware makers (src: README.md@deadbeef). See vision.md#goals for the mission.
## Organization
unknown
## Audience
Hardware makers (src: README.md@deadbeef)
## Platform
A TypeScript service (src: package.json@cafebabe)
## Infrastructure
unknown
## Talent
unknown
## Financials
unknown
## Intent
Ship the widget API this year (src: vision.md@feedface)
## Vision
Every hardware maker orders widgets in one call (src: vision.md@feedface)
## Bias
The sources say nothing about customers or incidents.

\`\`\`yaml
harness_defaults:
  level: 2
  tier: production-swe
  review: required
  exa: false
  budget_usd: 40
  personas: [implementer, contrarian]
\`\`\`
`;

const VERIFIER_OK = JSON.stringify({ ok: true, alignment: [{ claim: "Acme sells widgets", source: "vision.md", section: "Goals", status: "aligned" }], executionClaims: [], summary: "aligned with the sources" });
const JUDGE = JSON.stringify({ winner: 2, scores: [{ candidate: 1, score: 7 }, { candidate: 2, score: 9, reason: "most specific" }, { candidate: 3, score: 6 }], summary: "candidate 2 cites every claim" });

type Answer = string | ((req: AgentRequest, n: number) => Partial<AgentResult>);

function harness(cwd: string, answers: Record<string, Answer[]>) {
	const store = new RunStore(scratch());
	const { runId, dir: runDir } = store.open({ projectSlug: RunStore.projectSlug(cwd), cwd, workflow: { name: "terraform", sha256: sha256("t") }, command: "workflow" });
	const agentCalls: AgentRequest[] = [];
	const counts = new Map<string, number>();
	const deps: WorkflowRuntimeDeps = {
		cwd,
		runId,
		runDir,
		artifactsDir: join(runDir, "artifacts"),
		workflowId: "terraform",
		store,
		settings: DEFAULT_STACK_SETTINGS,
		async agent(req) {
			agentCalls.push(req);
			const n = (counts.get(req.nodeId) ?? 0) + 1;
			counts.set(req.nodeId, n);
			const scripted = answers[req.nodeId]?.shift();
			const base: AgentResult = { ok: true, text: `${req.nodeId} done`, sessionRef: `sess-${req.nodeId}-${n}`, usage: { tokensIn: 100, tokensOut: 50, costUsd: 0.001, tpsSeconds: 2 }, toolCalls: 0, model: req.model };
			if (scripted === undefined) return base;
			return typeof scripted === "string" ? { ...base, text: scripted } : { ...base, ...scripted(req, n) };
		},
		async bash(command) {
			return { code: 0, stdout: command.includes("sources recorded") ? "sources recorded\n" : "ok\n", stderr: "" };
		},
		async script() {
			return { code: 0, stdout: "{}", stderr: "" };
		},
		async approval() {
			return { approved: true };
		},
		notify() {},
		resolveRole(role) {
			return { model: `stub/${role}`, thinking: "medium", callsign: `${role}-1`, appendSystemPrompts: [], tools: role === "architect" || role === "verifier" ? READONLY_TOOLS : FULL_TOOLS };
		},
	};
	return { deps, store, runDir, runId, agentCalls };
}

const project = (): string => {
	const cwd = scratch();
	writeFileSync(join(cwd, "README.md"), "# Acme\n\nAcme sells widgets to hardware makers.\n");
	writeFileSync(join(cwd, "vision.md"), "# Vision\n\n## Goals\n\nEvery hardware maker orders widgets in one call.\n");
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "acme", version: "1.0.0" }));
	mkdirSync(join(cwd, "docs"), { recursive: true });
	writeFileSync(join(cwd, "docs", "arch.md"), "# Architecture\n\nA TypeScript service.\n");
	return cwd;
};

const scriptedAnswers = () => ({
	entity: ["## Domain\nsomething vague\n", ENTITY_TEXT, "## Domain\nalso vague\n", JUDGE],
	ontology: ["confidence: declared\n\n## Concepts\n- widget → sold to → hardware maker (entity: Domain)\n"],
	roadmap: ["## Workstreams\n1. Widget API (src: vision.md@feedface) — level 3\n\n## Missing information\n- pricing\n"],
	automations: ["## Automations\n- nightly telemetry refresh (entity: Platform)\n\n## Autonomous authoring\nnone\n"],
	connectors: ["## Connectors\n- github: issues and PRs (entity: Platform)\n"],
	verify: [VERIFIER_OK],
});

async function runTerraform(cwd: string, answers = scriptedAnswers()) {
	const user = join(scratch(), "user");
	const loaded = loadWorkflow("terraform", cwd, undefined, { user });
	const h = harness(cwd, answers);
	const gathered = collectSources(cwd, { git: () => "origin\tgit@github.com:acme/widgets.git (fetch)\n" });
	const inputs = terraformInputs(gathered, { connectorsYaml: "", workflows: [] });
	const result = await executeWorkflow(loaded, h.deps, { inputs: inputs as unknown as Record<string, unknown> });
	return { result, gathered, h, loaded };
}

// ═══ Tests ══════════════════════════════════════════════════════════════════

describe("the shipped terraform workflow", () => {
	test("validates with the P3 validator", () => {
		const result = validateFile(SHIPPED);
		expect(result.errors).toEqual([]);
		expect(result.ok).toBe(true);
		expect(result.warnings.map((w) => w.rule)).not.toContain("unknown-key");
	});

	test("loads by name from the package with its four command bodies", () => {
		const loaded = loadWorkflow("terraform", scratch(), undefined, { user: join(scratch(), "u") });
		expect(loaded.source).toBe("package");
		expect(Object.keys(loaded.commands).sort()).toEqual(["automations", "connectors", "ontology", "roadmap"]);
		expect(loaded.doc.titan?.tier).toBe("research-planning");
		expect(loaded.doc.returns).toBe("verify");
		for (const body of Object.values(loaded.commands)) expect(body).toContain("$inputs.contract");
	});

	test("runs end-to-end under the stub harness: best-of-3 entity, four sections, a passing verifier lane", async () => {
		const cwd = project();
		const { result, h } = await runTerraform(cwd);
		expect(result.status).toBe("completed");
		expect(Object.fromEntries(Object.values(result.nodes).map((n) => [n.nodeId, n.status]))).toEqual({ gather: "success", entity: "success", ontology: "success", roadmap: "success", automations: "success", connectors: "success", verify: "success" });
		const entityCalls = h.agentCalls.filter((c) => c.nodeId === "entity");
		expect(entityCalls).toHaveLength(4); // 3 candidates + judge
		expect(entityCalls.slice(0, 3).every((c) => c.context === "fresh" && c.tools === "none")).toBe(true);
		expect(entityCalls[0].prompt).toContain("You are one seat of the titan-harness terraform team");
		expect(entityCalls[0].prompt).toContain("### README.md (sha256");
		expect(result.nodes.entity.output).toBe(ENTITY_TEXT);
		const ontologyCall = h.agentCalls.find((c) => c.nodeId === "ontology")!;
		expect(ontologyCall.prompt).toContain("unavailable");
		expect(ontologyCall.prompt).toContain(ENTITY_TEXT.split("\n")[1]);
		const verifyCall = h.agentCalls.find((c) => c.nodeId === "verify")!;
		expect(verifyCall.role).toBe("verifier");
		expect(verifyCall.tools).toBe(READONLY_TOOLS);
		expect(verifyCall.prompt).toContain("# entity.md");
		expect(verifyCall.prompt).toContain("# roadmap.md");
		expect((result.nodes.verify.output as { evidence?: string }).evidence).toBe("matched");
		expect(existsSync(join(h.runDir, "evidence", "verify", "evidence.json"))).toBe(true);
	});

	test("a fake citation in the entity text fails the verify lane (H3b through terraform)", async () => {
		const cwd = project();
		const answers = scriptedAnswers();
		answers.entity[1] = ENTITY_TEXT.replace("vision.md#goals", "vision.md#pricing-tiers");
		const { result } = await runTerraform(cwd, answers);
		expect(result.nodes.verify.status).toBe("failed");
		expect(result.nodes.verify.error).toContain("citation");
		expect(result.status).toBe("failed");
	});
});

describe("collectSources", () => {
	test("hashes every source document, bounds the corpus and records remotes and the tree", () => {
		const cwd = project();
		const gathered = collectSources(cwd, { git: () => "origin\tgit@github.com:acme/widgets.git (fetch)\norigin\tgit@github.com:acme/widgets.git (push)\n" });
		expect(gathered.files.map((f) => f.path)).toEqual(["README.md", "vision.md", "package.json", "docs/arch.md"]);
		expect(gathered.files.find((f) => f.path === "vision.md")!.sha256).toBe(sha256(readFileSync(join(cwd, "vision.md"))));
		expect(gathered.files.map((f) => f.kind)).toEqual(["readme", "vision", "manifest", "doc"]);
		expect(gathered.remotes).toEqual(["origin git@github.com:acme/widgets.git"]);
		expect(gathered.tree).toEqual(["README.md", "docs/", "package.json", "vision.md"]);
		expect(gathered.corpus).toContain("### vision.md (sha256 ");
		expect(gathered.corpus).toContain("remotes: origin git@github.com:acme/widgets.git");
		const bounded = collectSources(cwd, { git: () => "", maxFileChars: 10, maxCorpusChars: 200 });
		expect(bounded.truncated.length).toBeGreaterThan(0);
		expect(bounded.corpus.length).toBeLessThan(400);
		const table = renderSourcesTable(gathered.files);
		expect(table.split("\n")).toHaveLength(4 + 4);
		expect(renderSourcesTable([])).toContain("No source documents");
	});
});

describe("harness_defaults", () => {
	test("parses a valid block, drops invalid fields, and ensureHarnessDefaults appends the titan defaults when none is valid", () => {
		expect(parseHarnessDefaults(ENTITY_TEXT)).toEqual({ level: 2, tier: "production-swe", review: "required", exa: false, budget_usd: 40, personas: ["implementer", "contrarian"] });
		expect(parseHarnessDefaults("```yaml\nharness_defaults:\n  level: 9\n  tier: nope\n  review: maybe\n  exa: yes please\n  budget_usd: -1\n  personas: [1, 2]\n```")).toBeUndefined();
		expect(parseHarnessDefaults("```yaml\nharness_defaults:\n  level: 3\n  tier: nope\n```")).toEqual({ level: 3 });
		expect(parseHarnessDefaults("```yaml\nharness_defaults: [not a mapping\n```")).toBeUndefined();
		expect(parseHarnessDefaults("no block here")).toBeUndefined();
		expect(ensureHarnessDefaults(ENTITY_TEXT)).toBe(ENTITY_TEXT);
		const fixed = ensureHarnessDefaults("## Domain\nx\n");
		expect(fixed).toContain("titan defaults apply");
		expect(parseHarnessDefaults(fixed)).toEqual(DEFAULT_HARNESS_DEFAULTS);
		expect(harnessDefaultsBlock({ level: 1, personas: [] })).toContain("  level: 1\n");
		expect(harnessDefaultsBlock({ level: 1, personas: [] })).toContain("personas: []");
	});
});

describe("persistTerraform", () => {
	test("writes the five docs with Sources tables and the host appendices; readHarnessDefaults reads entity.md", async () => {
		const cwd = project();
		const { result, gathered } = await runTerraform(cwd);
		const target = project();
		const persisted = persistTerraform(target, result, gathered, {
			refresh: true,
			ontology: { confidence: "declared", calls: [], reason: "no InfraNodus bridge", banner: DECLARED_BANNER },
			probes: [{ name: "github", kind: "cli", reachable: true, reason: "reachable · cli gh", needs: [] }, { name: "infranodus", kind: "mcp", reachable: false, reason: "vacant", needs: ["env INFRANODUS_API_KEY"] }],
			recipes: [{ workflow: "nightly-sweep", recipe: "orca automations create --name titan-nightly-sweep --trigger hourly" }],
			now: () => new Date("2026-09-15T12:00:00Z"),
		});
		expect(persisted.written).toEqual([...TERRAFORM_SECTIONS]);
		expect(persisted.skipped).toEqual([]);
		expect(persisted.missing).toEqual([]);
		expect(persisted.connectorsCreated).toBe(true);
		const visionDigest = gathered.files.find((f) => f.path === "vision.md")!.sha256;
		for (const section of TERRAFORM_SECTIONS) {
			const text = readFileSync(join(target, ".titan", "terraform", `${section}.md`), "utf8");
			expect(text).toContain("## Sources");
			expect(text).toContain(`| vision.md | ${visionDigest} |`);
			expect(text).toContain("<!-- titan terraform · run ");
			expect(text).toContain("2026-09-15T12:00:00.000Z");
		}
		const entity = readFileSync(join(target, ".titan", "terraform", "entity.md"), "utf8");
		expect(entity.startsWith("## Domain")).toBe(true);
		expect(readHarnessDefaults(target)).toEqual({ level: 2, tier: "production-swe", review: "required", exa: false, budget_usd: 40, personas: ["implementer", "contrarian"] });
		const ontology = readFileSync(join(target, ".titan", "terraform", "ontology.md"), "utf8");
		expect(ontology.startsWith(`> ${DECLARED_BANNER} (no InfraNodus bridge)`)).toBe(true);
		const automations = readFileSync(join(target, ".titan", "terraform", "automations.md"), "utf8");
		expect(automations).toContain("## Automation recipes");
		expect(automations).toContain("orca automations create --name titan-nightly-sweep");
		const connectors = readFileSync(join(target, ".titan", "terraform", "connectors.md"), "utf8");
		expect(connectors).toContain("| infranodus | mcp | ○ vacant | env INFRANODUS_API_KEY |");
		expect(connectors).toContain("created from the default catalog");
		expect(existsSync(join(target, ".titan", "terraform", "connectors.yaml"))).toBe(true);
		const record = JSON.parse(readFileSync(persisted.record, "utf8"));
		expect(record).toMatchObject({ status: "completed", written: [...TERRAFORM_SECTIONS], ontology: "declared" });
		expect(record.sources.map((s: { path: string }) => s.path)).toEqual(gathered.files.map((f) => f.path));
		expect(record.verification.status).toBe("success");
	});

	test("refuses to overwrite without --refresh, honours --section, appends the titan defaults when the seat wrote none, marks an observed ontology", async () => {
		const cwd = project();
		const answers = scriptedAnswers();
		answers.entity[1] = "## Domain\nno defaults block here (src: README.md@deadbeef); see vision.md#goals\n## Bias\nunknown\n";
		const { result, gathered } = await runTerraform(cwd, answers);
		const target = project();
		const first = persistTerraform(target, result, gathered, { ontology: { confidence: "observed", ontology: { nodes: ["widget"] }, calls: [{ tool: "generate_ontology_graph", ms: 5 }] } as never });
		expect(first.written).toEqual([...TERRAFORM_SECTIONS]);
		expect(readHarnessDefaults(target)).toEqual(DEFAULT_HARNESS_DEFAULTS);
		expect(readFileSync(join(target, ".titan", "terraform", "entity.md"), "utf8")).toContain("titan defaults apply");
		expect(readFileSync(join(target, ".titan", "terraform", "ontology.md"), "utf8")).toContain("confidence: observed — InfraNodus ontology stage ran (generate_ontology_graph)");
		expect(existingSections(target)).toEqual([...TERRAFORM_SECTIONS]);
		const roadmapBefore = readFileSync(join(target, ".titan", "terraform", "roadmap.md"), "utf8");
		const second = persistTerraform(target, result, gathered, {});
		expect(second.written).toEqual([]);
		expect(second.skipped).toEqual([...TERRAFORM_SECTIONS]);
		expect(readFileSync(join(target, ".titan", "terraform", "roadmap.md"), "utf8")).toBe(roadmapBefore);
		const third = persistTerraform(target, result, gathered, { section: "roadmap", now: () => new Date("2030-01-01T00:00:00Z") });
		expect(third.written).toEqual(["roadmap"]);
		expect(third.skipped).toEqual([]);
		expect(readFileSync(join(target, ".titan", "terraform", "roadmap.md"), "utf8")).toContain("2030-01-01T00:00:00.000Z");
		expect(readFileSync(join(target, ".titan", "terraform", "entity.md"), "utf8")).not.toContain("2030-01-01");
		expect(readHarnessDefaults(scratch())).toBeUndefined();
	});

	test("a section whose node did not succeed is reported missing, never written", () => {
		const cwd = project();
		const gathered = collectSources(cwd, { git: () => "" });
		const result: RunResult = { runId: "run-x", status: "failed", nodes: { entity: { nodeId: "entity", type: "best_of", status: "failed", output: undefined, error: "all candidates failed", startedAt: "", endedAt: "", attempts: 1 } as never }, error: "entity failed" };
		const persisted = persistTerraform(cwd, result, gathered, { refresh: true });
		expect(persisted.missing).toEqual([...TERRAFORM_SECTIONS]);
		expect(persisted.written).toEqual([]);
		expect(existsSync(join(cwd, ".titan", "terraform", "entity.md"))).toBe(false);
	});
});

describe("/terraform command", () => {
	test("parseTerraformArgs", () => {
		expect(parseTerraformArgs("")).toEqual({ refresh: false, dryRun: false, errors: [] });
		expect(parseTerraformArgs("--refresh --dry-run")).toMatchObject({ refresh: true, dryRun: true });
		expect(parseTerraformArgs("--section roadmap")).toMatchObject({ section: "roadmap" });
		expect(parseTerraformArgs("--section=entity")).toMatchObject({ section: "entity" });
		expect(parseTerraformArgs("--section nope").errors[0]).toContain("--section needs one of");
		expect(parseTerraformArgs("--bogus").errors).toEqual(["unknown argument --bogus"]);
	});

	test("dry run spends nothing; the run persists through deps.runWorkflow; existing docs refuse without --refresh", async () => {
		const cwd = project();
		const panels: Array<{ title: string; body: string }> = [];
		const notices: Array<{ text: string; level?: string }> = [];
		let runs = 0;
		const user = join(scratch(), "u");
		const controller = createTerraform({
			cwd: () => cwd,
			store: () => new RunStore(scratch()),
			notify: (_ctx, text, level) => notices.push({ text, level }),
			panel: (_ctx, title, body) => panels.push({ title, body }),
			overrides: { user },
			probes: () => ({ mcpServers: () => ["macro"], which: () => undefined, env: () => false }),
			async runWorkflow(_ctx, loaded, inputs) {
				runs += 1;
				expect(loaded.name).toBe("terraform");
				expect(typeof inputs.sources).toBe("string");
				expect(inputs.contract).toBe(terraformContract());
				expect(inputs.ontology_graph).toBe("unavailable");
				const h = harness(cwd, scriptedAnswers());
				return executeWorkflow(loaded, h.deps, { inputs });
			},
			now: () => new Date("2026-09-15T13:00:00Z"),
		});
		await controller.run("--dry-run", {});
		expect(runs).toBe(0);
		expect(panels[0].title).toContain("DRY RUN");
		expect(panels[0].body).toContain("gather");
		expect(panels[0].body).toContain("| vision.md |");
		expect(panels[0].body).toContain("| macro | mcp | ✓ reachable |");
		expect(panels[0].body).toContain("no bridge → declared");
		expect(existsSync(join(cwd, ".titan", "terraform"))).toBe(false);

		await controller.run("", {});
		expect(runs).toBe(1);
		expect(panels[1].title).toContain("COMPLETED");
		expect(panels[1].body).toContain("**written** entity, ontology, roadmap, automations, connectors");
		expect(panels[1].body).toContain("**ontology** declared");
		expect(panels[1].body).toContain("**verification** success");
		expect(existsSync(join(cwd, ".titan", "terraform", "entity.md"))).toBe(true);
		expect(existsSync(join(cwd, ".titan", "terraform", "connectors.yaml"))).toBe(true);
		expect(notices.some((n) => n.text.includes(DECLARED_BANNER))).toBe(true);
		expect(readHarnessDefaults(cwd)?.tier).toBe("production-swe");

		await controller.run("", {});
		expect(runs).toBe(1); // refused before spending anything
		expect(notices.at(-1)!.text).toContain("--refresh");

		await controller.run("--section roadmap", {});
		expect(runs).toBe(2);
		expect(panels.at(-1)!.body).toContain("**written** roadmap");
		expect(panels.at(-1)!.body).toContain("2026-09-15T13:00:00.000Z".slice(0, 4) === "2026" ? "roadmap" : "roadmap");

		await controller.run("--bogus", {});
		expect(notices.at(-1)!.text).toContain("unknown argument");
	});

	test("registerTerraformCommand registers /terraform with completions", async () => {
		const registered: Array<{ name: string; spec: any }> = [];
		const fakePi = { registerCommand: (name: string, spec: any) => registered.push({ name, spec }) } as never;
		const notices: string[] = [];
		registerTerraformCommand(fakePi, {
			cwd: () => scratch(),
			store: () => new RunStore(scratch()),
			notify: (_ctx, text) => notices.push(text),
			panel: () => {},
			runWorkflow: async () => {
				throw new Error("not reached");
			},
			overrides: { user: join(scratch(), "u"), package: join(scratch(), "no-such-package") },
		});
		expect(registered.map((r) => r.name)).toEqual(["terraform"]);
		expect(registered[0].spec.getArgumentCompletions("--se").map((i: { value: string }) => i.value)).toEqual(["--section", ...TERRAFORM_SECTIONS.map((s) => `--section ${s}`)]);
		await registered[0].spec.handler("", {});
		expect(notices[0]).toContain("did not load"); // the overridden package root has no terraform workflow
		expect(resolve(SHIPPED)).toContain("workflows/terraform/terraform.yaml");
	});
});
