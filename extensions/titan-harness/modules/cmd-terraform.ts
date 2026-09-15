/**
 * cmd-terraform.ts — `/terraform`, the entity originalization (plan §2 H7, §5.7; P8).
 *
 *   /terraform                       gather the sources, run the shipped `terraform` workflow,
 *                                    persist .titan/terraform/{entity,ontology,roadmap,
 *                                    automations,connectors}.md (refuses to overwrite)
 *   /terraform --refresh             overwrite every section
 *   /terraform --section <name>      persist only that section (overwriting it); the DAG still
 *                                    runs whole because every section derives from entity.md
 *   /terraform --dry-run             the layer plan, the gathered sources and the connector
 *                                    probe, nothing spent
 *
 * Division of labour: this host side is deterministic — it gathers the sources with a sha256
 * per file (`collectSources`), runs the InfraNodus ontology stage through `deps.ontology`
 * when the bridge is keyed (else the ontology section is declared, with a banner), builds
 * the workflow inputs, executes the DAG through `deps.runWorkflow` (the lead's runtime:
 * fusion seats, verifier lane, store rows), and persists the seats' text with a Sources
 * table, the `harness_defaults:` block (entity.md, consumed at level 2 through
 * `readHarnessDefaults`), the connector probe table and the automation recipes. Seats are
 * tool-less and never write; only this module touches .titan/terraform/.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";
import { automationRecipes, type ConnectorProbeResult, type ConnectorProbes, defaultProbes, dryRunConnectors, ensureConnectorsFile, loadConnectors, renderConnectorTable, TERRAFORM_DIRNAME } from "./connectors.ts";
import { sha256 } from "./hash-chain.ts";
import { DECLARED_BANNER, type OntologyStageResult } from "./infranodus.ts";
import { promptTemplate } from "./prompt-library.ts";
import type { RunStore } from "./run-store.ts";
import { TIER_NAMES } from "./workflow/tiers.ts";
import { formatLayerPlan } from "./cmd-workflow.ts";
import type { RunResult } from "./workflow/executor.ts";
import { type LoadedWorkflow, loadWorkflow, type WorkflowDirOverrides } from "./workflow/loader.ts";

export const TERRAFORM_SECTIONS = ["entity", "ontology", "roadmap", "automations", "connectors"] as const;
export type TerraformSection = (typeof TERRAFORM_SECTIONS)[number];
export const TERRAFORM_WORKFLOW = "terraform";
export const TERRAFORM_CONTRACT_FILE = "SYSTEM_PROMPT_TERRAFORM.md";
export const TERRAFORM_RECORD = "terraform.json";

// ═══ Arguments ══════════════════════════════════════════════════════════════

export interface TerraformArgs {
	refresh: boolean;
	section?: TerraformSection;
	dryRun: boolean;
	errors: string[];
}

export function parseTerraformArgs(args: string): TerraformArgs {
	const out: TerraformArgs = { refresh: false, dryRun: false, errors: [] };
	const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--refresh") out.refresh = true;
		else if (token === "--dry-run") out.dryRun = true;
		else if (token === "--section" || token.startsWith("--section=")) {
			const value = token.includes("=") ? token.slice("--section=".length) : tokens[++i];
			if (!value || !(TERRAFORM_SECTIONS as readonly string[]).includes(value)) out.errors.push(`--section needs one of ${TERRAFORM_SECTIONS.join(", ")}`);
			else out.section = value as TerraformSection;
		} else out.errors.push(`unknown argument ${token}`);
	}
	return out;
}

// ═══ Sources ════════════════════════════════════════════════════════════════

export interface SourceFile {
	path: string;
	sha256: string;
	bytes: number;
	kind: "readme" | "agents" | "vision" | "intent" | "manifest" | "doc" | "titan" | "terraform";
}

export interface GatheredSources {
	files: SourceFile[];
	/** Bounded text: every file under a `### <path> (sha256 <digest>)` heading. */
	corpus: string;
	remotes: string[];
	tree: string[];
	truncated: string[];
}

