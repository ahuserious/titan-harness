import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { readLedger, formatTotals, totalsFor } from "../modules/ledger.ts";
import { registerMonitorCommand, resolveRunDir, monitorScriptPath, MONITOR_REFRESH_MS } from "../modules/cmd-monitor.ts";
import { dwAgentState, dwProjectKey, dwRunsDir, readDwRuns } from "../modules/monitor/dw-adapter.ts";
import { fit, renderBarRow, renderFrame, renderList, rowText } from "../modules/monitor/frame.ts";
import { buildRunView, latestRuns, phaseViews, workingCount } from "../modules/monitor/rows.ts";
import { AGENT_STATES, NEEDS_INPUT_STATES, SPINNER_FRAMES, STATE_COLORS, STATE_GLYPH, TERMINAL_STATES, WORKING_STATES, isVerified } from "../modules/monitor/state.ts";
import { RunStore } from "../modules/run-store.ts";

const FIXTURE = resolve(import.meta.dir, "fixtures", "monitor");
const NOW_ISO = "2026-09-15T06:05:00.000Z";
const NOW = Date.parse(NOW_ISO);
const SCRIPT = resolve(import.meta.dir, "..", "..", "..", "scripts", "titan-monitor.mjs");

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-monitor-"));
	dirs.push(dir);
	return dir;
};
const store = () => new RunStore(scratch());

/** A store root holding the fixture run under its own project slug, with an index line. */
function fixtureStore(): { store: RunStore; root: string; slug: string; runId: string; dir: string } {
	const root = scratch();
	const run = JSON.parse(readFileSync(join(FIXTURE, "run.json"), "utf8"));
	const dir = join(root, run.projectSlug, run.runId);
	cpSync(FIXTURE, dir, { recursive: true });
	rmSync(join(dir, "dw-run.json"), { force: true });
	writeFileSync(join(root, "index.jsonl"), `${JSON.stringify({ runId: run.runId, projectSlug: run.projectSlug, workflow: run.workflow, startedAt: run.startedAt })}\n`);
	return { store: new RunStore(root), root, slug: run.projectSlug, runId: run.runId, dir };
}

