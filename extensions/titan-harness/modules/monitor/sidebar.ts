/**
 * monitor/sidebar.ts — the workflow progress sidebar (PRD v0.9 R3): the full phased
 * workflow rendered like a todo list, one line per phase, coloured by the role that owns
 * it, with a state glyph, a role box and a short description:
 *
 *   ◧ WORKFLOW proto-analytics-dashboard · running · 5m00s
 *   │ ⠋ [builder]   build — implement the dashboard (redo 2)
 *   │ ● [auditor]   audit — cross-family review of the build
 *   │ ○ [verifier]  verify — kane per device
 *   ctrl+w close · 10 min idle → dormant
 *
 * The `│` bar takes the role colour (state.ts ROLE_COLORS), the rest of the line the
 * phase state colour: working (blue spinner), in-review (amber ●), redo n (orange ●),
 * review-passed (green ✓), done (yellow ●, i.e. done-unverified), failed (red ✗), queued
 * (grey ○), skipped (–). A terminal phase idle for 10 minutes is dormant (dimmed), and the
 * whole sidebar reports itself due to close 10 minutes after the run reached a terminal
 * state (sidebarAutoCloseDue).
 *
 * Sources (pure file reading, no pi): run.json (status, phases, currentPhase, the
 * executor's `result` when cmd-workflow stored it), events.jsonl (node.start/end,
 * agent.start/end, review.verdict, phase.start, workflow.start layers), agents/*.json
 * (states, stateHistory timestamps) and, when the run's workflow is installed, the
 * WorkflowDoc (phases with `detail:`, node phase/role/prompt) — without it the phases are
 * the run's `phases:` titles, else one phase per layer titled by its node ids.
 *
 * Phase state: failed > in-review (an auditor/verifier/verify node running) > redo
 * (a node working on its 2nd+ call or in edit-round-n) > working > queued (nothing
 * started) > and once every node is settled: failed if any failed/cancelled, skipped if
 * all skipped, review-passed if every success is done-verified (or reviewed PASS), else
 * done. The redo counter is the node's extra agent calls (re-asks, loop iterations,
 * reworks) or its edit-round number, whichever is larger.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type ChainRow, readChain } from "../hash-chain.ts";
import { type AgentRecord, EVENTS_FILE, RUN_FILE, type RunMeta, type RunStore } from "../run-store.ts";
import { fmtSecs } from "../runtime.ts";
import type { NodeDoc, WorkflowDoc } from "../workflow/schema.ts";
import { nodeType } from "../workflow/schema.ts";
import { DORMANT_COLOR, PHASE_GLYPH, PHASE_TERMINAL_STATES, type PhaseState, phaseColorOf, roleColorOf, type SidebarRole } from "./state.ts";

export const DORMANT_AFTER_MS = 10 * 60_000;
export const AUTO_CLOSE_AFTER_MS = 10 * 60_000;
export const SIDEBAR_HEADER_COLOR = "#e2e8f0";
export const SIDEBAR_FOOTER_COLOR = "#475569";
const DESCRIPTION_MAX = 60;
const REVIEW_ROLES = new Set<string>(["auditor", "verifier"]);
const TERMINAL_RUN_STATUSES = new Set<string>(["completed", "failed", "aborted", "reauthored", "stalemate"]);
const identity = (_hex: string, text: string): string => text;

export interface SidebarNode {
	id: string;
	type?: string;
	role: SidebarRole;
	state: PhaseState;
	/** The raw agent state the store holds (done-verified, edit-round-n, …) when an agent record exists. */
	agentState?: string;
	/** Extra rounds: re-asks, loop iterations, reworks, or the edit-round number. */
	redo: number;
	lastActivityAt?: string;
	error?: string;
}

export interface SidebarPhase {
	title: string;
	detail: string;
	role: SidebarRole;
	state: PhaseState;
	redo: number;
	nodes: SidebarNode[];
	lastActivityAt?: string;
	/** Terminal and idle ≥ DORMANT_AFTER_MS at `now`. */
	dormant: boolean;
}

export interface SidebarView {
	runId: string;
	name: string;
	status: string;
	terminal: boolean;
	startedAt: string;
	endedAt?: string;
	elapsedMs: number;
	lastActivityAt?: string;
	phases: SidebarPhase[];
	/** Where the phase list came from. */
	source: "doc" | "run" | "layers";
}

