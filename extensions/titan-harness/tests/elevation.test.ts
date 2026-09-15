import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChain, sha256 } from "../modules/hash-chain.ts";
import { readLedger } from "../modules/ledger.ts";
import { RunStore } from "../modules/run-store.ts";
import { FULL_TOOLS, READONLY_TOOLS } from "../modules/runtime.ts";
import { DEFAULT_STACK_SETTINGS } from "../modules/stack-config.ts";
import {
	ARCHITECT_AGENT_ID,
	elevationTarget,
	findingIdentity,
	freezeRun,
	isFailedVerdict,
	isMechanicalLoop,
	ladderFor,
	normalizeVerdict,
	recordReviewFrame,
	type ReviewFrame,
	reviewedNodeFor,
	requiredKindsFor,
	verificationOf,
	writeEscalationReport,
} from "../modules/workflow/elevation.ts";
import { type AgentRequest, type AgentResult, type ExecuteOptions, type ProcessResult, type RunResult, type WorkflowRuntimeDeps, executeWorkflow } from "../modules/workflow/executor.ts";
import type { LoadedWorkflow } from "../modules/workflow/loader.ts";
import type { NodeDoc, WorkflowDoc } from "../modules/workflow/schema.ts";

// ═══ Harness (the executor test's stub agent/bash/approval, no pi, no network) ═══

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-elevation-"));
	dirs.push(dir);
	return dir;
};

type Answer = string | ((req: AgentRequest, call: number) => Partial<AgentResult> | Promise<Partial<AgentResult>>);
const JSON_ANSWER = (value: unknown): Answer => () => ({ text: JSON.stringify(value) });

interface HarnessOptions {
	answers?: Record<string, Answer[]>;
	bash?: (command: string) => ProcessResult | Promise<ProcessResult>;
	approvals?: Array<{ approved: boolean; response?: string }>;
	familyMax?: (model: string) => string | undefined;
	cwd?: string;
}

interface Harness {
	deps: WorkflowRuntimeDeps;
	store: RunStore;
	runDir: string;
	runId: string;
	cwd: string;
	agentCalls: AgentRequest[];
	bashCalls: string[];
	approvalsAsked: string[];
	notices: Array<{ text: string; level?: string }>;
}

function harness(options: HarnessOptions = {}): Harness {
	const store = new RunStore(scratch());
	const cwd = options.cwd ?? scratch();
	const { runId, dir: runDir } = store.open({ projectSlug: RunStore.projectSlug(cwd), cwd, workflow: { name: "t", sha256: sha256("t") }, command: "workflow" });
	const agentCalls: AgentRequest[] = [];
	const bashCalls: string[] = [];
	const approvalsAsked: string[] = [];
	const notices: Array<{ text: string; level?: string }> = [];
	const counts = new Map<string, number>();
	const approvals = [...(options.approvals ?? [])];
	const deps: WorkflowRuntimeDeps = {
		cwd,
		runId,
		runDir,
		artifactsDir: join(runDir, "artifacts"),
		workflowId: "t",
		store,
		settings: { ...DEFAULT_STACK_SETTINGS },
		async agent(req) {
			agentCalls.push(req);
			const n = (counts.get(req.nodeId) ?? 0) + 1;
			counts.set(req.nodeId, n);
			const scripted = options.answers?.[req.nodeId]?.shift();
			const base: AgentResult = { ok: true, text: `${req.nodeId} done`, sessionRef: `sess-${req.nodeId}-${n}`, usage: { tokensIn: 100, tokensOut: 50, costUsd: 0.001, tpsSeconds: 2 }, toolCalls: 0, model: req.model };
			if (scripted === undefined) return base;
			if (typeof scripted === "string") return { ...base, text: scripted };
			return { ...base, ...(await scripted(req, n)) };
		},
		async bash(command) {
			bashCalls.push(command);
			if (options.bash) return options.bash(command);
			return { code: 0, stdout: "ok\n", stderr: "" };
		},
		async script() {
			return { code: 0, stdout: "{}\n", stderr: "" };
		},
		async approval(message) {
			approvalsAsked.push(message);
			return approvals.shift() ?? { approved: false, response: "no more scripted approvals" };
		},
		notify(text, level) {
			notices.push({ text, level });
		},
		resolveRole(role) {
			return { model: `stub/${role}`, thinking: "medium", callsign: `${role}-1`, appendSystemPrompts: [], tools: role === "architect" ? READONLY_TOOLS : FULL_TOOLS };
		},
		familyMax: options.familyMax,
	};
	return { deps, store, runDir, runId, cwd, agentCalls, bashCalls, approvalsAsked, notices };
}

