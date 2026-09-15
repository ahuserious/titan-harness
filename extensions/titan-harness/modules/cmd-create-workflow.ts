/**
 * cmd-create-workflow.ts — /create-workflow: clean-context workflow authoring (plan H2,
 * Appendix B.5 / C.5, D11, P7).
 *
 *   /create-workflow <goal> [--name <n>] [--from-plan <planId|path>] [--from-findings <report>]
 *                    [--from <report>] [--elevate] [--level <0-3>] [--tier <tier>] [--dry-run] [--force]
 *
 * The architect seat of the live shape (level 2/3: gpt-6-astra, today its fallback) runs in
 * a FRESH child session with read-only tools and a curated context pack — `.titan/terraform/*.md`,
 * `vision.md`, `intent.md`, `AGENTS.md`, the fused plan (`--from-plan`), the escalation report
 * (`--from-findings` / `--elevate`), the active shape, the authoring skill references and the
 * installed workflow names — bounded to CONTEXT_BUDGET_CHARS with a sha256 per file in
 * `context-manifest.json`. Thinking is requested at xhigh and normalized to the seat's ceiling.
 *
 * The child never writes: it returns one JSON object (structured output v2 `submit_result`,
 * v1 text as the fallback) with the YAML, the command bodies, the phases and its notes. The
 * HOST stages the command bodies under the run dir, validates the document with the full
 * validator (≤ MAX_AUTHORING_ROUNDS re-asks carrying formatIssues), refuses traversal in
 * command names and any name outside NAME_RE, refuses to overwrite an existing workflow
 * without --force, and only then persists `.titan/workflows/<name>/<name>.yaml`,
 * `commands/<cmd>.md` and `AUTHORING.md` (goal, source, seat, thinking requested↘effective,
 * manifest hash, rounds).
 *
 * --elevate parses the escalation report the P4 control flow wrote (elevation.ts) and pins
 * the repair workflow to `min(level + 1, 3)`, tier depth + 1 (tiers.ts depthNext), half the
 * `context_budget` (default 120000 → 60000), `watchdog.enabled: true`, tighter phases and one
 * more verifier node, and records `titan.parent_run` so the store links the runs.
 * --from-findings is the same repair hand-off without the level change.
 *
 * Store: a run {command: "create-workflow"}, agent `workflow-architect` in state
 * `authoring-workflow`, events authoring.start / authoring.round / authoring.persist, one
 * ledger row per architect call. Status line while the child runs:
 * `L3 · level-3 · authoring-workflow · rune xhigh↘xhigh`, refreshed on shape changes.
 * Everything pi-specific arrives through CreateWorkflowDeps; the pure helpers are exported
 * for tests and never touch pi.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { runChild as RunChild } from "./child-runner.ts";
import { sha256 } from "./hash-chain.ts";
import { appendLedger, rowFromAgentRun } from "./ledger.ts";
import { loadPersona, personaAppend, personaRoots } from "./personas.ts";
import { fill, promptTemplate } from "./prompt-library.ts";
import { RunStore } from "./run-store.ts";
import { type AgentRun, READONLY_TOOLS } from "./runtime.ts";
import type { Thinking } from "./model-stack.ts";
import { normalizeThinking, thinkingLabel } from "./thinking.ts";
import { createAgentRunner, type StructuredAgentResult } from "./workflow-runtime.ts";
import type { AgentRequest } from "./workflow/executor.ts";
import { validateJson } from "./workflow/json-schema.ts";
import { listWorkflows, packageRoot, readWorkflowFile, resolveWorkflow } from "./workflow/loader.ts";
import { type JsonSchema, NAME_RE, type WorkflowDoc } from "./workflow/schema.ts";
import { formatSchemaErrors, parseStructured } from "./workflow/structured-output.ts";
import { TIERS, elevationTarget, isTierName } from "./workflow/tiers.ts";
import { type ValidateContext, type ValidationResult, formatIssues, validateWorkflow } from "./workflow/validator.ts";

// ═══ Constants and the result contract ═══════════════════════════════════════

export const CONTEXT_BUDGET_CHARS = 120_000;
/** Re-asks after the first answer (validator loop ≤ 3). */
export const MAX_AUTHORING_ROUNDS = 3;
export const ARCHITECT_AGENT_ID = "workflow-architect";
export const AUTHORING_FILE = "AUTHORING.md";
export const DEFAULT_CONTEXT_BUDGET = 120_000;
const REQUESTED_THINKING: Thinking = "xhigh";

/** The object the architect child returns (submit_result parameters / the v1 JSON answer). */
export const CREATE_WORKFLOW_RESULT_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		name: { type: "string", minLength: 1 },
		description: { type: "string" },
		yaml: { type: "string", minLength: 1 },
		commands: { type: "array", items: { type: "object", properties: { name: { type: "string" }, body: { type: "string" } }, required: ["name", "body"] } },
		phases: { type: "array", items: { type: "string" } },
		notes: { type: "string" },
	},
	required: ["name", "yaml"],
};

export interface AuthoredResult {
	name: string;
	description?: string;
	yaml: string;
	commands: Array<{ name: string; body: string }>;
	phases: string[];
	notes?: string;
}

// ═══ Arguments ═══════════════════════════════════════════════════════════════

export interface CreateArgs {
	goal: string;
	name?: string;
	fromPlan?: string;
	fromFindings?: string;
	elevate: boolean;
	level?: number;
	tier?: string;
	dryRun: boolean;
	force: boolean;
	errors: string[];
}