export interface SidebarRenderOptions {
	width: number;
	height: number;
	tick: number;
	/** Paints one finished segment; default identity (plain text). */
	color?: (hex: string, text: string) => string;
	/** Add the node lines under every phase. */
	expanded?: boolean;
	/** Now, for the auto-close countdown in the footer. */
	now?: number;
}

const isoMax = (a?: string, b?: string): string | undefined => {
	if (!a) return b;
	if (!b) return a;
	return Date.parse(b) > Date.parse(a) ? b : a;
};

/** A node's role for the sidebar: its declared role, else by type (verify → verifier), else worker for AI nodes and system otherwise. */
export function nodeRole(node: NodeDoc | undefined, eventRole?: string): SidebarRole {
	const declared = node?.role ?? eventRole;
	if (declared && declared !== "exa") return declared as SidebarRole;
	if (!node) return "system";
	const type = nodeType(node);
	if (type === "verify") return "verifier";
	if (type === "prompt" || type === "command" || type === "loop" || type === "best_of" || type === "interleave" || type === "hypothesis") return "worker";
	return "system";
}

/** The first line of a node's prompt (or command/bash), ≤ 60 characters. */
export function nodeDescription(node: NodeDoc | undefined): string {
	if (!node) return "";
	const text =
		(node as { prompt?: string }).prompt ??
		(node as { loop?: { prompt?: string } }).loop?.prompt ??
		(node as { best_of?: { prompt?: string } }).best_of?.prompt ??
		(node as { interleave?: { prompt?: string } }).interleave?.prompt ??
		(node as { approval?: { message?: string } }).approval?.message ??
		(node as { verify?: { objective?: string } }).verify?.objective ??
		(node as { command?: string }).command ??
		(node as { bash?: string }).bash ??
		"";
	const line = String(text).split("\n").map((l) => l.trim()).find(Boolean) ?? "";
	return [...line].length > DESCRIPTION_MAX ? `${[...line].slice(0, DESCRIPTION_MAX - 1).join("")}…` : line;
}

/** Terminal states of an agent record → the node state they imply. */
const agentStateToPhase = (state: string | undefined): PhaseState | undefined => {
	switch (state) {
		case "done-verified":
			return "review-passed";
		case "done-unverified":
			return "done";
		case "failed":
		case "failed-review":
		case "watchdog-failed":
		case "stalemate":
			return "failed";
		case "cancelled":
			return "skipped";
		case "in-review":
			return "in-review";
		case "edit-round-n":
			return "redo";
		default:
			return undefined;
	}
};

interface NodeFacts {
	started: number;
	ended?: { status: string; error?: string };
	agentCalls: number;
	reviewed?: "pass" | "fail";
	lastActivityAt?: string;
	type?: string;
	role?: string;
	layer?: number;
	phase?: string;
}

function readEvents(runDir: string): ChainRow[] {
	try {
		return readChain(path.join(runDir, EVENTS_FILE));
	} catch {
		return [];
	}
}

function readRunFile(runDir: string): RunMeta & { result?: { nodes?: Record<string, { status?: string; attempts?: number; error?: string; endedAt?: string }> } } {
	return JSON.parse(fs.readFileSync(path.join(runDir, RUN_FILE), "utf8"));
}