function loaded(nodes: NodeDoc[], extra: Partial<WorkflowDoc> = {}): LoadedWorkflow {
	const doc: WorkflowDoc = { apiVersion: "titan.harness/v1", name: "t", version: 1, nodes, ...extra };
	const dir = scratch();
	return { doc, normalized: doc, name: "t", dir, path: join(dir, "t.yaml"), sha256: sha256(JSON.stringify(doc)), source: "project", commands: {}, scripts: {}, validation: { ok: true, errors: [], warnings: [] } } as LoadedWorkflow;
}

const run = (h: Harness, nodes: NodeDoc[], opts: ExecuteOptions = {}, extra: Partial<WorkflowDoc> = {}): Promise<RunResult> => executeWorkflow(loaded(nodes, extra), h.deps, opts);
const events = (h: Harness) => readChain(join(h.runDir, "events.jsonl"));
const agent = (h: Harness, id: string) => JSON.parse(readFileSync(join(h.runDir, "agents", `${id}.json`), "utf8"));

const BUILD_AUDIT = (auditExtra: Partial<NodeDoc> = {}): NodeDoc[] => [
	{ id: "implement", prompt: "build the feature", role: "builder" } as NodeDoc,
	{ id: "audit", prompt: "audit $implement.output", role: "auditor", depends_on: ["implement"], output_format: { $ref: "titan://schemas/audit-verdict" }, retry: { max_attempts: 1 }, ...auditExtra } as NodeDoc,
	{ id: "report", prompt: "report", role: "architect", depends_on: ["audit"], when: "$audit.output.status == 'PASS'" } as NodeDoc,
];

// ═══ Pure helpers ═══════════════════════════════════════════════════════════

