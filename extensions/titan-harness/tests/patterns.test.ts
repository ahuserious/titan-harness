import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChain, sha256, verifyChain } from "../modules/hash-chain.ts";
import { readLedger } from "../modules/ledger.ts";
import { HYPOTHESES_FILE, NOTEBOOK_FILE, RunStore, readHypothesisLinks, readNotebook } from "../modules/run-store.ts";
import { FULL_TOOLS, READONLY_TOOLS } from "../modules/runtime.ts";
import { DEFAULT_STACK_SETTINGS } from "../modules/stack-config.ts";
import { type AgentRequest, type AgentResult, type ExecuteOptions, type RunResult, type WorkflowRuntimeDeps, executeWorkflow } from "../modules/workflow/executor.ts";
import type { LoadedWorkflow } from "../modules/workflow/loader.ts";
import { BEST_OF_DEFAULT_N, candidateCount, judgePrompt, judgeSeat } from "../modules/workflow/nodes/best-of.ts";
import { decide, extractLinks, tallyLinks } from "../modules/workflow/nodes/hypothesis.ts";
import { segmentLabels, segmentPrompt, synthesisPrompt } from "../modules/workflow/nodes/interleave.ts";
import type { NodeDoc, WorkflowDoc } from "../modules/workflow/schema.ts";

// ═══ Harness: a run store in a temp dir, an agent stub keyed by callsign/role — no pi, no network ═══

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "titan-patterns-"));
	dirs.push(dir);
	return dir;
}

type Answer = (req: AgentRequest, call: number) => Partial<AgentResult> | undefined;

interface Harness {
	deps: WorkflowRuntimeDeps;
	store: RunStore;
	runDir: string;
	runId: string;
	agentCalls: AgentRequest[];
	notices: Array<{ text: string; level?: string }>;
}

function harness(answer: Answer = () => undefined, bash?: (command: string) => { code: number; stdout: string; stderr: string }): Harness {
	const store = new RunStore(scratch());
	const cwd = scratch();
	const { runId, dir: runDir } = store.open({ projectSlug: RunStore.projectSlug(cwd), cwd, workflow: { name: "t", sha256: sha256("t") }, command: "workflow" });
	const agentCalls: AgentRequest[] = [];
	const notices: Array<{ text: string; level?: string }> = [];
	let calls = 0;
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
			calls++;
			const base: AgentResult = { ok: true, text: `${req.callsign ?? req.nodeId} done`, sessionRef: `sess-${req.callsign ?? req.nodeId}-${calls}`, usage: { tokensIn: 100, tokensOut: 50, costUsd: 0.001, tpsSeconds: 2 }, toolCalls: 0, model: req.model };
			return { ...base, ...(answer(req, calls) ?? {}) };
		},
		async bash(command) {
			if (bash) return bash(command);
			return { code: 0, stdout: "ok\n", stderr: "" };
		},
		async script() {
			return { code: 0, stdout: "", stderr: "" };
		},
		async approval() {
			return { approved: false };
		},
		notify(text, level) {
			notices.push({ text, level });
		},
		resolveRole(role) {
			return { model: `stub/${role}`, thinking: "medium", callsign: `${role}-1`, appendSystemPrompts: [], tools: role === "architect" ? READONLY_TOOLS : FULL_TOOLS };
		},
	};
	return { deps, store, runDir, runId, agentCalls, notices };
}

function loaded(nodes: NodeDoc[], extra: Partial<WorkflowDoc> = {}): LoadedWorkflow {
	const doc: WorkflowDoc = { apiVersion: "titan.harness/v1", name: "t", version: 1, nodes, ...extra };
	const dir = scratch();
	return { doc, normalized: doc, name: "t", dir, path: join(dir, "t.yaml"), sha256: sha256(JSON.stringify(doc)), source: "project", commands: {}, scripts: {}, validation: { ok: true, errors: [], warnings: [] } } as LoadedWorkflow;
}

const run = (h: Harness, nodes: NodeDoc[], opts: ExecuteOptions = {}, extra: Partial<WorkflowDoc> = {}): Promise<RunResult> => executeWorkflow(loaded(nodes, extra), h.deps, opts);
const events = (h: Harness) => readChain(join(h.runDir, "events.jsonl"));
const meta = (h: Harness, id: string) => JSON.parse(readFileSync(join(h.runDir, "artifacts", "nodes", `${id}.meta.json`), "utf8"));
const verdict = (winner: number, summary = "picked") => JSON.stringify({ winner, scores: [{ candidate: winner, score: 9, reason: "best" }], summary });

