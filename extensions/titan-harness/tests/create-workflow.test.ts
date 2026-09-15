import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { NODE_RESULT_PATH_ENV, NODE_SCHEMA_ENV, SUBMIT_RESULT_INSTRUCTION, SUBMIT_RESULT_TOOL } from "../modules/child-hooks.ts";
import {
	type ArchitectSeat,
	AUTHORING_FILE,
	CREATE_WORKFLOW_RESULT_SCHEMA,
	type CreateArgs,
	type CreateWorkflowDeps,
	MAX_AUTHORING_ROUNDS,
	applyElevation,
	authorWorkflow,
	authoringStatusText,
	buildContextPack,
	checkAuthoredResult,
	elevationDirectives,
	parseCreateArgs,
	parseEscalationReport,
	resolvePlanFile,
} from "../modules/cmd-create-workflow.ts";
import { readChain } from "../modules/hash-chain.ts";
import { readLedger } from "../modules/ledger.ts";
import { RunStore } from "../modules/run-store.ts";
import type { AgentRun } from "../modules/runtime.ts";
import { writeEscalationReport } from "../modules/workflow/elevation.ts";
import { validateFile } from "../modules/workflow/validator.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-create-wf-"));
	dirs.push(dir);
	return dir;
};

const VALID_YAML = `apiVersion: titan.harness/v1
name: smoke-fix
description: Fix the smoke test.
phases:
  - { title: plan }
  - { title: build }
returns: build
nodes:
  - id: plan
    role: architect
    phase: plan
    allowed_tools: []
    prompt: "Plan the fix for $ARGUMENTS"
  - id: build
    role: builder
    phase: build
    review: none
    depends_on: [plan]
    command: implement
`;

const validResult = (over: Record<string, unknown> = {}) => ({
	name: "smoke-fix",
	description: "Fix the smoke test.",
	yaml: VALID_YAML,
	commands: [{ name: "implement", body: "Implement the plan in $plan.output and run the tests." }],
	phases: ["plan", "build"],
	notes: "Two phases: plan, then a reviewed build.",
	...over,
});

type Script = { file?: unknown; text?: string; fail?: string };

/** A fake architect child: v2 writes the result file, v1 answers with text. */
function fakeRunChild(scripts: Script[]) {
	const calls: any[] = [];
	const runChild = async (opts: any): Promise<AgentRun> => {
		calls.push(opts);
		const script = scripts.shift() ?? { text: "" };
		const run = opts.run as AgentRun;
		run.sessionRef = `sess-${calls.length}`;
		run.tokensIn = 1000;
		run.tokensOut = 300;
		run.costUsd = 0.01;
		run.tpsSeconds = 3;
		run.exitCode = 0;
		if (script.fail) {
			run.status = "failed";
			run.exitCode = 1;
			run.errorMessage = script.fail;
			return run;
		}
		if (script.file !== undefined) {
			const file = opts.env[NODE_RESULT_PATH_ENV];
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, `${JSON.stringify(script.file)}\n`);
			run.text = "";
			run.status = "failed";
			return run;
		}
		run.text = script.text ?? "";
		run.status = run.text.trim() ? "done" : "failed";
		return run;
	};
	return { runChild: runChild as any, calls };
}

interface Fixture {
	deps: CreateWorkflowDeps;
	cwd: string;
	store: RunStore;
	calls: any[];
	panels: Array<{ title: string; markdown: string }>;
	notices: Array<{ text: string; level?: string }>;
	statuses: Array<string | undefined>;
	seat: ArchitectSeat;
}

function fixture(scripts: Script[], over: Partial<CreateWorkflowDeps> = {}): Fixture {
	const cwd = scratch();
	const store = new RunStore(scratch());
	const fake = fakeRunChild(scripts);
	const panels: Fixture["panels"] = [];
	const notices: Fixture["notices"] = [];
	const statuses: Fixture["statuses"] = [];
	const seat: ArchitectSeat = { model: "xai/grok-4.6", thinking: "xhigh", callsign: "rune", appendSystemPrompts: ["seat append"], substitutedFrom: "openai-codex/gpt-6-astra" };
	const deps: CreateWorkflowDeps = {
		runChild: fake.runChild,
		store: () => store,
		cwd: () => cwd,
		notify: (_ctx, text, level) => notices.push({ text, level }),
		panel: (_ctx, title, markdown) => panels.push({ title, markdown }),
		architectSeat: () => seat,
		levelInfo: () => ({ level: 3, shape: "level-3", tier: "production-swe" }),
		setStatus: (_ctx, text) => statuses.push(text),
		childTimeoutMs: () => 1000,
		now: () => new Date("2026-09-15T12:00:00Z"),
		...over,
	};
	return { deps, cwd, store, calls: fake.calls, panels, notices, statuses, seat };
}