const ROOT_CANDIDATES: Array<[string, SourceFile["kind"]]> = [
	["README.md", "readme"],
	["README", "readme"],
	["readme.md", "readme"],
	["AGENTS.md", "agents"],
	["CLAUDE.md", "agents"],
	["vision.md", "vision"],
	["VISION.md", "vision"],
	["intent.md", "intent"],
	["INTENT.md", "intent"],
	["package.json", "manifest"],
	["pyproject.toml", "manifest"],
	["Cargo.toml", "manifest"],
	["go.mod", "manifest"],
	["composer.json", "manifest"],
];

const DEFAULT_FILE_CHARS = 12_000;
const DEFAULT_CORPUS_CHARS = 60_000;

/** Every source document of the project with its digest, plus a bounded corpus for the seats. */
export function collectSources(cwd: string, opts: { maxFileChars?: number; maxCorpusChars?: number; git?: (args: string[]) => string; maxDocs?: number } = {}): GatheredSources {
	const root = path.resolve(cwd);
	const maxFile = opts.maxFileChars ?? DEFAULT_FILE_CHARS;
	const maxCorpus = opts.maxCorpusChars ?? DEFAULT_CORPUS_CHARS;
	const maxDocs = opts.maxDocs ?? 20;
	const files: SourceFile[] = [];
	const chunks: string[] = [];
	const truncated: string[] = [];
	const seen = new Set<string>();
	let used = 0;
	const add = (relative: string, kind: SourceFile["kind"]) => {
		const file = path.join(root, relative);
		if (seen.has(relative)) return;
		let buffer: Buffer;
		try {
			if (!fs.statSync(file).isFile()) return;
			buffer = fs.readFileSync(file);
		} catch {
			return;
		}
		seen.add(relative);
		const digest = sha256(buffer);
		files.push({ path: relative, sha256: digest, bytes: buffer.length, kind });
		let text = buffer.toString("utf8");
		if (text.length > maxFile) {
			text = `${text.slice(0, maxFile)}\n…[truncated ${text.length - maxFile} chars]`;
			truncated.push(relative);
		}
		const chunk = `### ${relative} (sha256 ${digest.slice(0, 12)})\n${text.trim()}\n`;
		if (used + chunk.length <= maxCorpus) {
			chunks.push(chunk);
			used += chunk.length;
		} else if (!truncated.includes(relative)) truncated.push(relative);
	};
	for (const [name, kind] of ROOT_CANDIDATES) add(name, kind);
	const listDocs = (dir: string, kind: SourceFile["kind"], limit: number) => {
		try {
			const names = fs
				.readdirSync(path.join(root, dir))
				.filter((name) => /\.md$/i.test(name))
				.sort()
				.slice(0, limit);
			for (const name of names) add(path.join(dir, name), kind);
		} catch {}
	};
	listDocs("docs", "doc", maxDocs);
	listDocs(".titan", "titan", maxDocs);
	listDocs(TERRAFORM_DIRNAME, "terraform", maxDocs);
	const git = opts.git ?? ((args: string[]) => {
		const out = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000 });
		return out.status === 0 ? out.stdout : "";
	});
	const remotes = [...new Set(git(["remote", "-v"]).split("\n").map((line) => line.trim()).filter(Boolean).map((line) => line.split(/\s+/).slice(0, 2).join(" ")))];
	let tree: string[] = [];
	try {
		tree = fs
			.readdirSync(root, { withFileTypes: true })
			.filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
			.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
			.sort()
			.slice(0, 80);
	} catch {}
	const header = [`# Sources of ${path.basename(root)}`, remotes.length ? `remotes: ${remotes.join("; ")}` : "remotes: none", `tree: ${tree.join(" ")}`, ""].join("\n");
	return { files, corpus: `${header}\n${chunks.join("\n")}`.trim(), remotes, tree, truncated };
}

/** The "## Sources" table every persisted section ends with. */
export function renderSourcesTable(files: SourceFile[]): string {
	if (!files.length) return "## Sources\n\n_No source documents were found (add README.md, vision.md, intent.md or docs/)._";
	return ["## Sources", "", "| path | sha256 | bytes |", "|---|---|---|", ...files.map((file) => `| ${file.path} | ${file.sha256} | ${file.bytes} |`)].join("\n");
}

// ═══ harness_defaults ═══════════════════════════════════════════════════════

export interface HarnessDefaults {
	level?: number;
	tier?: string;
	review?: "required" | "optional" | "none";
	exa?: boolean;
	budget_usd?: number | null;
	personas?: string[];
}