// ═══ best_of (A4) ═══════════════════════════════════════════════════════════

describe("best_of: n candidates, an anonymous judge, the winner delivered", () => {
	const texts: Record<string, string> = { "pick-c1": "Answer one: use a heap", "pick-c2": "Answer two: use a sorted array", "pick-c3": "Answer three: use a trie" };

	test("n = 3: three fresh candidates + one judge, the judge sees numbered bodies only, losers archived, every call ledgered", async () => {
		const h = harness((req) => (req.role === "judge" ? { text: `Verdict:\n\`\`\`json\n${verdict(2)}\n\`\`\`` } : { text: texts[req.callsign ?? ""] }));
		const result = await run(h, [{ id: "pick", best_of: { n: 3, criteria: "shortest correct answer", prompt: "Solve: $inputs.task" } } as NodeDoc], { inputs: { task: "top-k" } }, { returns: "pick" });
		expect(result.status).toBe("completed");
		expect(result.returns).toBe("Answer two: use a sorted array");
		expect(result.nodes.pick).toMatchObject({ status: "success", attempts: 1, output: "Answer two: use a sorted array" });

		const candidates = h.agentCalls.filter((r) => r.role !== "judge");
		const judges = h.agentCalls.filter((r) => r.role === "judge");
		expect(candidates.map((r) => r.callsign)).toEqual(["pick-c1", "pick-c2", "pick-c3"]);
		for (const c of candidates) {
			expect(c.context).toBe("fresh");
			expect(c.prompt).toBe("Solve: top-k"); // substituted, no other candidate's text
			expect(c.model).toBe("stub/worker");
		}
		expect(judges).toHaveLength(1);
		const judge = judges[0];
		expect(judge).toMatchObject({ callsign: "pick-judge", model: "stub/judge", context: "fresh" });
		expect(judge.prompt).toContain("Criteria: shortest correct answer");
		for (const [k, text] of [
			[1, texts["pick-c1"]],
			[2, texts["pick-c2"]],
			[3, texts["pick-c3"]],
		] as const) {
			expect(judge.prompt).toContain(`## Candidate ${k}\n\n${text}`);
		}
		// anonymity: no model id, callsign or session ref reaches the judge
		for (const forbidden of ["stub/worker", "stub/", "pick-c1", "pick-c2", "pick-c3", "sess-"]) expect(judge.prompt).not.toContain(forbidden);
		expect(judge.prompt).toContain("Respond with ONLY one JSON object");

		const archive = join(h.runDir, "artifacts", "nodes", "pick", "candidates");
		expect(readFileSync(join(archive, "1.md"), "utf8")).toBe(`${texts["pick-c1"]}\n`);
		expect(readFileSync(join(archive, "3.md"), "utf8")).toBe(`${texts["pick-c3"]}\n`);
		expect(meta(h, "pick")).toMatchObject({ n: 3, candidates: 3, winner: 2, winnerCallsign: "pick-c2", judgeCalls: 1, collapsed: 0, summary: "picked" });

		const ledger = readLedger(h.runDir);
		expect(ledger).toHaveLength(4);
		expect(ledger.filter((row) => row.origin === "judge")).toHaveLength(1);
		expect(ledger.filter((row) => row.origin === "run")).toHaveLength(3);
		expect(result.nodes.pick.usage).toEqual({ tokensIn: 400, tokensOut: 200, costUsd: 0.004, tpsSeconds: 8 });
		const types = events(h).map((e) => e.type);
		expect(types).toContain("best_of.candidates");
		expect(types).toContain("best_of.verdict");
	});

	test("all candidates failed: nothing is delivered and the judge never runs", async () => {
		const h = harness((req) => (req.role === "judge" ? { text: verdict(1) } : { ok: false, text: "", error: "provider down" }));
		const result = await run(h, [{ id: "pick", best_of: { n: 3, prompt: "p" }, retry: { max_attempts: 1 } } as NodeDoc], {}, { returns: "pick" });
		expect(result.status).toBe("failed");
		expect(result.returns).toBeUndefined();
		expect(result.nodes.pick).toMatchObject({ status: "failed", output: undefined, error: expect.stringContaining("all 3 candidates failed") });
		expect(h.agentCalls).toHaveLength(3);
		expect(h.agentCalls.some((r) => r.role === "judge")).toBe(false);
		expect(existsSync(join(h.runDir, "artifacts", "nodes", "pick", "candidates", "2.md"))).toBe(true); // failures are archived as such
	});

	test("an out-of-range or malformed verdict is re-asked in the judge's session ≤ 3 times, then the node fails", async () => {
		const h = harness((req) => (req.role === "judge" ? { text: verdict(9) } : { text: `${req.callsign} text` }));
		const result = await run(h, [{ id: "pick", best_of: { n: 2, prompt: "p" }, retry: { max_attempts: 1 } } as NodeDoc]);
		expect(result.status).toBe("failed");
		expect(result.nodes.pick.error).toMatch(/judge verdict invalid after 3 re-asks: winner must be one of 1, 2/);
		const judges = h.agentCalls.filter((r) => r.role === "judge");
		expect(judges).toHaveLength(4);
		expect(judges[0].context).toBe("fresh");
		for (const again of judges.slice(1)) expect(again.context).toEqual({ resume: expect.stringMatching(/^sess-pick-judge-/) });
		expect(h.notices.filter((n) => n.text.includes("judge verdict invalid"))).toHaveLength(3);
	});

	test("`judge:` may name a model, candidates that collapse are reported, n is clamped", async () => {
		const h = harness((req) => (req.role === "judge" ? { text: verdict(1) } : { text: "same answer" }));
		const result = await run(h, [{ id: "pick", best_of: { n: 2, judge: "xai/grok-4.6", prompt: "p" } } as NodeDoc]);
		expect(result.status).toBe("completed");
		const judge = h.agentCalls.find((r) => r.role === "judge")!;
		expect(judge.model).toBe("xai/grok-4.6");
		expect(h.notices.some((n) => n.text.includes("collapsed"))).toBe(true);
		expect(meta(h, "pick").collapsed).toBe(1);
		expect(candidateCount({ n: 1 })).toBe(2);
		expect(candidateCount({ n: 99 })).toBe(8);
		expect(candidateCount({ n: Number.NaN })).toBe(BEST_OF_DEFAULT_N);
		expect(judgeSeat(undefined)).toEqual({ role: "judge" });
		expect(judgeSeat("verifier")).toEqual({ role: "verifier" });
		expect(judgeSeat("antigravity/gemini-3.8-flash")).toEqual({ role: "judge", model: "antigravity/gemini-3.8-flash" });
		expect(judgePrompt(undefined, [{ index: 1, text: "a" }])).toContain("Criteria: correctness first");
	});
});