/** Fold a run directory (+ its workflow doc when known) into the sidebar view. */
export function buildSidebarView(store: RunStore, runDir: string, doc: WorkflowDoc | undefined, now: number = Date.now()): SidebarView {
	const run = readRunFile(runDir);
	store.readRun(runDir); // registers the run id for later appends by the caller
	const events = readEvents(runDir);
	const agents = new Map<string, AgentRecord>();
	for (const record of store.listAgents(runDir)) agents.set(record.agentId, record);
	const facts = new Map<string, NodeFacts>();
	const fact = (id: string): NodeFacts => {
		let f = facts.get(id);
		if (!f) {
			f = { started: 0, agentCalls: 0 };
			facts.set(id, f);
		}
		return f;
	};
	let layers: string[][] | undefined;
	let currentPhase: string | undefined;
	let lastActivityAt: string | undefined;
	for (const event of events) {
		const data = (event.data ?? {}) as Record<string, unknown>;
		const type = String(event.type ?? "");
		const ts = typeof event.ts === "string" ? event.ts : undefined;
		if (type === "workflow.start" && Array.isArray(data.layers)) layers = data.layers as string[][];
		if (type === "phase.start" && typeof data.phase === "string") currentPhase = data.phase;
		const nodeId = typeof data.nodeId === "string" ? data.nodeId : undefined;
		if (type === "node.start" && nodeId) {
			const f = fact(nodeId);
			if (data.skipped !== true) f.started += 1;
			if (typeof data.type === "string") f.type = data.type;
			if (typeof data.role === "string") f.role = data.role;
			if (typeof data.layer === "number") f.layer = data.layer;
			f.phase = typeof data.phase === "string" ? data.phase : (f.phase ?? currentPhase);
			f.lastActivityAt = isoMax(f.lastActivityAt, ts);
		} else if (type === "node.end" && nodeId) {
			const f = fact(nodeId);
			f.ended = { status: String(data.status ?? "success"), error: typeof data.error === "string" ? data.error : undefined };
			f.lastActivityAt = isoMax(f.lastActivityAt, ts);
		} else if (type === "agent.start" && nodeId) {
			const f = fact(nodeId);
			f.agentCalls += 1;
			if (typeof data.role === "string" && !f.role) f.role = data.role;
			f.lastActivityAt = isoMax(f.lastActivityAt, ts);
		} else if (type === "agent.end" && nodeId) {
			fact(nodeId).lastActivityAt = isoMax(fact(nodeId).lastActivityAt, ts);
		} else if (type === "review.verdict") {
			const reviewed = typeof data.reviewedNodeId === "string" ? data.reviewedNodeId : undefined;
			if (reviewed) {
				const f = fact(reviewed);
				const verdict = String(data.verdict ?? data.status ?? "").toUpperCase();
				f.reviewed = verdict === "PASS" || verdict === "PASS_WITH_WARNINGS" || data.state === "done-verified" ? "pass" : "fail";
				f.lastActivityAt = isoMax(f.lastActivityAt, ts);
			}
		}
		if (ts && type !== "workflow.start") lastActivityAt = isoMax(lastActivityAt, ts);
	}
	// The executor's stored result (cmd-workflow writes it at the end) settles nodes the events may not cover.
	for (const [id, node] of Object.entries(run.result?.nodes ?? {})) {
		const f = fact(id);
		if (!f.ended && node?.status && node.status !== "pending" && node.status !== "running" && node.status !== "waiting") f.ended = { status: String(node.status), error: node.error };
		if (node?.endedAt) f.lastActivityAt = isoMax(f.lastActivityAt, node.endedAt);
	}
	// Agent records: states and their timestamps.
	const agentStateOf = (id: string): string | undefined => agents.get(id)?.state;
	const agentActivity = (id: string): string | undefined => {
		let latest: string | undefined;
		for (const [agentId, record] of agents) {
			if (agentId !== id && !agentId.startsWith(`${id}#`)) continue;
			for (const entry of record.stateHistory ?? []) latest = isoMax(latest, entry.ts);
		}
		return latest;
	};
	const editRound = (id: string): number => {
		const record = agents.get(id);
		const match = /edit-round-(\d+)/.exec(String(record?.state ?? ""));
		if (match) return Number(match[1]);
		return record?.state === "edit-round-n" ? 1 : 0;
	};

	const docNodes = new Map<string, NodeDoc>();
	for (const node of doc?.nodes ?? []) docNodes.set(node.id, node);

	const nodeView = (id: string): SidebarNode => {
		const node = docNodes.get(id);
		const f = facts.get(id);
		const role = nodeRole(node, f?.role);
		const type = node ? nodeType(node) : f?.type;
		const agentState = agentStateOf(id);
		const calls = Math.max(0, (f?.agentCalls ?? 0) - 1);
		const redo = Math.max(calls, editRound(id));
		let state: PhaseState = "queued";
		if (f?.ended) {
			const status = f.ended.status;
			if (status === "success") {
				const fromAgent = agentStateToPhase(agentState);
				state = f.reviewed === "pass" || fromAgent === "review-passed" ? "review-passed" : f.reviewed === "fail" || fromAgent === "failed" ? "failed" : "done";
			} else if (status === "skipped") state = "skipped";
			else state = "failed";
		} else if (f && f.started > 0) {
			const fromAgent = agentStateToPhase(agentState);
			if (fromAgent === "in-review" || REVIEW_ROLES.has(role) || type === "verify") state = "in-review";
			else if (redo > 0 || fromAgent === "redo") state = "redo";
			else if (fromAgent === "failed") state = "failed";
			else state = "working";
		}
		const view: SidebarNode = { id, role, state, redo };
		if (type) view.type = type;
		if (agentState) view.agentState = agentState;
		const activity = isoMax(f?.lastActivityAt, agentActivity(id));
		if (activity) view.lastActivityAt = activity;
		if (f?.ended?.error) view.error = f.ended.error;
		return view;
	};

	// Phases: the doc's `phases:`, else the run's titles, else one per layer.
	let source: SidebarView["source"] = "layers";
	let groups: Array<{ title: string; detail: string; ids: string[] }> = [];
	const phaseOfNode = (id: string): string | undefined => docNodes.get(id)?.phase ?? facts.get(id)?.phase;
	const allIds = [...new Set([...(doc?.nodes ?? []).map((n) => n.id), ...facts.keys()])];
	const titles: Array<{ title: string; detail?: string }> = doc?.phases?.length ? doc.phases : (run.phases ?? []).map((title) => ({ title }));
	if (titles.length) {
		source = doc?.phases?.length ? "doc" : "run";
		groups = titles.map((phase) => ({ title: phase.title, detail: phase.detail ?? "", ids: allIds.filter((id) => phaseOfNode(id) === phase.title) }));
		const orphans = allIds.filter((id) => !phaseOfNode(id) || !titles.some((t) => t.title === phaseOfNode(id)));
		if (orphans.length) groups.push({ title: "other", detail: "", ids: orphans });
	} else {
		const byLayer = new Map<number, string[]>();
		if (layers) layers.forEach((ids, index) => byLayer.set(index, [...ids]));
		for (const id of allIds) {
			const layer = facts.get(id)?.layer;
			if (layers && layers.some((ids) => ids.includes(id))) continue;
			const key = layer ?? byLayer.size;
			byLayer.set(key, [...(byLayer.get(key) ?? []), id]);
		}
		groups = [...byLayer.entries()].sort((a, b) => a[0] - b[0]).map(([index, ids]) => ({ title: `layer ${index + 1}: ${ids.join(", ")}`, detail: "", ids }));
	}

	const phases: SidebarPhase[] = groups.map((group) => {
		const nodes = group.ids.map(nodeView);
		const first = group.ids.map((id) => docNodes.get(id)).find((node) => node && ["prompt", "command", "loop", "best_of", "interleave", "hypothesis"].includes(nodeType(node) ?? ""));
		const role: SidebarRole = nodes.length ? nodeRole(first ?? docNodes.get(group.ids[0]), facts.get(group.ids[0])?.role) : "system";
		const detail = group.detail || nodeDescription(first ?? docNodes.get(group.ids[0]));
		let state: PhaseState = "queued";
		const redo = nodes.reduce((max, node) => Math.max(max, node.redo), 0);
		if (nodes.length) {
			const settled = nodes.every((node) => PHASE_TERMINAL_STATES.includes(node.state));
			if (nodes.some((node) => node.state === "failed" && !settled)) state = "failed";
			else if (nodes.some((node) => node.state === "in-review")) state = "in-review";
			else if (nodes.some((node) => node.state === "redo")) state = "redo";
			else if (nodes.some((node) => node.state === "working")) state = "working";
			else if (settled) {
				if (nodes.some((node) => node.state === "failed")) state = "failed";
				else if (nodes.every((node) => node.state === "skipped")) state = "skipped";
				else if (nodes.filter((node) => node.state !== "skipped").every((node) => node.state === "review-passed")) state = "review-passed";
				else state = "done";
			} else state = "queued";
		}
		let last: string | undefined;
		for (const node of nodes) last = isoMax(last, node.lastActivityAt);
		const terminal = PHASE_TERMINAL_STATES.includes(state);
		const idleMs = last ? now - Date.parse(last) : Number.POSITIVE_INFINITY;
		const phase: SidebarPhase = { title: group.title, detail, role, state, redo, nodes, dormant: terminal && idleMs >= DORMANT_AFTER_MS };
		if (last) phase.lastActivityAt = last;
		return phase;
	});

	const started = Date.parse(run.startedAt);
	const ended = run.endedAt ? Date.parse(run.endedAt) : now;
	const view: SidebarView = {
		runId: run.runId,
		name: run.workflow?.name ?? run.command ?? "run",
		status: run.status,
		terminal: TERMINAL_RUN_STATUSES.has(run.status),
		startedAt: run.startedAt,
		elapsedMs: Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : 0,
		phases,
		source,
	};
	if (run.endedAt) view.endedAt = run.endedAt;
	const activity = isoMax(lastActivityAt, run.endedAt);
	if (activity) view.lastActivityAt = activity;
	return view;
}

