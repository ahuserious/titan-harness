import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendChained } from "../modules/hash-chain.ts";
import { createSidebarController, defaultLoadedFor, registerSidebarCommand, resolveSidebarRun, SIDEBAR_REFRESH_MS } from "../modules/cmd-sidebar.ts";
import {
	AUTO_CLOSE_AFTER_MS,
	buildSidebarView,
	DORMANT_AFTER_MS,
	nodeDescription,
	nodeLineText,
	nodeRole,
	phaseLineText,
	renderSidebar,
	sidebarAutoCloseDue,
	sidebarFooterText,
	type SidebarView,
} from "../modules/monitor/sidebar.ts";
import { DORMANT_COLOR, PHASE_GLYPH, PHASE_STATE_COLORS, PHASE_STATES, phaseColorOf, ROLE_COLORS, roleColorOf, SIDEBAR_ROLES, SPINNER_FRAMES, STATE_COLORS } from "../modules/monitor/state.ts";
import { RunStore } from "../modules/run-store.ts";
import type { WorkflowDoc } from "../modules/workflow/schema.ts";

const NOW_ISO = "2026-09-15T12:00:00.000Z";
const NOW = Date.parse(NOW_ISO);
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-sidebar-"));
	dirs.push(dir);
	return dir;
};

/** The workflow document of the fixture run: eight phases, one node each (plus a reviewer). */
const DOC: WorkflowDoc = {
	apiVersion: "titan.harness/v1",
	name: "eight-phases",
	phases: [
		{ title: "plan", detail: "map the spec" },
		{ title: "build", detail: "implement the dashboard" },
		{ title: "review" },
		{ title: "rework" },
		{ title: "verify", detail: "kane per device" },
		{ title: "polish" },
		{ title: "ship" },
		{ title: "cleanup" },
	],
	nodes: [
		{ id: "spec", phase: "plan", role: "architect", prompt: "Read the spec and write a numbered feature list\nsecond line" },
		{ id: "implement", phase: "build", role: "builder", loop: { prompt: "Implement the next feature", until: "DONE", max_iterations: 3 } },
		{ id: "audit", phase: "review", role: "auditor", prompt: "Review the build against the spec" },
		{ id: "fix", phase: "rework", role: "builder", prompt: "Fix the audit findings" },
		{ id: "e2e", phase: "verify", verify: { runner: "kane", objective: "Open the dashboard and check the chart" } },
		{ id: "polish-css", phase: "polish", role: "worker", prompt: "Tidy the CSS" },
		{ id: "release", phase: "ship", bash: "echo ship" },
		{ id: "tidy", phase: "cleanup", role: "worker", prompt: "Remove scaffolding" },
	],
} as unknown as WorkflowDoc;

interface FixtureOptions {
	status?: string;
	endedAt?: string;
	phases?: string[];
	withLayers?: boolean;
}

/**
 * A run directory driven into every phase state:
 *   plan → review-passed (spec success, agent done-verified, review PASS 5 min ago → not dormant)
 *   build → redo 2 (implement started, three agent calls, still running)
 *   review → in-review (audit started, auditor role)
 *   rework → working (fix started, one call)
 *   verify → failed (e2e ended failed 3 min ago)
 *   polish → done (polish-css success, agent done-unverified) — idle 11 min → dormant
 *   ship → skipped (release ended skipped 2 min ago)
 *   cleanup → queued (never started)
 */
