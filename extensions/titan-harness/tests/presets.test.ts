import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../modules/hash-chain.ts";
import { RunStore } from "../modules/run-store.ts";
import { FULL_TOOLS, READONLY_TOOLS } from "../modules/runtime.ts";
import { DEFAULT_STACK_SETTINGS } from "../modules/stack-config.ts";
import { type AgentRequest, type AgentResult, type RunResult, type WorkflowRuntimeDeps, executeWorkflow } from "../modules/workflow/executor.ts";
import type { LoadedWorkflow } from "../modules/workflow/loader.ts";
import { countApprovals, loadPresets, parsePreset, parseReviewResponse, presetByKey, presetDirs, readReceipts, receiptsDirFor, writeReceipt } from "../modules/workflow/presets.ts";
import type { NodeDoc, WorkflowDoc } from "../modules/workflow/schema.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-presets-"));
	dirs.push(dir);
	return dir;
};

const PRESET = `key: saas-blog-post-founder
industry: saas
content_type: blog-post
preference_profile:
  voice: founder
  tone: direct
  banned_claims: ["guaranteed", "#1"]
  style_guide_ref: .titan/terraform/style.md
rubric:
  - { criterion: accuracy, threshold: 4 }
  - { criterion: clarity }
reviewers:
  human_min: 3
  roles: [editor, founder, legal]
`;

function projectWith(files: Record<string, string>): string {
	const cwd = scratch();
	const dir = join(cwd, ".titan", "presets", "content");
	mkdirSync(dir, { recursive: true });
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
	return cwd;
}