function tokenize(text: string): string[] {
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

/** `<goal words> [--name n] [--from-plan p] [--from-findings f | --from f] [--elevate] [--level n] [--tier t] [--dry-run] [--force]` (quote-aware). */
export function parseCreateArgs(text: string): CreateArgs {
	const args: CreateArgs = { goal: "", elevate: false, dryRun: false, force: false, errors: [] };
	const words: string[] = [];
	const tokens = tokenize(text ?? "");
	const valued = new Set(["--name", "--from-plan", "--from-findings", "--from", "--level", "--tier"]);
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!token.startsWith("--")) {
			words.push(token);
			continue;
		}
		let flag = token;
		let value: string | undefined;
		const eq = token.indexOf("=");
		if (eq > 0) {
			flag = token.slice(0, eq);
			value = token.slice(eq + 1);
		} else if (valued.has(flag)) {
			value = tokens[++i];
		}
		switch (flag) {
			case "--name":
				args.name = value?.trim();
				if (!args.name || !NAME_RE.test(args.name)) args.errors.push(`--name must match ${NAME_RE} (got ${JSON.stringify(value ?? "")})`);
				break;
			case "--from-plan":
				if (!value) args.errors.push("--from-plan needs a plan id or a path");
				else args.fromPlan = value;
				break;
			case "--from-findings":
			case "--from":
				if (!value) args.errors.push(`${flag} needs the path of an escalation report`);
				else args.fromFindings = value;
				break;
			case "--elevate":
				args.elevate = true;
				break;
			case "--level": {
				const level = Number.parseInt(value ?? "", 10);
				if (!Number.isInteger(level) || level < 0 || level > 3) args.errors.push(`--level must be 0-3 (got ${JSON.stringify(value ?? "")})`);
				else args.level = level;
				break;
			}
			case "--tier":
				if (!value || !isTierName(value)) args.errors.push(`--tier must be one of ${Object.keys(TIERS).join(", ")} (got ${JSON.stringify(value ?? "")})`);
				else args.tier = value;
				break;
			case "--dry-run":
				args.dryRun = true;
				break;
			case "--force":
				args.force = true;
				break;
			default:
				args.errors.push(`unknown flag ${flag}`);
		}
	}
	args.goal = words.join(" ").trim();
	if (args.elevate && !args.fromFindings) args.errors.push("--elevate needs --from <escalation-report.md> (the report the P4 control flow wrote)");
	if (!args.goal && !args.fromFindings) args.errors.push("a goal is required (or --from <escalation-report.md>)");
	return args;
}

// ═══ Escalation reports → elevation directives ═══════════════════════════════

export interface EscalationSummary {
	path: string;
	sha256: string;
	workflow?: string;
	run?: string;
	node?: string;
	nodeType?: string;
	kind?: string;
	action?: string;
	verdict?: string;
	reviewedNode?: string;
	attempts?: number;
	error?: string;
	level?: number;
	targetLevel?: number;
	tier?: string;
	findings: Array<{ id: string; severity: string; category: string; summary: string; paths: string }>;
	text: string;
}

/** Parse the report `writeEscalationReport` produces (elevation.ts): the `- key: value` header and the findings table. */
export function parseEscalationReport(file: string): EscalationSummary {
	const text = fs.readFileSync(file, "utf8");
	const summary: EscalationSummary = { path: path.resolve(file), sha256: sha256(text), findings: [], text };
	const value = (key: string): string | undefined => {
		const m = new RegExp(`^- ${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: (.*)$`, "m").exec(text);
		return m?.[1]?.trim();
	};
	summary.workflow = value("workflow");
	summary.run = value("run");
	const node = value("node");
	if (node) {
		const m = /^(\S+)(?: \(([^)]+)\))?/.exec(node);
		summary.node = m?.[1] ?? node;
		summary.nodeType = m?.[2];
	}
	summary.kind = value("kind");
	summary.action = value("verdict");
	summary.verdict = value("audit verdict");
	summary.reviewedNode = value("reviewed node");
	const attempts = Number.parseInt(value("attempts") ?? "", 10);
	if (Number.isInteger(attempts)) summary.attempts = attempts;
	const error = value("error");
	if (error && error !== "—") summary.error = error;
	const level = value("level");
	if (level) {
		const m = /^(\d+)(?:\s*→\s*elevate to\s*(\d+))?/.exec(level);
		if (m) {
			summary.level = Number.parseInt(m[1], 10);
			if (m[2]) summary.targetLevel = Number.parseInt(m[2], 10);
		}
	}
	const tier = value("tier");
	if (tier && tier !== "—") summary.tier = tier;
	for (const line of text.split("\n")) {
		const row = line.trim();
		if (!row.startsWith("|") || !row.endsWith("|")) continue;
		// Cells are split on unescaped pipes; the writer escapes a literal `|` as `\|`.
		const cells = row.slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
		if (cells.length !== 5 || cells[0] === "id" || /^-+$/.test(cells[0])) continue;
		summary.findings.push({ id: cells[0], severity: cells[1], category: cells[2], summary: cells[3], paths: cells[4] });
	}
	return summary;
}

export interface ElevationDirectives {
	mode: "repair" | "elevate";
	level?: number;
	tier?: string;
	/** The absolute `context_budget` an elevation pins: half of the failed workflow's (default 120000 → 60000). */
	contextBudget?: number;
	watchdog: boolean;
	parentRun?: string;
	tighten: boolean;
	source: string;
	report: EscalationSummary;
}

/** What a repair (`--from-findings`) or an elevation (`--elevate`) pins on the authored document (plan §5.3 c). */
export function elevationDirectives(report: EscalationSummary, opts: { elevate: boolean; level?: number; tier?: string; previousBudget?: number }): ElevationDirectives {
	const elevate = opts.elevate;
	const level = opts.level ?? (elevate ? elevationTarget(report.level) : report.level);
	const tier = opts.tier ?? (elevate && report.tier && isTierName(report.tier) ? (TIERS[report.tier].depthNext ?? report.tier) : report.tier);
	const previous = typeof opts.previousBudget === "number" && Number.isFinite(opts.previousBudget) && opts.previousBudget > 0 ? opts.previousBudget : DEFAULT_CONTEXT_BUDGET;
	return { mode: elevate ? "elevate" : "repair", level, tier, ...(elevate ? { contextBudget: Math.floor(previous / 2) } : {}), watchdog: elevate, parentRun: report.run, tighten: elevate, source: report.path, report };
}