describe("monitor state vocabulary", () => {
	test("every state has a colour, a class and a glyph; done-unverified is never verified", () => {
		for (const state of AGENT_STATES) expect(STATE_COLORS[state]).toMatch(/^#[0-9a-f]{6}$/);
		expect(STATE_COLORS["done-verified"]).toBe("#16a34a");
		expect(STATE_COLORS["done-unverified"]).toBe("#ca8a04");
		expect(STATE_COLORS.stalemate).toBe("#dc2626");
		expect(STATE_COLORS["in-review"]).toBe("#d97706");
		expect(STATE_COLORS.stalemate).not.toBe(STATE_COLORS["in-review"]);
		expect(isVerified("done-verified")).toBe(true);
		expect(isVerified("done-unverified")).toBe(false);
		for (const state of WORKING_STATES) expect(SPINNER_FRAMES).toContain(STATE_GLYPH(state, 0));
		expect(STATE_GLYPH("dispatched-working", 1)).toBe(SPINNER_FRAMES[1]);
		expect(STATE_GLYPH("dispatched-working", 13)).toBe(SPINNER_FRAMES[3]);
		for (const state of [...TERMINAL_STATES, ...NEEDS_INPUT_STATES]) expect(STATE_GLYPH(state, 7)).toBe("●");
		expect(STATE_GLYPH("queued", 0)).toBe("○");
		const classified = new Set([...WORKING_STATES, ...TERMINAL_STATES, ...NEEDS_INPUT_STATES, "queued"]);
		for (const state of AGENT_STATES) expect(classified.has(state)).toBe(true);
	});
});

describe("buildRunView", () => {
	test("folds the fixture store into rows, phases, findings, nested sub-rows and totals", () => {
		const view = buildRunView(new RunStore(scratch()), FIXTURE, NOW);
		expect(view).toMatchObject({ runId: "run-20260915T060000Z-f1x7u3", workflow: "proto-analytics-dashboard", command: "workflow", status: "running", level: 3, tier: "prototype-analytics", shape: "level-3", source: "titan", elapsedMs: 300_000 });
		expect(view.phases).toEqual([
			{ title: "plan", state: "done" },
			{ title: "build", state: "active" },
			{ title: "verify", state: "pending" },
			{ title: "ship", state: "pending" },
		]);
		const top = view.rows.filter((row) => row.depth === 0);
		expect(top).toHaveLength(AGENT_STATES.length); // one record per state
		expect(new Set(top.map((row) => row.state))).toEqual(new Set(AGENT_STATES));
		expect(top.slice(0, 3).map((row) => [row.callsign, row.role, row.state, row.phase])).toEqual([
			["rune", "architect", "done-verified", "plan"],
			["forge-1", "builder", "dispatched-working", "build"],
			["forge-2", "builder", "edit-round-n", "build"],
		]);
		// nested: the re-ask record and the pi-subagents child sit right under forge-1 (implement)
		const implementIndex = view.rows.findIndex((row) => row.agentId === "implement");
		expect(view.rows[implementIndex + 1]).toMatchObject({ agentId: "implement#2", depth: 1, parentId: "implement", callsign: "forge-1", state: "dispatched-working", tokens: 550, tps: 25 });
		expect(view.rows[implementIndex + 2]).toMatchObject({ agentId: "implement/council-1", depth: 1, parentId: "implement", callsign: "council-1", role: "subagent", model: "cerebras/qwen-3.8-27b", state: "done-unverified", tokens: 900, costUsd: 0.001 });
		expect(view.rows[implementIndex + 3].depth).toBe(0);
		// watchdog findings per agent
		expect(view.rows.find((row) => row.agentId === "tests")?.wd).toBe(2);
		expect(view.rows.find((row) => row.agentId === "implement")?.wd).toBe(1);
		expect(view.rows.find((row) => row.agentId === "spec")?.wd).toBeUndefined();
		// thinking labels and tps
		const rune = view.rows.find((row) => row.agentId === "spec")!;
		expect(rune.thinking).toBe("high");
		expect(rune.tokens).toBe(1100);
		expect(rune.tps).toBe(20);
		expect(view.rows.some((row) => row.thinking === "xhigh↘high")).toBe(true);
		expect(view.rows.filter((row) => row.depth === 0 && row.tps === undefined).length).toBeGreaterThan(0);
		// totals = the same string Σ TOTALS prints for this ledger + these agents
		const agents = new RunStore(scratch()).listAgents(FIXTURE);
		expect(view.totals).toBe(formatTotals(totalsFor(readLedger(FIXTURE), agents)));
		expect(view.totals).toContain("Σ 38k tok");
		expect(view.totals).toContain("unmetered ×1");
		// verified counts over top-level rows only: one done-verified, one done-unverified, five failed-like
		expect(view.verified).toEqual({ verified: 1, unverified: 1, failed: 5 });
		expect(workingCount(view)).toEqual({ working: WORKING_STATES.length, total: AGENT_STATES.length });
	});

	test("phase rail rules and an empty run", () => {
		expect(phaseViews(["a", "b", "c"], "b", "running")).toEqual([
			{ title: "a", state: "done" },
			{ title: "b", state: "active" },
			{ title: "c", state: "pending" },
		]);
		expect(phaseViews(["a", "b"], undefined, "running").map((p) => p.state)).toEqual(["pending", "pending"]);
		expect(phaseViews(["a", "b"], "a", "completed").map((p) => p.state)).toEqual(["done", "done"]);
		expect(phaseViews(undefined, "a", "running")).toEqual([]);
		const s = store();
		const { dir } = s.open({ projectSlug: "p", cwd: "/tmp/p", command: "titan-only", status: "running" });
		const view = buildRunView(s, dir);
		expect(view.rows).toEqual([]);
		expect(view.totals).toBe("no spend yet");
		expect(view.verified).toEqual({ verified: 0, unverified: 0, failed: 0 });
		expect(view.phases).toEqual([]);
	});

	test("latestRuns reads the newest runs of a project through the index", () => {
		const fx = fixtureStore();
		const views = latestRuns(fx.store, fx.slug, 20, NOW);
		expect(views).toHaveLength(1);
		expect(views[0].runId).toBe(fx.runId);
		expect(latestRuns(fx.store, "other-project", 20, NOW)).toEqual([]);
	});
});

describe("renderFrame", () => {
	const view = () => buildRunView(new RunStore(scratch()), FIXTURE, NOW);

	test("header, rail, one coloured row per state, footer — every line within the width", () => {
		const painted: Array<[string, string]> = [];
		const lines = renderFrame(view(), { width: 120, height: 60, tick: 3, color: (hex, text) => (painted.push([hex, text]), text) });
		expect(lines[0]).toBe("◆ MONITOR proto-analytics-dashboard · run-20260915T060000Z-f1x7u3 · running · 300.0s · nested sub-rows: one level");
		expect(lines[1]).toBe(view().totals);
		expect(lines[2]).toBe("[✓ plan]─[● build]─[○ verify]─[○ ship]");
		expect(lines[3]).toBe("● rune · architect · claude-opus-4-6 (high) · done-verified · 1.1k tok · $0.01 · 20 tps");
		expect(lines[4]).toBe(`${SPINNER_FRAMES[3]} forge-1 · builder · gemini-3.8-flash (high) · dispatched-working · 2.2k tok · $0.02 · 40 tps · wd:1`);
		expect(lines[5]).toBe(`  └ ${SPINNER_FRAMES[3]} forge-1 · builder · claude-opus-4-6 (high) · dispatched-working · 550 tok · $0.0050 · 25 tps`);
		expect(lines[6]).toBe("  └ ● council-1 · subagent · qwen-3.8-27b (—) · done-unverified · 900 tok · $0.0010");
		expect(lines[7]).toBe(`${SPINNER_FRAMES[3]} forge-2 · builder · qwen-3.8-27b (xhigh↘high) · edit-round-n · 3.3k tok · $0.03 · 60 tps · wd:2`);
		expect(lines[lines.length - 1]).toBe(`verified 1/${AGENT_STATES.length} · ↑↓ scroll · q close`);
		expect(lines).toHaveLength(3 + AGENT_STATES.length + 2 + 1);
		for (const line of lines) expect([...line].length).toBeLessThanOrEqual(120);
		// every state row is painted with its own colour
		const rowsPainted = painted.filter(([hex]) => Object.values(STATE_COLORS).includes(hex));
		expect(rowsPainted).toHaveLength(AGENT_STATES.length + 2);
		for (const state of AGENT_STATES) {
			const hit = rowsPainted.find(([, text]) => text.includes(` · ${state} · `));
			expect(hit?.[0]).toBe(STATE_COLORS[state]);
		}
		expect(painted[0][0]).toBe("#e2e8f0");
		expect(painted.at(-1)?.[0]).toBe("#475569");
		for (const hex of ["#e2e8f0", "#94a3b8", "#475569"]) expect(Object.values(STATE_COLORS)).not.toContain(hex); // chrome never wears a state colour
	});

	test("narrow widths truncate with an ellipsis and short heights scroll with an offset", () => {
		const narrow = renderFrame(view(), { width: 40, height: 60, tick: 0 });
		for (const line of narrow) expect([...line].length).toBeLessThanOrEqual(40);
		expect(narrow[0].endsWith("…")).toBe(true);
		expect(narrow[0]).toBe("◆ MONITOR proto-analytics-dashboard · r…");
		expect(narrow.filter((line) => line.endsWith("…")).length).toBeGreaterThan(5);
		expect(renderFrame(view(), { width: 1, height: 5, tick: 0 })[0]).toBe("…");
		const short = renderFrame(view(), { width: 100, height: 10, tick: 0 });
		expect(short).toHaveLength(10);
		expect(short[9]).toBe(`verified 1/${AGENT_STATES.length} · rows 1–6 of ${AGENT_STATES.length + 2} · ↑↓ scroll · q close`);
		const scrolled = renderFrame(view(), { width: 100, height: 10, tick: 0, offset: 5 });
		expect(scrolled[9]).toContain(`rows 6–11 of ${AGENT_STATES.length + 2}`);
		const full = renderFrame(view(), { width: 100, height: 60, tick: 0 });
		expect(scrolled[3]).toBe(full[3 + 5]); // the window starts at row index 5
		const clamped = renderFrame(view(), { width: 100, height: 10, tick: 0, offset: 999 });
		expect(clamped[9]).toContain(`rows ${AGENT_STATES.length + 2 - 5}–${AGENT_STATES.length + 2} of ${AGENT_STATES.length + 2}`);
		const tiny = renderFrame(view(), { width: 100, height: 2, tick: 0 });
		expect(tiny).toHaveLength(2);
		expect(renderFrame(view(), { width: 100, height: 60, tick: 0, showRail: false })[2]).toContain("rune");
	});

	test("totals stay on the header line when they fit", () => {
		const s = store();
		const { dir } = s.open({ projectSlug: "p", cwd: "/tmp/p", command: "titan-only", status: "completed" });
		const lines = renderFrame(buildRunView(s, dir), { width: 200, height: 10, tick: 0 });
		expect(lines[0]).toMatch(/^◆ MONITOR titan-only · run-\S+ · completed · \d+\.\ds · no spend yet$/);
		expect(lines[1]).toBe("verified 0/0 · ↑↓ scroll · q close");
		expect(fit("abcdef", 4)).toBe("abc…");
		expect(fit("abc", 3)).toBe("abc");
		expect(rowText({ agentId: "x", callsign: "x", role: "worker", model: "a/b", thinking: "low", state: "queued", tokens: 0, costUsd: 0, depth: 0 }, 0)).toBe("○ x · worker · b (low) · queued · 0 tok · $0.00");
	});

	test("bar row and runs table", () => {
		expect(renderBarRow(undefined)).toBe("◫ MONITOR | no run");
		expect(renderBarRow(view())).toBe(`◫ MONITOR | proto-analytics-dashboard · running · ${WORKING_STATES.length}/${AGENT_STATES.length} agents working · verified 1/${AGENT_STATES.length}`);
		const table = renderList([view()], 140);
		expect(table[0].startsWith("name")).toBe(true);
		expect(table[0]).toContain("phase");
		expect(table[0]).toContain("result");
		expect(table).toHaveLength(2);
		expect(table[1]).toContain("proto-analytics-dashboard");
		expect(table[1]).toContain("build");
		expect(table[1]).toContain("rune, forge-1, forge-2 +");
		expect(table[1]).toContain(`7/${AGENT_STATES.length}`);
		expect(table[1]).toContain(`running · verified 1/${AGENT_STATES.length}`);
		for (const line of renderList([view()], 50)) expect([...line].length).toBeLessThanOrEqual(50);
	});
});

describe("pi-dynamic-workflows adapter", () => {
	test("project key follows dist/workflow-paths.js: lower-cased basename + 12 hex of sha256(resolve(cwd))", () => {
		const cwd = "/tmp/My Project.v2";
		const expectedHash = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 12);
		expect(dwProjectKey(cwd)).toBe(`my-project.v2-${expectedHash}`);
		expect(dwProjectKey("/")).toMatch(/^project-[0-9a-f]{12}$/);
		expect(dwRunsDir(cwd, "/home/x/.pi/workflows")).toBe(`/home/x/.pi/workflows/projects/my-project.v2-${expectedHash}/runs`);
		expect(basename(dwRunsDir(cwd))).toBe("runs");
		expect(dwAgentState("running")).toBe("dispatched-working");
		expect(dwAgentState("done")).toBe("done-unverified");
		expect(dwAgentState("error")).toBe("failed");
		expect(dwAgentState("skipped")).toBe("cancelled");
		expect(dwAgentState("queued")).toBe("queued");
	});

	test("a persisted run becomes a RunView with mapped states, phases and usage", () => {
		const dir = scratch();
		mkdirSync(join(dir, "runs"));
		cpSync(join(FIXTURE, "dw-run.json"), join(dir, "runs", "run-dw-20260915-0001.json"));
		writeFileSync(join(dir, "runs", "run-dw-20260915-0001.json.bak"), "{}");
		writeFileSync(join(dir, "runs", "garbage.json"), "{not json");
		const views = readDwRuns("/tmp/whatever", { dirs: [join(dir, "runs")], now: NOW });
		expect(views).toHaveLength(1);
		const view = views[0];
		expect(view).toMatchObject({ runId: "run-dw-20260915-0001", workflow: "review-changes", status: "running", source: "pi-dynamic-workflows", totals: "Σ 12.3k tok · $0.21", elapsedMs: 300_000 });
		expect(view.phases).toEqual([
			{ title: "Review", state: "done" },
			{ title: "Verify", state: "active" },
		]);
		expect(view.rows.map((row) => [row.callsign, row.state, row.tokens, row.phase])).toEqual([
			["review:bugs", "done-unverified", 12000, "Review"],
			["review:perf", "failed", 300, "Review"],
			["verify:src/a.ts", "dispatched-working", 0, "Verify"],
			["verify:src/b.ts", "queued", 0, "Verify"],
		]);
		expect(view.rows[1].note).toBe("provider timeout");
		expect(view.verified).toEqual({ verified: 0, unverified: 1, failed: 1 });
		expect(readDwRuns("/tmp/whatever", { dirs: [join(dir, "missing")] })).toEqual([]);
		const table = renderList(views, 140);
		expect(table[1]).toContain("review-changes (pi-dw)");
		expect(table[1]).toContain("Verify");
		const lines = renderFrame(view, { width: 120, height: 20, tick: 0 });
		expect(lines[0]).toContain("pi-dynamic-workflows");
	});
});