export const DEFAULT_HARNESS_DEFAULTS: Required<HarnessDefaults> = { level: 2, tier: "prototype-analytics", review: "required", exa: true, budget_usd: 25, personas: ["implementer", "evidence-auditor"] };

const BLOCK_RE = /```ya?ml\s*\n([\s\S]*?)```/g;

/** Validate a parsed `harness_defaults` mapping; unknown or malformed fields are dropped, not guessed. */
export function normalizeHarnessDefaults(raw: unknown): HarnessDefaults | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	const out: HarnessDefaults = {};
	if (Number.isInteger(r.level) && (r.level as number) >= 0 && (r.level as number) <= 3) out.level = r.level as number;
	if (typeof r.tier === "string" && (TIER_NAMES as readonly string[]).includes(r.tier)) out.tier = r.tier;
	if (r.review === "required" || r.review === "optional" || r.review === "none") out.review = r.review;
	if (typeof r.exa === "boolean") out.exa = r.exa;
	if (r.budget_usd === null || (typeof r.budget_usd === "number" && Number.isFinite(r.budget_usd) && r.budget_usd >= 0)) out.budget_usd = r.budget_usd as number | null;
	if (Array.isArray(r.personas) && r.personas.every((p) => typeof p === "string")) out.personas = [...(r.personas as string[])];
	return Object.keys(out).length ? out : undefined;
}

/** The first fenced YAML block carrying `harness_defaults:` in a document. */
export function parseHarnessDefaults(text: string): HarnessDefaults | undefined {
	for (const match of text.matchAll(BLOCK_RE)) {
		if (!/^\s*harness_defaults\s*:/m.test(match[1])) continue;
		try {
			const doc = parseYaml(match[1]) as { harness_defaults?: unknown } | null;
			const parsed = normalizeHarnessDefaults(doc?.harness_defaults);
			if (parsed) return parsed;
		} catch {
			/* a malformed block is not defaults */
		}
	}
	return undefined;
}

export function harnessDefaultsBlock(defaults: HarnessDefaults = DEFAULT_HARNESS_DEFAULTS): string {
	const d = { ...DEFAULT_HARNESS_DEFAULTS, ...defaults };
	return ["```yaml", "harness_defaults:", `  level: ${d.level}`, `  tier: ${d.tier}`, `  review: ${d.review}`, `  exa: ${d.exa}`, `  budget_usd: ${d.budget_usd === null ? "null" : d.budget_usd}`, `  personas: [${d.personas.join(", ")}]`, "```"].join("\n");
}

/** entity.md always closes with a harness_defaults block: the seat's when valid, else the defaults (marked as such). */
export function ensureHarnessDefaults(entityMd: string, fallback: HarnessDefaults = DEFAULT_HARNESS_DEFAULTS): string {
	if (parseHarnessDefaults(entityMd)) return entityMd;
	return `${entityMd.trimEnd()}\n\n<!-- harness_defaults: the seat wrote none or an invalid block; titan defaults apply -->\n${harnessDefaultsBlock(fallback)}\n`;
}

/** `<cwd>/.titan/terraform` */
export function terraformDir(cwd: string): string {
	return path.join(path.resolve(cwd), TERRAFORM_DIRNAME);
}

export function sectionDocPath(cwd: string, section: TerraformSection): string {
	return path.join(terraformDir(cwd), `${section}.md`);
}

/** The level-2 defaults declared by .titan/terraform/entity.md, or undefined when the entity has not been terraformed. */
export function readHarnessDefaults(cwd: string): HarnessDefaults | undefined {
	try {
		return parseHarnessDefaults(fs.readFileSync(sectionDocPath(cwd, "entity"), "utf8"));
	} catch {
		return undefined;
	}
}

// ═══ Inputs and persistence ═════════════════════════════════════════════════

export interface TerraformRunInputs {
	sources: string;
	corpus: string;
	contract: string;
	ontology_graph: string;
	connectors_yaml: string;
	workflows: string;
}

/** prompts/SYSTEM_PROMPT_TERRAFORM.md (cached by the prompt library). */
export function terraformContract(): string {
	return promptTemplate(TERRAFORM_CONTRACT_FILE);
}

const MAX_GRAPH_CHARS = 20_000;