/** The failed workflow's declared `context_budget`, when it is installed and declares one. */
export function previousContextBudget(cwd: string, workflow: string | undefined): number | undefined {
	if (!workflow) return undefined;
	try {
		const located = resolveWorkflow(workflow, cwd);
		if (!located) return undefined;
		const doc = readWorkflowFile(located.path).doc as WorkflowDoc | undefined;
		const budget = doc?.titan?.budget?.context_budget;
		return typeof budget === "number" && Number.isFinite(budget) && budget > 0 ? budget : undefined;
	} catch {
		return undefined;
	}
}

/** Enforce the directives on the parsed document; returns the changes made (empty when the child already complied). */
export function applyElevation(doc: WorkflowDoc, d: ElevationDirectives): string[] {
	const changes: string[] = [];
	const titan = (doc.titan ??= {});
	if (d.level !== undefined && titan.level !== d.level) {
		titan.level = d.level;
		changes.push(`titan.level = ${d.level}`);
	}
	if (d.tier && titan.tier !== d.tier) {
		titan.tier = d.tier;
		changes.push(`titan.tier = ${d.tier}`);
	}
	if (d.contextBudget !== undefined) {
		const current = typeof titan.budget?.context_budget === "number" ? titan.budget.context_budget : undefined;
		if (current === undefined || current > d.contextBudget) {
			titan.budget = { ...(titan.budget ?? {}), context_budget: d.contextBudget };
			changes.push(`titan.budget.context_budget = ${d.contextBudget}`);
		}
	}
	if (d.watchdog && titan.watchdog?.enabled !== true) {
		titan.watchdog = { ...(titan.watchdog ?? {}), enabled: true };
		changes.push("titan.watchdog.enabled = true");
	}
	if (d.parentRun && titan.parent_run !== d.parentRun) {
		titan.parent_run = d.parentRun;
		changes.push(`titan.parent_run = ${d.parentRun}`);
	}
	return changes;
}

/** The "Hard constraints" block of the prompt for a repair or elevation. */
export function constraintsText(d: ElevationDirectives | undefined, extra: string[] = []): string {
	const lines = [...extra];
	if (d) {
		const r = d.report;
		lines.push(`This is a ${d.mode === "elevate" ? "RE-AUTHORING AT A HIGHER LEVEL" : "REPAIR"} of workflow ${r.workflow ?? "?"} (run ${r.run ?? "?"}), node ${r.node ?? "?"}, escalation kind ${r.kind ?? "?"}${r.verdict ? `, audit verdict ${r.verdict}` : ""}. The escalation report is in the context pack: address every finding.`);
		if (d.level !== undefined) lines.push(`titan.level: ${d.level}`);
		if (d.tier) lines.push(`titan.tier: ${d.tier}`);
		if (d.contextBudget !== undefined) lines.push(`titan.budget.context_budget: ${d.contextBudget} (half of the failed workflow's budget)`);
		if (d.watchdog) lines.push("titan.watchdog.enabled: true");
		if (d.parentRun) lines.push(`titan.parent_run: ${d.parentRun}`);
		if (d.tighten) lines.push("Split the work into more and smaller phases than the failed workflow, with tighter nodes, and add one more verify node than it had.");
		lines.push("The builder never resumes on reviewer prose: the repair starts from the findings and the evidence, not from the failed transcript.");
	}
	if (!lines.length) lines.push("none beyond the contract in your instructions");
	return lines.map((line) => `- ${line}`).join("\n");
}

// ═══ The context pack ════════════════════════════════════════════════════════

export interface PackEntry {
	id: string;
	label: string;
	path?: string;
	sha256: string;
	bytes: number;
	chars: number;
	included: number;
	truncated: boolean;
}

export interface ContextPack {
	entries: PackEntry[];
	text: string;
	manifest: { budgetChars: number; totalChars: number; includedChars: number; entries: PackEntry[]; generated: string };
	manifestJson: string;
	sha256: string;
}

export interface ContextPackOptions {
	cwd: string;
	packageRoot?: string;
	fromPlan?: string;
	findingsPath?: string;
	shapeSummary: string;
	installed: Array<{ name: string; source: string }>;
	budgetChars?: number;
	now?: () => Date;
}

interface PackSource {
	id: string;
	label: string;
	path?: string;
	text: string;
}

function readIfFile(file: string): string | undefined {
	try {
		if (fs.statSync(file).isFile()) return fs.readFileSync(file, "utf8");
	} catch {
		/* absent */
	}
	return undefined;
}

/** `--from-plan <planId|path>` → the fused plan file (`.titan/plans/<id>/fused-plan.md`, a dir holding one, or a file). */
export function resolvePlanFile(cwd: string, fromPlan: string): string | undefined {
	const candidates = [fromPlan, path.join(cwd, fromPlan), path.join(cwd, ".titan", "plans", fromPlan)];
	for (const candidate of candidates) {
		try {
			const stat = fs.statSync(candidate);
			if (stat.isFile()) return path.resolve(candidate);
			if (stat.isDirectory()) {
				for (const name of ["fused-plan.md", "plan.md"]) {
					const file = path.join(candidate, name);
					if (readIfFile(file) !== undefined) return path.resolve(file);
				}
			}
		} catch {
			/* next */
		}
	}
	return undefined;
}