function fixtureRun(root: string, opts: FixtureOptions = {}): { store: RunStore; dir: string; runId: string; slug: string } {
	const store = new RunStore(root);
	const slug = RunStore.projectSlug("/tmp/fixture-project"); // what deps.cwd resolves to in the command tests
	const runId = "run-20260915T113000Z-s1d3b4";
	const dir = join(root, slug, runId);
	mkdirSync(join(dir, "agents"), { recursive: true });
	const run: Record<string, unknown> = {
		runId,
		projectSlug: slug,
		cwd: "/tmp/fixture-project",
		command: "workflow",
		workflow: { name: "eight-phases", sha256: "ab".repeat(32) },
		status: opts.status ?? "running",
		startedAt: minutesAgo(30),
		phases: opts.phases ?? DOC.phases!.map((p) => p.title),
		currentPhase: "build",
	};
	if (opts.endedAt) run.endedAt = opts.endedAt;
	writeFileSync(join(dir, "run.json"), JSON.stringify(run, null, 2));
	writeFileSync(join(root, "index.jsonl"), `${JSON.stringify({ runId, projectSlug: slug, workflow: run.workflow, startedAt: run.startedAt })}\n`);
	const events = join(dir, "events.jsonl");
	const ev = (ts: string, type: string, data: Record<string, unknown>, agentId?: string) => appendChained(events, { runId, ts, type, data, ...(agentId ? { agentId } : {}) });
	if (opts.withLayers) ev(minutesAgo(29), "workflow.start", { workflow: "eight-phases", layers: [["spec"], ["implement", "audit"], ["fix", "e2e"], ["polish-css", "release", "tidy"]] });
	// plan
	ev(minutesAgo(28), "phase.start", { phase: "plan" });
	ev(minutesAgo(28), "node.start", { nodeId: "spec", type: "prompt", role: "architect", attempt: 1, layer: 0, phase: "plan" });
	ev(minutesAgo(28), "agent.start", { agentId: "spec", nodeId: "spec", role: "architect", model: "xai/grok-4.6" }, "spec");
	ev(minutesAgo(27), "agent.end", { agentId: "spec", nodeId: "spec", ok: true }, "spec");
	ev(minutesAgo(27), "node.end", { nodeId: "spec", type: "prompt", status: "success", attempts: 1 });
	ev(minutesAgo(5), "review.verdict", { reviewerNodeId: "audit", reviewedNodeId: "spec", verdict: "PASS", state: "done-verified" }, "audit"); // plan settled 5 min ago: not dormant
	// build: three calls, still running
	ev(minutesAgo(25), "phase.start", { phase: "build" });
	ev(minutesAgo(25), "node.start", { nodeId: "implement", type: "loop", role: "builder", attempt: 1, layer: 1, phase: "build" });
	ev(minutesAgo(25), "agent.start", { agentId: "implement", nodeId: "implement", role: "builder" }, "implement");
	ev(minutesAgo(20), "agent.end", { agentId: "implement", nodeId: "implement", ok: true }, "implement");
	ev(minutesAgo(20), "agent.start", { agentId: "implement#2", nodeId: "implement", role: "builder" }, "implement#2");
	ev(minutesAgo(15), "agent.end", { agentId: "implement#2", nodeId: "implement", ok: true }, "implement#2");
	ev(minutesAgo(15), "agent.start", { agentId: "implement#3", nodeId: "implement", role: "builder" }, "implement#3");
	// review: auditor running
	ev(minutesAgo(14), "node.start", { nodeId: "audit", type: "prompt", role: "auditor", attempt: 1, layer: 1, phase: "review" });
	ev(minutesAgo(14), "agent.start", { agentId: "audit", nodeId: "audit", role: "auditor" }, "audit");
	// rework: working, one call
	ev(minutesAgo(13), "node.start", { nodeId: "fix", type: "prompt", role: "builder", attempt: 1, layer: 2, phase: "rework" });
	ev(minutesAgo(13), "agent.start", { agentId: "fix", nodeId: "fix", role: "builder" }, "fix");
	// verify: failed
	ev(minutesAgo(4), "node.start", { nodeId: "e2e", type: "verify", attempt: 1, layer: 2, phase: "verify" });
	ev(minutesAgo(3), "node.end", { nodeId: "e2e", type: "verify", status: "failed", attempts: 2, error: "kane-cli not on PATH" }); // failed 3 min ago: not dormant
	// polish: done 11 minutes ago (dormant)
	ev(minutesAgo(12), "node.start", { nodeId: "polish-css", type: "prompt", role: "worker", attempt: 1, layer: 3, phase: "polish" });
	ev(minutesAgo(11), "node.end", { nodeId: "polish-css", type: "prompt", status: "success", attempts: 1 });
	// ship: skipped
	ev(minutesAgo(2), "node.start", { nodeId: "release", type: "bash", attempt: 0, skipped: true, phase: "ship" });
	ev(minutesAgo(2), "node.end", { nodeId: "release", type: "bash", status: "skipped", attempts: 0 }); // skipped 2 min ago: not dormant
	const agent = (agentId: string, state: string, ts: string, extra: Record<string, unknown> = {}) =>
		writeFileSync(join(dir, "agents", `${agentId.replace(/[#/]/g, "-")}.json`), JSON.stringify({ agentId, callsign: agentId, role: "builder", model: "xai/grok-4.6", thinking: { requested: "high", effective: "high" }, state, stateHistory: [{ state, ts, seq: 1 }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001 }, tps: { outputTokens: 5, seconds: 1 }, ...extra }, null, 2));
	agent("spec", "done-verified", minutesAgo(26), { role: "architect" });
	agent("implement", "dispatched-working", minutesAgo(15));
	agent("implement#3", "dispatched-working", minutesAgo(15));
	agent("audit", "in-review", minutesAgo(14), { role: "auditor" });
	agent("fix", "dispatched-working", minutesAgo(13));
	agent("polish-css", "done-unverified", minutesAgo(11), { role: "worker" });
	return { store, dir, runId, slug };
}

