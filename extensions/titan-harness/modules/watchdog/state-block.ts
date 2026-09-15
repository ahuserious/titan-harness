/**
 * watchdog/state-block.ts — the deterministic state block (plan §5.5 row 1, D3).
 *
 * Built synchronously from the store in well under a second and with no model: run id,
 * phase, node states, agent states, evidence ids (with the sha256 of each package),
 * open findings, the plan digest and the last 20 event hashes. The compaction summary
 * embeds `text` verbatim and the resume prompt starts from it, which is why the field
 * order never changes: a later session can diff two blocks line by line. Pure Node.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type ChainRow, readChain, sha256 } from "../hash-chain.ts";
import { EVENTS_FILE, type RunStore } from "../run-store.ts";
import type { WatchdogFinding } from "./state.ts";

export const STATE_BLOCK_HEADER = "## titan state block";
export const DEFAULT_EVENT_TAIL = 20;

export interface StateBlockJson {
	runId: string;
	workflow?: string;
	command?: string;
	phase?: string;
	phases?: string[];
	status: string;
	nodes: Record<string, string>;
	agents: Array<{ id: string; callsign?: string; state: string; model?: string }>;
	evidence: string[];
	findings: Array<{ id: string; severity: string; summary: string }>;
	planDigest?: string;
	lastEventHashes: string[];
	ts: string;
}

export interface StateBlock {
	text: string;
	json: StateBlockJson;
	sha256: string;
}

export interface StateBlockExtra {
	findings?: WatchdogFinding[];
	planDigest?: string;
	maxEvents?: number;
	/** Test seam: the timestamp written into the block. */
	now?: () => Date;
}

const short = (hash: string | undefined, n = 12): string => (typeof hash === "string" ? hash.slice(0, n) : "?");

function readEvidenceIds(runDir: string): string[] {
	const folder = path.join(runDir, "evidence");
	let names: string[];
	try {
		names = fs.readdirSync(folder).sort();
	} catch {
		return [];
	}
	const ids: string[] = [];
	for (const name of names) {
		const file = path.join(folder, name, "evidence.json");
		try {
			ids.push(`${name}:${sha256(fs.readFileSync(file)).slice(0, 12)}`);
		} catch {
			/* a directory without a package is not evidence */
		}
	}
	return ids;
}

/** Node states from the events chain: node.start marks running, node.end carries the final status (last row wins). */
function nodeStatesFrom(events: ChainRow[]): Record<string, string> {
	const nodes: Record<string, string> = {};
	for (const row of events) {
		const data = (row.data ?? {}) as Record<string, unknown>;
		const nodeId = typeof data.nodeId === "string" ? data.nodeId : undefined;
		if (!nodeId) continue;
		if (row.type === "node.start") nodes[nodeId] = data.skipped ? "skipped" : "running";
		else if (row.type === "node.end") nodes[nodeId] = typeof data.status === "string" ? data.status : "ended";
	}
	return nodes;
}

/** Build the block for `runDir` (throws when run.json is unreadable — a block without a run would be a lie). */
export function buildStateBlock(store: RunStore, runDir: string, extra: StateBlockExtra = {}): StateBlock {
	const run = store.readRun(runDir);
	const events = readChainSafe(path.join(runDir, EVENTS_FILE));
	const tail = events.slice(-(extra.maxEvents ?? DEFAULT_EVENT_TAIL));
	const agents = store.listAgents(runDir).map((a) => ({ id: a.agentId, callsign: a.callsign || undefined, state: a.state, model: a.model || undefined }));
	const findings = (extra.findings ?? []).map((f) => ({ id: f.id, severity: f.severity, summary: f.summary }));
	const json: StateBlockJson = {
		runId: run.runId,
		workflow: run.workflow?.name,
		command: run.command,
		phase: run.currentPhase,
		phases: run.phases,
		status: run.status,
		nodes: nodeStatesFrom(events),
		agents,
		evidence: readEvidenceIds(runDir),
		findings,
		planDigest: extra.planDigest,
		lastEventHashes: tail.map((row) => `${row.seq}:${short(row.hash)}`),
		ts: (extra.now?.() ?? new Date()).toISOString(),
	};
	const lines = [
		STATE_BLOCK_HEADER,
		`- run: ${json.runId} · ${json.workflow ? `workflow: ${json.workflow}` : `command: ${json.command ?? "-"}`} · status: ${json.status}`,
		`- phase: ${json.phase ?? "-"} · phases: ${json.phases?.length ? json.phases.join(" → ") : "-"}`,
		`- nodes: ${Object.keys(json.nodes).length ? Object.entries(json.nodes).map(([id, state]) => `${id}=${state}`).join(", ") : "-"}`,
		`- agents: ${agents.length ? agents.map((a) => `${a.callsign ?? a.id}(${a.id}) ${a.state}${a.model ? ` ${a.model}` : ""}`).join(", ") : "-"}`,
		`- evidence: ${json.evidence.length ? json.evidence.join(", ") : "-"}`,
		`- open findings: ${findings.length ? findings.map((f) => `[${f.severity}] ${f.summary} (${short(f.id, 8)})`).join("; ") : "-"}`,
		`- plan digest: ${json.planDigest ?? "-"}`,
		`- last events: ${json.lastEventHashes.length ? json.lastEventHashes.join(" ") : "-"}`,
		`- ts: ${json.ts}`,
	];
	const text = lines.join("\n");
	return { text, json, sha256: sha256(text) };
}

function readChainSafe(file: string): ChainRow[] {
	try {
		return readChain(file);
	} catch {
		return [];
	}
}

/** "seq ts type · short data" lines for the newest `max` events (oldest first). */
export function formatActivityTail(events: ChainRow[], max = DEFAULT_EVENT_TAIL): string {
	return events
		.slice(-max)
		.map((row) => {
			let data = "";
			try {
				data = JSON.stringify(row.data ?? {});
			} catch {
				data = "?";
			}
			if (data.length > 80) data = `${data.slice(0, 77)}…`;
			return `${row.seq} ${row.ts} ${String(row.type)} · ${data}`;
		})
		.join("\n");
}

/** The custom message the host posts after a default (Pi-summarized) compaction so the block still reaches the context. */
export function stateBlockMessage(block: StateBlock, badge?: string): string {
	return badge ? `${block.text}\n- badge: ${badge}` : block.text;
}