/** Collect, hash and bound the sources the architect child sees (plan H2). */
export function buildContextPack(opts: ContextPackOptions): ContextPack {
	const cwd = path.resolve(opts.cwd);
	const pkg = opts.packageRoot ?? packageRoot();
	const budget = opts.budgetChars ?? CONTEXT_BUDGET_CHARS;
	const sources: PackSource[] = [];
	const push = (id: string, label: string, file: string | undefined, inline?: string) => {
		if (file) {
			const text = readIfFile(file);
			if (text === undefined) return;
			sources.push({ id, label, path: file, text });
		} else if (inline !== undefined) sources.push({ id, label, text: inline });
	};
	if (opts.fromPlan) {
		const plan = resolvePlanFile(cwd, opts.fromPlan);
		if (plan) push("plan", "fused plan", plan);
		else sources.push({ id: "plan", label: "fused plan", text: `[not found: ${opts.fromPlan}]` });
	}
	if (opts.findingsPath) push("findings", "escalation report (findings package)", opts.findingsPath);
	const terraformDir = path.join(cwd, ".titan", "terraform");
	let terraform: string[] = [];
	try {
		terraform = fs.readdirSync(terraformDir).filter((f) => f.endsWith(".md")).sort();
	} catch {
		/* no terraform pack */
	}
	for (const file of terraform) push(`terraform/${file}`, `terraform ${file}`, path.join(terraformDir, file));
	for (const name of ["vision.md", "intent.md", "AGENTS.md"]) push(name, name, path.join(cwd, name));
	sources.push({ id: "shape", label: "active harness shape", text: opts.shapeSummary });
	for (const ref of ["schema", "rules", "examples"]) push(`skill/${ref}`, `authoring reference ${ref}.md`, path.join(pkg, "skills", "titan-workflow-authoring", "references", `${ref}.md`));
	sources.push({ id: "installed", label: "installed workflows", text: opts.installed.length ? opts.installed.map((w) => `- ${w.name} (${w.source})`).join("\n") : "- none" });

	const entries: PackEntry[] = [];
	const blocks: string[] = [];
	let remaining = budget;
	let totalChars = 0;
	let includedChars = 0;
	for (const source of sources) {
		const chars = source.text.length;
		totalChars += chars;
		const included = Math.max(0, Math.min(chars, remaining));
		remaining -= included;
		const truncated = included < chars;
		const entry: PackEntry = { id: source.id, label: source.label, ...(source.path ? { path: source.path } : {}), sha256: sha256(source.text), bytes: Buffer.byteLength(source.text), chars, included, truncated };
		entries.push(entry);
		includedChars += included;
		if (!included) continue;
		const head = `### ${source.label}${source.path ? ` (${path.relative(cwd, source.path) || source.path})` : ""} — sha256 ${entry.sha256.slice(0, 12)} — ${chars} chars${truncated ? ` (truncated to ${included})` : ""}`;
		blocks.push(`${head}\n\n${source.text.slice(0, included)}${truncated ? "\n[… truncated by the context budget …]" : ""}`);
	}
	const text = blocks.join("\n\n");
	const manifest = { budgetChars: budget, totalChars, includedChars, entries, generated: (opts.now?.() ?? new Date()).toISOString() };
	const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
	return { entries, text, manifest, manifestJson, sha256: sha256(manifestJson) };
}

// ═══ Checking, staging, validating and persisting the child's result ═════════

const TRAVERSAL_RE = /[\\/]|\.\./;

/** Structural refusals before the validator runs: names, traversal, duplicates, overwrite. */
export function checkAuthoredResult(value: unknown, opts: { cwd: string; force: boolean; fixedName?: string }): { result?: AuthoredResult; problems: string[] } {
	const problems: string[] = [];
	const errors = validateJson(value, CREATE_WORKFLOW_RESULT_SCHEMA);
	if (errors.length) return { problems: [`the answer is not the required object: ${formatSchemaErrors(errors)}`] };
	const raw = value as Record<string, unknown>;
	const name = (opts.fixedName ?? String(raw.name)).trim();
	if (!NAME_RE.test(name)) problems.push(`name ${JSON.stringify(name)} must match ${NAME_RE}`);
	const commands: Array<{ name: string; body: string }> = [];
	const seen = new Set<string>();
	for (const entry of (raw.commands as Array<{ name: string; body: string }> | undefined) ?? []) {
		const cname = String(entry.name ?? "").trim();
		if (TRAVERSAL_RE.test(cname) || !NAME_RE.test(cname)) {
			problems.push(`command name ${JSON.stringify(cname)} is not allowed: a bare file name matching ${NAME_RE}, never a path`);
			continue;
		}
		if (seen.has(cname)) problems.push(`command ${cname} is listed twice`);
		seen.add(cname);
		if (typeof entry.body !== "string" || !entry.body.trim()) problems.push(`command ${cname} has an empty body`);
		commands.push({ name: cname, body: String(entry.body ?? "") });
	}
	if (typeof raw.yaml !== "string" || !raw.yaml.trim()) problems.push("yaml is empty");
	if (!problems.length && !opts.force && NAME_RE.test(name) && fs.existsSync(path.join(opts.cwd, ".titan", "workflows", name))) {
		problems.push(opts.fixedName ? `workflow ${name} already exists under .titan/workflows — rerun with --force to replace it` : `workflow ${name} already exists under .titan/workflows — choose another name (or the operator reruns with --force)`);
	}
	if (problems.length) return { problems };
	return {
		problems,
		result: { name, description: typeof raw.description === "string" ? raw.description : undefined, yaml: raw.yaml as string, commands, phases: Array.isArray(raw.phases) ? (raw.phases as unknown[]).map(String) : [], notes: typeof raw.notes === "string" ? raw.notes : undefined },
	};
}

export interface StagedResult {
	doc: WorkflowDoc;
	yamlText: string;
	changed: string[];
	validation: ValidationResult;
	staging: string;
}

