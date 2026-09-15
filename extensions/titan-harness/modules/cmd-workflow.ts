/**
 * cmd-workflow.ts — /workflow, the YAML DAG engine's front door (plan §7 P3, D1).
 *
 *   /workflow run <name> [--input k=v]... [--args "text"] [--dry-run]
 *                                   validate + load, open a run in the store, execute the
 *                                   DAG, stream node ends to the status line, post the
 *                                   final panel; --dry-run prints the layer plan and the
 *                                   graph without opening a run
 *   /workflow validate <name|path> [--json]
 *                                   every validator rule, errors then warnings
 *   /workflow list                  project → user → package workflows (shadowing order)
 *   /workflow status [runId]        run.json + the last 20 events of the latest (or given)
 *                                   workflow run for this project; the live run when one
 *                                   is in flight
 *   /workflow stop                  abort the in-flight run (its AbortController)
 *   /workflow graph <name|path>     Mermaid `flowchart TD` of nodes and depends_on
 *   /workflow help
 *
 * One run per session at a time: `run` refuses while another is in flight. The module
 * renders nothing pi-specific beyond ctx.ui.setStatus / deps.notify / deps.panel; the
 * factory (titan-harness.ts) supplies the WorkflowRuntimeDeps (agent, bash, script,
 * approval, role resolution) through `WorkflowCommandDeps.runtime`. The pure helpers —
 * parseRunArgs, mermaidFor, formatRunPanel, formatStatusPanel, formatLayerPlan — are
 * exported for tests and never touch pi.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";
import { type ChainRow, readChain } from "./hash-chain.ts";
import { formatTotals, readLedger, totalsFor } from "./ledger.ts";
import { EVENTS_FILE, type RunMeta, RunStore, type RunStatus } from "./run-store.ts";
import { fmtSecs } from "./runtime.ts";
import { executeWorkflow, type NodeResult, type RunResult, type WorkflowRuntimeDeps } from "./workflow/executor.ts";
import { defaultValidateContext, type LoadedWorkflow, listWorkflows, loadWorkflow, resolveWorkflow } from "./workflow/loader.ts";
import { layers } from "./workflow/scheduler.ts";
import { type NodeDoc, type NodeType, nodeType, type WorkflowDoc } from "./workflow/schema.ts";
import { formatIssues, type ValidateContext, validateFile } from "./workflow/validator.ts";

/** The status-line key every /workflow message uses (one line, replaced in place). */
export const STATUS_KEY = "titan-workflow";
export const SUBCOMMANDS = ["run", "validate", "list", "status", "stop", "graph", "help"] as const;
const EVENT_TAIL = 20;

export interface WorkflowCommandDeps {
	cwd(ctx: any): string;
	runtime(ctx: any, loaded: LoadedWorkflow, runId: string, runDir: string): WorkflowRuntimeDeps;
	store(): RunStore;
	notify(ctx: any, text: string, level?: string): void;
	panel(ctx: any, title: string, markdown: string): void;
	validateContext(cwd: string, ctx: any): Partial<ValidateContext>;
}

export interface RunArgs {
	name?: string;
	inputs: Record<string, unknown>;
	arguments?: string;
	dryRun: boolean;
	json: boolean;
	errors: string[];
}

/** One glyph per node type, used in the graph and the run table. */
export const TYPE_GLYPH: Record<NodeType, string> = {
	command: "⌘",
	prompt: "✎",
	bash: "$",
	script: "⚙",
	loop: "↻",
	approval: "✋",
	cancel: "⊘",
	verify: "✓",
	best_of: "⚖",
	interleave: "⫴",
	hypothesis: "?",
	mcp_tool: "⚡",
	workflow: "⧉",
};

const STATUS_GLYPH: Record<NodeResult["status"], string> = {
	pending: "○",
	waiting: "⏸",
	running: "◐",
	success: "✓",
	failed: "✗",
	skipped: "⤼",
	cancelled: "⊘",
};

// ═══ Argument parsing ════════════════════════════════════════════════════════