const args = (over: Partial<CreateArgs> = {}): CreateArgs => ({ goal: "fix the smoke test", elevate: false, dryRun: false, force: false, errors: [], ...over });
const findFiles = (root: string, needle: string): string[] => execSync(`find ${JSON.stringify(root)} -name ${JSON.stringify(needle)} 2>/dev/null || true`, { encoding: "utf8" }).split("\n").filter(Boolean);

describe("parseCreateArgs", () => {
	test("goal words, quoted values, every flag, and the errors", () => {
		const parsed = parseCreateArgs('build "the analytics" dashboard --name proto-dash --from-plan plan-1 --level 2 --tier prototype-analytics --dry-run --force');
		expect(parsed).toMatchObject({ goal: "build the analytics dashboard", name: "proto-dash", fromPlan: "plan-1", level: 2, tier: "prototype-analytics", dryRun: true, force: true, errors: [] });
		expect(parseCreateArgs("--from /tmp/r.md --elevate")).toMatchObject({ goal: "", fromFindings: "/tmp/r.md", elevate: true, errors: [] });
		expect(parseCreateArgs("--from-findings=/tmp/r.md fix").fromFindings).toBe("/tmp/r.md");
		expect(parseCreateArgs("").errors[0]).toContain("goal is required");
		expect(parseCreateArgs("x --elevate").errors[0]).toContain("--elevate needs --from");
		expect(parseCreateArgs("x --name Bad_Name").errors[0]).toContain("--name must match");
		expect(parseCreateArgs("x --level 7").errors[0]).toContain("--level must be 0-3");
		expect(parseCreateArgs("x --tier nope").errors[0]).toContain("--tier must be one of");
		expect(parseCreateArgs("x --bogus").errors[0]).toContain("unknown flag");
	});
});

describe("the context pack", () => {
	test("lists every source with its sha256 and respects the character budget with truncation flags", () => {
		const cwd = scratch();
		mkdirSync(join(cwd, ".titan", "terraform"), { recursive: true });
		writeFileSync(join(cwd, ".titan", "terraform", "entity.md"), "# Entity\n".repeat(20));
		writeFileSync(join(cwd, "vision.md"), "V".repeat(500));
		writeFileSync(join(cwd, "AGENTS.md"), "agents");
		const pack = buildContextPack({ cwd, shapeSummary: "- level: 3", installed: [{ name: "classify-and-fix", source: "package" }], budgetChars: 300 });
		const ids = pack.entries.map((e) => e.id);
		expect(ids).toEqual(["terraform/entity.md", "vision.md", "AGENTS.md", "shape", "skill/schema", "skill/rules", "skill/examples", "installed"]);
		for (const entry of pack.entries) expect(entry.sha256).toHaveLength(64);
		expect(pack.entries[0].included).toBe(180);
		expect(pack.entries[0].truncated).toBe(false);
		expect(pack.entries[1]).toMatchObject({ chars: 500, included: 120, truncated: true });
		expect(pack.entries[2].included).toBe(0);
		expect(pack.manifest.includedChars).toBe(300);
		expect(pack.manifest.totalChars).toBeGreaterThan(300);
		expect(pack.text).toContain("[… truncated by the context budget …]");
		expect(pack.text).not.toContain("agents\n");
		expect(pack.sha256).toHaveLength(64);
		expect(JSON.parse(pack.manifestJson).entries).toHaveLength(8);
	});

	test("a fused plan and an escalation report come first; --from-plan resolves ids, dirs and files", () => {
		const cwd = scratch();
		mkdirSync(join(cwd, ".titan", "plans", "plan-1"), { recursive: true });
		writeFileSync(join(cwd, ".titan", "plans", "plan-1", "fused-plan.md"), "# Fused plan\nDo X.");
		const report = join(scratch(), "escalation-report.md");
		writeFileSync(report, "# Escalation report\n- kind: audit\n");
		expect(resolvePlanFile(cwd, "plan-1")).toBe(join(cwd, ".titan", "plans", "plan-1", "fused-plan.md"));
		expect(resolvePlanFile(cwd, join(cwd, ".titan", "plans", "plan-1"))).toBe(join(cwd, ".titan", "plans", "plan-1", "fused-plan.md"));
		expect(resolvePlanFile(cwd, "missing")).toBeUndefined();
		const pack = buildContextPack({ cwd, fromPlan: "plan-1", findingsPath: report, shapeSummary: "shape", installed: [] });
		expect(pack.entries.slice(0, 2).map((e) => e.id)).toEqual(["plan", "findings"]);
		expect(pack.text.indexOf("Do X.")).toBeLessThan(pack.text.indexOf("- kind: audit"));
		expect(pack.entries[0].path).toBe(join(cwd, ".titan", "plans", "plan-1", "fused-plan.md"));
	});
});