/** True 10 minutes after the run reached a terminal state (endedAt, else its last activity, else its start). */
export function sidebarAutoCloseDue(view: Pick<SidebarView, "terminal" | "endedAt" | "lastActivityAt" | "startedAt">, now: number = Date.now()): boolean {
	if (!view.terminal) return false;
	const anchor = Date.parse(view.endedAt ?? view.lastActivityAt ?? view.startedAt);
	return Number.isFinite(anchor) && now - anchor >= AUTO_CLOSE_AFTER_MS;
}

/** Truncate to `width` code points with an ellipsis. */
const fit = (text: string, width: number): string => {
	const chars = [...text];
	if (width <= 0) return "";
	if (chars.length <= width) return text;
	if (width === 1) return "…";
	return `${chars.slice(0, width - 1).join("")}…`;
};

const stateLabel = (node: { state: PhaseState; redo: number }): string => (node.state === "redo" ? `redo ${Math.max(1, node.redo)}` : node.state);

/** `│ ⠋ [builder]   build — implement the dashboard (redo 2)` without colour. */
export function phaseLineText(phase: SidebarPhase, tick: number): string {
	const box = `[${phase.role}]`.padEnd(11);
	const body = phase.detail ? `${phase.title} — ${phase.detail}` : phase.title;
	const suffix = phase.state === "redo" || (phase.redo > 0 && !PHASE_TERMINAL_STATES.includes(phase.state)) ? ` (redo ${Math.max(1, phase.redo)})` : phase.redo > 0 ? ` (${phase.redo} redo)` : "";
	const status = phase.state === "failed" || phase.state === "skipped" || phase.state === "review-passed" || phase.state === "in-review" ? ` · ${phase.state}` : "";
	return `│ ${PHASE_GLYPH(phase.state, tick)} ${box} ${body}${suffix}${status}${phase.dormant ? " · dormant" : ""}`;
}