/** Parse the YAML, pin the name, enforce the directives, stage the commands and run the full validator. */
export function stageAndValidate(result: AuthoredResult, opts: { stagingDir: string; cwd: string; directives?: ElevationDirectives; validateContext?: Partial<ValidateContext>; installed: string[] }): StagedResult | { problems: string[] } {
	let doc: unknown;
	try {
		doc = parseYaml(result.yaml);
	} catch (error) {
		return { problems: [`yaml does not parse: ${error instanceof Error ? error.message : String(error)}`] };
	}
	if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { problems: ["yaml must be a mapping (the workflow document)"] };
	const workflow = doc as WorkflowDoc;
	const changed: string[] = [];
	if (workflow.name !== result.name) {
		workflow.name = result.name;
		changed.push(`name = ${result.name}`);
	}
	if (opts.directives) changed.push(...applyElevation(workflow, opts.directives));
	const staging = path.join(opts.stagingDir, "commands");
	fs.rmSync(opts.stagingDir, { recursive: true, force: true });
	fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
	for (const command of result.commands) fs.writeFileSync(path.join(staging, `${command.name}.md`), command.body, { mode: 0o600 });
	const ctx: ValidateContext = {
		dir: "",
		commandDirs: [opts.stagingDir, path.join(opts.cwd, ".titan")],
		scriptDirs: [opts.stagingDir, path.join(opts.cwd, ".titan"), opts.cwd],
		personaDirs: personaRoots(opts.cwd).map((root) => path.dirname(root)), // the validator looks under <root>/personas/
		workflowNames: [...new Set([...opts.installed, result.name])],
		...(opts.validateContext ?? {}),
	};
	const validation = validateWorkflow(workflow, ctx);
	const yamlText = changed.length ? `# authored by /create-workflow — host adjustments: ${changed.join("; ")}\n${stringifyYaml(workflow)}` : result.yaml;
	return { doc: workflow, yamlText, changed, validation, staging: opts.stagingDir };
}

export interface PersistedWorkflow {
	dir: string;
	files: string[];
	yamlSha256: string;
}

/** Write the workflow directory: <name>.yaml, commands/*.md, AUTHORING.md — never outside `.titan/workflows/<name>/`. */
export function persistWorkflow(cwd: string, result: AuthoredResult, staged: StagedResult, authoring: string, force: boolean): PersistedWorkflow {
	if (!NAME_RE.test(result.name)) throw new Error(`titan-harness: refusing to persist workflow name ${JSON.stringify(result.name)}`);
	const root = path.join(path.resolve(cwd), ".titan", "workflows");
	const dir = path.join(root, result.name);
	if (path.dirname(dir) !== root) throw new Error("titan-harness: refusing a workflow directory outside .titan/workflows");
	if (fs.existsSync(dir)) {
		if (!force) throw new Error(`titan-harness: workflow ${result.name} already exists (use --force)`);
		fs.rmSync(dir, { recursive: true, force: true });
	}
	fs.mkdirSync(path.join(dir, "commands"), { recursive: true });
	const files: string[] = [];
	const yamlPath = path.join(dir, `${result.name}.yaml`);
	fs.writeFileSync(yamlPath, staged.yamlText.endsWith("\n") ? staged.yamlText : `${staged.yamlText}\n`);
	files.push(yamlPath);
	for (const command of result.commands) {
		if (TRAVERSAL_RE.test(command.name) || !NAME_RE.test(command.name)) throw new Error(`titan-harness: refusing command name ${JSON.stringify(command.name)}`);
		const file = path.join(dir, "commands", `${command.name}.md`);
		fs.writeFileSync(file, command.body.endsWith("\n") ? command.body : `${command.body}\n`);
		files.push(file);
	}
	const record = path.join(dir, AUTHORING_FILE);
	fs.writeFileSync(record, authoring);
	files.push(record);
	return { dir, files, yamlSha256: sha256(fs.readFileSync(yamlPath)) };
}

// ═══ The command ═════════════════════════════════════════════════════════════

export interface ArchitectSeat {
	model: string;
	thinking: string;
	callsign: string;
	systemPrompt?: string;
	appendSystemPrompts: string[];
	/** The declared model when the seat runs on its fallback (e.g. openai-codex/gpt-6-astra → xai/grok-4.6). */
	substitutedFrom?: string;
}

export interface CreateWorkflowDeps {
	runChild: typeof RunChild;
	store(): RunStore;
	cwd(ctx: any): string;
	notify(ctx: any, text: string, level?: "info" | "warning" | "error"): void;
	panel(ctx: any, title: string, markdown: string): void;
	architectSeat(ctx: any): ArchitectSeat;
	levelInfo(ctx: any): { level: number | null; shape: string; tier?: string };
	setStatus(ctx: any, text: string | undefined): void;
	childTimeoutMs(): number;
	/** Called once per authoring run with a refresh callback; the host invokes it on `shape-changed`. Returns an unsubscribe when it can. */
	onShapeChanged?(cb: () => void): (() => void) | void;
	validateContext?(cwd: string, ctx: any): Partial<ValidateContext>;
	packageRoot?(): string;
	now?(): Date;
}

export interface AuthoringOutcome {
	ok: boolean;
	name?: string;
	dir?: string;
	files?: string[];
	runId?: string;
	runDir?: string;
	calls: number;
	rounds: number;
	problems: string[];
	directives?: ElevationDirectives;
	pack?: ContextPack;
	dryRun?: boolean;
	seat?: ArchitectSeat;
	effectiveThinking?: string;
	error?: string;
}

const relative = (cwd: string, file: string): string => path.relative(cwd, file) || file;

/** The status-line text while the architect child runs. */
export function authoringStatusText(level: number | null, shape: string, seat: ArchitectSeat): string {
	const label = thinkingLabel(normalizeThinking(seat.model, REQUESTED_THINKING));
	return `L${level ?? "-"} · ${shape} · authoring-workflow · ${seat.callsign} ${label}`;
}

function shapeSummaryText(level: { level: number | null; shape: string; tier?: string }, seat: ArchitectSeat): string {
	const effective = normalizeThinking(seat.model, REQUESTED_THINKING);
	return [
		`- level: ${level.level ?? "shape-driven (no level active)"}`,
		`- shape: ${level.shape}`,
		...(level.tier ? [`- default tier: ${level.tier}`] : []),
		`- architect seat: ${seat.callsign} (thinking ${thinkingLabel(effective)})${seat.substitutedFrom ? " — running on its declared fallback" : ""}`,
		"- roles available to nodes: architect, builder, worker, verifier, auditor, judge, fuser, watchdog (name roles, not models)",
	].join("\n");
}