/** Shell-like tokens: whitespace-separated, double or single quotes group, backslash escapes inside double quotes and bare text. */
export function tokenize(text: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let started = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) quote = undefined;
			else if (ch === "\\" && quote === '"' && i + 1 < text.length) current += text[++i];
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
		} else if (ch === "\\" && i + 1 < text.length) {
			current += text[++i];
			started = true;
		} else if (/\s/.test(ch)) {
			if (started) tokens.push(current);
			current = "";
			started = false;
		} else {
			current += ch;
			started = true;
		}
	}
	if (started) tokens.push(current);
	return tokens;
}

/** `--input k=v` values: JSON when it parses to a non-string (123, true, null, [..], {..}); otherwise the raw text. */
export function parseInputValue(raw: string): unknown {
	const text = raw.trim();
	if (text === "") return "";
	try {
		const parsed = JSON.parse(text);
		return typeof parsed === "string" ? raw : parsed;
	} catch {
		return raw;
	}
}

/**
 * `run <name> [--input k=v]... [--args "text"] [--dry-run]` (also `validate <name> [--json]`).
 * Bare tokens after the name join into `arguments` when --args is absent (Archon's
 * `workflow run <name> <args…>` habit). Unknown flags are errors, never silently ignored.
 */
export function parseRunArgs(args: string): RunArgs {
	const out: RunArgs = { inputs: {}, dryRun: false, json: false, errors: [] };
	const tokens = tokenize(args);
	const bare: string[] = [];
	let explicitArgs: string | undefined;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!token.startsWith("--")) {
			bare.push(token);
			continue;
		}
		const eq = token.indexOf("=");
		const flag = eq >= 0 ? token.slice(2, eq) : token.slice(2);
		const inlineValue = eq >= 0 ? token.slice(eq + 1) : undefined;
		const takeValue = (): string | undefined => {
			if (inlineValue !== undefined) return inlineValue;
			if (i + 1 < tokens.length) return tokens[++i];
			return undefined;
		};
		switch (flag) {
			case "dry-run":
				out.dryRun = true;
				break;
			case "json":
				out.json = true;
				break;
			case "input": {
				const pair = takeValue();
				const sep = pair?.indexOf("=") ?? -1;
				if (!pair || sep <= 0) {
					out.errors.push(`--input expects key=value${pair ? ` (got ${JSON.stringify(pair)})` : ""}`);
					break;
				}
				out.inputs[pair.slice(0, sep).trim()] = parseInputValue(pair.slice(sep + 1));
				break;
			}
			case "args": {
				const value = takeValue();
				if (value === undefined) out.errors.push("--args expects a value");
				else explicitArgs = value;
				break;
			}
			default:
				out.errors.push(`unknown flag --${flag}`);
		}
	}
	if (bare.length) out.name = bare[0];
	const rest = bare.slice(1).join(" ");
	if (explicitArgs !== undefined) out.arguments = explicitArgs;
	else if (rest) out.arguments = rest;
	return out;
}

// ═══ Rendering (pure) ════════════════════════════════════════════════════════