describe("scripts/titan-monitor.mjs", () => {
	const run = (args: string[]) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });

	test("renders the same plain-text frame as renderFrame", () => {
		expect(monitorScriptPath()).toBe(SCRIPT);
		for (const width of [100, 40]) {
			const expected = renderFrame(buildRunView(new RunStore(scratch()), FIXTURE, NOW), { width, height: 40, tick: 3 });
			const result = run(["--run", FIXTURE, "--width", String(width), "--height", "40", "--tick", "3", "--now", NOW_ISO]);
			expect(result.status).toBe(0);
			expect(result.stdout.replace(/\n$/, "").split("\n")).toEqual(expected);
		}
		const scrolled = run(["--run", FIXTURE, "--width", "100", "--height", "10", "--now", NOW_ISO]);
		expect(scrolled.stdout.replace(/\n$/, "").split("\n")).toEqual(renderFrame(buildRunView(new RunStore(scratch()), FIXTURE, NOW), { width: 100, height: 10, tick: 0 }));
	});

	test("lists a project's runs like renderList and exits 2 on a missing run", () => {
		const fx = fixtureStore();
		const result = run(["--list", fx.root, "--project", fx.slug, "--width", "140", "--now", NOW_ISO]);
		expect(result.status).toBe(0);
		expect(result.stdout.replace(/\n$/, "").split("\n")).toEqual(renderList(latestRuns(fx.store, fx.slug, 20, NOW), 140));
		const missing = run(["--run", join(fx.root, "nope")]);
		expect(missing.status).toBe(2);
		expect(missing.stderr).toContain("no run.json");
		expect(run([]).status).toBe(2);
	});
});