describe("elevation: verdicts and frames", () => {
	test("normalizeVerdict reads verdict or its status alias, case-insensitively, and harvests findings", () => {
		expect(normalizeVerdict("PASS")).toBeUndefined();
		expect(normalizeVerdict({ summary: "no verdict" })).toBeUndefined();
		expect(normalizeVerdict({ status: "pass", summary: "ok" })).toMatchObject({ verdict: "PASS", summary: "ok", findings: [] });
		expect(normalizeVerdict({ verdict: "scope violation", summary: "x" })?.verdict).toBe("SCOPE_VIOLATION");
		const v = normalizeVerdict({
			verdict: "FAIL",
			summary: "two problems",
			blocking: ["tests missing for export", { category: "correctness", summary: "off-by-one in pager", paths: ["src/pager.ts"], severity: "major" }],
			warnings: [{ message: "long function", file: "src/a.ts" }],
		})!;
		expect(v.verdict).toBe("FAIL");
		expect(v.blocking).toEqual(["tests missing for export", "off-by-one in pager"]);
		expect(v.warnings).toEqual(["long function"]);
		expect(v.findings.map((f) => [f.category, f.severity, f.paths])).toEqual([
			["audit", "blocker", []],
			["correctness", "major", ["src/pager.ts"]],
			["audit", "minor", ["src/a.ts"]],
		]);
		expect(v.findings[1].id).toBe(findingIdentity({ category: "correctness", summary: "off-by-one in pager", paths: ["src/pager.ts"] }));
		expect(findingIdentity({ category: "A", summary: " Off-By-One ", paths: ["b", "a"] })).toBe(findingIdentity({ category: "a", summary: "off-by-one", paths: ["a", "b"] }));
	});

	test("isFailedVerdict and verificationOf implement review-before-report", () => {
		expect(["FAIL", "SAFETY", "SCOPE_VIOLATION"].every((v) => isFailedVerdict(v as never))).toBe(true);
		expect(["PASS", "PASS_WITH_WARNINGS", "INCONCLUSIVE"].some((v) => isFailedVerdict(v as never))).toBe(false);
		const frame = (over: Partial<ReviewFrame>): ReviewFrame => ({ reviewerNodeId: "audit", reviewedNodeId: "implement", verdict: "PASS", verdictHash: "h", reviewerLedgerRow: true, ts: "t", findings: [], ...over });
		expect(verificationOf(undefined, [])).toBe("done-unverified");
		expect(verificationOf(frame({}), [])).toBe("done-verified");
		expect(verificationOf(frame({ verdict: "PASS_WITH_WARNINGS", evidenceStatus: "matched" }), ["screenshot"])).toBe("done-verified");
		expect(verificationOf(frame({ verdict: "FAIL" }), [])).toBe("failed-review");
		expect(verificationOf(frame({ verdict: "INCONCLUSIVE" }), [])).toBe("done-unverified");
		expect(verificationOf(frame({ reviewerLedgerRow: false }), [])).toBe("done-unverified");
		expect(verificationOf(frame({ evidenceStatus: "current-unverified" }), ["screenshot"])).toBe("done-unverified"); // H3d: required evidence missing
		expect(verificationOf(frame({}), ["screenshot"])).toBe("done-unverified"); // required but no evidence at all
		expect(verificationOf(frame({ evidenceStatus: "unavailable" }), [])).toBe("done-unverified");
	});

	test("reviewedNodeFor: explicit reviews, else the nearest builder/worker ancestor; requiredKindsFor merges node and tier kinds", () => {
		const doc: WorkflowDoc = {
			apiVersion: "titan.harness/v1",
			name: "t",
			titan: { evidence: { require: ["log"] } },
			nodes: [
				{ id: "plan", prompt: "p", role: "architect" },
				{ id: "build", prompt: "b", role: "builder", depends_on: ["plan"], evidence: { require: ["screenshot", "log"] } },
				{ id: "verify", bash: "true", depends_on: ["build"] },
				{ id: "audit", prompt: "a", role: "auditor", depends_on: ["verify"] },
				{ id: "audit2", prompt: "a", role: "auditor", depends_on: ["plan"], reviews: "build" } as NodeDoc,
				{ id: "audit3", prompt: "a", role: "auditor", depends_on: ["plan"] },
			] as NodeDoc[],
		};
		expect(reviewedNodeFor(doc, doc.nodes[3])).toBe("build");
		expect(reviewedNodeFor(doc, doc.nodes[4])).toBe("build");
		expect(reviewedNodeFor(doc, doc.nodes[5])).toBeUndefined();
		expect(requiredKindsFor(doc, doc.nodes[1])).toEqual(["screenshot", "log"]);
		expect(requiredKindsFor(doc, doc.nodes[0])).toEqual(["log"]);
		expect(elevationTarget(undefined)).toBe(1);
		expect(elevationTarget(2)).toBe(3);
		expect(elevationTarget(3)).toBe(3);
	});

	test("ladderFor: base, thinking +1 (ceiling-aware, same session), then family max in a fresh session", () => {
		const base = { model: "cerebras/qwen-3.8-27b", thinking: "medium" as const };
		expect(ladderFor(1, base)).toMatchObject({ iteration: 1, thinking: "medium", model: base.model, freshSession: false, note: "base" });
		expect(ladderFor(2, base)).toMatchObject({ iteration: 2, thinking: "high", model: base.model, freshSession: false });
		// qwen caps at high: from high the next step (xhigh) normalizes back to high and the note says so
		const capped = ladderFor(2, { model: base.model, thinking: "high" });
		expect(capped.thinking).toBe("high");
		expect(capped.note).toContain("xhigh↘high");
		const third = ladderFor(3, base, (m) => (m.startsWith("cerebras/") ? "xai/grok-4.6" : undefined));
		expect(third).toMatchObject({ iteration: 3, model: "xai/grok-4.6", freshSession: true });
		expect(third.thinking).toBe("max"); // grok-4.6 has no static ceiling → unknown_model passes max through
		expect(ladderFor(3, base)).toMatchObject({ model: base.model, thinking: "high", freshSession: true }); // no family max → same model, max↘high
		expect(isMechanicalLoop({ id: "l", loop: { prompt: "p", until_bash: "bun test", max_iterations: 3 } } as NodeDoc)).toBe(true);
		expect(isMechanicalLoop({ id: "l", loop: { prompt: "p", until: "DONE", max_iterations: 3 }, on_fail: { action: "elevate" } } as NodeDoc)).toBe(true);
		expect(isMechanicalLoop({ id: "l", loop: { prompt: "p", until: "DONE", max_iterations: 3 } } as NodeDoc)).toBe(false);
	});

	test("recordReviewFrame, writeEscalationReport and freezeRun write the store rows and files", () => {
		const h = harness();
		const frame: ReviewFrame = { reviewerNodeId: "audit", reviewedNodeId: "implement", reviewerCallsign: "ward", verdict: "FAIL", verdictHash: "abc", reviewerLedgerRow: true, ts: "2026-09-15T00:00:00.000Z", summary: "broken", findings: [{ id: "f1", category: "correctness", summary: "off-by-one", paths: ["src/p.ts"], severity: "blocker" }] };
		expect(recordReviewFrame(h.store, h.runDir, frame, undefined, h.deps.artifactsDir)).toBe("failed-review");
		const reviewFile = JSON.parse(readFileSync(join(h.deps.artifactsDir, "reviews", "implement.json"), "utf8"));
		expect(reviewFile).toMatchObject({ reviewedNodeId: "implement", state: "failed-review", latest: { verdict: "FAIL" } });
		expect(reviewFile.history).toHaveLength(1);
		expect(agent(h, "implement").state).toBe("failed-review");
		expect(events(h).find((r) => r.type === "review.verdict")!.data).toMatchObject({ reviewerNodeId: "audit", verdict: "FAIL", state: "failed-review" });
		const report = writeEscalationReport(h.deps.artifactsDir, { runId: h.runId, workflowId: "t", nodeId: "audit", nodeType: "prompt", kind: "audit", action: "reauthor", attempts: 1, verdict: "FAIL", findings: frame.findings, evidenceIds: ["e1"], error: "audit verdict FAIL: broken", outputExcerpt: "{}", level: 2, tier: "prototype-analytics", reviewedNodeId: "implement" });
		const text = readFileSync(report.path, "utf8");
		expect(report.sha256).toBe(sha256(text));
		expect(text).toContain("- kind: audit");
		expect(text).toContain("- verdict: reauthor");
		expect(text).toContain("- audit verdict: FAIL");
		expect(text).toContain("| correctness | off-by-one | src/p.ts |");
		expect(text).toContain("- level: 2 → elevate to 3");
		expect(text).toContain("/create-workflow --elevate --from");
		freezeRun(h.store, h.runDir, { runId: h.runId, workflowId: "t", nodeId: "audit", kind: "audit", action: "reauthor", attempts: 1, findings: [], evidenceIds: [], report: report.path, level: 2 });
		expect(h.store.readRun(h.runDir).status).toBe("reauthored");
		expect(events(h).find((r) => r.type === "elevation.freeze")!.data).toMatchObject({ kind: "audit", nodeId: "audit", report: report.path, targetLevel: 3 });
		expect(agent(h, ARCHITECT_AGENT_ID).state).toBe("repairing-workflow");
	});
});