// ═══ interleave (A10) ═══════════════════════════════════════════════════════

describe("interleave: fresh segments, one synthesis, no cross-contamination", () => {
	const labels = ["auth.ts", "billing.ts", "cache.ts", "db.ts"];

	test("4 segments ⇒ 4 fresh sessions + 1 read-only synthesis; each segment sees only itself; the synthesis sees all", async () => {
		const h = harness((req) => (req.callsign === "int-synth" ? { text: "SYNTHESIS: all four reviewed" } : { text: `review of ${req.prompt.match(/: (\S+)\n/)?.[1]}` }));
		const result = await run(h, [{ id: "int", interleave: { segments: labels, by: "files", prompt: "Review $SEGMENT (one of $SEGMENT_COUNT files) in $inputs.repo." } } as NodeDoc], { inputs: { repo: "acme" } }, { returns: "int" });
		expect(result.status).toBe("completed");
		expect(result.returns).toBe("SYNTHESIS: all four reviewed");
		expect(h.agentCalls).toHaveLength(5);
		const segments = h.agentCalls.slice(0, 4);
		expect(segments.map((r) => r.callsign)).toEqual(["int-s1", "int-s2", "int-s3", "int-s4"]);
		segments.forEach((req, i) => {
			expect(req.context).toBe("fresh");
			expect(req.role).toBe("worker");
			expect(req.prompt).toBe(`Segment ${i + 1} of 4 (files): ${labels[i]}\nWork only on this segment.\n\nReview ${labels[i]} (one of 4 files) in acme.`);
			for (const other of labels.filter((l) => l !== labels[i])) expect(req.prompt).not.toContain(other);
		});
		const synth = h.agentCalls[4];
		expect(synth).toMatchObject({ callsign: "int-synth", role: "architect", context: "fresh", tools: READONLY_TOOLS, model: "stub/architect" });
		for (const label of labels) expect(synth.prompt).toContain(`review of ${label}`);
		expect(synth.prompt).toContain("Synthesize the 4 segment results");
		const archive = join(h.runDir, "artifacts", "nodes", "int", "segments");
		expect(readFileSync(join(archive, "2.md"), "utf8")).toBe("review of billing.ts\n");
		expect(meta(h, "int")).toMatchObject({ segments: 4, by: "files", labels, synthesized: true });
		expect(new Set(readLedger(h.runDir).map((row) => row.agentId)).size).toBe(5);
		expect(events(h).map((e) => e.type)).toEqual(expect.arrayContaining(["interleave.segments", "interleave.synthesis"]));
	});

	test("a failed segment with reauthor fails the node without retry or synthesis and flags meta.reauthor", async () => {
		const h = harness((req) => (req.callsign === "int-s2" ? { ok: false, text: "", error: "context overflow" } : { text: "ok" }));
		const result = await run(h, [{ id: "int", interleave: { segments: 3, reauthor: true, prompt: "p" } } as NodeDoc]);
		expect(result.status).toBe("failed");
		expect(result.nodes.int).toMatchObject({ status: "failed", attempts: 1, error: expect.stringContaining("1 of 3 segments failed (2: context overflow); reauthor requested") });
		expect(h.agentCalls).toHaveLength(3);
		expect(h.agentCalls.some((r) => r.callsign === "int-synth")).toBe(false);
		expect(meta(h, "int")).toMatchObject({ failed: [2], reauthor: true });
		expect(readFileSync(join(h.runDir, "artifacts", "nodes", "int", "segments", "2.md"), "utf8")).toBe("[failed] context overflow\n");
	});

	test("synthesize: false returns the segment texts; numeric segments label 1..N; helpers", async () => {
		const h = harness((req) => ({ text: `seg ${req.callsign}` }));
		const result = await run(h, [{ id: "int", interleave: { segments: 2, synthesize: false, prompt: "p" } } as NodeDoc], {}, { returns: "int" });
		expect(result.status).toBe("completed");
		expect(result.returns).toEqual(["seg int-s1", "seg int-s2"]);
		expect(h.agentCalls).toHaveLength(2);
		expect(segmentLabels(3)).toEqual(["1", "2", "3"]);
		expect(segmentLabels([" a ", "", "b"])).toEqual(["a", "b"]);
		expect(segmentLabels(0)).toEqual([]);
		expect(segmentPrompt("Do $SEGMENT of $SEGMENT_COUNT; $SEGMENTS stays", 2, "x", 5, "sections")).toBe("Segment 2 of 5 (sections): x\nWork only on this segment.\n\nDo x of 5; $SEGMENTS stays");
		expect(synthesisPrompt("n", undefined, [{ index: 1, label: "a", text: "t" }])).toContain("## Segment 1: a\n\nt");
		const bad = await run(harness(), [{ id: "int", interleave: { segments: 1, prompt: "p" } } as NodeDoc]);
		expect(bad.nodes.int).toMatchObject({ status: "failed", attempts: 1, error: expect.stringContaining("segments must be 2–16") });
	});
});