describe("cmd-monitor", () => {
	test("resolveRunDir: explicit id or prefix, the in-flight run, else the newest", () => {
		const fx = fixtureStore();
		const second = fx.store.open({ projectSlug: fx.slug, cwd: "/tmp/fixture-project", command: "titan-only", status: "running" });
		expect(resolveRunDir(fx.store, fx.slug, undefined)?.runId).toBe(second.runId);
		expect(resolveRunDir(fx.store, fx.slug, "f1x7u3")?.runId).toBe(fx.runId);
		expect(resolveRunDir(fx.store, fx.slug, "run-20260915T060000Z")?.runId).toBe(fx.runId);
		expect(resolveRunDir(fx.store, fx.slug, "zzz")).toBeUndefined();
		expect(resolveRunDir(fx.store, fx.slug, undefined, fx.dir)?.runId).toBe(fx.runId);
		expect(resolveRunDir(fx.store, fx.slug, undefined, join(fx.root, "gone"))?.runId).toBe(second.runId);
		expect(resolveRunDir(fx.store, "no-such-project", undefined)).toBeUndefined();
	});

	test("registers /workflow-monitor: overlay open/close, list panel, split fallback, headless panel", async () => {
		const fx = fixtureStore();
		let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
		let completions: ((prefix: string) => unknown) | undefined;
		const pi = { registerCommand: (name: string, spec: any) => { expect(name).toBe("workflow-monitor"); handler = spec.handler; completions = spec.getArgumentCompletions; } } as any;
		const calls: Array<[string, string]> = [];
		let closed = 0;
		let refreshed = 0;
		let overlayRender: ((tick: number, size: { width: number; height: number }) => string[]) | undefined;
		let headless = false;
		registerMonitorCommand(pi, {
			store: () => fx.store,
			cwd: () => "/tmp/fixture-project",
			openOverlay: (_ctx, render) => {
				if (headless) return undefined;
				overlayRender = render;
				return { close: () => void closed++, refresh: () => void refreshed++ };
			},
			spawnSplit: async () => ({ ok: false, how: "none", detail: "no orca, no tmux" }),
			notify: (_ctx, text, level) => calls.push([level ?? "info", text]),
			panel: (_ctx, title, markdown) => calls.push(["panel", `${title}\n${markdown}`]),
		});
		expect(handler).toBeDefined();
		expect(completions?.("li")).toEqual([{ value: "list", label: "list" }]);
		expect(completions?.("zz")).toBeNull();
		// the fixture slug differs from projectSlug("/tmp/fixture-project"), so point the store at it through the index
		const slug = RunStore.projectSlug("/tmp/fixture-project");
		const dir = join(fx.root, slug, fx.runId);
		cpSync(fx.dir, dir, { recursive: true });
		writeFileSync(join(fx.root, "index.jsonl"), `${JSON.stringify({ runId: fx.runId, projectSlug: slug, startedAt: "2026-09-15T06:00:00.000Z" })}\n`);
		await handler!("", {});
		expect(overlayRender).toBeDefined();
		const lines = overlayRender!(2, { width: 100, height: 12 });
		expect(lines).toHaveLength(12);
		expect(lines[0]).toContain("◆ MONITOR proto-analytics-dashboard");
		expect(calls.at(-1)?.[1]).toContain("monitor: run-20260915T060000Z-f1x7u3");
		await new Promise((resolve) => setTimeout(resolve, MONITOR_REFRESH_MS * 2 + 50));
		expect(refreshed).toBeGreaterThanOrEqual(1);
		await handler!("close", {});
		expect(closed).toBe(1);
		expect(calls.at(-1)?.[1]).toBe("monitor closed");
		await handler!("close", {});
		expect(calls.at(-1)?.[1]).toBe("monitor: nothing open");
		await handler!("list", {});
		const panel = calls.at(-1)!;
		expect(panel[0]).toBe("panel");
		expect(panel[1]).toContain("◫ MONITOR — RUNS");
		expect(panel[1]).toContain("proto-analytics-dashboard");
		await handler!("--split", {});
		expect(calls.at(-1)?.[0]).toBe("warning");
		expect(calls.at(-1)?.[1]).toContain("no pane host available");
		expect(calls.at(-1)?.[1]).toContain("titan-monitor.mjs --run");
		await handler!("nope-run", {});
		expect(calls.at(-1)?.[1]).toContain('No run matching "nope-run"');
		headless = true;
		await handler!("", {});
		expect(calls.at(-1)?.[0]).toBe("panel");
		expect(calls.at(-1)?.[1]).toContain("◫ MONITOR run-20260915T060000Z-f1x7u3");
	});
});