const mermaidId = (id: string): string => `n_${id.replace(/[^A-Za-z0-9_]/g, "_")}`;
const mermaidText = (text: string): string => text.replace(/"/g, "#quot;").replace(/\r?\n/g, " ");

/** Mermaid `flowchart TD`: one node per id with a type glyph (+ role, when, trigger rule), phases as subgraphs, depends_on as edges. */
export function mermaidFor(doc: Pick<WorkflowDoc, "nodes"> & Partial<Pick<WorkflowDoc, "phases" | "returns" | "name">>): string {
	const nodes = Array.isArray(doc.nodes) ? doc.nodes.filter((node): node is NodeDoc => !!node && typeof node === "object" && typeof (node as NodeDoc).id === "string") : [];
	const lines = ["flowchart TD"];
	const label = (node: NodeDoc): string => {
		const type = nodeType(node);
		const parts = [`${type ? TYPE_GLYPH[type] : "▢"} ${node.id}`];
		const meta = [type ?? "?", node.role].filter(Boolean).join(" · ");
		parts.push(`(${meta})`);
		if (node.when) parts.push(`when ${node.when}`);
		if (node.trigger_rule && node.trigger_rule !== "all_success") parts.push(node.trigger_rule);
		return mermaidText(parts.join(" "));
	};
	const decl = (node: NodeDoc): string => (doc.returns === node.id ? `${mermaidId(node.id)}(["${label(node)}"])` : `${mermaidId(node.id)}["${label(node)}"]`);
	const byPhase = new Map<string, NodeDoc[]>();
	const loose: NodeDoc[] = [];
	const phaseTitles = (doc.phases ?? []).map((phase) => phase.title);
	for (const node of nodes) {
		if (node.phase && phaseTitles.includes(node.phase)) {
			byPhase.set(node.phase, [...(byPhase.get(node.phase) ?? []), node]);
		} else loose.push(node);
	}
	for (const title of phaseTitles) {
		const members = byPhase.get(title);
		if (!members?.length) continue;
		lines.push(`  subgraph ${mermaidId(`phase_${title}`)}["${mermaidText(title)}"]`);
		for (const node of members) lines.push(`    ${decl(node)}`);
		lines.push("  end");
	}
	for (const node of loose) lines.push(`  ${decl(node)}`);
	const known = new Set(nodes.map((node) => node.id));
	for (const node of nodes) {
		for (const dep of node.depends_on ?? []) {
			if (known.has(dep)) lines.push(`  ${mermaidId(dep)} --> ${mermaidId(node.id)}`);
			else lines.push(`  ${mermaidId(dep)}["? ${mermaidText(dep)} (missing)"] -.-> ${mermaidId(node.id)}`);
		}
	}
	return lines.join("\n");
}

/** The dry-run view: topological layers with each node's type and readiness inputs. */
export function formatLayerPlan(doc: WorkflowDoc): string {
	const byId = new Map(doc.nodes.map((node) => [node.id, node]));
	const rows = layers(doc).map((layer, index) => {
		const items = layer.map((id) => {
			const node = byId.get(id);
			const type = node ? nodeType(node) : undefined;
			const bits = [`${type ? TYPE_GLYPH[type] : "▢"} ${id}`];
			if (node?.role) bits.push(node.role);
			if (node?.when) bits.push(`when ${node.when}`);
			if (node?.trigger_rule && node.trigger_rule !== "all_success") bits.push(node.trigger_rule);
			return bits.join(" · ");
		});
		return `${index + 1}. ${items.join("  |  ")}`;
	});
	return rows.length ? rows.join("\n") : "(no nodes)";
}

const msBetween = (start?: string, end?: string): number | undefined => {
	if (!start || !end) return undefined;
	const ms = new Date(end).getTime() - new Date(start).getTime();
	return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
};
const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const jsonBlock = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;

const RESULT_GLYPH: Record<RunResult["status"], string> = { completed: "✓", failed: "✗", cancelled: "⊘", paused: "⏸" };

/** The final markdown panel: a node table (status/attempts/duration), the `returns` value, the artifacts dir, the error. */
export function formatRunPanel(result: RunResult, opts: { name?: string; artifactsDir?: string; elapsedMs?: number; inputs?: Record<string, unknown> } = {}): string {
	const head = [`**${opts.name ?? "workflow"}** · \`${result.runId}\` · ${RESULT_GLYPH[result.status] ?? "•"} ${result.status}${opts.elapsedMs !== undefined ? ` · ${fmtSecs(opts.elapsedMs)}` : ""}`];
	if (opts.inputs && Object.keys(opts.inputs).length) head.push(`inputs: \`${clip(JSON.stringify(opts.inputs), 200)}\``);
	const nodes = Object.values(result.nodes ?? {}).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.nodeId.localeCompare(b.nodeId));
	const table = ["| node | type | status | attempts | duration | note |", "|---|---|---|---|---|---|"];
	for (const node of nodes) {
		const ms = msBetween(node.startedAt, node.endedAt);
		const note = node.error ? clip(node.error, 120) : node.status === "success" && node.usage ? `${node.usage.tokensIn + node.usage.tokensOut} tok · $${node.usage.costUsd.toFixed(4)}` : "";
		table.push(`| ${cell(node.nodeId)} | ${TYPE_GLYPH[node.type] ?? ""} ${cell(node.type)} | ${STATUS_GLYPH[node.status] ?? ""} ${cell(node.status)} | ${node.attempts} | ${ms === undefined ? "" : fmtSecs(ms)} | ${cell(note)} |`);
	}
	const sections = [head.join("\n"), nodes.length ? table.join("\n") : "_no nodes ran_"];
	if (result.returns !== undefined) sections.push(`**returns**\n${jsonBlock(result.returns)}`);
	if (result.error) sections.push(`**error:** ${result.error}`);
	if (opts.artifactsDir) sections.push(`artifacts: \`${opts.artifactsDir}\``);
	return sections.join("\n\n");
}