export function terraformInputs(gathered: GatheredSources, opts: { contract?: string; ontology?: OntologyStageResult; connectorsYaml?: string; workflows?: Array<{ name: string; description?: string; trigger?: unknown }> } = {}): TerraformRunInputs {
	let graph = "unavailable";
	if (opts.ontology?.confidence === "observed" && opts.ontology.ontology !== undefined) {
		const json = JSON.stringify(opts.ontology.ontology, null, 1);
		graph = json.length > MAX_GRAPH_CHARS ? `${json.slice(0, MAX_GRAPH_CHARS)}\n…[truncated]` : json;
	}
	return {
		sources: JSON.stringify(gathered.files, null, 1),
		corpus: gathered.corpus,
		contract: opts.contract ?? terraformContract(),
		ontology_graph: graph,
		connectors_yaml: opts.connectorsYaml ?? "",
		workflows: JSON.stringify(opts.workflows ?? [], null, 1),
	};
}

export interface PersistOptions {
	refresh?: boolean;
	section?: TerraformSection;
	ontology?: OntologyStageResult;
	probes?: ConnectorProbeResult[];
	recipes?: Array<{ workflow: string; recipe: string }>;
	runId?: string;
	now?: () => Date;
}

export interface PersistResult {
	written: TerraformSection[];
	skipped: TerraformSection[];
	missing: TerraformSection[];
	paths: Partial<Record<TerraformSection, string>>;
	record: string;
	connectorsCreated: boolean;
}

const sectionText = (result: RunResult, section: TerraformSection): string | undefined => {
	const node = result.nodes?.[section];
	if (!node || node.status !== "success") return undefined;
	const output = node.output;
	if (typeof output === "string" && output.trim()) return output;
	if (typeof node.text === "string" && node.text.trim()) return node.text;
	if (output !== undefined && output !== null) return JSON.stringify(output, null, 2);
	return undefined;
};

/** Which sections a persist would refuse: existing docs without --refresh, except the explicit --section. */
export function existingSections(cwd: string): TerraformSection[] {
	return TERRAFORM_SECTIONS.filter((section) => fs.existsSync(sectionDocPath(cwd, section)));
}