describe("presets: catalog", () => {
	test("parsePreset validates the shape and fills defaults; invalid files name the path and every problem", () => {
		const preset = parsePreset(PRESET, "/p/saas.yaml");
		expect(preset).toMatchObject({ key: "saas-blog-post-founder", industry: "saas", content_type: "blog-post", source: "project", path: "/p/saas.yaml" });
		expect(preset.preference_profile).toEqual({ voice: "founder", tone: "direct", banned_claims: ["guaranteed", "#1"], style_guide_ref: ".titan/terraform/style.md" });
		expect(preset.rubric).toEqual([{ criterion: "accuracy", threshold: 4 }, { criterion: "clarity" }]);
		expect(preset.reviewers).toEqual({ human_min: 3, roles: ["editor", "founder", "legal"] });
		expect(parsePreset("key: k\nindustry: i\ncontent_type: c\npreference_profile: {}\nrubric: [tone]\n", "/p/min.yaml").reviewers).toEqual({ human_min: 3, roles: [] });
		expect(() => parsePreset("key: Bad Key\nindustry: x\n", "/p/bad.yaml")).toThrow(/preset \/p\/bad\.yaml is invalid:[\s\S]*key must match[\s\S]*content_type is required[\s\S]*preference_profile must be[\s\S]*rubric must be/);
		expect(() => parsePreset("key: k\nindustry: i\ncontent_type: c\npreference_profile: {}\nrubric: [a]\nreviewers: { human_min: 0 }\n", "/p/h.yaml")).toThrow("human_min must be an integer 1–20");
		expect(() => parsePreset("key: k\nindustry: i\ncontent_type: c\npreference_profile: {}\nrubric: [a]\nreceipts_dir: ../../etc\n", "/p/r.yaml")).toThrow("receipts_dir must stay inside");
		expect(() => parsePreset("- not a mapping", "/p/list.yaml")).toThrow("must be a mapping");
		expect(() => parsePreset("key: [unclosed", "/p/torn.yaml")).toThrow("not valid YAML");
	});

	test("loadPresets: project shadows package by key, sorted by key; the shipped example loads; presetByKey finds one", () => {
		const pkg = scratch();
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, "shared.yaml"), PRESET.replace("key: saas-blog-post-founder", "key: shared").replace("voice: founder", "voice: package"));
		writeFileSync(join(pkg, "only-pkg.yaml"), PRESET.replace("key: saas-blog-post-founder", "key: only-pkg"));
		const cwd = projectWith({ "shared.yaml": PRESET.replace("key: saas-blog-post-founder", "key: shared").replace("voice: founder", "voice: project"), "zeta.yaml": PRESET.replace("key: saas-blog-post-founder", "key: zeta") });
		const all = loadPresets(cwd, { package: pkg });
		expect(all.map((p) => [p.key, p.source])).toEqual([
			["only-pkg", "package"],
			["shared", "project"],
			["zeta", "project"],
		]);
		expect(presetByKey(cwd, "shared", { package: pkg })?.preference_profile.voice).toBe("project");
		expect(presetByKey(cwd, "nope", { package: pkg })).toBeUndefined();
		// an invalid project file fails loudly rather than being skipped
		writeFileSync(join(cwd, ".titan", "presets", "content", "broken.yaml"), "key: broken\n");
		expect(() => loadPresets(cwd, { package: pkg })).toThrow("broken.yaml is invalid");
		// the shipped catalog: README + example preset
		const shipped = presetDirs(scratch()).package;
		expect(existsSync(join(shipped, "README.md"))).toBe(true);
		const example = loadPresets(scratch()).find((p) => p.key === "example-saas-blog-post-founder");
		expect(example).toMatchObject({ source: "package", reviewers: { human_min: 3 } });
		expect(example!.rubric.length).toBeGreaterThanOrEqual(3);
	});

	test("receipts: parseReviewResponse, writeReceipt, readReceipts, countApprovals (distinct named reviewers)", () => {
		expect(parseReviewResponse(undefined)).toEqual({ reviewer: "human", rubricScores: {} });
		expect(parseReviewResponse("reviewer: Dana; accuracy=5, clarity=4")).toEqual({ reviewer: "Dana", rubricScores: { accuracy: 5, clarity: 4 } });
		expect(parseReviewResponse("by: Lee\nbrand-fit: 3/5")).toEqual({ reviewer: "Lee", rubricScores: { "brand-fit": 3 } });
		expect(parseReviewResponse("looks good")).toEqual({ reviewer: "human", rubricScores: {} });
		const dir = join(scratch(), "receipts", "k");
		const content = sha256("draft v1");
		const base = { presetKey: "k", decision: "approve" as const, rubricScores: {}, ts: "t", contentSha256: content };
		const first = writeReceipt(dir, { ...base, reviewer: "Dana" });
		expect(first).toBe(join(dir, `${content}-1.json`));
		writeReceipt(dir, { ...base, reviewer: "dana" }); // same reviewer, different case → one distinct approval
		writeReceipt(dir, { ...base, reviewer: "Lee" });
		writeReceipt(dir, { ...base, reviewer: "human" });
		writeReceipt(dir, { ...base, reviewer: "human" });
		writeReceipt(dir, { ...base, reviewer: "Sam", decision: "reject" });
		writeReceipt(dir, { ...base, reviewer: "Other", contentSha256: sha256("draft v2") });
		expect(readdirSync(dir)).toHaveLength(7);
		expect(readReceipts(dir, content)).toHaveLength(6);
		expect(countApprovals(dir, content)).toEqual({ approve: 4, reject: 1, reviewers: ["Dana", "Lee", "human", "human"] });
		expect(countApprovals(dir, sha256("draft v2")).approve).toBe(1);
		expect(countApprovals(join(dir, "missing"), content)).toEqual({ approve: 0, reject: 0, reviewers: [] });
		writeFileSync(join(dir, `${content}-9.json`), "{ torn");
		expect(countApprovals(dir, content).approve).toBe(4); // a torn receipt never counts
		expect(receiptsDirFor("/a", { key: "k" })).toBe(join("/a", "receipts", "k"));
		expect(receiptsDirFor("/a", { key: "k", receipts_dir: "custom/dir" })).toBe(join("/a", "custom", "dir"));
	});
});

// ═══ H3f through the executor ═══════════════════════════════════════════════

interface Harness {
	deps: WorkflowRuntimeDeps;
	runDir: string;
	approvalsAsked: string[];
	agentCalls: AgentRequest[];
}

