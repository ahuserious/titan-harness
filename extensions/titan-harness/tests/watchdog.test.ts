import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChain, sha256 } from "../modules/hash-chain.ts";
import { RunStore } from "../modules/run-store.ts";
import type { WatchdogSettings } from "../modules/stack-config.ts";
import {
	type CompactionDeps,
	createMachine,
	createWatchdog,
	EDGES,
	formatActivityTail,
	handleAfterCompact,
	handleBeforeCompact,
	handleCompactFailed,
	inspectPreempted,
	inspectorBudgetMs,
	type InspectorResult,
	type LedgerNote,
	LIMITS,
	mapChildCard,
	noteFinding,
	onAgentStopped,
	onArchitectPing,
	onChildCard,
	onFinding,
	onReviewerError,
	onReviewPass,
	onSpend,
	onUserInput,
	onWorkflowTerminal,
	parseInspection,
	type PreemptDeps,
	shouldPreempt,
	STATE_BLOCK_HEADER,
	stateBlockMessage,
	transition,
	type WatchdogFinding,
	type WatchdogState,
	WATCHDOG_STATES,
	buildStateBlock,
} from "../modules/watchdog/index.ts";
import { boundText, compactionPrompt, inspectionPrompt, render, resumePrompt } from "../modules/watchdog/prompts.ts";

// ═══ Harness: a run store in a temp dir, a seeded run, fake inspectors — no pi, no network ═══

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-watchdog-"));
	dirs.push(dir);
	return dir;
};