/** `  └ implement · redo 2` */
export function nodeLineText(node: SidebarNode): string {
	return `  └ ${node.id} · ${stateLabel(node)}${node.error ? ` · ${node.error}` : ""}`;
}

export function sidebarHeaderText(view: SidebarView): string {
	return `◧ WORKFLOW ${view.name} · ${view.status} · ${fmtSecs(view.elapsedMs)}`;
}

export function sidebarFooterText(view: SidebarView, now: number = Date.now()): string {
	const bits = ["ctrl+w close", "10 min idle → dormant"];
	if (view.terminal) {
		const anchor = Date.parse(view.endedAt ?? view.lastActivityAt ?? view.startedAt);
		const left = Number.isFinite(anchor) ? Math.max(0, AUTO_CLOSE_AFTER_MS - (now - anchor)) : AUTO_CLOSE_AFTER_MS;
		bits.push(`auto-close in ${Math.ceil(left / 60_000)} min`);
	}
	return bits.join(" · ");
}

/** Render the sidebar as painted lines, never wider than `width` nor taller than `height`. */
export function renderSidebar(view: SidebarView, opts: SidebarRenderOptions): string[] {
	const paint = opts.color ?? identity;
	const width = Math.max(1, Math.floor(opts.width));
	const height = Math.max(1, Math.floor(opts.height));
	const now = opts.now ?? Date.now();
	const lines: string[] = [paint(SIDEBAR_HEADER_COLOR, fit(sidebarHeaderText(view), width))];
	const body: string[] = [];
	for (const phase of view.phases) {
		const text = fit(phaseLineText(phase, opts.tick), width);
		const stateColor = phaseColorOf(phase.state, phase.dormant);
		// The bar keeps the role colour; a dormant line dims the rest.
		const bar = [...text][0] === "│" ? paint(phase.dormant ? DORMANT_COLOR : roleColorOf(phase.role), "│") + paint(stateColor, [...text].slice(1).join("")) : paint(stateColor, text);
		body.push(bar);
		if (opts.expanded) for (const node of phase.nodes) body.push(paint(phaseColorOf(node.state, phase.dormant), fit(nodeLineText(node), width)));
	}
	const footer = paint(SIDEBAR_FOOTER_COLOR, fit(sidebarFooterText(view, now), width));
	const available = Math.max(0, height - 2);
	if (body.length > available) {
		const shown = body.slice(0, Math.max(0, available - 1));
		lines.push(...shown, paint(SIDEBAR_FOOTER_COLOR, fit(`… ${body.length - shown.length} more lines`, width)));
	} else lines.push(...body);
	lines.push(footer);
	return lines.slice(0, height);
}