const recording = () => {
	const calls: Array<[string, string]> = [];
	return { calls, color: (hex: string, text: string) => `<${hex}>${text}</>`, paints: () => calls };
};

describe("sidebar vocabulary", () => {
	test("role colours, phase state colours, glyphs and the dormant dim", () => {
		expect(ROLE_COLORS).toEqual({ architect: "#7c3aed", builder: "#f59e0b", worker: "#22d3ee", verifier: "#16a34a", auditor: "#d97706", watchdog: "#0d9488", fusion: "#f472b6", judge: "#f472b6", fuser: "#f472b6", system: "#94a3b8" });
		for (const role of SIDEBAR_ROLES) expect(roleColorOf(role)).toBe(ROLE_COLORS[role]);
		expect(roleColorOf("exa")).toBe(ROLE_COLORS.system);
		for (const state of PHASE_STATES) expect(PHASE_STATE_COLORS[state]).toMatch(/^#[0-9a-f]{6}$/);
		expect(PHASE_STATE_COLORS.working).toBe(STATE_COLORS["dispatched-working"]);
		expect(PHASE_STATE_COLORS["in-review"]).toBe(STATE_COLORS["in-review"]);
		expect(PHASE_STATE_COLORS.redo).toBe(STATE_COLORS["edit-round-n"]);
		expect(PHASE_STATE_COLORS["review-passed"]).toBe(STATE_COLORS["done-verified"]);
		expect(PHASE_STATE_COLORS.done).not.toBe(PHASE_STATE_COLORS["review-passed"]); // done-unverified never reads as verified
		expect(PHASE_STATE_COLORS.failed).toBe(STATE_COLORS.failed);
		expect(phaseColorOf("failed", true)).toBe(DORMANT_COLOR);
		expect(phaseColorOf("failed")).toBe(STATE_COLORS.failed);
		expect(SPINNER_FRAMES).toContain(PHASE_GLYPH("working", 3));
		expect(PHASE_GLYPH("working", 12)).toBe(SPINNER_FRAMES[2]);
		expect(PHASE_GLYPH("review-passed", 0)).toBe("✓");
		expect(PHASE_GLYPH("failed", 0)).toBe("✗");
		expect(PHASE_GLYPH("queued", 0)).toBe("○");
		expect(PHASE_GLYPH("skipped", 0)).toBe("–");
		expect(PHASE_GLYPH("in-review", 0)).toBe("●");
		expect(PHASE_GLYPH("redo", 0)).toBe("●");
		expect(PHASE_GLYPH("done", 0)).toBe("●");
	});

	test("nodeRole and nodeDescription", () => {
		expect(nodeRole(DOC.nodes[0])).toBe("architect");
		expect(nodeRole(DOC.nodes[4])).toBe("verifier"); // verify node without a role
		expect(nodeRole(DOC.nodes[6])).toBe("system"); // bash node
		expect(nodeRole({ id: "x", prompt: "hi" } as never)).toBe("worker");
		expect(nodeRole(undefined, "auditor")).toBe("auditor");
		expect(nodeRole(undefined)).toBe("system");
		expect(nodeDescription(DOC.nodes[0])).toBe("Read the spec and write a numbered feature list");
		expect(nodeDescription(DOC.nodes[1])).toBe("Implement the next feature");
		expect(nodeDescription(DOC.nodes[4])).toBe("Open the dashboard and check the chart");
		expect(nodeDescription(DOC.nodes[6])).toBe("echo ship");
		expect(nodeDescription({ id: "long", prompt: `${"x".repeat(80)}\nmore` } as never)).toHaveLength(60);
		expect(nodeDescription(undefined)).toBe("");
	});
});

describe("buildSidebarView", () => {
	test("derives every phase state, the redo counter, roles, descriptions and dormancy from the store", () => {
		const { store, dir } = fixtureRun(scratch());
		const view = buildSidebarView(store, dir, DOC, NOW);
		expect(view).toMatchObject({ runId: "run-20260915T113000Z-s1d3b4", name: "eight-phases", status: "running", terminal: false, source: "doc", elapsedMs: 30 * 60_000 });
		const byTitle = Object.fromEntries(view.phases.map((phase) => [phase.title, phase]));
		expect(view.phases.map((phase) => phase.title)).toEqual(["plan", "build", "review", "rework", "verify", "polish", "ship", "cleanup"]);
		expect(byTitle.plan).toMatchObject({ state: "review-passed", role: "architect", detail: "map the spec", redo: 0, dormant: false });
		expect(byTitle.build).toMatchObject({ state: "redo", role: "builder", detail: "implement the dashboard", redo: 2 });
		expect(byTitle.review).toMatchObject({ state: "in-review", role: "auditor", detail: "Review the build against the spec" });
		expect(byTitle.rework).toMatchObject({ state: "working", role: "builder", redo: 0 });
		expect(byTitle.verify).toMatchObject({ state: "failed", role: "verifier", detail: "kane per device", dormant: false });
		expect(byTitle.verify.nodes[0].error).toBe("kane-cli not on PATH");
		expect(byTitle.polish).toMatchObject({ state: "done", role: "worker", dormant: true }); // idle 11 min
		expect(byTitle.ship).toMatchObject({ state: "skipped", role: "system", dormant: false });
		expect(byTitle.cleanup).toMatchObject({ state: "queued", role: "worker", detail: "Remove scaffolding", dormant: false });
		// the redo counter comes from the extra agent calls (3 calls → redo 2)
		expect(byTitle.build.nodes[0]).toMatchObject({ id: "implement", type: "loop", state: "redo", redo: 2, agentState: "dispatched-working" });
		expect(byTitle.build.lastActivityAt).toBe(minutesAgo(15));
		expect(view.lastActivityAt).toBe(minutesAgo(2));
		// polish is terminal and idle ≥ 10 min → dormant; viewed 5 minutes after it settled it is not; plan turns dormant 10 min after its verdict
		const fresh = buildSidebarView(store, dir, DOC, Date.parse(minutesAgo(6)));
		expect(fresh.phases.find((phase) => phase.title === "polish")?.dormant).toBe(false);
		expect(buildSidebarView(store, dir, DOC, NOW + 6 * 60_000).phases.find((phase) => phase.title === "plan")?.dormant).toBe(true);
		// a queued phase is never dormant even after hours
		expect(buildSidebarView(store, dir, DOC, NOW + 3 * 60 * 60_000).phases.find((phase) => phase.title === "cleanup")?.dormant).toBe(false);
	});

	test("edit-round-n agent state counts as a redo even with a single call", () => {
		const { store, dir } = fixtureRun(scratch());
		writeFileSync(join(dir, "agents", "fix.json"), JSON.stringify({ agentId: "fix", callsign: "fix", role: "builder", model: "xai/grok-4.6", thinking: { requested: "high", effective: "high" }, state: "edit-round-n", stateHistory: [{ state: "edit-round-n", ts: minutesAgo(2), seq: 3 }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, tps: { outputTokens: 1, seconds: 1 } }));
		const view = buildSidebarView(store, dir, DOC, NOW);
		const rework = view.phases.find((phase) => phase.title === "rework")!;
		expect(rework.state).toBe("redo");
		expect(rework.redo).toBe(1);
		expect(rework.nodes[0].agentState).toBe("edit-round-n");
	});

	test("falls back to the run's phase titles, then to layers, when no document is known", () => {
		const { store, dir } = fixtureRun(scratch(), { withLayers: true });
		const fromRun = buildSidebarView(store, dir, undefined, NOW);
		expect(fromRun.source).toBe("run");
		expect(fromRun.phases.map((phase) => `${phase.title}:${phase.state}`)).toEqual(["plan:review-passed", "build:redo", "review:in-review", "rework:working", "verify:failed", "polish:done", "ship:skipped", "cleanup:queued"]);
		expect(fromRun.phases.find((phase) => phase.title === "review")?.role).toBe("auditor"); // role from the node.start event
		const { store: s2, dir: d2 } = fixtureRun(scratch(), { withLayers: true, phases: [] });
		const fromLayers = buildSidebarView(s2, d2, undefined, NOW);
		expect(fromLayers.source).toBe("layers");
		expect(fromLayers.phases.map((phase) => phase.title)).toEqual(["layer 1: spec", "layer 2: implement, audit", "layer 3: fix, e2e", "layer 4: polish-css, release, tidy"]);
		expect(fromLayers.phases[1].state).toBe("in-review"); // review beats redo within a layer
		expect(fromLayers.phases[2].state).toBe("failed"); // an unsettled layer with a failed node reads failed
	});

	test("nodes the document does not know land under 'other'; the stored result settles nodes the events missed", () => {
		const { store, dir } = fixtureRun(scratch());
		const run = JSON.parse(require("node:fs").readFileSync(join(dir, "run.json"), "utf8"));
		run.result = { nodes: { tidy: { status: "success", attempts: 1, endedAt: minutesAgo(1) }, ghost: { status: "failed", attempts: 2, error: "boom", endedAt: minutesAgo(1) } } };
		writeFileSync(join(dir, "run.json"), JSON.stringify(run));
		const view = buildSidebarView(store, dir, DOC, NOW);
		expect(view.phases.find((phase) => phase.title === "cleanup")).toMatchObject({ state: "done" });
		const other = view.phases.find((phase) => phase.title === "other")!;
		expect(other.nodes.map((node) => [node.id, node.state, node.error])).toEqual([["ghost", "failed", "boom"]]);
	});
});

describe("sidebarAutoCloseDue", () => {
	test("true 10 minutes after a terminal run; never for a running run", () => {
		const base: Pick<SidebarView, "terminal" | "endedAt" | "lastActivityAt" | "startedAt"> = { terminal: true, endedAt: minutesAgo(11), startedAt: minutesAgo(40) };
		expect(sidebarAutoCloseDue(base, NOW)).toBe(true);
		expect(sidebarAutoCloseDue({ ...base, endedAt: minutesAgo(9) }, NOW)).toBe(false);
		expect(sidebarAutoCloseDue({ ...base, endedAt: undefined, lastActivityAt: minutesAgo(10) }, NOW)).toBe(true);
		expect(sidebarAutoCloseDue({ ...base, endedAt: undefined, lastActivityAt: undefined }, NOW)).toBe(true); // startedAt 40 min ago
		expect(sidebarAutoCloseDue({ ...base, terminal: false }, NOW)).toBe(false);
		expect(AUTO_CLOSE_AFTER_MS).toBe(DORMANT_AFTER_MS);
		const { store, dir } = fixtureRun(scratch(), { status: "completed", endedAt: minutesAgo(12) });
		const view = buildSidebarView(store, dir, DOC, NOW);
		expect(view.terminal).toBe(true);
		expect(sidebarAutoCloseDue(view, NOW)).toBe(true);
		expect(sidebarFooterText(view, NOW)).toBe("ctrl+w close · 10 min idle → dormant · auto-close in 0 min");
		expect(sidebarFooterText(buildSidebarView(store, dir, DOC, Date.parse(minutesAgo(8))), Date.parse(minutesAgo(8)))).toBe("ctrl+w close · 10 min idle → dormant · auto-close in 6 min");
	});
});

describe("renderSidebar", () => {
	test("one line per phase with the role bar, glyph, role box, title, description and state; footer; colours", () => {
		const { store, dir } = fixtureRun(scratch());
		const view = buildSidebarView(store, dir, DOC, NOW);
		const plain = renderSidebar(view, { width: 100, height: 40, tick: 0, now: NOW });
		expect(plain[0]).toBe("◧ WORKFLOW eight-phases · running · 30m0s".replace("30m0s", require("../modules/runtime.ts").fmtSecs(30 * 60_000)));
		expect(plain[1]).toBe("│ ✓ [architect] plan — map the spec · review-passed");
		expect(plain[2]).toBe(`│ ${SPINNER_FRAMES[0]} [builder]   build — implement the dashboard (redo 2)`.replace(SPINNER_FRAMES[0], "●"));
		expect(plain[3]).toBe("│ ● [auditor]   review — Review the build against the spec · in-review");
		expect(plain[4]).toBe(`│ ${SPINNER_FRAMES[0]} [builder]   rework — Fix the audit findings`);
		expect(plain[5]).toBe("│ ✗ [verifier]  verify — kane per device · failed");
		expect(plain[6]).toBe("│ ● [worker]    polish — Tidy the CSS · dormant");
		expect(plain[7]).toBe("│ – [system]    ship — echo ship · skipped");
		expect(plain[8]).toBe("│ ○ [worker]    cleanup — Remove scaffolding");
		expect(plain[9]).toBe("ctrl+w close · 10 min idle → dormant");
		expect(plain).toHaveLength(10);
		expect(renderSidebar(view, { width: 100, height: 40, tick: 4, now: NOW })[4]).toContain(SPINNER_FRAMES[4]);
		// colours: bar = role colour, rest = state colour, dormant dims both
		const rec = recording();
		const painted = renderSidebar(view, { width: 100, height: 40, tick: 0, now: NOW, color: rec.color });
		expect(painted[1]).toBe(`<${ROLE_COLORS.architect}>│</><${PHASE_STATE_COLORS["review-passed"]}> ✓ [architect] plan — map the spec · review-passed</>`);
		expect(painted[2].startsWith(`<${ROLE_COLORS.builder}>│</><${PHASE_STATE_COLORS.redo}>`)).toBe(true);
		expect(painted[3].startsWith(`<${ROLE_COLORS.auditor}>│</><${PHASE_STATE_COLORS["in-review"]}>`)).toBe(true);
		expect(painted[4].startsWith(`<${ROLE_COLORS.builder}>│</><${PHASE_STATE_COLORS.working}>`)).toBe(true);
		expect(painted[5].startsWith(`<${ROLE_COLORS.verifier}>│</><${PHASE_STATE_COLORS.failed}>`)).toBe(true);
		expect(painted[6]).toBe(`<${DORMANT_COLOR}>│</><${DORMANT_COLOR}> ● [worker]    polish — Tidy the CSS · dormant</>`);
		expect(painted[7].startsWith(`<${ROLE_COLORS.system}>│</><${PHASE_STATE_COLORS.skipped}>`)).toBe(true);
		expect(painted[8].startsWith(`<${ROLE_COLORS.worker}>│</><${PHASE_STATE_COLORS.queued}>`)).toBe(true);
		expect(painted[0]).toMatch(/^<#e2e8f0>/);
		expect(painted[9]).toMatch(/^<#475569>/);
	});

	test("expanded mode adds the node lines; width truncates; height clips with a count", () => {
		const { store, dir } = fixtureRun(scratch());
		const view = buildSidebarView(store, dir, DOC, NOW);
		const expanded = renderSidebar(view, { width: 100, height: 60, tick: 0, now: NOW, expanded: true });
		expect(expanded[2]).toBe("  └ spec · review-passed");
		expect(expanded[4]).toBe("  └ implement · redo 2");
		expect(expanded[6]).toBe("  └ audit · in-review");
		expect(expanded[10]).toBe("  └ e2e · failed · kane-cli not on PATH");
		expect(expanded).toHaveLength(1 + 8 * 2 + 1);
		expect(nodeLineText({ id: "x", role: "worker", state: "queued", redo: 0 })).toBe("  └ x · queued");
		const narrow = renderSidebar(view, { width: 30, height: 40, tick: 0, now: NOW });
		for (const line of narrow) expect([...line].length).toBeLessThanOrEqual(30);
		expect(narrow[1]).toBe("│ ✓ [architect] plan — map th…");
		const short = renderSidebar(view, { width: 100, height: 6, tick: 0, now: NOW });
		expect(short).toHaveLength(6);
		expect(short[4]).toBe("… 5 more lines");
		expect(short[5]).toBe("ctrl+w close · 10 min idle → dormant");
		expect(phaseLineText({ title: "t", detail: "", role: "fuser", state: "done", redo: 3, nodes: [], dormant: false }, 0)).toBe("│ ● [fuser]     t (3 redo)");
	});
});

describe("/workflow-sidebar", () => {
	const fakePi = () => {
		const commands = new Map<string, any>();
		return { pi: { registerCommand: (name: string, spec: any) => commands.set(name, spec) } as any, commands };
	};
	const baseDeps = (fx: ReturnType<typeof fixtureRun>, extra: Record<string, unknown> = {}) => {
		const notes: string[] = [];
		const panels: Array<[string, string]> = [];
		const deps = {
			store: () => fx.store,
			cwd: () => "/tmp/fixture-project",
			openOverlay: () => undefined,
			notify: (_ctx: any, text: string) => notes.push(text),
			panel: (_ctx: any, title: string, markdown: string) => panels.push([title, markdown]),
			loadedFor: () => ({ doc: DOC }) as any,
			now: () => NOW,
			...extra,
		};
		return { deps, notes, panels };
	};

	test("resolveSidebarRun: explicit id, current run dir, newest", () => {
		const fx = fixtureRun(scratch());
		expect(resolveSidebarRun(fx.store, fx.slug, "s1d3b4")).toMatchObject({ runId: fx.runId });
		expect(resolveSidebarRun(fx.store, fx.slug, "nope")).toBeUndefined();
		expect(resolveSidebarRun(fx.store, fx.slug, undefined, fx.dir)).toMatchObject({ runId: fx.runId, dir: fx.dir });
		expect(resolveSidebarRun(fx.store, fx.slug, undefined)).toMatchObject({ runId: fx.runId });
		expect(resolveSidebarRun(fx.store, "other-project", undefined)).toBeUndefined();
		expect(defaultLoadedFor(fx.store, fx.dir, "/tmp/fixture-project")).toBeUndefined(); // eight-phases is not an installed workflow
	});

	test("headless (no overlay) prints one plain frame as a panel; toggle opens and closes a fake overlay; expand shows nodes", async () => {
		const fx = fixtureRun(scratch());
		const { deps, notes, panels } = baseDeps(fx);
		const { pi, commands } = fakePi();
		const controller = registerSidebarCommand(pi, deps as any);
		expect(commands.has("workflow-sidebar")).toBe(true);
		await commands.get("workflow-sidebar").handler("", {});
		expect(panels).toHaveLength(1);
		expect(panels[0][0]).toBe(`◧ WORKFLOW ${fx.runId}`);
		expect(panels[0][1]).toContain("│ ✓ [architect] plan — map the spec · review-passed");
		expect(controller.isOpen()).toBe(false);
		await commands.get("workflow-sidebar").handler("close", {});
		expect(notes.at(-1)).toBe("sidebar: nothing open");
		// a fake overlay
		let closed = 0;
		let refreshes = 0;
		let lastRender: string[] = [];
		const overlayDeps = {
			...deps,
			openOverlay: (_ctx: any, render: (tick: number, size: { width: number; height: number }) => string[]) => {
				lastRender = render(0, { width: 90, height: 30 });
				return { close: () => void closed++, refresh: () => void (refreshes++, (lastRender = render(refreshes, { width: 90, height: 30 }))) };
			},
		};
		const ctl = createSidebarController(overlayDeps as any);
		ctl.toggle({});
		expect(ctl.isOpen()).toBe(true);
		expect(lastRender[1]).toBe("│ ✓ [architect] plan — map the spec · review-passed");
		expect(notes.at(-1)).toContain("ctrl+w or /workflow-sidebar close to hide");
		ctl.setExpanded(true);
		expect(lastRender[2]).toBe("  └ spec · review-passed");
		ctl.toggle({});
		expect(ctl.isOpen()).toBe(false);
		expect(closed).toBe(1);
		expect(ctl.close()).toBe(false);
	});

	test("the overlay closes itself once the run has been terminal for 10 minutes", async () => {
		const fx = fixtureRun(scratch(), { status: "completed", endedAt: minutesAgo(11) });
		let closed = 0;
		const { deps, notes } = baseDeps(fx, { openOverlay: () => ({ close: () => void closed++, refresh: () => {} }) });
		const ctl = createSidebarController(deps as any);
		ctl.open({});
		expect(ctl.isOpen()).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, SIDEBAR_REFRESH_MS + 150));
		expect(ctl.isOpen()).toBe(false);
		expect(closed).toBe(1);
		expect(notes.at(-1)).toContain("settled 10 minutes ago — closed");
		// a still-running run keeps its overlay
		const fx2 = fixtureRun(scratch());
		let closed2 = 0;
		const { deps: deps2 } = baseDeps(fx2, { openOverlay: () => ({ close: () => void closed2++, refresh: () => {} }) });
		const ctl2 = createSidebarController(deps2 as any);
		ctl2.open({});
		await new Promise((resolve) => setTimeout(resolve, SIDEBAR_REFRESH_MS + 150));
		expect(ctl2.isOpen()).toBe(true);
		expect(closed2).toBe(0);
		ctl2.close();
	});

	test("no run in the project → a warning, no overlay", () => {
		const store = new RunStore(scratch());
		const notes: string[] = [];
		const ctl = createSidebarController({ store: () => store, cwd: () => "/nowhere", openOverlay: () => ({ close() {}, refresh() {} }), notify: (_c: any, t: string) => notes.push(t), panel: () => {} } as any);
		ctl.open({});
		expect(ctl.isOpen()).toBe(false);
		expect(notes[0]).toContain("No runs recorded");
	});
});