/** Persist the run's section texts under .titan/terraform/ with their Sources tables and host-owned appendices. */
export function persistTerraform(cwd: string, result: RunResult, gathered: GatheredSources, opts: PersistOptions = {}): PersistResult {
	const dir = terraformDir(cwd);
	fs.mkdirSync(dir, { recursive: true });
	const now = (opts.now ?? (() => new Date()))().toISOString();
	const wanted: TerraformSection[] = opts.section ? [opts.section] : [...TERRAFORM_SECTIONS];
	const out: PersistResult = { written: [], skipped: [], missing: [], paths: {}, record: path.join(dir, TERRAFORM_RECORD), connectorsCreated: false };
	const sources = renderSourcesTable(gathered.files);
	const footer = `<!-- titan terraform · run ${opts.runId ?? result.runId ?? "?"} · ${now} · ${gathered.files.length} sources -->`;
	for (const section of wanted) {
		const target = sectionDocPath(cwd, section);
		if (fs.existsSync(target) && !opts.refresh && opts.section !== section) {
			out.skipped.push(section);
			continue;
		}
		let body = sectionText(result, section);
		if (body === undefined) {
			out.missing.push(section);
			continue;
		}
		if (section === "entity") body = ensureHarnessDefaults(body);
		if (section === "ontology") {
			const observed = opts.ontology?.confidence === "observed";
			if (!observed && !body.includes(DECLARED_BANNER)) body = `> ${DECLARED_BANNER}${opts.ontology?.reason ? ` (${opts.ontology.reason})` : ""}\n\n${body}`;
			if (observed) body = `> confidence: observed — InfraNodus ontology stage ran (${opts.ontology?.calls.map((call) => call.tool).join(" → ") || "graph"}).\n\n${body}`;
		}
		if (section === "automations") {
			const recipes = opts.recipes ?? [];
			body += `\n\n## Automation recipes\n\n${recipes.length ? recipes.map((entry) => `**${entry.workflow}**\n\n\`\`\`bash\n${entry.recipe}\n\`\`\``).join("\n\n") : "_No installed workflow declares a `trigger:` yet. Add one (`trigger: { every: 6h }`) and `/terraform --section automations` prints its `orca automations create` line._"}`;
		}
		if (section === "connectors") {
			const ensured = ensureConnectorsFile(cwd);
			out.connectorsCreated = ensured.created;
			body += `\n\n## Probe\n\n${opts.probes?.length ? renderConnectorTable(opts.probes) : "_Not probed._"}\n\nDeclared in \`${path.relative(cwd, ensured.path)}\`${ensured.created ? " (created from the default catalog)" : ""}.`;
		}
		const text = `${body.trimEnd()}\n\n${sources}\n\n${footer}\n`;
		const tmp = `${target}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, text, { mode: 0o600 });
		fs.renameSync(tmp, target);
		out.paths[section] = target;
		out.written.push(section);
	}
	const record = {
		runId: opts.runId ?? result.runId,
		ts: now,
		status: result.status,
		written: out.written,
		skipped: out.skipped,
		missing: out.missing,
		ontology: opts.ontology?.confidence ?? "declared",
		sources: gathered.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
		verification: result.nodes?.verify ? { status: result.nodes.verify.status, output: result.nodes.verify.output ?? null } : null,
	};
	fs.writeFileSync(out.record, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
	return out;
}

// ═══ The command ════════════════════════════════════════════════════════════

export interface TerraformDeps {
	cwd(ctx: any): string;
	store(): RunStore;
	notify(ctx: any, text: string, level?: "info" | "warning" | "error"): void;
	panel(ctx: any, title: string, markdown: string): void;
	/** Open a run and execute the loaded workflow with the host's runtime (fusion seats, verifier lane). */
	runWorkflow(ctx: any, loaded: LoadedWorkflow, inputs: Record<string, unknown>): Promise<RunResult>;
	/** The InfraNodus ontology stage over the corpus; absent → the ontology section is declared. */
	ontology?(text: string, ctx: any): Promise<OntologyStageResult>;
	/** Loader override (tests point the package root elsewhere). */
	loadWorkflow?(cwd: string): LoadedWorkflow;
	probes?(cwd: string): ConnectorProbes;
	overrides?: WorkflowDirOverrides;
	now?(): Date;
}

export interface TerraformController {
	run(args: string, ctx: any): Promise<void>;
}

const declaredOntology = (reason: string): OntologyStageResult => ({ confidence: "declared", calls: [], reason, banner: DECLARED_BANNER });

export function createTerraform(deps: TerraformDeps): TerraformController {
	return {
		async run(args, ctx) {
			const parsed = parseTerraformArgs(args);
			if (parsed.errors.length) return deps.notify(ctx, `Not run: ${parsed.errors.join("; ")}\nUsage: /terraform [--refresh] [--section entity|ontology|roadmap|automations|connectors] [--dry-run]`, "warning");
			const cwd = deps.cwd(ctx);
			let loaded: LoadedWorkflow;
			try {
				loaded = deps.loadWorkflow ? deps.loadWorkflow(cwd) : loadWorkflow(TERRAFORM_WORKFLOW, cwd, undefined, deps.overrides);
			} catch (error) {
				return deps.notify(ctx, `terraform: the shipped workflow did not load — ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			const gathered = collectSources(cwd);
			const connectors = loadConnectors(cwd);
			const probes = dryRunConnectors(connectors.connectors, (deps.probes ?? defaultProbes)(cwd));
			const recipes = automationRecipes(cwd, { overrides: deps.overrides });
			if (parsed.dryRun) {
				deps.panel(
					ctx,
					"◆ TERRAFORM — DRY RUN",
					[
						`**${loaded.name}** · ${loaded.doc.nodes.length} nodes · nothing spent`,
						"",
						"```",
						formatLayerPlan(loaded.doc),
						"```",
						`**sources** (${gathered.files.length}; ${gathered.remotes.length ? gathered.remotes.join("; ") : "no git remote"})`,
						"",
						renderSourcesTable(gathered.files).replace(/^## Sources\n\n/, ""),
						gathered.truncated.length ? `\n_truncated in the corpus: ${gathered.truncated.join(", ")}_` : "",
						"",
						`**connectors** (${connectors.exists ? path.relative(cwd, connectors.path) : "defaults; connectors.yaml will be created"})`,
						"",
						renderConnectorTable(probes),
						"",
						`**automation recipes**: ${recipes.length ? recipes.map((entry) => entry.workflow).join(", ") : "none (no workflow declares a trigger)"}`,
						`**existing docs**: ${existingSections(cwd).join(", ") || "none"} · ontology stage: ${deps.ontology ? "bridge present" : "no bridge → declared"}`,
					]
						.filter((line) => line !== undefined)
						.join("\n"),
				);
				return;
			}
			const existing = existingSections(cwd);
			if (!parsed.refresh && !parsed.section && existing.length === TERRAFORM_SECTIONS.length) {
				return deps.notify(ctx, `terraform: .titan/terraform already has ${existing.join(", ")} — /terraform --refresh to overwrite everything or --section <name> for one`, "warning");
			}
			if (!parsed.refresh && !parsed.section && existing.length) deps.notify(ctx, `terraform: keeping existing ${existing.join(", ")} (no --refresh); writing the rest`, "info");
			let ontology: OntologyStageResult;
			try {
				ontology = deps.ontology ? await deps.ontology(gathered.corpus, ctx) : declaredOntology("no InfraNodus bridge in this session");
			} catch (error) {
				ontology = declaredOntology(`ontology stage failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (ontology.confidence !== "observed") deps.notify(ctx, `terraform: ${ontology.banner ?? DECLARED_BANNER}${ontology.reason ? ` — ${ontology.reason}` : ""}`, "warning");
			const inputs = terraformInputs(gathered, { ontology, connectorsYaml: connectors.text, workflows: recipes.map((entry) => ({ name: entry.workflow, trigger: entry.trigger })) });
			let result: RunResult;
			try {
				result = await deps.runWorkflow(ctx, loaded, inputs as unknown as Record<string, unknown>);
			} catch (error) {
				return deps.notify(ctx, `terraform: the workflow failed — ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			const persisted = persistTerraform(cwd, result, gathered, { refresh: parsed.refresh, section: parsed.section, ontology, probes, recipes, now: deps.now });
			const verify = result.nodes?.verify;
			const verdict = verify ? `${verify.status}${verify.error ? ` — ${verify.error}` : ""}` : "not run";
			deps.panel(
				ctx,
				`◆ TERRAFORM — ${result.status.toUpperCase()}`,
				[
					`**run** ${result.runId} · ${result.status}${result.error ? ` — ${result.error}` : ""}`,
					`**written** ${persisted.written.join(", ") || "none"}${persisted.skipped.length ? ` · **kept** ${persisted.skipped.join(", ")} (no --refresh)` : ""}${persisted.missing.length ? ` · **missing** ${persisted.missing.join(", ")} (node did not succeed)` : ""}`,
					`**ontology** ${ontology.confidence}${ontology.reason ? ` (${ontology.reason})` : ""} · **verification** ${verdict}`,
					`**sources** ${gathered.files.length} · **connectors** ${probes.filter((p) => p.reachable).length}/${probes.length} reachable${persisted.connectorsCreated ? " · connectors.yaml created" : ""} · **recipes** ${recipes.length}`,
					`**record** \`${path.relative(cwd, persisted.record)}\``,
					"",
					...TERRAFORM_SECTIONS.map((section) => `- ${section}: ${persisted.paths[section] ? `\`${path.relative(cwd, persisted.paths[section]!)}\`` : persisted.skipped.includes(section) ? "kept" : "missing"}`),
				].join("\n"),
			);
			if (persisted.missing.length || result.status !== "completed") deps.notify(ctx, `terraform: ${result.status}; missing ${persisted.missing.join(", ") || "nothing"} — see the run's artifacts`, "warning");
		},
	};
}

export function registerTerraformCommand(pi: ExtensionAPI, deps: TerraformDeps): TerraformController {
	const controller = createTerraform(deps);
	pi.registerCommand("terraform", {
		description: "Originalize the entity: entity, ontology, roadmap, automations and connectors docs under .titan/terraform with source digests. /terraform [--refresh] [--section <name>] [--dry-run]",
		getArgumentCompletions: (prefix: string) => {
			const options = ["--refresh", "--section", "--dry-run", ...TERRAFORM_SECTIONS.map((section) => `--section ${section}`)];
			const items = options.filter((option) => option.startsWith(prefix.trim())).map((option) => ({ value: option, label: option }));
			return items.length ? items : null;
		},
		handler: async (args: string, ctx: any) => {
			await controller.run(args ?? "", ctx);
		},
	} as any);
	return controller;
}