describe("escalation reports and elevation directives", () => {
	test("parseEscalationReport reads the P4 report; --elevate bumps level/tier, halves the budget, enables the watchdog, links the run", () => {
		const artifacts = scratch();
		const { path: file } = writeEscalationReport(artifacts, {
			runId: "run-20260915T000000Z-abc123",
			workflowId: "proto-analytics-dashboard",
			nodeId: "implement",
			nodeType: "loop",
			kind: "mechanical",
			action: "elevate",
			attempts: 3,
			findings: [{ id: "f".repeat(64), category: "tests", summary: "suite still red | flaky", paths: ["src/a.ts"], severity: "blocker" }],
			evidenceIds: ["verify"],
			error: "tests red after 3 iterations",
			level: 2,
			tier: "prototype-analytics",
			iterations: 3,
		});
		const report = parseEscalationReport(file);
		expect(report).toMatchObject({ workflow: "proto-analytics-dashboard", run: "run-20260915T000000Z-abc123", node: "implement", nodeType: "loop", kind: "mechanical", action: "elevate", attempts: 3, error: "tests red after 3 iterations", level: 2, targetLevel: 3, tier: "prototype-analytics" });
		expect(report.findings).toEqual([{ id: "ffffffffffff", severity: "blocker", category: "tests", summary: "suite still red | flaky", paths: "src/a.ts" }]);
		const elevate = elevationDirectives(report, { elevate: true, previousBudget: 100000 });
		expect(elevate).toMatchObject({ mode: "elevate", level: 3, tier: "production-swe", contextBudget: 50000, watchdog: true, parentRun: "run-20260915T000000Z-abc123", tighten: true });
		expect(elevationDirectives(report, { elevate: true }).contextBudget).toBe(60000);
		const repair = elevationDirectives(report, { elevate: false });
		expect(repair).toMatchObject({ mode: "repair", level: 2, tier: "prototype-analytics", watchdog: false, parentRun: "run-20260915T000000Z-abc123", tighten: false });
		expect(repair.contextBudget).toBeUndefined();
		expect(elevationDirectives(report, { elevate: true, level: 1, tier: "content" })).toMatchObject({ level: 1, tier: "content" });
		expect(elevationDirectives({ ...report, level: 3 }, { elevate: true }).level).toBe(3); // min(level + 1, 3)

		const doc: any = { apiVersion: "titan.harness/v1", name: "x", nodes: [], titan: { budget: { context_budget: 100000, usd: 5 } } };
		expect(applyElevation(doc, elevate)).toEqual(["titan.level = 3", "titan.tier = production-swe", "titan.budget.context_budget = 50000", "titan.watchdog.enabled = true", "titan.parent_run = run-20260915T000000Z-abc123"]);
		expect(doc.titan.budget.usd).toBe(5);
		expect(applyElevation(doc, elevate)).toEqual([]); // idempotent
		const bare: any = { apiVersion: "titan.harness/v1", name: "y", nodes: [] };
		applyElevation(bare, elevationDirectives(report, { elevate: true }));
		expect(bare.titan.budget.context_budget).toBe(60000);
		const tighter: any = { apiVersion: "titan.harness/v1", name: "z", nodes: [], titan: { budget: { context_budget: 30000 } } };
		expect(applyElevation(tighter, elevate)).not.toContain("titan.budget.context_budget = 50000"); // a tighter budget is kept
	});
});