function authoringRecord(input: { goal: string; args: CreateArgs; seat: ArchitectSeat; effective: string; level: { level: number | null; shape: string }; pack: ContextPack; rounds: number; calls: number; runId: string; runDir: string; result: AuthoredResult; staged: StagedResult; directives?: ElevationDirectives; now: Date }): string {
	const source = input.directives ? `${input.directives.mode} from ${input.directives.source}` : input.args.fromPlan ? `plan ${input.args.fromPlan}` : "goal";
	const lines = [
		`# Authoring record — ${input.result.name}`,
		"",
		`- goal: ${input.goal}`,
		`- source: ${source}`,
		`- seat: ${input.seat.callsign} · ${input.seat.model}${input.seat.substitutedFrom ? ` (fallback for ${input.seat.substitutedFrom})` : ""}`,
		`- thinking: requested ${REQUESTED_THINKING} · effective ${input.effective}`,
		`- level: ${input.level.level ?? "shape-driven"} · shape ${input.level.shape}`,
		`- context manifest: sha256 ${input.pack.sha256} (${input.pack.entries.length} entries, ${input.pack.manifest.includedChars}/${input.pack.manifest.totalChars} chars, budget ${input.pack.manifest.budgetChars})`,
		`- validator rounds: ${input.rounds} (architect calls ${input.calls})`,
		...(input.staged.changed.length ? [`- host adjustments: ${input.staged.changed.join("; ")}`] : []),
		...(input.staged.validation.warnings.length ? [`- validator warnings: ${input.staged.validation.warnings.length}`] : []),
		`- run: ${input.runId} (${input.runDir})`,
		`- generated: ${input.now.toISOString()}`,
		"",
		"## Phases",
		"",
		...(input.result.phases.length ? input.result.phases.map((p) => `- ${p}`) : ["- (none declared)"]),
		"",
		"## Notes",
		"",
		input.result.notes?.trim() || "(none)",
		"",
	];
	return lines.join("\n");
}