const eventSummary = (row: ChainRow): string => {
	const data = (row.data && typeof row.data === "object" ? row.data : {}) as Record<string, unknown>;
	const bits: string[] = [];
	if (typeof data.nodeId === "string") bits.push(data.nodeId);
	if (typeof data.status === "string") bits.push(data.status);
	if (typeof data.error === "string") bits.push(`error: ${data.error}`);
	if (!bits.length) {
		const rest = JSON.stringify(data);
		if (rest && rest !== "{}") bits.push(rest);
	}
	return clip(bits.join(" · "), 100);
};

/** The status panel: run.json headline, ledger totals, the last EVENT_TAIL events, and the node table when the run stored its result. */
export function formatStatusPanel(run: RunMeta, events: ChainRow[], opts: { result?: RunResult; totals?: string; live?: { elapsedMs: number } } = {}): string {
	const head = [`**${run.workflow?.name ?? run.command ?? "run"}** · \`${run.runId}\` · ${opts.live ? `◐ running · ${fmtSecs(opts.live.elapsedMs)}` : run.status}`];
	head.push(`started ${run.startedAt}${run.endedAt ? ` · ended ${run.endedAt}` : ""}${run.currentPhase ? ` · phase ${run.currentPhase}` : ""}`);
	if (opts.totals) head.push(opts.totals);
	const tail = events.slice(-EVENT_TAIL);
	const table = ["| seq | time | event | detail |", "|---|---|---|---|"];
	for (const row of tail) {
		const time = typeof row.ts === "string" ? row.ts.replace(/^.*T/, "").replace(/\.\d+Z$/, "Z") : "";
		table.push(`| ${row.seq} | ${time} | ${cell(String(row.type ?? ""))}${row.agentId ? ` (${cell(String(row.agentId))})` : ""} | ${cell(eventSummary(row))} |`);
	}
	const sections = [head.join("\n"), tail.length ? `${events.length > EVENT_TAIL ? `_last ${EVENT_TAIL} of ${events.length} events_\n` : ""}${table.join("\n")}` : "_no events yet_"];
	if (opts.result) sections.push(formatRunPanel(opts.result, { name: run.workflow?.name }));
	return sections.join("\n\n");
}

export function helpText(): string {
	return [
		"/workflow run <name> [--input k=v]... [--args \"text\"] [--dry-run]   validate, then execute the DAG (one run per session)",
		"/workflow validate <name|path> [--json]                              every validator rule: errors, then warnings",
		"/workflow list                                                       workflows visible from this project (project › user › package)",
		"/workflow status [runId]                                             run.json + the last 20 events (latest run by default)",
		"/workflow stop                                                       abort the in-flight run",
		"/workflow graph <name|path>                                          Mermaid flowchart of nodes and depends_on",
		"/workflow help",
		"Workflows live in .titan/workflows/<name>/<name>.yaml (project) or ~/.pi/titan-harness/workflows/ (user); see skill titan-workflow-authoring.",
	].join("\n");
}

// ═══ Command registration ═════════════════════════════════════════════════════

interface LiveRun {
	runId: string;
	dir: string;
	name: string;
	controller: AbortController;
	startedAt: number;
}

const RUN_STATUS: Record<RunResult["status"], RunStatus> = { completed: "completed", failed: "failed", cancelled: "aborted", paused: "paused" };

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The loader's default context for a workflow dir, with the factory's overrides (modelStatus, thinkingCeiling, …) on top; undefined overrides are skipped. */
function validateContextFor(base: Partial<ValidateContext>, dir: string, cwd: string): ValidateContext {
	const full: ValidateContext = { ...defaultValidateContext(dir, cwd) };
	for (const [key, value] of Object.entries(base ?? {})) if (value !== undefined) (full as unknown as Record<string, unknown>)[key] = value;
	return full;
}