describe("checkAuthoredResult", () => {
	test("refuses traversal, bad names, duplicates, empty bodies and existing workflows; accepts the good result", () => {
		const cwd = scratch();
		expect(checkAuthoredResult({ nope: true }, { cwd, force: false }).problems[0]).toContain("not the required object");
		expect(checkAuthoredResult(validResult({ commands: [{ name: "../../evil", body: "x" }] }), { cwd, force: false }).problems[0]).toContain("not allowed");
		expect(checkAuthoredResult(validResult({ commands: [{ name: "sub/dir", body: "x" }] }), { cwd, force: false }).problems[0]).toContain("not allowed");
		expect(checkAuthoredResult(validResult({ name: "Bad Name" }), { cwd, force: false }).problems[0]).toContain("must match");
		expect(checkAuthoredResult(validResult({ commands: [{ name: "a", body: "x" }, { name: "a", body: "y" }] }), { cwd, force: false }).problems[0]).toContain("listed twice");
		expect(checkAuthoredResult(validResult({ commands: [{ name: "a", body: "  " }] }), { cwd, force: false }).problems[0]).toContain("empty body");
		const ok = checkAuthoredResult(validResult(), { cwd, force: false });
		expect(ok.problems).toEqual([]);
		expect(ok.result?.commands).toEqual([{ name: "implement", body: "Implement the plan in $plan.output and run the tests." }]);
		expect(checkAuthoredResult(validResult(), { cwd, force: false, fixedName: "renamed" }).result?.name).toBe("renamed");
		mkdirSync(join(cwd, ".titan", "workflows", "smoke-fix"), { recursive: true });
		expect(checkAuthoredResult(validResult(), { cwd, force: false }).problems[0]).toContain("already exists");
		expect(checkAuthoredResult(validResult(), { cwd, force: true }).problems).toEqual([]);
	});
});