/** The whole authoring flow (the command handler minus argument parsing); testable with a fake runChild. */
export async function authorWorkflow(deps: CreateWorkflowDeps, ctx: any, args: CreateArgs): Promise<AuthoringOutcome> {
	const now = deps.now ?? (() => new Date());
	if (args.errors.length) return { ok: false, calls: 0, rounds: 0, problems: [...args.errors], error: args.errors.join("; ") };
	const cwd = path.resolve(deps.cwd(ctx));
	const seat = deps.architectSeat(ctx);
	const levelInfo = deps.levelInfo(ctx);
	const effective = normalizeThinking(seat.model, REQUESTED_THINKING).effective;

	let directives: ElevationDirectives | undefined;
	if (args.fromFindings) {
		let file = args.fromFindings;
		if (!fs.existsSync(file)) file = path.join(cwd, args.fromFindings);
		let report: EscalationSummary;
		try {
			report = parseEscalationReport(file);
		} catch (error) {
			const message = `escalation report not readable: ${error instanceof Error ? error.message : String(error)}`;
			return { ok: false, calls: 0, rounds: 0, problems: [message], error: message };
		}
		directives = elevationDirectives(report, { elevate: args.elevate, level: args.level, tier: args.tier, previousBudget: previousContextBudget(cwd, report.workflow) });
	}
	const goal = args.goal || (directives ? `${directives.mode === "elevate" ? "Re-author at a higher level" : "Repair"} workflow ${directives.report.workflow ?? "?"}: node ${directives.report.node ?? "?"} failed (${directives.report.kind ?? "?"}${directives.report.error ? `: ${directives.report.error}` : ""})` : "");
	if (args.name && !args.force && fs.existsSync(path.join(cwd, ".titan", "workflows", args.name))) {
		const message = `workflow ${args.name} already exists under .titan/workflows — rerun with --force to replace it`;
		return { ok: false, calls: 0, rounds: 0, problems: [message], error: message };
	}

	const installed = listWorkflows(cwd);
	const pack = buildContextPack({ cwd, packageRoot: deps.packageRoot?.(), fromPlan: args.fromPlan, findingsPath: directives?.source, shapeSummary: shapeSummaryText(levelInfo, seat), installed, now });
	const extraConstraints = [
		...(args.level !== undefined && !directives ? [`titan.level: ${args.level}`] : []),
		...(args.tier && !directives ? [`titan.tier: ${args.tier}`] : []),
		...(args.fromPlan ? ["Follow the fused plan in the context pack: its phases become your phases, its verification requirements become verify nodes."] : []),
	];
	const prompt = fill("USER_PROMPT_CREATE_WORKFLOW.md", {
		GOAL: goal,
		MODE: directives ? (directives.mode === "elevate" ? "elevate: re-author the failed workflow at a higher harness level" : "repair: author a repair workflow from the findings package") : args.fromPlan ? "from-plan: turn the fused plan into a workflow" : "new: author a workflow for the goal",
		CONSTRAINTS: constraintsText(directives, extraConstraints),
		HARNESS: shapeSummaryText(levelInfo, seat),
		NAME_HINT: args.name ? `Use exactly this name: ${args.name}` : "Choose a short slug (^[a-z0-9][a-z0-9-]{0,63}$) that is not one of the installed workflows.",
		CONTEXT_PACK: pack.text,
	});

	if (args.dryRun) {
		const rows = pack.entries.map((e) => `| ${e.label} | ${e.path ? relative(cwd, e.path) : "inline"} | ${e.sha256.slice(0, 12)} | ${e.chars} | ${e.included}${e.truncated ? " (truncated)" : ""} |`);
		deps.panel(ctx, "◆ CREATE-WORKFLOW — DRY RUN", [`**goal:** ${goal}`, `**seat:** ${seat.callsign} · ${seat.model} · thinking ${thinkingLabel(normalizeThinking(seat.model, REQUESTED_THINKING))}`, directives ? `**directives:** ${constraintsText(directives).replace(/\n/g, " ")}` : "", `**context pack:** ${pack.entries.length} entries · ${pack.manifest.includedChars}/${pack.manifest.totalChars} chars (budget ${pack.manifest.budgetChars}) · manifest sha256 ${pack.sha256.slice(0, 12)}`, "", "| source | path | sha256 | chars | included |", "|---|---|---|---|---|", ...rows, "", `prompt: ${prompt.length} chars · no child was spawned`].filter((line) => line !== "").join("\n"));
		return { ok: true, calls: 0, rounds: 0, problems: [], directives, pack, dryRun: true, seat, effectiveThinking: effective };
	}

	// The run: everything the architect child does lands here.
	const store = deps.store();
	const { runId, dir: runDir } = store.open({ projectSlug: RunStore.projectSlug(cwd), cwd, command: "create-workflow", level: levelInfo.level ?? undefined, shape: levelInfo.shape, tier: directives?.tier ?? args.tier, parentRunId: directives?.parentRun, status: "running" });
	fs.writeFileSync(path.join(runDir, "context-manifest.json"), pack.manifestJson, { mode: 0o600 });
	fs.writeFileSync(path.join(runDir, "context-pack.md"), pack.text, { mode: 0o600 });
	store.appendEvent(runDir, "authoring.start", { goal, mode: directives?.mode ?? (args.fromPlan ? "from-plan" : "new"), seat: seat.callsign, model: seat.model, thinking: { requested: REQUESTED_THINKING, effective }, manifestSha256: pack.sha256, packChars: pack.manifest.includedChars });
	store.upsertAgent(runDir, { agentId: ARCHITECT_AGENT_ID, callsign: seat.callsign, role: "architect", model: seat.model, thinking: { requested: REQUESTED_THINKING, effective }, state: "authoring-workflow" });

	let statusOn = true;
	const paintStatus = () => {
		if (!statusOn) return;
		try {
			deps.setStatus(ctx, authoringStatusText(deps.levelInfo(ctx).level, deps.levelInfo(ctx).shape, deps.architectSeat(ctx)));
		} catch {}
	};
	paintStatus();
	const unsubscribe = deps.onShapeChanged?.(paintStatus);

	const agent = createAgentRunner({
		runChild: deps.runChild,
		sessionsDir: path.join(runDir, "sessions"),
		cwd,
		onRun: (run: AgentRun) => {
			try {
				appendLedger(runDir, { ...rowFromAgentRun(run, runId, "run", effective, ARCHITECT_AGENT_ID), runId });
				store.upsertAgent(runDir, { agentId: ARCHITECT_AGENT_ID, usage: { input: run.tokensIn, output: run.tokensOut, cacheRead: 0, cacheWrite: 0, cost: run.costUsd }, tps: { outputTokens: run.tokensOut, seconds: run.tpsSeconds } });
			} catch {
				/* observational */
			}
		},
	});
	let personaAppendText: string | undefined;
	try {
		personaAppendText = personaAppend(loadPersona("workflow-architect", personaRoots(cwd)));
	} catch {
		personaAppendText = undefined; // the shipped persona is optional context; the system prompt carries the contract
	}
	const systemPrompt = promptTemplate("SYSTEM_PROMPT_WORKFLOW_ARCHITECT.md");
	const request = (text: string, resume?: string): AgentRequest => ({
		nodeId: ARCHITECT_AGENT_ID,
		role: "architect",
		callsign: seat.callsign,
		model: seat.model,
		thinking: REQUESTED_THINKING,
		prompt: text,
		systemPrompt,
		appendSystemPrompts: [...seat.appendSystemPrompts, ...(personaAppendText ? [personaAppendText] : [])],
		tools: READONLY_TOOLS,
		context: resume ? { resume } : "fresh",
		outputSchema: CREATE_WORKFLOW_RESULT_SCHEMA,
		timeoutMs: deps.childTimeoutMs(),
		env: { TITAN_RUN_ID: runId, TITAN_RUN_DIR: runDir, TITAN_WORKFLOW_ID: "create-workflow" },
		label: "create-workflow/architect",
	});

	const finish = (outcome: AuthoringOutcome, status: "completed" | "failed"): AuthoringOutcome => {
		statusOn = false;
		try {
			unsubscribe?.();
		} catch {}
		try {
			deps.setStatus(ctx, undefined);
		} catch {}
		try {
			store.upsertAgent(runDir, { agentId: ARCHITECT_AGENT_ID, state: status === "completed" ? "done-unverified" : "failed" });
			store.updateRun(runDir, { status, endedAt: now().toISOString() });
		} catch {}
		return { ...outcome, runId, runDir, directives, pack, seat, effectiveThinking: effective };
	};

	let calls = 0;
	let rounds = 0;
	let text = prompt;
	let resume: string | undefined;
	let lastProblems: string[] = [];
	try {
		for (;;) {
			const result: StructuredAgentResult = await agent(request(text, resume));
			calls++;
			if (!result.ok) {
				const message = `architect call failed: ${result.error ?? "no answer"}`;
				store.appendEvent(runDir, "authoring.round", { round: rounds, ok: false, problems: [message] });
				return finish({ ok: false, calls, rounds, problems: [message], error: message }, "failed");
			}
			// v2 object or v1 text.
			let value: unknown = result.value;
			const problems: string[] = [];
			if (value === undefined) {
				const parsed = parseStructured(result.text, CREATE_WORKFLOW_RESULT_SCHEMA);
				if (parsed.ok) value = parsed.value;
				else problems.push(`the answer is not the required JSON object: ${formatSchemaErrors(parsed.errors)}`);
			}
			let checked: AuthoredResult | undefined;
			if (!problems.length) {
				const check = checkAuthoredResult(value, { cwd, force: args.force, fixedName: args.name });
				problems.push(...check.problems);
				checked = check.result;
			}
			let staged: StagedResult | undefined;
			if (!problems.length && checked) {
				const outcome = stageAndValidate(checked, { stagingDir: path.join(runDir, "staging", String(calls)), cwd, directives, validateContext: deps.validateContext?.(cwd, ctx), installed: installed.map((w) => w.name) });
				if ("problems" in outcome) problems.push(...outcome.problems);
				else if (!outcome.validation.ok) problems.push(`the workflow does not validate:\n${formatIssues(outcome.validation)}`);
				else staged = outcome;
			}
			store.appendEvent(runDir, "authoring.round", { round: rounds, calls, ok: !problems.length, problems, name: checked?.name });
			if (!problems.length && checked && staged) {
				const record = authoringRecord({ goal, args, seat, effective, level: levelInfo, pack, rounds, calls, runId, runDir, result: checked, staged, directives, now: now() });
				let persisted: PersistedWorkflow;
				try {
					persisted = persistWorkflow(cwd, checked, staged, record, args.force);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return finish({ ok: false, name: checked.name, calls, rounds, problems: [message], error: message }, "failed");
				}
				store.appendEvent(runDir, "authoring.persist", { name: checked.name, dir: persisted.dir, files: persisted.files.map((f) => relative(cwd, f)), yamlSha256: persisted.yamlSha256, changed: staged.changed, warnings: staged.validation.warnings.length });
				store.updateRun(runDir, { workflow: { name: checked.name, sha256: persisted.yamlSha256 } });
				if (staged.validation.warnings.length) deps.notify(ctx, `${checked.name}: ${staged.validation.warnings.length} validator warning(s)\n${formatIssues(staged.validation)}`, "warning");
				deps.panel(
					ctx,
					`◆ CREATE-WORKFLOW ${checked.name} — AUTHORED`,
					[
						`**${checked.name}** — ${checked.description ?? "(no description)"}`,
						"",
						`- path: \`${relative(cwd, persisted.dir)}/\` (${persisted.files.length} files)`,
						`- phases: ${checked.phases.length ? checked.phases.join(" → ") : "(none declared)"} · nodes: ${staged.doc.nodes.length}`,
						`- seat: ${seat.callsign} · ${seat.model}${seat.substitutedFrom ? ` (fallback for ${seat.substitutedFrom})` : ""} · thinking ${thinkingLabel(normalizeThinking(seat.model, REQUESTED_THINKING))}`,
						`- validator rounds: ${rounds} (${calls} call${calls === 1 ? "" : "s"})${staged.changed.length ? ` · host adjustments: ${staged.changed.join("; ")}` : ""}`,
						`- context manifest: ${pack.entries.length} entries · sha256 ${pack.sha256.slice(0, 12)}`,
						`- run: \`${runId}\``,
						"",
						`next: \`/workflow validate ${checked.name}\` then \`/workflow run ${checked.name}\``,
					].join("\n"),
				);
				return finish({ ok: true, name: checked.name, dir: persisted.dir, files: persisted.files, calls, rounds, problems: [] }, "completed");
			}
			lastProblems = problems;
			if (rounds >= MAX_AUTHORING_ROUNDS) {
				const message = `the architect did not produce a valid workflow after ${MAX_AUTHORING_ROUNDS} re-asks`;
				deps.panel(ctx, "◆ CREATE-WORKFLOW — FAILED", [`**${message}**`, "", "last problems:", "```", problems.join("\n"), "```", "", `run: \`${runId}\` · artifacts under \`${runDir}\``].join("\n"));
				return finish({ ok: false, calls, rounds, problems, error: message }, "failed");
			}
			rounds++;
			deps.notify(ctx, `create-workflow: answer rejected (${problems[0].split("\n")[0]}) — re-asking ${rounds}/${MAX_AUTHORING_ROUNDS}`, "warning");
			const lead = `Your previous answer was rejected by the host. Fix every problem below and return the complete JSON object again (the whole workflow, not a diff):\n${problems.map((p) => `- ${p}`).join("\n")}`;
			if (result.sessionRef) {
				resume = result.sessionRef;
				text = lead;
			} else {
				resume = undefined;
				text = `${prompt}\n\n${lead}`;
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return finish({ ok: false, calls, rounds, problems: [...lastProblems, message], error: message }, "failed");
	}
}

const FLAGS = ["--name", "--from-plan", "--from-findings", "--from", "--elevate", "--level", "--tier", "--dry-run", "--force"];

/** `/create-workflow …` — one authoring at a time per session. */
export function registerCreateWorkflowCommand(pi: ExtensionAPI, deps: CreateWorkflowDeps): void {
	let inFlight: string | undefined;
	pi.registerCommand("create-workflow", {
		description: "Author a workflow with the architect seat in a clean context: /create-workflow <goal> [--name n] [--from-plan id] [--from <escalation-report.md> [--elevate]] [--level 0-3] [--tier t] [--dry-run] [--force]",
		getArgumentCompletions: (prefix: string) => {
			const last = prefix.split(/\s+/).pop() ?? "";
			if (!last.startsWith("-")) return null;
			const items = FLAGS.filter((flag) => flag.startsWith(last)).map((flag) => ({ value: flag, label: flag }));
			return items.length ? items : null;
		},
		handler: async (args: string, ctx: any) => {
			const parsed = parseCreateArgs(args ?? "");
			if (parsed.errors.length) return deps.notify(ctx, `Not started: ${parsed.errors.join("; ")}\nUsage: /create-workflow <goal> [--name n] [--from-plan id] [--from <report> [--elevate]] [--level 0-3] [--tier t] [--dry-run] [--force]`, "warning");
			if (inFlight) return deps.notify(ctx, `An authoring run is already in flight (${inFlight}); wait for its panel.`, "warning");
			inFlight = parsed.name ?? parsed.goal.slice(0, 40);
			try {
				const outcome = await authorWorkflow(deps, ctx, parsed);
				if (!outcome.ok && !outcome.dryRun && outcome.calls === 0) deps.notify(ctx, `Not started: ${outcome.error ?? outcome.problems.join("; ")}`, "error");
			} finally {
				inFlight = undefined;
			}
		},
	});
}