function harness(cwd: string, approvals: Array<{ approved: boolean; response?: string }>, answers: Record<string, string[]> = {}): Harness {
	const store = new RunStore(scratch());
	const { runId, dir: runDir } = store.open({ projectSlug: RunStore.projectSlug(cwd), cwd, workflow: { name: "t", sha256: sha256("t") }, command: "workflow" });
	const approvalsAsked: string[] = [];
	const agentCalls: AgentRequest[] = [];
	const queue = [...approvals];
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
			const text = answers[req.nodeId]?.shift() ?? `${req.nodeId} done`;
			const base: AgentResult = { ok: true, text, sessionRef: `sess-${req.nodeId}`, usage: { tokensIn: 10, tokensOut: 5, costUsd: 0.0001, tpsSeconds: 1 }, toolCalls: 0, model: req.model };
			return base;
		},
		async bash() {
			return { code: 0, stdout: "ok\n", stderr: "" };
		},
		async script() {
			return { code: 0, stdout: "{}\n", stderr: "" };
		},
		async approval(message) {
			approvalsAsked.push(message);
			return queue.shift() ?? { approved: false, response: "no more scripted approvals" };
		},
		notify() {},
		resolveRole(role) {
			return { model: `stub/${role}`, thinking: "medium", callsign: `${role}-1`, appendSystemPrompts: [], tools: role === "architect" ? READONLY_TOOLS : FULL_TOOLS };
		},
	};
	return { deps, runDir, approvalsAsked, agentCalls };
}

function loaded(nodes: NodeDoc[]): LoadedWorkflow {
	const doc: WorkflowDoc = { apiVersion: "titan.harness/v1", name: "t", version: 1, nodes };
	const dir = scratch();
	return { doc, normalized: doc, name: "t", dir, path: join(dir, "t.yaml"), sha256: sha256(JSON.stringify(doc)), source: "project", commands: {}, scripts: {}, validation: { ok: true, errors: [], warnings: [] } } as LoadedWorkflow;
}

const CONTENT_FLOW = (): NodeDoc[] => [
	{ id: "draft", prompt: "write the post", role: "worker" } as NodeDoc,
	{ id: "review-1", approval: { message: "Editor: approve the draft?", preset_key: "saas-blog-post-founder", content: "$draft.output" }, depends_on: ["draft"] } as NodeDoc,
	{ id: "review-2", approval: { message: "Founder: approve the draft?", preset_key: "saas-blog-post-founder", content: "$draft.output" }, depends_on: ["review-1"] } as NodeDoc,
	{ id: "review-3", approval: { message: "Legal: approve the draft?", preset_key: "saas-blog-post-founder", content: "$draft.output" }, depends_on: ["review-2"] } as NodeDoc,
	{ id: "ship", prompt: "publish $draft.output", role: "judge", depends_on: ["review-3"], when: "$review-3.output.receipts >= 3" } as NodeDoc,
];