// ═══ hypothesis (A11) ═══════════════════════════════════════════════════════

describe("hypothesis: decisions from evidence links only", () => {
	const hypotheses = [
		{ id: "h1", claim: "cache misses cause the latency" },
		{ id: "h2", claim: "the db pool is exhausted" },
	];
	const linksA = { links: [{ hypothesis: "h1", relation: "supports", evidence: "miss rate 40 %" }, { hypothesis: "h2", relation: "challenges", evidence: "pool at 20 %" }] };
	const linksB = { links: [{ hypothesis: "h1", relation: "supports", evidence: "p99 tracks misses", weight: 2 }, { hypothesis: "h2", relation: "inconclusive", evidence: "no pool metrics after 3am" }, { hypothesis: "zzz", relation: "supports", evidence: "ignored" }] };
	const bashJson = (command: string) => ({ code: 0, stdout: `${JSON.stringify(command.includes("a") ? linksA : linksB)}\n`, stderr: "" });

	test("links from two upstream nodes → tallies, most_supported decision, chained hypotheses.jsonl, decision event", async () => {
		const h = harness(undefined, bashJson);
		const result = await run(
			h,
			[
				{ id: "probe-a", bash: "probe a" } as NodeDoc,
				{ id: "probe-b", bash: "probe b" } as NodeDoc,
				{ id: "decide", depends_on: ["probe-a", "probe-b"], hypothesis: { hypotheses, decide_by: "most_supported" } } as NodeDoc,
			],
			{},
			{ returns: "decide" },
		);
		expect(result.status).toBe("completed");
		expect(result.returns).toMatchObject({ decision: "h1", links: 4, rule: "most_supported" });
		const tallies = (result.returns as { tallies: Record<string, { supports: number; challenges: number; weight: number; counts: Record<string, number> }> }).tallies;
		expect(tallies.h1).toMatchObject({ supports: 3, challenges: 0, weight: 3, counts: { supports: 2, challenges: 0, inconclusive: 0, context: 0 } });
		expect(tallies.h2).toMatchObject({ supports: 0, challenges: 1, inconclusive: 1, weight: -1 });
		expect(h.agentCalls).toHaveLength(0);
		expect(h.notices.some((n) => n.text.includes("undeclared hypotheses (zzz)"))).toBe(true);

		const rows = readHypothesisLinks(h.runDir);
		expect(rows.map((r) => r.type)).toEqual(["link", "link", "link", "link", "decision"]);
		expect(rows[0]).toMatchObject({ runId: h.runId, nodeId: "decide", hypothesis: "h1", relation: "supports", evidence: "miss rate 40 %", weight: 1, source: "probe-a", seq: 1 });
		expect(rows[4]).toMatchObject({ type: "decision", hypothesis: "h1", rule: "most_supported", links: 4 });
		expect(verifyChain(join(h.runDir, HYPOTHESES_FILE))).toMatchObject({ ok: true, rows: 5 });
		expect(events(h).find((e) => e.type === "hypothesis.decision")?.data).toMatchObject({ decision: "h1", links: 4 });
		expect(meta(h, "decide")).toMatchObject({ decision: "h1", links: 4, hypotheses: ["h1", "h2"] });
	});

	test("comparison rules: explicit ids and $h binding", async () => {
		const h = harness(undefined, bashJson);
		const nodes = (rule: string): NodeDoc[] => [{ id: "probe-a", bash: "probe a" } as NodeDoc, { id: "probe-b", bash: "probe b" } as NodeDoc, { id: "decide", depends_on: ["probe-a", "probe-b"], hypothesis: { hypotheses, decide_by: rule } } as NodeDoc];
		const explicit = await run(h, nodes("supports(h1) >= 2 && challenges(h1) == 0"), {}, { returns: "decide" });
		expect(explicit.status).toBe("completed");
		expect(explicit.returns).toMatchObject({ decision: "h1" });
		const bound = await run(harness(undefined, bashJson), nodes("supports($h) > challenges($h)"), {}, { returns: "decide" });
		expect(bound.returns).toMatchObject({ decision: "h1", reason: "first hypothesis satisfying supports($h) > challenges($h)" });
		const falseRule = await run(harness(undefined, bashJson), nodes("count_challenges(h2) > 1"));
		expect(falseRule.nodes.decide).toMatchObject({ status: "failed", attempts: 1, error: expect.stringContaining("undecided") });
		const malformed = await run(harness(undefined, bashJson), nodes("supports(h1) >"));
		expect(malformed.nodes.decide).toMatchObject({ status: "failed", attempts: 1, error: expect.stringContaining("decide_by:") });
	});

	test("no links → failed, never retried, no agent call; a tie is undecided", async () => {
		const h = harness(undefined, () => ({ code: 0, stdout: "prose only, no links\n", stderr: "" }));
		const result = await run(h, [{ id: "probe-a", bash: "probe a" } as NodeDoc, { id: "decide", depends_on: ["probe-a"], hypothesis: { hypotheses, decide_by: "most_supported" } } as NodeDoc]);
		expect(result.status).toBe("failed");
		expect(result.nodes.decide).toMatchObject({ status: "failed", attempts: 1, error: "hypothesis: no evidence links — decisions come from links, not prose" });
		expect(h.agentCalls).toHaveLength(0);
		expect(readHypothesisLinks(h.runDir)).toEqual([]);
		const tie = await run(
			harness(undefined, () => ({ code: 0, stdout: JSON.stringify({ links: [{ hypothesis: "h1", relation: "supports", evidence: "x" }, { hypothesis: "h2", relation: "supports", evidence: "y" }] }), stderr: "" })),
			[{ id: "probe-a", bash: "probe a" } as NodeDoc, { id: "decide", depends_on: ["probe-a"], hypothesis: { hypotheses, decide_by: "most_supported" } } as NodeDoc],
		);
		expect(tie.nodes.decide.error).toContain("tie between h1, h2");
	});

	test("pure helpers: extractLinks, tallyLinks, decide", () => {
		expect(extractLinks({ links: [{ hypothesis: "a", relation: "supports", evidence: 1 }, { id: "b", relation: "context", evidence: "e", weight: -3 }, { hypothesis: "c", relation: "maybe" }, null] }, "src")).toEqual([
			{ hypothesis: "a", relation: "supports", evidence: "1", weight: 1, source: "src" },
			{ hypothesis: "b", relation: "context", evidence: "e", weight: 1, source: "src" },
		]);
		expect(extractLinks("prose", "src")).toEqual([]);
		const tallies = tallyLinks(["a", "b"], [
			{ hypothesis: "a", relation: "supports", evidence: "", weight: 2, source: "s" },
			{ hypothesis: "a", relation: "challenges", evidence: "", weight: 0.5, source: "s" },
			{ hypothesis: "zzz", relation: "supports", evidence: "", weight: 1, source: "s" },
		]);
		expect(tallies.a).toMatchObject({ supports: 2, challenges: 0.5, weight: 1.5, counts: { supports: 1, challenges: 1 } });
		expect(tallies.b.weight).toBe(0);
		expect(decide("weight(a) > weight(b)", ["a", "b"], tallies)).toEqual({ decision: "a", reason: "weight(a) > weight(b) holds" });
		expect(decide("(supports(a) >= 2 || supports(b) >= 2) && challenges(b) == 0", ["a", "b"], tallies).decision).toBe("a");
		expect(decide("supports(b) > 0", ["a", "b"], tallies)).toEqual({ decision: null, reason: "supports(b) > 0 is false" });
		expect(decide("1 == 1", ["a", "b"], tallies).decision).toBeNull();
		expect(() => decide("supports(nope) > 0", ["a", "b"], tallies)).toThrow("unknown hypothesis nope");
		expect(() => decide("magic(a) > 0", ["a", "b"], tallies)).toThrow("unknown function magic");
		expect(() => decide("supports(a) > 0 extra", ["a", "b"], tallies)).toThrow("decide_by:");
	});
});