const FIXTURES = join(import.meta.dir, "fixtures", "watchdog");
const readLines = (name: string): any[] =>
	readFileSync(join(FIXTURES, name), "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));

const settings = (over: Partial<WatchdogSettings> = {}): WatchdogSettings => ({
	enabled: true,
	model: "cerebras/qwen-3.8-27b",
	thinking: "medium",
	stalemateRepeats: 3,
	onCompaction: "halt-inspect",
	inspectorTimeoutMs: 60,
	preemptAtContextFraction: 0.75,
	...over,
});

/** A seeded run: two agents, a few node events, one evidence package. */
function seededRun(): { store: RunStore; dir: string; runId: string } {
	const store = new RunStore(scratch());
	const cwd = scratch();
	const { runId, dir } = store.open({ projectSlug: RunStore.projectSlug(cwd), cwd, workflow: { name: "proto", sha256: sha256("proto") }, command: "workflow", level: 2, phases: ["plan", "build", "verify"], status: "running" });
	store.updateRun(dir, { currentPhase: "build" });
	store.appendEvent(dir, "workflow.start", { workflow: "proto" });
	store.appendEvent(dir, "node.start", { nodeId: "plan", type: "prompt" });
	store.appendEvent(dir, "node.end", { nodeId: "plan", status: "success" });
	store.appendEvent(dir, "node.start", { nodeId: "implement", type: "loop" });
	store.upsertAgent(dir, { agentId: "plan", callsign: "rune", role: "architect", model: "antigravity/gemini-3.8-flash", state: "done-unverified" });
	store.upsertAgent(dir, { agentId: "implement", callsign: "forge", role: "builder", model: "xai/grok-4.6", state: "dispatched-working", ...({ sessionRef: "sess-forge-1" } as object) });
	store.writeEvidence(dir, "plan", { schemaVersion: 1, runId, nodeId: "plan", status: "matched", artifacts: [] });
	return { store, dir, runId };
}

type FakeInspector = ((prompt: string, opts: { timeoutMs: number; signal?: AbortSignal; model: string; thinking: string; systemPrompt: string }) => Promise<InspectorResult>) & { calls: Array<{ prompt: string; opts: any }> };

function inspector(behaviour: { text?: string; ok?: boolean; hang?: boolean; throws?: string; delayMs?: number; usage?: InspectorResult["usage"] } = {}): FakeInspector {
	const calls: FakeInspector["calls"] = [];
	const fn = (async (prompt: string, opts: any) => {
		calls.push({ prompt, opts });
		if (behaviour.hang) return new Promise<InspectorResult>(() => {});
		if (behaviour.delayMs) await new Promise((r) => setTimeout(r, behaviour.delayMs));
		if (behaviour.throws) throw new Error(behaviour.throws);
		return { ok: behaviour.ok ?? true, text: behaviour.text ?? "Decisions: kept the plan. Open findings: none. Next: verify.", usage: behaviour.usage ?? { tokensIn: 1200, tokensOut: 300, costUsd: 0.0021, tpsSeconds: 2 } };
	}) as FakeInspector;
	fn.calls = calls;
	return fn;
}

function compactionDeps(run: ReturnType<typeof seededRun>, inspect: FakeInspector, over: Partial<CompactionDeps> = {}): CompactionDeps & { rows: LedgerNote[] } {
	const rows: LedgerNote[] = [];
	return { inspect, store: run.store, runDir: run.dir, settings: settings(), ledger: (row) => rows.push(row), entriesText: (entries) => (entries ?? []).map((e) => JSON.stringify(e)).join("\n"), rows, ...over };
}

const event = (reason: "manual" | "threshold" | "overflow", over: Record<string, unknown> = {}) => ({ reason, willRetry: false, preparation: { firstKeptEntryId: "e42", tokensBefore: 120000 }, branchEntries: [{ type: "message", role: "user", text: "build the dashboard" }], ...over });

const eventsOf = (dir: string) => readChain(join(dir, "events.jsonl"));
const agentOf = (store: RunStore, dir: string, id: string) => store.listAgents(dir).find((a) => a.agentId === id) as any;

// ═══ state.ts ═══

describe("watchdog state machine", () => {
	test("follows the §5.5 edges and refuses the others", () => {
		let m = createMachine({ stalemateRepeats: 3 });
		expect(m.state).toBe("idle");
		expect(() => transition(m, "inspecting")).toThrow(/illegal transition idle → inspecting/);
		m = transition(m, "armed", "run started");
		m = transition(m, "inspecting");
		for (const to of ["cleared", "steering", "resuming", "halted-stalemate", "failed"] as WatchdogState[]) {
			expect(transition(m, to).state).toBe(to);
		}
		const cleared = transition(m, "cleared");
		expect(transition(cleared, "armed").lastTransition).toMatch(/cleared → armed/);
		expect(() => transition(transition(m, "halted-stalemate"), "inspecting")).toThrow(/illegal/);
		for (const from of WATCHDOG_STATES) expect(from === "idle" || EDGES[from].includes("idle")).toBe(true);
		expect(transition(m, "inspecting")).toBe(m); // same state: no-op
		expect(() => transition(m, "bogus" as WatchdogState)).toThrow(/unknown state/);
	});

	test("three identical findings halt in stalemate; a different fourth one does not un-halt; the machine self-arms from idle", () => {
		let m = createMachine({ stalemateRepeats: 3 });
		const f = { category: "unverified-claim", summary: "tests pass with no log", paths: ["src/app.ts"], severity: "major" as const, source: "inspector" as const };
		let r = noteFinding(m, f);
		expect(r.stalemate).toBe(false);
		expect(r.machine.state).toBe("idle");
		r = noteFinding(r.machine, { ...f, summary: "  TESTS PASS with no log " });
		expect(r.finding.id).toBe(r.machine.findings[0].id); // identity normalizes case and whitespace
		expect(r.stalemate).toBe(false);
		r = noteFinding(r.machine, f);
		expect(r.stalemate).toBe(true);
		expect(r.machine.state).toBe("halted-stalemate");
		expect(r.machine.stalemateId).toBe(r.finding.id);
		expect(r.machine.identityRuns[r.finding.id]).toBe(3);
		const other = noteFinding(r.machine, { ...f, summary: "different" });
		expect(other.stalemate).toBe(false);
		expect(other.machine.state).toBe("halted-stalemate");
		expect(other.machine.lastIdentityRun).toBe(1);
		// interleaving breaks the run
		let n = createMachine({ stalemateRepeats: 3 });
		n = noteFinding(n, f).machine;
		n = noteFinding(n, { ...f, summary: "b" }).machine;
		n = noteFinding(n, f).machine;
		expect(n.state).toBe("idle");
		expect(n.lastIdentityRun).toBe(1);
	});

	test("mapChildCard maps pi-subagents severities and extracts paths from evidence", () => {
		const card = JSON.parse(readFileSync(join(FIXTURES, "child-card.json"), "utf8"));
		const f = mapChildCard(card, "forge-1");
		expect(f).toMatchObject({ severity: "major", category: "unverified-claim", source: "child-card", agentId: "forge-1", paths: ["src/app.test.ts"] });
		expect(f!.id).toMatch(/^[0-9a-f]{64}$/);
		expect(mapChildCard({ severity: "blocker", summary: "x" })!.severity).toBe("blocker");
		expect(mapChildCard({ details: { severity: "note", summary: "y" } })!.severity).toBe("minor");
		expect(mapChildCard({ severity: "weird", summary: "z" })!.severity).toBe("info");
		expect(mapChildCard({ details: { severity: "blocker" } })).toBeUndefined();
		expect(mapChildCard("nope")).toBeUndefined();
		const identity = "a".repeat(64);
		expect(mapChildCard({ summary: "keep identity", identity })!.id).toBe(identity);
	});
});

// ═══ state-block.ts + prompts ═══

describe("state block", () => {
	test("is deterministic, ordered and carries run, nodes, agents, evidence and event hashes", () => {
		const run = seededRun();
		const now = () => new Date("2026-09-15T06:00:00.000Z");
		const findings: WatchdogFinding[] = [{ id: "f".repeat(64), category: "c", summary: "open item", paths: [], severity: "major", source: "inspector", ts: "t" }];
		const a = buildStateBlock(run.store, run.dir, { findings, planDigest: "abc123", now });
		const b = buildStateBlock(run.store, run.dir, { findings, planDigest: "abc123", now });
		expect(a.text).toBe(b.text);
		expect(a.sha256).toBe(sha256(a.text));
		const lines = a.text.split("\n");
		expect(lines[0]).toBe(STATE_BLOCK_HEADER);
		expect(lines.map((l) => l.split(":")[0])).toEqual([STATE_BLOCK_HEADER, "- run", "- phase", "- nodes", "- agents", "- evidence", "- open findings", "- plan digest", "- last events", "- ts"]);
		expect(lines[1]).toContain(run.runId);
		expect(lines[1]).toContain("workflow: proto");
		expect(lines[2]).toBe("- phase: build · phases: plan → build → verify");
		expect(a.json.nodes).toEqual({ plan: "success", implement: "running" });
		expect(a.json.agents.map((x) => `${x.callsign}:${x.state}`).sort()).toEqual(["forge:dispatched-working", "rune:done-unverified"]);
		expect(a.json.evidence).toHaveLength(1);
		expect(a.json.evidence[0]).toMatch(/^plan:[0-9a-f]{12}$/);
		expect(a.json.findings).toEqual([{ id: "f".repeat(64), severity: "major", summary: "open item" }]);
		expect(a.json.planDigest).toBe("abc123");
		expect(a.json.lastEventHashes).toHaveLength(4);
		expect(a.json.lastEventHashes[0]).toMatch(/^1:[0-9a-f]{12}$/);
		expect(lines[6]).toContain("[major] open item (ffffffff)");
		expect(stateBlockMessage(a, "watchdog-failed")).toBe(`${a.text}\n- badge: watchdog-failed`);
		const later = buildStateBlock(run.store, run.dir, { maxEvents: 2, now });
		expect(later.json.lastEventHashes).toHaveLength(2);
		expect(later.text).toContain("- open findings: -");
		expect(() => buildStateBlock(run.store, join(run.dir, "missing"), { now })).toThrow();
	});

	test("activity tail and prompt rendering", () => {
		const run = seededRun();
		const tail = formatActivityTail(eventsOf(run.dir), 2);
		expect(tail.split("\n")).toHaveLength(2);
		expect(tail).toMatch(/^3 \S+ node\.end · \{"nodeId":"plan","status":"success"\}\n4 /);
		expect(render("a {{X}} b {{Y}}", { X: "1" })).toBe("a 1 b {{Y}}");
		expect(boundText("x".repeat(30), 10)).toMatch(/^\[… 20 earlier characters elided …\]\nxxxxxxxxxx$/);
		const block = buildStateBlock(run.store, run.dir);
		const c = compactionPrompt({ STATE_BLOCK: block.text, ENTRIES: "entry one", REASON: "threshold" });
		expect(c).toContain(STATE_BLOCK_HEADER);
		expect(c).toContain("reason: threshold");
		expect(c).toContain("entry one");
		const r = resumePrompt({ STATE_BLOCK: block.text, DIFF: "diff --git", FINDINGS: "- none", CARRY: "keep the migration" });
		expect(r).toContain(STATE_BLOCK_HEADER);
		expect(r).toContain("keep the migration");
		expect(r).toContain("do not replay");
		const i = inspectionPrompt({ STATE_BLOCK: block.text, TRANSCRIPT_TAIL: "y".repeat(LIMITS.maxReviewInputChars + 5), AGENT: "forge" });
		expect(i).toContain("elided");
		expect(i).toContain('"verdict"');
	});
});

// ═══ compaction.ts ═══

describe("compaction", () => {
	test("threshold + working inspector → custom summary = state block + narrative, one ledger row, compaction.before event", async () => {
		const run = seededRun();
		const inspect = inspector({ text: "Kept the plan; implement is mid-loop; evidence plan:ok." });
		const deps = compactionDeps(run, inspect);
		const out = await handleBeforeCompact(event("threshold"), deps);
		expect(out.mode).toBe("custom");
		expect(out.badge).toBeUndefined();
		expect(out.summary!.startsWith(STATE_BLOCK_HEADER)).toBe(true);
		expect(out.summary).toContain("## narrative\nKept the plan");
		expect(out.firstKeptEntryId).toBe("e42");
		expect(out.tokensBefore).toBe(120000);
		expect(inspect.calls).toHaveLength(1);
		expect(inspect.calls[0].opts).toMatchObject({ timeoutMs: 60, model: "cerebras/qwen-3.8-27b", thinking: "medium" });
		expect(inspect.calls[0].opts.systemPrompt).toContain("WATCHDOG");
		expect(inspect.calls[0].prompt).toContain("build the dashboard");
		expect(deps.rows).toEqual([{ origin: "compaction-inspector", model: "cerebras/qwen-3.8-27b", costUsd: 0.0021, tokensIn: 1200, tokensOut: 300, tpsSeconds: 2, ok: true, note: "compaction threshold" }]);
		const last = eventsOf(run.dir).at(-1)!;
		expect(last.type).toBe("compaction.before");
		expect(last.data).toMatchObject({ reason: "threshold", mode: "custom", stateSha256: out.stateBlock!.sha256 });
	});

	test("an inspector that never answers is bounded: state-only + watchdog-failed badge, compaction not cancelled, ledger ok:false", async () => {
		const run = seededRun();
		const inspect = inspector({ hang: true });
		const deps = compactionDeps(run, inspect);
		const started = Date.now();
		const out = await handleBeforeCompact(event("threshold"), deps);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(out.mode).toBe("state-only");
		expect(out.badge).toBe("watchdog-failed");
		expect(out.summary).toContain(STATE_BLOCK_HEADER);
		expect(out.summary).toContain("- badge: watchdog-failed (inspector timed out after 60 ms)");
		expect(out.note).toContain("compaction not cancelled");
		expect(deps.rows[0]).toMatchObject({ origin: "compaction-inspector", ok: false, costUsd: 0 });
		expect(eventsOf(run.dir).at(-1)!.data).toMatchObject({ mode: "state-only", badge: "watchdog-failed" });
	});

	test("inspector failures (ok:false, throw, empty text, abort) all degrade to state-only with the badge", async () => {
		for (const behaviour of [{ ok: false, text: "" }, { throws: "auth error" }, { text: "   " }]) {
			const run = seededRun();
			const deps = compactionDeps(run, inspector(behaviour));
			const out = await handleBeforeCompact(event("manual"), deps);
			expect(out.mode).toBe("state-only");
			expect(out.badge).toBe("watchdog-failed");
			expect(deps.rows[0].ok).toBe(false);
		}
		const run = seededRun();
		const controller = new AbortController();
		const deps = compactionDeps(run, inspector({ hang: true }), { settings: settings({ inspectorTimeoutMs: 5000 }) });
		const pending = handleBeforeCompact(event("manual", { signal: controller.signal }), deps);
		controller.abort();
		const out = await pending;
		expect(out.badge).toBe("watchdog-failed");
		expect(out.note).toContain("aborted");
	});

	test("overflow, retries and summary-only never call the inspector; off and no-run fall through to Pi", async () => {
		const run = seededRun();
		const inspect = inspector();
		const deps = compactionDeps(run, inspect);
		const overflow = await handleBeforeCompact(event("overflow"), deps);
		expect(overflow.mode).toBe("state-only");
		expect(overflow.summary).toBe(overflow.stateBlock!.text);
		const retry = await handleBeforeCompact(event("threshold", { willRetry: true }), deps);
		expect(retry.mode).toBe("state-only");
		const summaryOnly = await handleBeforeCompact(event("threshold"), { ...deps, settings: settings({ onCompaction: "summary-only" }) });
		expect(summaryOnly.mode).toBe("state-only");
		expect(summaryOnly.badge).toBeUndefined();
		expect(inspect.calls).toHaveLength(0);
		expect(deps.rows).toHaveLength(0);
		expect((await handleBeforeCompact(event("threshold"), { ...deps, settings: settings({ onCompaction: "off" }) })).mode).toBe("default");
		expect((await handleBeforeCompact(event("threshold"), { ...deps, runDir: undefined })).mode).toBe("default");
		expect((await handleBeforeCompact(event("threshold"), { ...deps, runDir: join(run.dir, "nope") })).mode).toBe("default");
		expect(eventsOf(run.dir).filter((r) => r.type === "compaction.before")).toHaveLength(3);
	});

	test("the inspector budget: settings by default, raised by titan:inspector=<ms> on manual compactions only", () => {
		expect(inspectorBudgetMs({ reason: "threshold" }, { inspectorTimeoutMs: 20000 })).toBe(20000);
		expect(inspectorBudgetMs({ reason: "manual", customInstructions: "titan:inspector=45000 keep the findings" }, { inspectorTimeoutMs: 20000 })).toBe(45000);
		expect(inspectorBudgetMs({ reason: "threshold", customInstructions: "titan:inspector=45000" }, { inspectorTimeoutMs: 20000 })).toBe(20000);
		expect(inspectorBudgetMs({ reason: "manual", customInstructions: "titan:inspector=100" }, { inspectorTimeoutMs: 20000 })).toBe(20000);
		expect(inspectorBudgetMs({ reason: "manual" }, { inspectorTimeoutMs: 0 })).toBe(LIMITS.compactionInspectorTimeoutMs);
	});

	test("session_compact and session_compact_failed are recorded", () => {
		const run = seededRun();
		const done = handleAfterCompact({ reason: "threshold", fromExtension: true, summary: "## titan state block\n…" }, { store: run.store, runDir: run.dir });
		expect(done.summaryHash).toBe(sha256("## titan state block\n…"));
		expect(done.agentStatePatch).toEqual({ from: "compacting", to: "dispatched-working" });
		expect(eventsOf(run.dir).at(-1)).toMatchObject({ type: "compaction.done", data: { reason: "threshold", fromExtension: true, summaryHash: done.summaryHash } });
		const failed = handleCompactFailed({ reason: "manual", aborted: true }, { store: run.store, runDir: run.dir });
		expect(failed.note).toContain("aborted");
		expect(eventsOf(run.dir).at(-1)).toMatchObject({ type: "compaction.failed", data: { reason: "manual", aborted: true } });
		expect(handleAfterCompact({ reason: "manual" }, { store: run.store, runDir: undefined }).summaryHash).toBeUndefined();
	});
});

// ═══ preempt.ts ═══

describe("pre-emption", () => {
	test("shouldPreempt: 75 % of the window, or a compaction event; a missing window never pre-empts", () => {
		expect(shouldPreempt({ agentId: "a", ctxTokens: 99_200, contextWindow: 131_072 }, 0.75)).toBe(true);
		expect(shouldPreempt({ agentId: "a", ctxTokens: 97_000, contextWindow: 131_072 }, 0.75)).toBe(false);
		expect(shouldPreempt({ agentId: "a", ctxTokens: 10, contextWindow: 131_072, compactionSeen: true }, 0.75)).toBe(true);
		expect(shouldPreempt({ agentId: "a", ctxTokens: 500_000, contextWindow: 0 }, 0.75)).toBe(false);
		expect(shouldPreempt({ agentId: "a", ctxTokens: 80_000, contextWindow: 100_000 }, Number.NaN)).toBe(true); // bad fraction → 0.75
	});

	test("parseInspection takes the last JSON object and fails closed to loss", () => {
		expect(parseInspection('thinking…\n```json\n{"verdict":"clean","reasons":["ok"],"carry":"nothing"}\n```')).toEqual({ verdict: "clean", reasons: ["ok"], carry: "nothing", parsed: true });
		expect(parseInspection('{"verdict":"clean"} later I changed my mind: {"verdict":"hallucination","reasons":["fake test log"]}').verdict).toBe("hallucination");
		expect(parseInspection("no json here")).toMatchObject({ verdict: "loss", parsed: false });
		expect(parseInspection('{"verdict":"maybe"}')).toMatchObject({ verdict: "loss", parsed: false });
	});

	function preemptDeps(run: ReturnType<typeof seededRun>, inspect: FakeInspector, over: Partial<PreemptDeps> = {}): PreemptDeps & { rows: LedgerNote[] } {
		const rows: LedgerNote[] = [];
		return { inspect, store: run.store, runDir: run.dir, settings: settings(), ledger: (r) => rows.push(r), transcriptTail: () => "…edited src/app.ts… tests pass…", diff: () => "diff --git a/src/app.ts", architectModel: "xai/grok-4.6", architectThinking: "high", rows, ...over };
	}

	test("clean → logical clear: fresh checkpoint id, prior transcript flagged, bytes kept, ledger row on the architect model", async () => {
		const run = seededRun();
		const inspect = inspector({ text: '{"verdict":"clean","reasons":["consistent"],"carry":"loop iteration 2 next"}' });
		const deps = preemptDeps(run, inspect);
		const block = buildStateBlock(run.store, run.dir);
		const d = await inspectPreempted("implement", block, deps);
		expect(d.action).toBe("logical-clear");
		if (d.action !== "logical-clear") throw new Error("unreachable");
		expect(d.checkpointSessionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(d.carry).toBe("loop iteration 2 next");
		expect(inspect.calls[0].opts).toMatchObject({ model: "xai/grok-4.6", thinking: "high", timeoutMs: 180 });
		expect(inspect.calls[0].prompt).toContain("Agent under inspection: implement");
		expect(inspect.calls[0].prompt).toContain(STATE_BLOCK_HEADER);
		expect(deps.rows).toEqual([expect.objectContaining({ origin: "watchdog", model: "xai/grok-4.6", ok: true, agentId: "implement" })]);
		const agent = agentOf(run.store, run.dir, "implement");
		expect(agent.state).toBe("resuming");
		expect(agent.stateHistory.map((h: any) => h.state)).toEqual(["dispatched-working", "inspecting-compaction", "resuming"]);
		expect(agent.logicalCleared).toMatchObject({ priorSessionRef: "sess-forge-1", checkpointSessionId: d.checkpointSessionId });
		expect(agent.sessionRef).toBe("sess-forge-1"); // nothing deleted
		const clear = eventsOf(run.dir).find((r) => r.type === "watchdog.logical_clear")!;
		expect(clear.agentId).toBe("implement");
		expect(clear.data).toMatchObject({ priorSessionRef: "sess-forge-1", checkpointSessionId: d.checkpointSessionId });
	});

	test("loss or hallucination → a fresh session on the architect model with the resume prompt, never a replay", async () => {
		const run = seededRun();
		const inspect = inspector({ text: '{"verdict":"hallucination","reasons":["claims tests passed; no log"],"carry":"re-run the suite"}' });
		const deps = preemptDeps(run, inspect, { findings: () => [{ id: "1".repeat(64), category: "unverified-claim", summary: "tests pass with no log", paths: ["src/app.ts"], severity: "major", source: "inspector", ts: "t" }] });
		const d = await inspectPreempted("implement", buildStateBlock(run.store, run.dir), deps);
		expect(d.action).toBe("resume-fresh");
		if (d.action !== "resume-fresh") throw new Error("unreachable");
		expect(d).toMatchObject({ model: "xai/grok-4.6", thinking: "high", verdict: "hallucination" });
		expect(d.resumePrompt).toContain(STATE_BLOCK_HEADER);
		expect(d.resumePrompt).toContain("re-run the suite");
		expect(d.resumePrompt).toContain("diff --git a/src/app.ts");
		expect(d.resumePrompt).toContain("[major] unverified-claim: tests pass with no log (src/app.ts)");
		expect(d.resumePrompt).not.toContain("edited src/app.ts"); // no transcript replay
		expect(agentOf(run.store, run.dir, "implement").state).toBe("resuming");
		expect(eventsOf(run.dir).at(-1)).toMatchObject({ type: "watchdog.resume_fresh", data: { verdict: "hallucination", model: "xai/grok-4.6" } });
		const garbage = await inspectPreempted("implement", buildStateBlock(run.store, run.dir), preemptDeps(run, inspector({ text: "I think it is fine" })));
		expect(garbage.action).toBe("resume-fresh"); // unparseable → loss (fail closed)
	});

	test("inspector failure → failed; the agent is watchdog-failed and stays halted; ledger ok:false", async () => {
		const run = seededRun();
		const deps = preemptDeps(run, inspector({ throws: "provider 401" }));
		const d = await inspectPreempted("implement", buildStateBlock(run.store, run.dir), deps);
		expect(d.action).toBe("failed");
		expect(d.note).toContain("provider 401");
		expect(agentOf(run.store, run.dir, "implement").state).toBe("watchdog-failed");
		expect(deps.rows[0]).toMatchObject({ origin: "watchdog", ok: false });
		expect(eventsOf(run.dir).at(-1)).toMatchObject({ type: "watchdog.failed", agentId: "implement" });
		const hung = await inspectPreempted("implement", buildStateBlock(run.store, run.dir), preemptDeps(run, inspector({ hang: true })));
		expect(hung.action).toBe("failed");
		expect(hung.note).toContain("timed out after 180 ms");
	});
});

// ═══ triggers.ts ═══

describe("§5.5 trigger table", () => {
	test("each row maps to its action", () => {
		expect(onWorkflowTerminal("forge", false)).toEqual({ kind: "mark-unverified", agentId: "forge", dispatchAuditor: true, reason: "terminal state without a review frame" });
		expect(onWorkflowTerminal("forge", true).kind).toBe("none");
		expect(onArchitectPing("forge", false)).toEqual({ kind: "queue-ping", agentId: "forge", missingReview: true });
		expect(onArchitectPing("forge", true).kind).toBe("none");
		expect(onAgentStopped("forge", "crash", false)).toMatchObject({ kind: "mark-unverified", reason: "stopped (crash) without review" });
		expect(onAgentStopped("forge", "abort", true).kind).toBe("none");
		expect(onReviewPass("forge", false)).toEqual({ kind: "force-harvest", agentId: "forge", rePromptArchitect: true });
		expect(onReviewPass("forge", true).kind).toBe("none");
		expect(onReviewerError("auth: invalid token")).toEqual({ kind: "watchdog-failed", reason: "auth: invalid token", refuseVerified: true });
		expect(onSpend(3.5, 3)).toEqual({ kind: "held-spend", spentUsd: 3.5, budgetUsd: 3 });
		expect(onSpend(2.5, 3).kind).toBe("none");
		expect(onSpend(99, null).kind).toBe("none");
		let m = createMachine({ stalemateRepeats: 3 });
		const f = { category: "c", summary: "same", paths: [] as string[], severity: "major" as const, source: "inspector" as const };
		let r = onFinding(m, f);
		expect(r.action.kind).toBe("none");
		r = onFinding(r.machine, f);
		r = onFinding(r.machine, f);
		expect(r.action).toEqual({ kind: "stalemate", findingId: r.finding.id, humanGate: true, pauseRun: true });
		expect(r.machine.state).toBe("halted-stalemate");
		m = createMachine({ stalemateRepeats: 2 });
		const card = JSON.parse(readFileSync(join(FIXTURES, "child-card.json"), "utf8"));
		let c = onChildCard(m, card, "forge-2");
		expect(c.action).toMatchObject({ kind: "ingest-card", stalemate: false, finding: { severity: "major", agentId: "forge-2" } });
		c = onChildCard(c.machine, card, "forge-2");
		expect(c.action).toMatchObject({ kind: "ingest-card", stalemate: true });
		expect(c.machine.state).toBe("halted-stalemate");
		expect(onChildCard(m, { details: {} }).action.kind).toBe("none");
		const inspecting = transition(transition(createMachine(), "armed"), "inspecting");
		const u = onUserInput(inspecting);
		expect(u.action).toEqual({ kind: "cancel-inspection" });
		expect(u.machine.state).toBe("armed");
		expect(onUserInput(createMachine()).action.kind).toBe("none");
	});
});

// ═══ createWatchdog: the host-facing object ═══

describe("createWatchdog", () => {
	function watchdog(run: ReturnType<typeof seededRun>, inspect: FakeInspector, over: Partial<WatchdogSettings> = {}) {
		const rows: LedgerNote[] = [];
		const wd = createWatchdog({ settings: settings(over), store: run.store, inspect, ledger: (r) => rows.push(r), entriesText: (e) => JSON.stringify(e ?? []), transcriptTail: () => "tail", diff: () => "", architectModel: "xai/grok-4.6", architectThinking: "high" });
		return { wd, rows };
	}

	test("arms per run, halts a child at 76 %, inspects a compaction and re-arms, reports status", async () => {
		const run = seededRun();
		const inspect = inspector();
		const { wd, rows } = watchdog(run, inspect);
		expect(wd.status()).toMatchObject({ enabled: true, state: "idle", inspections: 0 });
		expect(wd.childUsage({ agentId: "implement", ctxTokens: 120_000, contextWindow: 131_072 })).toBe("continue"); // not armed
		wd.arm(run.dir);
		expect(wd.machine().state).toBe("armed");
		expect(wd.childUsage({ agentId: "implement", ctxTokens: 99_200, contextWindow: 131_072 })).toBe("halt");
		expect(wd.childUsage({ agentId: "implement", ctxTokens: 50_000, contextWindow: 131_072 })).toBe("continue");
		const out = await wd.beforeCompact(event("threshold"));
		expect(out.mode).toBe("custom");
		expect(wd.machine().state).toBe("armed");
		expect(wd.machine().lastTransition).toMatch(/cleared → armed/);
		expect(wd.status()).toMatchObject({ inspections: 1, spendUsd: 0.0021, armedRun: run.dir.split("/").pop() });
		expect(rows).toHaveLength(1);
		expect(wd.afterCompact({ reason: "threshold", fromExtension: true, summary: out.summary }).agentStatePatch.to).toBe("dispatched-working");
		expect(wd.stateBlock()!.text).toContain(STATE_BLOCK_HEADER);
		wd.disarm();
		expect(wd.machine().state).toBe("idle");
		expect(wd.stateBlock()).toBeUndefined();
	});

	test("a failed compaction inspector leaves the badge and re-arms; user input cancels an in-flight inspection", async () => {
		const run = seededRun();
		const { wd } = watchdog(run, inspector({ hang: true }), { inspectorTimeoutMs: 40 });
		wd.arm(run.dir);
		const pending = wd.beforeCompact(event("threshold"));
		expect(wd.machine().state).toBe("inspecting");
		expect(wd.userInput()).toEqual({ kind: "cancel-inspection" });
		expect(wd.machine().state).toBe("armed");
		const out = await pending;
		expect(out.badge).toBe("watchdog-failed");
		expect(wd.machine().state).toBe("armed"); // the cancelled inspection does not overwrite the user's state
		const second = await wd.beforeCompact(event("manual"));
		expect(second.badge).toBe("watchdog-failed");
		expect(wd.machine().lastTransition).toMatch(/failed → armed/);
	});

	test("a compaction and a pre-emption in flight together settle independently; a cancelled inspection never overwrites the state", async () => {
		const run = seededRun();
		let release: ((r: InspectorResult) => void) | undefined;
		const gate = new Promise<InspectorResult>((r) => (release = r));
		let calls = 0;
		const inspect = (async () => {
			calls += 1;
			if (calls === 1) return gate; // the compaction inspector waits
			return { ok: true, text: '{"verdict":"clean","reasons":[],"carry":"c"}', usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.001, tpsSeconds: 1 } };
		}) as unknown as FakeInspector;
		const { wd } = watchdog(run, inspect, { inspectorTimeoutMs: 5000 });
		wd.arm(run.dir);
		const compaction = wd.beforeCompact(event("manual"));
		expect(wd.machine().state).toBe("inspecting");
		const preempt = await wd.preempted("implement"); // second inspection: no token, must not settle the first one's state
		expect(preempt.action).toBe("logical-clear");
		expect(wd.machine().state).toBe("inspecting");
		release!({ ok: true, text: "narrative", usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.001, tpsSeconds: 1 } });
		expect((await compaction).mode).toBe("custom");
		expect(wd.machine().state).toBe("armed");
		expect(wd.status().inspections).toBe(2);
	});

	test("three identical findings stalemate the run: children keep running unhalted, the human gate re-arms", async () => {
		const run = seededRun();
		const { wd } = watchdog(run, inspector());
		wd.arm(run.dir);
		const f = { category: "unverified-claim", summary: "tests pass with no log", paths: ["src/app.ts"], severity: "major" as const, source: "inspector" as const };
		expect(wd.finding(f).kind).toBe("none");
		expect(wd.finding(f).kind).toBe("none");
		const third = wd.finding(f);
		expect(third.kind).toBe("stalemate");
		expect(wd.machine().state).toBe("halted-stalemate");
		expect(wd.childUsage({ agentId: "implement", ctxTokens: 130_000, contextWindow: 131_072 })).toBe("continue");
		expect(wd.finding({ ...f, summary: "another" }).kind).toBe("none");
		expect(wd.machine().state).toBe("halted-stalemate");
		wd.resumeAfterStalemate();
		expect(wd.machine().state).toBe("armed");
		expect(wd.machine().lastIdentityRun).toBe(0);
		expect(wd.spend(1.5, 1).kind).toBe("held-spend");
	});

	test("a disabled watchdog never halts, never inspects and lets Pi compact", async () => {
		const run = seededRun();
		const inspect = inspector();
		const { wd, rows } = watchdog(run, inspect, { enabled: false });
		wd.arm(run.dir);
		expect(wd.machine().state).toBe("idle");
		expect(wd.childUsage({ agentId: "implement", ctxTokens: 130_000, contextWindow: 131_072 })).toBe("continue");
		expect((await wd.beforeCompact(event("threshold"))).mode).toBe("default");
		expect(inspect.calls).toHaveLength(0);
		expect(rows).toHaveLength(0);
		expect(wd.status().enabled).toBe(false);
	});

	test("chaos fixture: a child stream with a compaction event that then dies mid-tool ends in `resuming` with a resume prompt carrying the state block", async () => {
		const run = seededRun();
		const inspect = inspector({ text: '{"verdict":"loss","reasons":["deploy claimed without evidence"],"carry":"nothing was deployed; re-run npm test with a log"}' });
		const { wd, rows } = watchdog(run, inspect);
		wd.arm(run.dir);
		const window = 131_072;
		let ctxTokens = 0;
		let compactionSeen = false;
		let openTool: string | undefined;
		let decision: Awaited<ReturnType<typeof wd.preempted>> | undefined;
		let haltRequested = false;
		for (const line of readLines("child-stream-chaos.jsonl")) {
			if (line.type === "message_end" && line.message?.usage) ctxTokens = line.message.usage.totalTokens;
			if (line.type === "compaction_start") compactionSeen = true;
			if (line.type === "tool_execution_start") openTool = line.toolName;
			if (line.type === "tool_execution_end") {
				openTool = undefined;
				if (haltRequested && !decision) decision = await wd.preempted("implement", { transcriptTail: "…deploying now…" }); // the host halts at the next tool end
			}
			if (!haltRequested && wd.childUsage({ agentId: "implement", ctxTokens, contextWindow: window, compactionSeen }) === "halt") haltRequested = true;
		}
		// The stream ended while `./deploy.sh` was still open: the child died mid-tool.
		expect(openTool).toBe("bash");
		expect(haltRequested).toBe(true);
		if (!decision) decision = await wd.preempted("implement", { transcriptTail: "…deploying now…" });
		expect(decision.action).toBe("resume-fresh");
		if (decision.action !== "resume-fresh") throw new Error("unreachable");
		expect(decision.resumePrompt).toContain(STATE_BLOCK_HEADER);
		expect(decision.resumePrompt).toContain("nothing was deployed");
		expect(wd.machine().state).toBe("resuming");
		expect(onAgentStopped("implement", "crash", false).kind).toBe("mark-unverified");
		expect(rows).toEqual([expect.objectContaining({ origin: "watchdog", ok: true, agentId: "implement" })]);
		expect(agentOf(run.store, run.dir, "implement").state).toBe("resuming");
		// A compaction while resuming still works and re-arms the watchdog afterwards.
		const out = await wd.beforeCompact(event("threshold"));
		expect(out.mode).toBe("custom");
		expect(wd.machine().state).toBe("armed");
	});

	test("clean fixture: the second usage report crosses 75 % and a clean inspection logically clears the child", async () => {
		const run = seededRun();
		const { wd } = watchdog(run, inspector({ text: '{"verdict":"clean","reasons":[],"carry":"continue"}' }));
		wd.arm(run.dir);
		const halts: number[] = [];
		for (const line of readLines("child-stream-clean.jsonl")) {
			if (line.type === "message_end" && line.message?.usage && wd.childUsage({ agentId: "implement", ctxTokens: line.message.usage.totalTokens, contextWindow: 131_072 }) === "halt") halts.push(line.message.usage.totalTokens);
		}
		expect(halts).toEqual([99_200]);
		const d = await wd.preempted("implement");
		expect(d.action).toBe("logical-clear");
		expect(wd.machine().state).toBe("armed");
		expect(agentOf(run.store, run.dir, "implement").logicalCleared.priorSessionRef).toBe("sess-forge-1");
	});
});