describe("presets: H3f approval receipts gate the ship node", () => {
	test("three distinct human approve receipts for the same content let the ship node run", async () => {
		const cwd = projectWith({ "saas-blog-post-founder.yaml": PRESET });
		const h = harness(cwd, [
			{ approved: true, response: "reviewer: Editor; accuracy=5, clarity=4" },
			{ approved: true, response: "reviewer: Founder; accuracy=4" },
			{ approved: true, response: "reviewer: Legal" },
		]);
		const result: RunResult = await executeWorkflow(loaded(CONTENT_FLOW()), h.deps);
		expect(result.status).toBe("completed");
		const contentSha256 = sha256("draft done");
		expect(result.nodes["review-1"].output).toMatchObject({ approved: true, receipts: 1, required: 3, presetKey: "saas-blog-post-founder", contentSha256, reviewers: ["Editor"] });
		expect(result.nodes["review-3"].output).toMatchObject({ approved: true, receipts: 3, required: 3, reviewers: ["Editor", "Founder", "Legal"] });
		expect(result.nodes.ship.status).toBe("success");
		const receiptsDir = join(h.deps.artifactsDir, "receipts", "saas-blog-post-founder");
		const receipts = readReceipts(receiptsDir, contentSha256);
		expect(receipts.map((r) => [r.reviewer, r.decision, r.rubricScores])).toEqual([
			["Editor", "approve", { accuracy: 5, clarity: 4 }],
			["Founder", "approve", { accuracy: 4 }],
			["Legal", "approve", {}],
		]);
		expect(receipts.every((r) => r.presetKey === "saas-blog-post-founder" && r.contentSha256 === contentSha256 && r.nodeId?.startsWith("review-"))).toBe(true);
		expect(JSON.parse(readFileSync(join(h.runDir, "artifacts", "nodes", "review-3.meta.json"), "utf8"))).toMatchObject({ receipts: 3, required: 3, presetKey: "saas-blog-post-founder" });
	});

	test("fewer than three receipts (a rejection, a duplicate reviewer) skip the ship node — the counter blocks, never prose", async () => {
		const cwd = projectWith({ "saas-blog-post-founder.yaml": PRESET });
		// review-2 rejects → cancelled run; the ship node never runs
		const rejected = harness(cwd, [{ approved: true, response: "reviewer: Editor" }, { approved: false, response: "reviewer: Founder; tone is off" }]);
		const r1 = await executeWorkflow(loaded(CONTENT_FLOW()), rejected.deps);
		expect(r1.status).toBe("cancelled");
		expect(r1.nodes.ship.status).toBe("cancelled");
		const dir1 = join(rejected.deps.artifactsDir, "receipts", "saas-blog-post-founder");
		expect(countApprovals(dir1, sha256("draft done"))).toEqual({ approve: 1, reject: 1, reviewers: ["Editor"] });
		// three approvals but the same named reviewer twice → receipts 2 → `when` false → ship skipped
		const duplicate = harness(cwd, [{ approved: true, response: "reviewer: Editor" }, { approved: true, response: "reviewer: editor" }, { approved: true, response: "reviewer: Legal" }]);
		const r2 = await executeWorkflow(loaded(CONTENT_FLOW()), duplicate.deps);
		expect(r2.status).toBe("completed");
		expect(r2.nodes["review-3"].output).toMatchObject({ receipts: 2, required: 3 });
		expect(r2.nodes.ship.status).toBe("skipped");
		expect(r2.nodes.ship.error).toContain("when: $review-3.output.receipts >= 3 → false");
		expect(duplicate.agentCalls.some((c) => c.nodeId === "ship")).toBe(false);
	});

	test("content defaults to the message; an unknown or invalid preset fails the node without retries", async () => {
		const cwd = projectWith({ "saas-blog-post-founder.yaml": PRESET });
		const h = harness(cwd, [{ approved: true }]);
		const r = await executeWorkflow(loaded([{ id: "gate", approval: { message: "Approve v1?", preset_key: "saas-blog-post-founder" } } as NodeDoc]), h.deps);
		expect(r.nodes.gate.output).toMatchObject({ approved: true, receipts: 1, contentSha256: sha256("Approve v1?"), reviewers: ["human"] });
		const missing = harness(cwd, [{ approved: true }]);
		const m = await executeWorkflow(loaded([{ id: "gate", approval: { message: "Approve?", preset_key: "nope" } } as NodeDoc]), missing.deps);
		expect(m.nodes.gate).toMatchObject({ status: "failed", attempts: 1 });
		expect(m.nodes.gate.error).toContain('preset "nope" not found');
		expect(missing.approvalsAsked).toHaveLength(0);
		const broken = projectWith({ "bad.yaml": "key: bad\n" });
		const b = await executeWorkflow(loaded([{ id: "gate", approval: { message: "Approve?", preset_key: "bad" } } as NodeDoc]), harness(broken, [{ approved: true }]).deps);
		expect(b.nodes.gate.status).toBe("failed");
		expect(b.nodes.gate.error).toContain("bad.yaml is invalid");
		// without preset_key the P3 behaviour is untouched
		const plain = harness(cwd, [{ approved: true, response: "fine" }]);
		const p = await executeWorkflow(loaded([{ id: "gate", approval: { message: "ok?", capture_response: true } } as NodeDoc]), plain.deps);
		expect(p.nodes.gate.output).toBe("fine");
		expect(existsSync(join(plain.deps.artifactsDir, "receipts"))).toBe(false);
	});
});