// ═══ Through the executor ═══════════════════════════════════════════════════

describe("elevation: the audit loop through the executor", () => {
	test("a PASS verdict with a reviewer ledger row makes the builder done-verified and the report node runs", async () => {
		const h = harness({ answers: { audit: [JSON_ANSWER({ verdict: "PASS", summary: "clean", checklist: { tests: "PASS" } })] } });
		const result = await run(h, BUILD_AUDIT());
		expect(result.status).toBe("completed");
		expect(result.nodes.audit.output).toMatchObject({ verdict: "PASS", status: "PASS" }); // both spellings stored
		expect(result.nodes.report.status).toBe("success"); // `when: $audit.output.status == 'PASS'` routed on the alias
		expect(result.verification).toEqual({ implement: "done-verified" });
		expect(result.verified).toEqual({ verified: 1, unverified: 0, failedReview: 0 });
		expect(result.unverified).toBe(false);
		expect(agent(h, "implement").state).toBe("done-verified");
		expect(readLedger(h.runDir).find((r) => r.agentId === "audit")).toMatchObject({ origin: "auditor" });
		const frame = events(h).find((r) => r.type === "review.verdict")!.data as Record<string, unknown>;
		expect(frame).toMatchObject({ reviewerNodeId: "audit", reviewedNodeId: "implement", reviewerCallsign: "auditor-1", verdict: "PASS", reviewerLedgerRow: true, state: "done-verified" });
		expect(existsSync(join(h.deps.artifactsDir, "reviews", "implement.json"))).toBe(true);
		expect(h.store.readRun(h.runDir).status).toBe("completed");
	});

	test("H3c/H3d: a seeded defect is caught — the FAIL verdict names it, the run freezes as repairing-workflow with the findings package", async () => {
		const h = harness({
			answers: {
				implement: ["function page(n) { return items.slice(n, n + 10); } // TODO: off-by-one"],
				audit: [
					(req) => ({
						text: JSON.stringify(
							req.prompt.includes("off-by-one")
								? { verdict: "FAIL", summary: "seeded defect present", blocking: [{ category: "correctness", summary: "off-by-one in page()", paths: ["src/page.ts"] }], warnings: ["no tests"] }
								: { verdict: "PASS", summary: "missed it" },
						),
					}),
				],
			},
		});
		const result = await run(h, BUILD_AUDIT({ on_fail: { action: "reauthor" } }), {}, { titan: { level: 1, tier: "prototype-analytics" } });
		expect(result.status).toBe("failed");
		expect(result.nodes.audit).toMatchObject({ status: "failed", attempts: 1, error: "audit verdict FAIL: seeded defect present" });
		expect(result.nodes.report.status).toBe("cancelled");
		expect(h.agentCalls.filter((c) => c.nodeId === "audit")).toHaveLength(1); // a failed verdict is never re-asked
		const report = join(h.deps.artifactsDir, "escalation-report.md");
		expect(result.escalationReport).toBe(report);
		expect(result.error).toBe(`repairing-workflow: audit audit verdict FAIL → ${report}`);
		expect(result.frozen).toMatchObject({ kind: "audit", nodeId: "audit", report, reviewedNodeId: "implement", verdict: "FAIL" });
		expect(result.verification).toEqual({ implement: "failed-review" });
		expect(result.verified).toEqual({ verified: 0, unverified: 0, failedReview: 1 });
		const text = readFileSync(report, "utf8");
		expect(text).toContain("- kind: audit");
		expect(text).toContain("- verdict: reauthor");
		expect(text).toContain("- audit verdict: FAIL");
		expect(text).toContain("- reviewed node: implement");
		expect(text).toContain("| correctness | off-by-one in page() | src/page.ts |");
		expect(text).toContain("| audit | no tests | — |");
		expect(text).toContain("- level: 1 → elevate to 2");
		expect(text).toContain("- tier: prototype-analytics");
		expect(h.store.readRun(h.runDir).status).toBe("reauthored");
		expect(agent(h, "implement").state).toBe("failed-review");
		expect(agent(h, ARCHITECT_AGENT_ID).state).toBe("repairing-workflow");
		const evs = events(h);
		expect(evs.find((r) => r.type === "elevation.report")!.data).toMatchObject({ nodeId: "audit", action: "reauthor", kind: "audit", attempts: 1, path: report, sha256: sha256(text), verdict: "FAIL", reviewedNodeId: "implement" });
		expect(evs.find((r) => r.type === "elevation.freeze")!.data).toMatchObject({ kind: "audit", nodeId: "audit", report, targetLevel: 2, reviewedNodeId: "implement", findings: 2 });
		expect(h.notices.some((n) => n.level === "error" && n.text.includes("reauthor →"))).toBe(true);
	});

	test("the `reauthor` cancel node is the P4 stand-in for /create-workflow --from-findings and receives the report path", async () => {
		const h = harness({ answers: { audit: [JSON_ANSWER({ verdict: "SAFETY", summary: "deletes prod data" })] } });
		const result = await run(h, [...BUILD_AUDIT({ on_fail: { action: "reauthor" } }), { id: "reauthor", cancel: "repair workflow needed: $REJECTION_REASON", depends_on: ["audit"], trigger_rule: "all_done" } as NodeDoc]);
		expect(result.status).toBe("failed");
		expect(result.nodes.reauthor.status).toBe("cancelled");
		expect(String(result.nodes.reauthor.error)).toContain(`repair workflow needed: ${join(h.deps.artifactsDir, "escalation-report.md")}`);
		expect(events(h).find((r) => r.type === "node.start" && (r.data as { nodeId: string }).nodeId === "reauthor")!.data).toMatchObject({ standIn: true });
	});

	test("the third failed audit for the same node elevates even without on_fail", async () => {
		const failing = JSON_ANSWER({ verdict: "FAIL", summary: "still broken", blocking: ["x"] });
		const h = harness({ answers: { audit: [failing, failing, failing] } });
		const result = await run(h, [
			{ id: "implement", prompt: "build", role: "builder" } as NodeDoc,
			{ id: "audit", prompt: "audit", role: "auditor", depends_on: ["implement"], output_format: { $ref: "titan://schemas/audit-verdict" }, retry: { max_attempts: 3, delay_ms: 0 }, on_fail: { action: "retry", max: 3 } } as NodeDoc,
		]);
		// attempts 1 and 2 fail the audit node (retry budget 3 re-runs the auditor), the third frame freezes with kind elevate
		expect(h.agentCalls.filter((c) => c.nodeId === "audit")).toHaveLength(1); // a failed VERDICT is not retryable — one call
		expect(result.nodes.audit.status).toBe("failed");
		expect(result.frozen).toBeUndefined();
		// … so three failures need three audit rounds: a loop of three audit nodes on the same reviewed node
		const h3 = harness({ answers: { "audit-1": [failing], "audit-2": [failing], "audit-3": [failing] } });
		const r3 = await run(h3, [
			{ id: "implement", prompt: "build", role: "builder" } as NodeDoc,
			{ id: "audit-1", prompt: "audit", role: "auditor", depends_on: ["implement"], output_format: { $ref: "titan://schemas/audit-verdict" }, reviews: "implement" } as NodeDoc,
			{ id: "audit-2", prompt: "audit", role: "auditor", depends_on: ["audit-1"], trigger_rule: "all_done", output_format: { $ref: "titan://schemas/audit-verdict" }, reviews: "implement" } as NodeDoc,
			{ id: "audit-3", prompt: "audit", role: "auditor", depends_on: ["audit-2"], trigger_rule: "all_done", output_format: { $ref: "titan://schemas/audit-verdict" }, reviews: "implement" } as NodeDoc,
			{ id: "ship", prompt: "ship", role: "builder", depends_on: ["audit-3"], trigger_rule: "all_done" } as NodeDoc,
		]);
		expect(r3.status).toBe("failed");
		expect(r3.nodes["audit-1"].status).toBe("failed");
		expect(r3.nodes["audit-2"].status).toBe("failed");
		expect(r3.nodes["audit-3"].status).toBe("failed");
		expect(r3.nodes.ship.status).toBe("cancelled");
		expect(r3.frozen).toMatchObject({ kind: "elevate", nodeId: "audit-3", reviewedNodeId: "implement" });
		expect(r3.error).toContain("failed audit 3/3 → elevate");
		expect(readFileSync(r3.escalationReport!, "utf8")).toContain("- kind: elevate");
		expect(h3.store.readRun(h3.runDir).status).toBe("reauthored");
		expect(JSON.parse(readFileSync(join(h3.deps.artifactsDir, "reviews", "implement.json"), "utf8")).history).toHaveLength(3);
	});

	test("review-before-report: an unreviewed builder is done-unverified, the run reports it, and an architect downstream is told", async () => {
		const h = harness();
		const result = await run(h, [
			{ id: "build", prompt: "build", role: "builder" } as NodeDoc,
			{ id: "summarize", prompt: "summarize $build.output", role: "architect", depends_on: ["build"] } as NodeDoc,
		]);
		expect(result.status).toBe("completed");
		expect(result.verification).toEqual({ build: "done-unverified" });
		expect(result.verified).toEqual({ verified: 0, unverified: 1, failedReview: 0 });
		expect(result.unverified).toBe(true);
		expect(agent(h, "build").state).toBe("done-unverified");
		const architect = h.agentCalls.find((c) => c.nodeId === "summarize")!;
		expect(architect.prompt.startsWith("[titan] upstream output build is UNVERIFIED (no review frame)")).toBe(true);
		expect(architect.prompt).toContain("summarize build done");
		// a worker downstream is not lectured
		const w = harness();
		await run(w, [{ id: "build", prompt: "build", role: "builder" } as NodeDoc, { id: "next", prompt: "next", role: "worker", depends_on: ["build"] } as NodeDoc]);
		expect(w.agentCalls.find((c) => c.nodeId === "next")!.prompt).toBe("next");
	});

	test("H3d: required evidence that a verify dependency could not match keeps a PASS verdict at done-unverified", async () => {
		// verify nodes are still stubs in this tree; a verify-shaped output from a dependency stands in (the frame reads `evidence` off it)
		const h = harness({
			answers: {
				checks: [JSON_ANSWER({ status: "pass", evidence: "current-unverified", evidencePath: "/runs/x/artifacts/evidence/checks/evidence.json", missing: ["video"] })],
				audit: [JSON_ANSWER({ verdict: "PASS", summary: "looks fine" })],
			},
		});
		const result = await run(h, [
			{ id: "implement", prompt: "build", role: "builder", evidence: { require: ["screenshot", "video"] } } as NodeDoc,
			{ id: "checks", prompt: "verify", role: "verifier", depends_on: ["implement"], output_format: { type: "object", properties: { status: { type: "string" }, evidence: { type: "string" }, evidencePath: { type: "string" }, missing: { type: "array" } }, required: ["status", "evidence"] } } as NodeDoc,
			{ id: "audit", prompt: "audit", role: "auditor", depends_on: ["checks"], output_format: { $ref: "titan://schemas/audit-verdict" } } as NodeDoc,
		]);
		expect(result.status).toBe("completed");
		// the verifier's output has no verdict field so it is not a frame; the auditor's PASS is, but the builder's required kinds are not matched
		expect(result.verification).toEqual({ implement: "done-unverified" });
		expect(agent(h, "implement").state).toBe("done-unverified");
	});
});