const runTotals = (result: RunResult): RunMeta["totals"] => {
	let tokens = 0;
	let costUsd = 0;
	let agents = 0;
	for (const node of Object.values(result.nodes ?? {})) {
		if (!node.usage) continue;
		agents += 1;
		tokens += node.usage.tokensIn + node.usage.tokensOut;
		costUsd += node.usage.costUsd;
	}
	return { tokens, costUsd, agents };
};

export function registerWorkflowCommands(pi: ExtensionAPI, deps: WorkflowCommandDeps): void {
	let current: LiveRun | undefined;

	const setStatus = (ctx: any, text: string | undefined) => {
		try {
			ctx.ui?.setStatus?.(STATUS_KEY, text);
		} catch {
			/* headless */
		}
	};

	const run = async (ctx: any, rest: string) => {
		const parsed = parseRunArgs(rest);
		if (parsed.errors.length) return deps.notify(ctx, `Not run: ${parsed.errors.join("; ")}\nUsage: /workflow run <name> [--input k=v]... [--args \"text\"] [--dry-run]`, "warning");
		if (!parsed.name) return deps.notify(ctx, "Usage: /workflow run <name> [--input k=v]... [--args \"text\"] [--dry-run]", "warning");
		if (current) return deps.notify(ctx, `A workflow run is already in flight (${current.name} · ${current.runId}). /workflow stop it first, or wait for it to finish.`, "warning");
		const cwd = deps.cwd(ctx);
		let loaded: LoadedWorkflow;
		try {
			loaded = loadWorkflow(parsed.name, cwd, deps.validateContext(cwd, ctx));
		} catch (error) {
			return deps.notify(ctx, `Not run: ${errorText(error)}`, "error");
		}
		if (loaded.validation.warnings.length) deps.notify(ctx, `${loaded.name}: ${loaded.validation.warnings.length} validator warning(s)\n${formatIssues(loaded.validation)}`, "warning");
		const doc = loaded.normalized;
		if (parsed.dryRun) {
			const body = [
				`**${loaded.name}** (${loaded.source}) · \`${loaded.path}\` · sha256 ${loaded.sha256.slice(0, 12)}`,
				Object.keys(parsed.inputs).length ? `inputs: \`${JSON.stringify(parsed.inputs)}\`` : "",
				parsed.arguments ? `arguments: ${parsed.arguments}` : "",
				"**layers**",
				formatLayerPlan(doc),
				"```mermaid",
				mermaidFor(doc),
				"```",
			].filter(Boolean);
			return deps.panel(ctx, `◆ WORKFLOW ${loaded.name} — DRY RUN`, body.join("\n\n"));
		}
		const store = deps.store();
		const { runId, dir } = store.open({
			projectSlug: RunStore.projectSlug(cwd),
			cwd,
			command: "workflow",
			workflow: { name: loaded.name, sha256: loaded.sha256 },
			level: doc.titan?.level,
			tier: doc.titan?.tier,
			shape: doc.titan?.shape,
			phases: doc.phases?.map((phase) => phase.title),
			status: "running",
		});
		const controller = new AbortController();
		const runtime = deps.runtime(ctx, loaded, runId, dir);
		if (runtime.signal) runtime.signal.addEventListener("abort", () => controller.abort(), { once: true });
		const rt: WorkflowRuntimeDeps = { ...runtime, signal: controller.signal };
		const startedAt = Date.now();
		current = { runId, dir, name: loaded.name, controller, startedAt };
		const total = doc.nodes.length;
		let done = 0;
		store.appendEvent(dir, "run.start", { workflow: loaded.name, sha256: loaded.sha256, inputs: parsed.inputs, arguments: parsed.arguments ?? null });
		setStatus(ctx, `workflow ${loaded.name}: 0/${total} nodes · starting…`);
		let result: RunResult | undefined;
		try {
			result = await executeWorkflow(loaded, rt, {
				inputs: parsed.inputs,
				arguments: parsed.arguments,
				onNode: (node) => {
					done += 1;
					setStatus(ctx, `workflow ${loaded.name}: ${done}/${total} nodes · ${STATUS_GLYPH[node.status] ?? ""} ${node.nodeId} ${node.status} · ${fmtSecs(Date.now() - startedAt)}`);
				},
			});
			const elapsedMs = Date.now() - startedAt;
			const patch = { status: RUN_STATUS[result.status] ?? "failed", endedAt: new Date().toISOString(), totals: runTotals(result), result } as Partial<RunMeta> & { result: RunResult };
			store.updateRun(dir, patch);
			store.appendEvent(dir, "run.end", { status: result.status, error: result.error ?? null, elapsedMs });
			deps.panel(ctx, `◆ WORKFLOW ${loaded.name} — ${result.status.toUpperCase()}`, formatRunPanel(result, { name: loaded.name, artifactsDir: rt.artifactsDir, elapsedMs, inputs: parsed.inputs }));
		} catch (error) {
			const message = errorText(error);
			try {
				store.updateRun(dir, { status: controller.signal.aborted ? "aborted" : "failed", endedAt: new Date().toISOString() });
				store.appendEvent(dir, "run.end", { status: "failed", error: message });
			} catch {
				/* the store row is best effort once the run itself has crashed */
			}
			deps.panel(ctx, `◆ WORKFLOW ${loaded.name} — FAILED`, `**${loaded.name}** · \`${runId}\` · ✗ failed after ${fmtSecs(Date.now() - startedAt)}\n\n**error:** ${message}\n\nartifacts: \`${rt.artifactsDir}\``);
		} finally {
			current = undefined;
			setStatus(ctx, undefined);
		}
	};

	const validate = (ctx: any, rest: string) => {
		const parsed = parseRunArgs(rest);
		if (!parsed.name) return deps.notify(ctx, "Usage: /workflow validate <name|path> [--json]", "warning");
		const cwd = deps.cwd(ctx);
		const resolved = resolveWorkflow(parsed.name, cwd);
		if (!resolved) return deps.notify(ctx, `No workflow named ${parsed.name}. /workflow list shows what is visible from ${cwd}.`, "error");
		let result: ReturnType<typeof validateFile>;
		try {
			result = validateFile(resolved.path, validateContextFor(deps.validateContext(cwd, ctx), resolved.dir, cwd));
		} catch (error) {
			return deps.notify(ctx, `Not validated: ${errorText(error)}`, "error");
		}
		if (parsed.json) return deps.panel(ctx, `◆ WORKFLOW ${resolved.name} — VALIDATE`, jsonBlock({ name: resolved.name, path: resolved.path, source: resolved.source, ok: result.ok, errors: result.errors, warnings: result.warnings }));
		const headline = result.ok ? `✓ ${resolved.name} is valid${result.warnings.length ? ` (${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"})` : ""}` : `✗ ${resolved.name}: ${result.errors.length} error${result.errors.length === 1 ? "" : "s"}, ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}`;
		const issues = formatIssues(result);
		deps.panel(ctx, `◆ WORKFLOW ${resolved.name} — VALIDATE`, [`**${headline}**`, `\`${resolved.path}\` (${resolved.source})`, issues.trim() ? `\`\`\`\n${issues.trim()}\n\`\`\`` : ""].filter(Boolean).join("\n\n"));
	};

	const list = (ctx: any) => {
		const cwd = deps.cwd(ctx);
		const entries = listWorkflows(cwd);
		if (!entries.length) return deps.notify(ctx, `No workflows visible from ${cwd}. Create .titan/workflows/<name>/<name>.yaml (skill: titan-workflow-authoring).`, "info");
		const rows = ["| name | source | path |", "|---|---|---|", ...entries.map((entry) => `| ${cell(entry.name)} | ${entry.source} | \`${entry.dir}\` |`)];
		deps.panel(ctx, "◆ WORKFLOWS", rows.join("\n"));
	};

	const status = (ctx: any, rest: string) => {
		const wanted = tokenize(rest)[0];
		const cwd = deps.cwd(ctx);
		const store = deps.store();
		if (current && (!wanted || current.runId.startsWith(wanted))) {
			const run = store.readRun(current.dir);
			const events = readChain(path.join(current.dir, EVENTS_FILE));
			return deps.panel(ctx, `◆ WORKFLOW ${current.name} — STATUS`, formatStatusPanel(run, events, { live: { elapsedMs: Date.now() - current.startedAt }, totals: ledgerTotals(current.dir) }));
		}
		const runs = store.listRuns(RunStore.projectSlug(cwd)).filter((run) => run.command === "workflow");
		const run = wanted ? runs.find((candidate) => candidate.runId === wanted) ?? runs.find((candidate) => candidate.runId.startsWith(wanted)) : runs[0];
		if (!run) return deps.notify(ctx, wanted ? `No workflow run ${wanted} for this project.` : "No workflow runs for this project yet.", "info");
		const dir = store.dir(run.runId, run.projectSlug);
		let events: ChainRow[] = [];
		try {
			events = readChain(path.join(dir, EVENTS_FILE));
		} catch (error) {
			deps.notify(ctx, `events.jsonl unreadable: ${errorText(error)}`, "warning");
		}
		const result = (run as RunMeta & { result?: RunResult }).result;
		deps.panel(ctx, `◆ WORKFLOW ${run.workflow?.name ?? run.runId} — STATUS`, formatStatusPanel(run, events, { result, totals: ledgerTotals(dir) }));
	};

	const ledgerTotals = (dir: string): string | undefined => {
		try {
			const rows = readLedger(dir);
			return rows.length ? formatTotals(totalsFor(rows)) : undefined;
		} catch {
			return undefined;
		}
	};

	const stop = (ctx: any) => {
		if (!current) return deps.notify(ctx, "No workflow run is in flight.", "info");
		current.controller.abort();
		deps.notify(ctx, `Stopping ${current.name} (${current.runId})…`, "warning");
	};

	const graph = (ctx: any, rest: string) => {
		const ref = tokenize(rest)[0];
		if (!ref) return deps.notify(ctx, "Usage: /workflow graph <name|path>", "warning");
		const cwd = deps.cwd(ctx);
		const resolved = resolveWorkflow(ref, cwd);
		if (!resolved) return deps.notify(ctx, `No workflow named ${ref}.`, "error");
		let doc: unknown;
		try {
			doc = parseYaml(fs.readFileSync(resolved.path, "utf8"));
		} catch (error) {
			return deps.notify(ctx, `${resolved.path}: ${errorText(error)}`, "error");
		}
		if (!doc || typeof doc !== "object" || !Array.isArray((doc as WorkflowDoc).nodes)) return deps.notify(ctx, `${resolved.path}: no nodes: array to draw.`, "error");
		deps.panel(ctx, `◆ WORKFLOW ${resolved.name} — GRAPH`, `\`\`\`mermaid\n${mermaidFor(doc as WorkflowDoc)}\n\`\`\``);
	};

	pi.registerCommand("workflow", {
		description: "titan workflow engine: run | validate | list | status | stop | graph | help (YAML DAGs under .titan/workflows)",
		getArgumentCompletions: (prefix: string) => {
			const items = SUBCOMMANDS.filter((verb) => verb.startsWith(prefix.trim().toLowerCase())).map((verb) => ({ value: verb, label: verb }));
			return items.length ? items : null;
		},
		handler: async (args: string, ctx: any) => {
			const text = (args ?? "").trim();
			const space = text.search(/\s/);
			const verb = (space < 0 ? text : text.slice(0, space)).toLowerCase();
			const rest = space < 0 ? "" : text.slice(space + 1).trim();
			switch (verb) {
				case "run":
					return run(ctx, rest);
				case "validate":
					return validate(ctx, rest);
				case "list":
				case "ls":
					return list(ctx);
				case "status":
					return status(ctx, rest);
				case "stop":
					return stop(ctx);
				case "graph":
					return graph(ctx, rest);
				case "":
				case "help":
					return deps.panel(ctx, "◆ WORKFLOW — HELP", `\`\`\`\n${helpText()}\n\`\`\``);
				default:
					return deps.notify(ctx, `Unknown subcommand "${verb}".\n${helpText()}`, "warning");
			}
		},
	});
}