// ═══ run-store notebook / hypotheses helpers ═══════════════════════════════

describe("run-store: notebook.jsonl and hypotheses.jsonl", () => {
	test("appendNotebook / readNotebook chain rows with the run id; missing files read as empty", () => {
		const store = new RunStore(scratch());
		const cwd = scratch();
		const { runId, dir } = store.open({ projectSlug: "p", cwd, command: "workflow" });
		expect(readNotebook(dir)).toEqual([]);
		expect(readHypothesisLinks(dir)).toEqual([]);
		store.appendNotebook(dir, { type: "note", nodeId: "n1", text: "first" });
		store.appendNotebook(dir, { type: "decision", nodeId: "n1", decision: "h1" });
		const rows = readNotebook(dir);
		expect(rows.map((r) => [r.seq, r.type, r.nodeId, r.runId])).toEqual([
			[1, "note", "n1", runId],
			[2, "decision", "n1", runId],
		]);
		expect(verifyChain(join(dir, NOTEBOOK_FILE))).toMatchObject({ ok: true, rows: 2 });
		store.appendHypothesisLink(dir, { type: "link", nodeId: "n2", hypothesis: "h1", relation: "supports", evidence: "e", weight: 1 });
		expect(readHypothesisLinks(dir)).toHaveLength(1);
		expect(readNotebook(dir)).toHaveLength(2); // separate chains
	});
});
