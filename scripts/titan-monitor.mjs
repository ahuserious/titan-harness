#!/usr/bin/env node
/**
 * titan-monitor.mjs — the split-pane tailer for a titan-harness run (plan D4, H4).
 *
 *   node scripts/titan-monitor.mjs --run <runDir> [--follow] [--interval 1000] [--width N] [--height N] [--tick N] [--now <iso>]
 *   node scripts/titan-monitor.mjs --list <runsRoot> --project <projectSlug> [--width N]
 *
 * Prints the same text frame as modules/monitor/frame.ts renderFrame (the overlay), read
 * straight from the run directory (run.json, agents/*.json, events.jsonl, ledger.jsonl);
 * with --follow it clears the screen and redraws every --interval ms until the run's
 * status is terminal. Plain Node ESM, no dependencies, so `orca terminal split` or
 * `tmux split-window` can run it without the harness. tests/monitor.test.ts pins this
 * renderer to the TypeScript one byte for byte, so keep the two in step.
 *
 * Exit codes: 0 ok · 2 missing run / usage.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ═══ Vocabulary (modules/monitor/state.ts) ═══════════════════════════════════
const STATE_COLORS = {
	queued: "#64748b", "dispatched-working": "#2563eb", "waiting-architect": "#7c3aed", "in-review": "#d97706", "edit-round-n": "#ea580c", stalemate: "#dc2626", harvesting: "#0891b2",
	"done-verified": "#16a34a", "done-unverified": "#ca8a04", "authoring-workflow": "#9333ea", "repairing-workflow": "#e11d48", compacting: "#4f46e5", "inspecting-compaction": "#6366f1",
	resuming: "#0ea5e9", "held-spend": "#78716c", "blocked-guard": "#c026d3", "system-run": "#0d9488", "watchdog-failed": "#b91c1c", "uncertain-launch": "#92400e", failed: "#991b1b", cancelled: "#6b7280", "failed-review": "#9f1239",
};
const WORKING = new Set(["dispatched-working", "in-review", "edit-round-n", "harvesting", "compacting", "inspecting-compaction", "resuming", "authoring-workflow", "repairing-workflow", "system-run"]);
const FAILED_LIKE = new Set(["failed", "cancelled", "stalemate", "failed-review", "watchdog-failed"]);
const TERMINAL_RUN = new Set(["completed", "failed", "aborted", "stalemate", "reauthored"]);
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const glyph = (state, tick) => (WORKING.has(state) ? SPINNER[((tick % SPINNER.length) + SPINNER.length) % SPINNER.length] : state === "queued" ? "○" : "●");
const colorOf = (state) => STATE_COLORS[state] ?? "#94a3b8";
const HEADER_COLOR = "#e2e8f0";
const RAIL_COLOR = "#94a3b8";
const FOOTER_COLOR = "#475569";

// ═══ Formatting (modules/ledger.ts, modules/runtime.ts, modules/thinking.ts) ═══
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const trimZeros = (s) => s.replace(/\.?0+$/, "");
const fmtTokens = (n) => (n >= 1_000_000 ? `${trimZeros((n / 1_000_000).toFixed(2))}M` : n >= 1000 ? `${trimZeros((n / 1000).toFixed(1))}k` : `${Math.round(n)}`);
const fmtUsd = (c) => (c > 0 && c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`);
const fmtSecs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const thinkingLabel = (requested, effective) => (requested === effective ? effective : `${requested}↘${effective}`);
const shortModel = (m) => (m.includes("/") ? m.slice(m.lastIndexOf("/") + 1) : m);

function totalsFor(rows, agents) {
	let input = 0, output = 0, costUsd = 0, unmetered = 0;
	const ids = new Set();
	for (const row of rows) {
		input += num(row.tokens?.input);
		output += num(row.tokens?.output);
		costUsd += num(row.costUsd);
		if (row.source === "unmetered") unmetered++;
		if (row.agentId) ids.add(row.agentId);
	}
	const t = { tokens: input + output, input, output, costUsd, unmetered, agents: agents ? agents.length : ids.size, verified: 0, unverified: 0, failed: 0 };
	if (!agents) return t;
	let tpsSum = 0, tpsCount = 0;
	for (const a of agents) {
		if (a.tps && num(a.tps.seconds) > 0) {
			tpsSum += num(a.tps.outputTokens) / a.tps.seconds;
			tpsCount++;
		}
		if (a.state === "done-verified") t.verified++;
		else if (a.state === "done-unverified") t.unverified++;
		else if (a.state === "failed" || a.state === "cancelled" || a.state === "stalemate") t.failed++;
	}
	if (tpsCount > 0) t.avgTpsPerAgent = tpsSum / tpsCount;
	const settled = t.verified + t.unverified + t.failed;
	if (settled > 0) t.completionRate = t.verified / settled;
	return t;
}
function formatTotals(t) {
	const parts = [`Σ ${fmtTokens(t.tokens)} tok`, fmtUsd(t.costUsd)];
	if (t.avgTpsPerAgent !== undefined) parts.push(`${Math.round(t.avgTpsPerAgent)} tps/agent`);
	if (t.completionRate !== undefined) parts.push(`verified ${Math.round(t.completionRate * 100)} % (${t.verified}/${t.verified + t.unverified + t.failed})`);
	if (t.unmetered > 0) parts.push(`unmetered ×${t.unmetered}`);
	return parts.join(" · ");
}

// ═══ Store reading (modules/run-store.ts, hash-chain.ts readChain) ═══════════
function readJsonl(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
	const rows = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		rows.push(JSON.parse(line)); // a torn line throws, exactly like readChain
	}
	return rows;
}
const readEvents = (dir) => {
	try {
		return readJsonl(path.join(dir, "events.jsonl"));
	} catch {
		return [];
	}
};
const readLedger = (dir) => readJsonl(path.join(dir, "ledger.jsonl"));
function listAgents(dir) {
	let names;
	try {
		names = fs.readdirSync(path.join(dir, "agents")).filter((n) => n.endsWith(".json"));
	} catch {
		return [];
	}
	const records = [];
	for (const name of names) {
		try {
			records.push(JSON.parse(fs.readFileSync(path.join(dir, "agents", name), "utf8")));
		} catch {}
	}
	const key = (r) => [r.stateHistory?.[0]?.seq ?? 0, r.stateHistory?.[0]?.ts ?? "", r.agentId];
	return records.sort((a, b) => {
		const [sa, ta, ia] = key(a), [sb, tb, ib] = key(b);
		return sa - sb || ta.localeCompare(tb) || ia.localeCompare(ib);
	});
}

// ═══ View model (modules/monitor/rows.ts) ═════════════════════════════════════
const nodeIdOf = (agentId) => agentId.split("#")[0];
function phaseViews(phases, currentPhase, status) {
	if (!phases?.length) return [];
	if (status === "completed") return phases.map((title) => ({ title, state: "done" }));
	const index = currentPhase ? phases.indexOf(currentPhase) : -1;
	return phases.map((title, i) => ({ title, state: index < 0 ? "pending" : i < index ? "done" : i === index ? "active" : "pending" }));
}
function subagentState(status) {
	switch (String(status ?? "").toLowerCase()) {
		case "running": case "working": case "started": return "dispatched-working";
		case "done": case "completed": case "success": return "done-unverified";
		case "error": case "failed": return "failed";
		case "cancelled": case "aborted": return "cancelled";
		default: return "queued";
	}
}
function rowFromRecord(record, phaseByNode, wdByAgent, parentIds) {
	const nodeId = nodeIdOf(record.agentId);
	const nested = record.agentId.includes("#") && parentIds.has(nodeId);
	const requested = record.thinking?.requested || record.thinking?.effective || "";
	const effective = record.thinking?.effective || requested;
	const usage = record.usage ?? { input: 0, output: 0, cost: 0 };
	const tps = record.tps && num(record.tps.seconds) > 0 ? num(record.tps.outputTokens) / record.tps.seconds : undefined;
	const history = record.stateHistory ?? [];
	const row = {
		agentId: record.agentId, callsign: record.callsign || record.agentId, role: record.role || "agent", model: record.model || "?",
		thinking: requested || effective ? thinkingLabel(requested, effective) : "—", state: record.state,
		tokens: num(usage.input) + num(usage.output), costUsd: num(usage.cost), nodeId, depth: nested ? 1 : 0,
	};
	if (tps !== undefined) row.tps = tps;
	if (nested) row.parentId = nodeId;
	const phase = phaseByNode.get(nodeId);
	if (phase) row.phase = phase;
	const wd = wdByAgent.get(record.agentId);
	if (wd) row.wd = wd;
	if (history[0]?.ts) row.startedAt = history[0].ts;
	if (history.length) row.updatedAt = history[history.length - 1].ts;
	return row;
}
export function buildRunView(dir, now = Date.now()) {
	const run = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
	const agents = listAgents(dir);
	const events = readEvents(dir);
	const phaseByNode = new Map();
	const wdByAgent = new Map();
	const subRows = new Map();
	let currentPhase;
	for (const event of events) {
		const data = event.data ?? {};
		const type = String(event.type ?? "");
		if (type === "phase.start" && typeof data.phase === "string") currentPhase = data.phase;
		if (type === "node.start" && typeof data.nodeId === "string") {
			const phase = typeof data.phase === "string" ? data.phase : currentPhase;
			if (phase && !phaseByNode.has(data.nodeId)) phaseByNode.set(data.nodeId, phase);
		}
		if (type === "watchdog.finding") {
			const id = typeof event.agentId === "string" ? event.agentId : typeof data.agentId === "string" ? data.agentId : undefined;
			if (id) wdByAgent.set(id, (wdByAgent.get(id) ?? 0) + 1);
		}
		if (type.startsWith("subagent.") && typeof data.parent === "string") {
			const id = typeof data.agentId === "string" ? data.agentId : typeof event.agentId === "string" ? event.agentId : `${data.parent}/${data.label ?? "subagent"}`;
			const previous = subRows.get(id);
			subRows.set(id, {
				agentId: id, callsign: typeof data.label === "string" ? data.label : (previous?.callsign ?? id), role: "subagent",
				model: typeof data.model === "string" ? data.model : (previous?.model ?? "?"), thinking: previous?.thinking ?? "—",
				state: data.status === undefined ? (previous?.state ?? "dispatched-working") : subagentState(data.status),
				tokens: num(data.tokens) || (previous?.tokens ?? 0), costUsd: num(data.costUsd) || (previous?.costUsd ?? 0), depth: 1, parentId: data.parent,
				startedAt: previous?.startedAt ?? (typeof event.ts === "string" ? event.ts : undefined), updatedAt: typeof event.ts === "string" ? event.ts : previous?.updatedAt,
			});
		}
	}
	const parentIds = new Set(agents.map((r) => r.agentId));
	const rows = [];
	const nested = new Map();
	for (const record of agents) {
		const row = rowFromRecord(record, phaseByNode, wdByAgent, parentIds);
		if (row.depth === 1 && row.parentId) {
			const list = nested.get(row.parentId) ?? [];
			list.push(row);
			nested.set(row.parentId, list);
		} else rows.push(row);
	}
	for (const row of subRows.values()) {
		if (!row.parentId) continue;
		const wd = wdByAgent.get(row.agentId);
		if (wd) row.wd = wd;
		const list = nested.get(row.parentId) ?? [];
		list.push(row);
		nested.set(row.parentId, list);
	}
	const ordered = [];
	for (const row of rows) {
		ordered.push(row);
		const children = nested.get(row.agentId);
		if (children) ordered.push(...children.sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0)));
	}
	for (const [parentId, children] of nested) if (!rows.some((row) => row.agentId === parentId)) ordered.push(...children);
	const ledger = readLedger(dir);
	const totals = ledger.length ? formatTotals(totalsFor(ledger, agents)) : "no spend yet";
	const verified = { verified: 0, unverified: 0, failed: 0 };
	for (const row of ordered) {
		if (row.depth !== 0) continue;
		if (row.state === "done-verified") verified.verified++;
		else if (row.state === "done-unverified") verified.unverified++;
		else if (FAILED_LIKE.has(String(row.state))) verified.failed++;
	}
	const started = Date.parse(run.startedAt);
	const ended = run.endedAt ? Date.parse(run.endedAt) : now;
	const view = { runId: run.runId, status: run.status, phases: phaseViews(run.phases, run.currentPhase, run.status), rows: ordered, totals, verified, startedAt: run.startedAt, source: "titan", elapsedMs: Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : 0 };
	if (run.workflow?.name) view.workflow = run.workflow.name;
	if (run.command) view.command = run.command;
	if (run.endedAt) view.endedAt = run.endedAt;
	return view;
}

// ═══ Frames (modules/monitor/frame.ts) ═══════════════════════════════════════
function fit(text, width) {
	const chars = [...text];
	if (width <= 0) return "";
	if (chars.length <= width) return text;
	if (width === 1) return "…";
	return `${chars.slice(0, width - 1).join("")}…`;
}
const viewName = (view) => view.workflow ?? view.command ?? "run";
function rowText(row, tick) {
	const bits = [`${glyph(row.state, tick)} ${row.callsign}`, row.role, `${shortModel(row.model)} (${row.thinking})`, String(row.state), `${fmtTokens(row.tokens)} tok`, fmtUsd(row.costUsd)];
	if (row.tps !== undefined) bits.push(`${Math.round(row.tps)} tps`);
	if (row.wd) bits.push(`wd:${row.wd}`);
	const line = bits.join(" · ");
	return row.depth === 1 ? `  └ ${line}` : line;
}
const railText = (view) => view.phases.map((p) => `[${{ done: "✓", active: "●", pending: "○" }[p.state]} ${p.title}]`).join("─");
function headerText(view, hasNested, title) {
	const bits = [`◆ ${title ?? "MONITOR"} ${viewName(view)}`, view.runId, view.status, fmtSecs(view.elapsedMs)];
	if (view.source === "pi-dynamic-workflows") bits.push("pi-dynamic-workflows");
	if (hasNested) bits.push("nested sub-rows: one level");
	return bits.join(" · ");
}
export function renderFrame(view, opts) {
	const paint = opts.color ?? ((_hex, text) => text);
	const width = Math.max(1, Math.floor(opts.width));
	const height = Math.max(1, Math.floor(opts.height));
	const hasNested = view.rows.some((row) => row.depth === 1);
	const head = [];
	const header = headerText(view, hasNested, opts.title);
	const joined = `${header} · ${view.totals}`;
	if ([...joined].length <= width) head.push([joined, HEADER_COLOR]);
	else {
		head.push([header, HEADER_COLOR]);
		head.push([view.totals, HEADER_COLOR]);
	}
	if ((opts.showRail ?? true) && view.phases.length) head.push([railText(view), RAIL_COLOR]);
	const top = view.rows.filter((row) => row.depth === 0).length;
	const available = Math.max(0, height - head.length - 1);
	const rows = view.rows;
	let offset = Math.max(0, Math.floor(opts.offset ?? 0));
	if (rows.length > available) offset = Math.min(offset, Math.max(0, rows.length - available));
	else offset = 0;
	const window = available > 0 ? rows.slice(offset, offset + available) : [];
	const footerBits = [`verified ${view.verified.verified}/${top}`];
	if (rows.length > available) footerBits.push(`rows ${window.length ? offset + 1 : 0}–${offset + window.length} of ${rows.length}`);
	footerBits.push("↑↓ scroll", "q close");
	const lines = [];
	for (const [text, hex] of head) lines.push(paint(hex, fit(text, width)));
	for (const row of window) lines.push(paint(colorOf(row.state), fit(rowText(row, opts.tick), width)));
	lines.push(paint(FOOTER_COLOR, fit(footerBits.join(" · "), width)));
	return lines.slice(0, height);
}
const LIST_COLUMNS = [["name", 26], ["phase", 14], ["roster", 26], ["progress", 9], ["result", 26]];
export function renderList(views, width) {
	const cell = (text, size) => fit(text, size).padEnd(size);
	const lines = [LIST_COLUMNS.map(([name, size]) => cell(name, size)).join(" · ")];
	for (const view of views) {
		const top = view.rows.filter((row) => row.depth === 0);
		const settled = top.filter((row) => row.state === "done-verified" || row.state === "done-unverified" || FAILED_LIKE.has(String(row.state))).length;
		const callsigns = [...new Set(top.map((row) => row.callsign))];
		const roster = callsigns.length > 3 ? `${callsigns.slice(0, 3).join(", ")} +${callsigns.length - 3}` : callsigns.join(", ") || "—";
		const phase = view.phases.find((p) => p.state === "active")?.title ?? (view.phases.length && view.phases.every((p) => p.state === "done") ? "done" : "—");
		const name = view.source === "pi-dynamic-workflows" ? `${viewName(view)} (pi-dw)` : viewName(view);
		const result = top.length ? `${view.status} · verified ${view.verified.verified}/${top.length}` : view.status;
		lines.push([cell(name, 26), cell(phase, 14), cell(roster, 26), cell(`${settled}/${top.length}`, 9), cell(result, 26)].join(" · "));
	}
	return lines.map((line) => fit(line.trimEnd(), width));
}

// ═══ ANSI painter for the pane ═══════════════════════════════════════════════
function ansi(hex, text) {
	const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (!m) return text;
	return `\x1b[38;2;${parseInt(m[1], 16)};${parseInt(m[2], 16)};${parseInt(m[3], 16)}m${text}\x1b[39m`;
}

// ═══ CLI ═════════════════════════════════════════════════════════════════════
function parseArgs(argv) {
	const out = { follow: false, interval: 1000, tick: 0 };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === "--run") out.run = next();
		else if (a === "--list") out.list = next();
		else if (a === "--project") out.project = next();
		else if (a === "--follow") out.follow = true;
		else if (a === "--interval") out.interval = Math.max(100, Number(next()) || 1000);
		else if (a === "--width") out.width = Number(next());
		else if (a === "--height") out.height = Number(next());
		else if (a === "--tick") out.tick = Number(next()) || 0;
		else if (a === "--now") out.now = Date.parse(next());
		else if (a === "--color") out.color = true;
		else if (a === "--help" || a === "-h") out.help = true;
	}
	return out;
}
function listRuns(root, project) {
	let lines;
	try {
		lines = fs.readFileSync(path.join(root, "index.jsonl"), "utf8").split("\n");
	} catch {
		return [];
	}
	const dirs = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line);
			if (e?.runId && e.projectSlug && (!project || e.projectSlug === project)) dirs.push(path.join(root, e.projectSlug, e.runId));
		} catch {}
	}
	return dirs.slice(-300).reverse();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || (!args.run && !args.list)) {
		process.stdout.write("usage: titan-monitor.mjs --run <runDir> [--follow] [--interval ms] [--width N] [--height N] [--tick N] [--now iso] [--color]\n       titan-monitor.mjs --list <runsRoot> --project <projectSlug> [--width N]\n");
		process.exit(2);
	}
	const width = Number.isFinite(args.width) && args.width > 0 ? args.width : process.stdout.columns || 120;
	const height = Number.isFinite(args.height) && args.height > 0 ? args.height : process.stdout.rows || 40;
	const color = args.color || (process.stdout.isTTY && !args.width) ? ansi : undefined;
	if (args.list) {
		const views = [];
		for (const dir of listRuns(args.list, args.project)) {
			try {
				views.push(buildRunView(dir, args.now));
			} catch {}
		}
		process.stdout.write(`${renderList(views, width).join("\n")}\n`);
		process.exit(0);
	}
	if (!fs.existsSync(path.join(args.run, "run.json"))) {
		process.stderr.write(`titan-monitor: no run.json in ${args.run}\n`);
		process.exit(2);
	}
	let tick = args.tick;
	const draw = () => {
		const view = buildRunView(args.run, Number.isFinite(args.now) ? args.now : Date.now());
		const lines = renderFrame(view, { width, height, tick, color });
		process.stdout.write(`${args.follow ? "\x1b[2J\x1b[H" : ""}${lines.join("\n")}\n`);
		return view;
	};
	const view = draw();
	if (args.follow && !TERMINAL_RUN.has(view.status)) {
		const timer = setInterval(() => {
			tick += 1;
			let latest;
			try {
				latest = draw();
			} catch (error) {
				process.stderr.write(`titan-monitor: ${error?.message ?? error}\n`);
				return;
			}
			if (TERMINAL_RUN.has(latest.status)) {
				clearInterval(timer);
				process.exit(0);
			}
		}, args.interval);
	}
}