describe("elevation: the mechanical ladder through the executor", () => {
	test("three mechanical fails climb the ladder (thinking +1, then family max fresh) and freeze the run with kind mechanical", async () => {
		const h = harness({
			answers: { implement: ["attempt one", "attempt two", "attempt three"] },
			bash: (command) => (command.startsWith("bun test") ? { code: 1, stdout: "3 fail\n", stderr: "" } : { code: 0, stdout: "ok\n", stderr: "" }),
			familyMax: (model) => (model === "cerebras/qwen-3.8-27b" ? "cerebras/qwen-3.8-27b-max" : undefined),
		});
		const result = await run(h, [
			{ id: "implement", role: "builder", model: "cerebras/qwen-3.8-27b", thinking: "medium", loop: { prompt: "make the suite green ($LOOP_COUNT) $LOOP_USER_INPUT", until: "GREEN", until_bash: "bun test", max_iterations: 3 }, on_fail: { action: "elevate", max: 3 } } as NodeDoc,
			{ id: "verify", prompt: "verify", depends_on: ["implement"] } as NodeDoc,
		]);
		expect(result.status).toBe("failed");
		expect(result.error).toBe("elevation: implement failed 1 times"); // one node attempt: the loop's max_iterations is THE budget
		expect(result.nodes.implement).toMatchObject({ status: "failed", attempts: 1, error: "loop did not complete within 3 iterations" });
		const calls = h.agentCalls.filter((c) => c.nodeId === "implement");
		expect(calls).toHaveLength(3);
		expect(calls.map((c) => [c.model, c.thinking, c.context])).toEqual([
			["cerebras/qwen-3.8-27b", "medium", "fresh"],
			["cerebras/qwen-3.8-27b", "high", { resume: "sess-implement-1" }],
			["cerebras/qwen-3.8-27b-max", "max", "fresh"],
		]);
		expect(calls[1].prompt).toContain("until_bash exit 1"); // the failing log rides $LOOP_USER_INPUT
		expect(calls[1].prompt).toContain("3 fail");
		expect(h.bashCalls.filter((c) => c.startsWith("bun test"))).toHaveLength(3);
		expect(h.notices.filter((n) => n.text.includes("ladder step"))).toHaveLength(2);
		const report = readFileSync(result.escalationReport!, "utf8");
		expect(report).toContain("- kind: mechanical");
		expect(report).toContain("- verdict: elevate");
		expect(report).toContain("- iterations: 3");
		expect(report).toContain("- ladder: 1: base → 2: thinking +1");
		expect(result.frozen).toMatchObject({ kind: "mechanical", nodeId: "implement" });
		expect(h.store.readRun(h.runDir).status).toBe("reauthored");
		expect(events(h).find((r) => r.type === "elevation.freeze")!.data).toMatchObject({ kind: "mechanical", nodeId: "implement", targetLevel: 1 });
		expect(result.nodes.verify.status).toBe("cancelled");
	});

	test("a mechanical loop that goes green on the second step succeeds with the ladder recorded; a plain loop never climbs", async () => {
		let runs = 0;
		const h = harness({ answers: { implement: ["red", "green now"] }, bash: () => ({ code: runs++ === 0 ? 1 : 0, stdout: "", stderr: "" }) });
		const result = await run(h, [{ id: "implement", role: "builder", loop: { prompt: "fix", until_bash: "bun test", max_iterations: 3 } } as NodeDoc]);
		expect(result.status).toBe("completed");
		const calls = h.agentCalls.filter((c) => c.nodeId === "implement");
		expect(calls.map((c) => c.thinking)).toEqual(["medium", "high"]);
		const meta = JSON.parse(readFileSync(join(h.runDir, "artifacts", "nodes", "implement.meta.json"), "utf8"));
		expect(meta).toMatchObject({ iterations: 2, completedBy: "until_bash", mechanical: true });
		expect(meta.ladder).toHaveLength(2);

		const plain = harness({ answers: { think: ["no", "no", "DONE"] } });
		await run(plain, [{ id: "think", loop: { prompt: "think", until: "DONE", max_iterations: 3 } } as NodeDoc]);
		expect(plain.agentCalls.map((c) => c.thinking)).toEqual(["medium", "medium", "medium"]);
		expect(plain.notices.some((n) => n.text.includes("ladder"))).toBe(false);
	});
});