describe("authorWorkflow", () => {
	test("v2 happy path: read-only child, host persists the YAML + commands + AUTHORING.md, the store and the status line follow", async () => {
		const f = fixture([{ file: validResult() }]);
		mkdirSync(join(f.cwd, ".titan", "terraform"), { recursive: true });
		writeFileSync(join(f.cwd, ".titan", "terraform", "entity.md"), "# Entity\nTriarc.");
		writeFileSync(join(f.cwd, "vision.md"), "# Vision\nShip.");
		const outcome = await authorWorkflow(f.deps, {}, args());
		expect(outcome.ok).toBe(true);
		expect(outcome.name).toBe("smoke-fix");
		expect(outcome.calls).toBe(1);
		expect(outcome.rounds).toBe(0);
		// The child: fresh session, read-only tools only, the v2 schema and the instruction, the pack in the prompt.
		const call = f.calls[0];
		expect(call.tools).toBe("read,grep,find,ls");
		expect(call.tools).not.toMatch(/write|edit|bash/);
		expect(call.extraTools).toEqual([SUBMIT_RESULT_TOOL]);
		expect(typeof call.sessionId).toBe("string");
		expect(call.resume).toBeUndefined();
		expect(call.thinking).toBe("xhigh");
		expect(JSON.parse(call.env[NODE_SCHEMA_ENV])).toEqual(CREATE_WORKFLOW_RESULT_SCHEMA);
		expect(call.prompt.endsWith(SUBMIT_RESULT_INSTRUCTION)).toBe(true);
		expect(call.prompt).toContain("fix the smoke test");
		expect(call.prompt).toContain("Triarc.");
		expect(call.prompt).toContain("### vision.md");
		expect(call.systemPrompt).toContain("WORKFLOW ARCHITECT");
		expect(call.appendSystemPrompts[0]).toBe("seat append");
		expect(call.appendSystemPrompts.some((t: string) => t.startsWith("# Persona: workflow-architect"))).toBe(true);
		// Persisted by the host.
		const dir = join(f.cwd, ".titan", "workflows", "smoke-fix");
		expect(readdirSync(dir).sort()).toEqual([AUTHORING_FILE, "commands", "smoke-fix.yaml"]);
		expect(readFileSync(join(dir, "smoke-fix.yaml"), "utf8")).toBe(VALID_YAML);
		expect(readFileSync(join(dir, "commands", "implement.md"), "utf8")).toContain("Implement the plan");
		const record = readFileSync(join(dir, AUTHORING_FILE), "utf8");
		expect(record).toContain("- goal: fix the smoke test");
		expect(record).toContain("- seat: rune · xai/grok-4.6 (fallback for openai-codex/gpt-6-astra)");
		expect(record).toContain("- thinking: requested xhigh · effective xhigh");
		expect(record).toContain("- context manifest: sha256 ");
		expect(record).toContain("- validator rounds: 0 (architect calls 1)");
		expect(record).toContain("Two phases: plan, then a reviewed build.");
		const check = validateFile(join(dir, "smoke-fix.yaml"));
		expect(check.ok).toBe(true);
		// The store: run, manifest, events, agent state, ledger.
		const runDir = outcome.runDir!;
		expect(existsSync(join(runDir, "context-manifest.json"))).toBe(true);
		const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
		expect(run).toMatchObject({ command: "create-workflow", status: "completed", level: 3, shape: "level-3", workflow: { name: "smoke-fix" } });
		const types = readChain(join(runDir, "events.jsonl")).map((row) => (row as any).type);
		expect(types).toEqual(["authoring.start", "authoring.round", "authoring.persist"]);
		expect(readLedger(runDir)).toHaveLength(1);
		const agent = JSON.parse(readFileSync(join(runDir, "agents", "workflow-architect.json"), "utf8"));
		expect(agent.stateHistory.map((s: any) => s.state)).toEqual(["authoring-workflow", "done-unverified"]);
		expect(f.statuses[0]).toBe("L3 · level-3 · authoring-workflow · rune xhigh");
		expect(f.statuses[f.statuses.length - 1]).toBeUndefined();
		expect(f.panels[0].title).toBe("◆ CREATE-WORKFLOW smoke-fix — AUTHORED");
		expect(f.panels[0].markdown).toContain("/workflow validate smoke-fix");
	});

	test("an invalid document is re-asked in the same session with the validator's errors, then persisted", async () => {
		const broken = VALID_YAML.replace("depends_on: [plan]", "depends_on: [ghost]");
		const f = fixture([{ file: validResult({ yaml: broken }) }, { file: validResult() }]);
		const outcome = await authorWorkflow(f.deps, {}, args());
		expect(outcome.ok).toBe(true);
		expect(outcome.calls).toBe(2);
		expect(outcome.rounds).toBe(1);
		expect(f.calls[1].resume).toBe("sess-1");
		expect(f.calls[1].prompt).toContain("rejected by the host");
		expect(f.calls[1].prompt).toContain("ghost");
		expect(f.notices.some((n) => n.text.includes("re-asking 1/3"))).toBe(true);
		expect(existsSync(join(f.cwd, ".titan", "workflows", "smoke-fix", "smoke-fix.yaml"))).toBe(true);
	});

	test("v1 fallback: a JSON answer in the text is accepted", async () => {
		const f = fixture([{ text: `Here is the workflow:\n${JSON.stringify(validResult())}` }]);
		const outcome = await authorWorkflow(f.deps, {}, args());
		expect(outcome.ok).toBe(true);
		expect(outcome.calls).toBe(1);
	});

	test("never-valid answers stop after MAX_AUTHORING_ROUNDS re-asks with a failed panel and nothing persisted", async () => {
		const bad = validResult({ yaml: "apiVersion: nope\nname: smoke-fix\nnodes: []\n" });
		const f = fixture([{ file: bad }, { file: bad }, { file: bad }, { file: bad }, { file: bad }]);
		const outcome = await authorWorkflow(f.deps, {}, args());
		expect(outcome.ok).toBe(false);
		expect(outcome.calls).toBe(1 + MAX_AUTHORING_ROUNDS);
		expect(outcome.rounds).toBe(MAX_AUTHORING_ROUNDS);
		expect(outcome.error).toContain(`after ${MAX_AUTHORING_ROUNDS} re-asks`);
		expect(existsSync(join(f.cwd, ".titan", "workflows"))).toBe(false);
		expect(f.panels[0].title).toBe("◆ CREATE-WORKFLOW — FAILED");
		expect(JSON.parse(readFileSync(join(outcome.runDir!, "run.json"), "utf8")).status).toBe("failed");
	});

	test("a traversal command name is refused, nothing lands anywhere, and the child is re-asked", async () => {
		const f = fixture([{ file: validResult({ commands: [{ name: "../../../evil", body: "rm -rf /" }, { name: "implement", body: "ok" }] }) }, { file: validResult() }]);
		const outcome = await authorWorkflow(f.deps, {}, args());
		expect(outcome.ok).toBe(true);
		expect(outcome.calls).toBe(2);
		expect(f.calls[1].prompt).toContain("not allowed");
		expect(findFiles(f.cwd, "evil.md")).toEqual([]);
		expect(findFiles(outcome.runDir!, "evil.md")).toEqual([]);
		expect(findFiles(dirname(dirname(outcome.runDir!)), "evil.md")).toEqual([]);
	});

	test("--elevate: the repair workflow is pinned to level 3, the deeper tier, half the budget, the watchdog and parent_run", async () => {
		const f = fixture([{ file: validResult({ name: "proto-repair", yaml: VALID_YAML.replace("name: smoke-fix", "name: proto-repair") }) }]);
		const artifacts = scratch();
		const { path: report } = writeEscalationReport(artifacts, { runId: "run-parent-1", workflowId: "proto-analytics-dashboard", nodeId: "implement", kind: "mechanical", action: "elevate", attempts: 3, findings: [], evidenceIds: [], error: "tests red", level: 2, tier: "prototype-analytics" });
		const outcome = await authorWorkflow(f.deps, {}, args({ goal: "", fromFindings: report, elevate: true }));
		expect(outcome.ok).toBe(true);
		expect(outcome.directives?.mode).toBe("elevate");
		const yamlPath = join(f.cwd, ".titan", "workflows", "proto-repair", "proto-repair.yaml");
		const doc = parseYaml(readFileSync(yamlPath, "utf8"));
		expect(doc.titan).toEqual({ level: 3, tier: "production-swe", budget: { context_budget: 60000 }, watchdog: { enabled: true }, parent_run: "run-parent-1" });
		expect(validateFile(yamlPath).ok).toBe(true);
		expect(JSON.parse(readFileSync(join(outcome.runDir!, "run.json"), "utf8"))).toMatchObject({ parentRunId: "run-parent-1", tier: "production-swe" });
		expect(f.calls[0].prompt).toContain("RE-AUTHORING AT A HIGHER LEVEL");
		expect(f.calls[0].prompt).toContain("titan.level: 3");
		expect(f.calls[0].prompt).toContain("### escalation report");
		expect(readFileSync(join(f.cwd, ".titan", "workflows", "proto-repair", AUTHORING_FILE), "utf8")).toContain("- source: elevate from");
		expect(readFileSync(yamlPath, "utf8")).toContain("host adjustments: titan.level = 3");
	});

	test("--dry-run spawns nothing and opens no run; an existing workflow without --force is refused before any call", async () => {
		const f = fixture([{ file: validResult() }]);
		const dry = await authorWorkflow(f.deps, {}, args({ dryRun: true }));
		expect(dry.ok).toBe(true);
		expect(dry.dryRun).toBe(true);
		expect(f.calls).toHaveLength(0);
		expect(f.panels[0].title).toContain("DRY RUN");
		expect(f.panels[0].markdown).toContain("| authoring reference schema.md |");
		expect(f.store.listRuns(RunStore.projectSlug(f.cwd))).toEqual([]);
		mkdirSync(join(f.cwd, ".titan", "workflows", "taken"), { recursive: true });
		const refused = await authorWorkflow(f.deps, {}, args({ name: "taken" }));
		expect(refused.ok).toBe(false);
		expect(refused.calls).toBe(0);
		expect(refused.error).toContain("--force");
		const failed = await authorWorkflow(f.deps, {}, args({ errors: ["a goal is required"] }));
		expect(failed.ok).toBe(false);
		expect(failed.calls).toBe(0);
	});

	test("a failed architect call ends the run failed with the reason", async () => {
		const f = fixture([{ fail: "provider down" }]);
		const outcome = await authorWorkflow(f.deps, {}, args());
		expect(outcome.ok).toBe(false);
		expect(outcome.error).toContain("provider down");
		expect(JSON.parse(readFileSync(join(outcome.runDir!, "run.json"), "utf8")).status).toBe("failed");
		expect(f.statuses[f.statuses.length - 1]).toBeUndefined();
	});

	test("authoringStatusText shows requested↘effective thinking on capped seats", () => {
		expect(authoringStatusText(1, "level-1", { model: "cerebras/qwen-3.8-27b", thinking: "high", callsign: "rune", appendSystemPrompts: [] })).toBe("L1 · level-1 · authoring-workflow · rune xhigh↘high");
		expect(authoringStatusText(null, "consult", { model: "xai/grok-4.6", thinking: "high", callsign: "rune", appendSystemPrompts: [] })).toBe("L- · consult · authoring-workflow · rune xhigh");
	});
});
