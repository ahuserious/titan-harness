/**
 * connectors.ts — the entity's connectors as EXISTING surfaces (plan §5.7, H7; P8).
 *
 * A connector is declared in `.titan/terraform/connectors.yaml` and implemented by something
 * titan already has — never a new client:
 *   mcp     a server of the titan catalog (macro, figma, brandfetch, testmu, infranodus, …)
 *   cli     a binary on PATH (`gh` for issues and PRs)
 *   orca    an `orca <subcommand>` surface (`orca linear` for tickets)
 *   script  a read-only `script:` node whose credentials are NAMED environment variables
 *
 * `dryRunConnectors` reports each one reachable or vacant from injected probes (the enabled
 * catalog names, `which`, env presence) and names the missing pieces — it never reads or
 * prints a credential value; a connectors.yaml entry that carries `NAME=value` is refused.
 * `automationRecipes` turns every installed workflow with a `trigger:` into the exact
 * `orca automations create …` line (printed for the operator, never executed here).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { defaultCatalogPaths, loadMcpCatalog } from "./mcp-client.ts";
import { listWorkflows, readWorkflowFile, type WorkflowDirOverrides } from "./workflow/loader.ts";
import { orcaAutomationRecipe, type TriggerSpec } from "./workflow/trigger.ts";

export type ConnectorKind = "mcp" | "cli" | "orca" | "script";
export const CONNECTOR_KINDS: ConnectorKind[] = ["mcp", "cli", "orca", "script"];

export interface ConnectorSpec {
	name: string;
	kind: ConnectorKind;
	purpose: string;
	/** mcp: the catalog server name. */
	server?: string;
	/** cli: the binary on PATH. */
	bin?: string;
	/** orca: the subcommand (`linear`). */
	command?: string;
	/** Credential NAMES (environment variables) the connector needs; values never appear here. */
	env?: string[];
	/** script: the read-only script a workflow node runs. */
	script?: string;
	scope?: "read" | "write" | "read-write";
}

export const CONNECTORS_FILE = "connectors.yaml";
export const TERRAFORM_DIRNAME = path.join(".titan", "terraform");
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** `<cwd>/.titan/terraform/connectors.yaml` */
export function connectorsPath(cwd: string): string {
	return path.join(path.resolve(cwd), TERRAFORM_DIRNAME, CONNECTORS_FILE);
}

/** The default catalog: the surfaces the plan names (§5.7), all read scope unless noted. */
export const DEFAULT_CONNECTORS: ConnectorSpec[] = [
	{ name: "macro", kind: "mcp", server: "macro", purpose: "organization documents, tasks and channel posts (entity, roadmap, automations inputs)", scope: "read-write" },
	{ name: "fiber", kind: "mcp", server: "fiber", purpose: "B2B people and company search for outbound lists (scratch CRM is Macro, not Salesforce sandbox)", scope: "read" },
	{ name: "figma", kind: "mcp", server: "figma", purpose: "design context and components for design-match verdicts", scope: "read" },
	{ name: "brandfetch", kind: "mcp", server: "brandfetch", purpose: "brand kit (logos, colours, fonts) for the entity's brand sections", scope: "read" },
	{ name: "testmu", kind: "mcp", server: "testmu", purpose: "cloud test data: HyperExecute jobs, logs, SmartUI diffs, accessibility audits", scope: "read" },
	{ name: "infranodus", kind: "mcp", server: "infranodus", env: ["INFRANODUS_API_KEY"], purpose: "reasoning ontology, gaps and cross-run memory relations", scope: "read-write" },
	{ name: "github", kind: "cli", bin: "gh", purpose: "issues, pull requests and CI status through the gh CLI", scope: "read-write" },
	{ name: "linear", kind: "orca", command: "linear", purpose: "ticket context through `orca linear`", scope: "read" },
	{ name: "analytics-db", kind: "script", script: "scripts/analytics-readonly.ts", env: ["ANALYTICS_DATABASE_URL"], purpose: "read-only analytics queries for telemetry rows (credential by name only)", scope: "read" },
];

/** connectors.yaml text for a list (a comment header + `connectors:`). */
export function renderConnectorsYaml(connectors: ConnectorSpec[] = DEFAULT_CONNECTORS): string {
	const header = [
		"# .titan/terraform/connectors.yaml — the systems this entity's workflows read and write.",
		"# Every connector is an existing surface: an MCP server of the titan catalog (kind: mcp),",
		"# a CLI on PATH (kind: cli), an `orca <command>` surface (kind: orca) or a read-only script",
		"# with credentials NAMED by environment variable (kind: script). Values never belong here.",
		"# `/terraform --section connectors` re-probes them; `/titan-doctor` shows the names it needs.",
		"",
	].join("\n");
	return `${header}${stringifyYaml({ connectors })}`;
}

/** Parse connectors.yaml text; malformed entries throw with the file and the field. */
export function parseConnectors(text: string, file = CONNECTORS_FILE): ConnectorSpec[] {
	if (!text.trim()) return []; // an empty file declares no connectors
	const doc = parseYaml(text) as unknown;
	const list = doc && typeof doc === "object" && Array.isArray((doc as { connectors?: unknown }).connectors) ? ((doc as { connectors: unknown[] }).connectors as unknown[]) : Array.isArray(doc) ? (doc as unknown[]) : undefined;
	if (!list) throw new Error(`${file}: expected a \`connectors:\` list`);
	const seen = new Set<string>();
	return list.map((raw, index) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file}: connectors[${index}] must be a mapping`);
		const entry = raw as Record<string, unknown>;
		const name = typeof entry.name === "string" ? entry.name.trim() : "";
		if (!NAME_RE.test(name)) throw new Error(`${file}: connectors[${index}].name must match ${NAME_RE}; found ${JSON.stringify(entry.name)}`);
		if (seen.has(name)) throw new Error(`${file}: duplicate connector ${name}`);
		seen.add(name);
		const kind = entry.kind as ConnectorKind;
		if (!CONNECTOR_KINDS.includes(kind)) throw new Error(`${file}: connector ${name}: kind must be one of ${CONNECTOR_KINDS.join(", ")}; found ${JSON.stringify(entry.kind)}`);
		const env = entry.env === undefined ? undefined : Array.isArray(entry.env) ? entry.env.map(String) : [String(entry.env)];
		for (const variable of env ?? []) {
			if (variable.includes("=")) throw new Error(`${file}: connector ${name}: env entries are NAMES only (found an assignment)`);
			if (!ENV_NAME_RE.test(variable)) throw new Error(`${file}: connector ${name}: ${JSON.stringify(variable)} is not an environment variable name`);
		}
		const spec: ConnectorSpec = { name, kind, purpose: typeof entry.purpose === "string" ? entry.purpose : "" };
		if (typeof entry.server === "string") spec.server = entry.server;
		if (typeof entry.bin === "string") spec.bin = entry.bin;
		if (typeof entry.command === "string") spec.command = entry.command;
		if (typeof entry.script === "string") spec.script = entry.script;
		if (env) spec.env = env;
		if (entry.scope === "read" || entry.scope === "write" || entry.scope === "read-write") spec.scope = entry.scope;
		if (kind === "mcp" && !spec.server) spec.server = name;
		if (kind === "cli" && !spec.bin) spec.bin = name;
		if (kind === "orca" && !spec.command) spec.command = name;
		return spec;
	});
}

/** Read `.titan/terraform/connectors.yaml`; the defaults (unwritten) when the file is absent. */
export function loadConnectors(cwd: string): { connectors: ConnectorSpec[]; path: string; exists: boolean; text: string } {
	const file = connectorsPath(cwd);
	try {
		const text = fs.readFileSync(file, "utf8");
		return { connectors: parseConnectors(text, path.relative(cwd, file)), path: file, exists: true, text };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { connectors: DEFAULT_CONNECTORS, path: file, exists: false, text: "" };
		throw error;
	}
}

/** Create connectors.yaml from the defaults when it does not exist (never overwrites). */
export function ensureConnectorsFile(cwd: string): { path: string; created: boolean } {
	const file = connectorsPath(cwd);
	if (fs.existsSync(file)) return { path: file, created: false };
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, renderConnectorsYaml(), { mode: 0o600 });
	return { path: file, created: true };
}

export interface ConnectorProbes {
	/** Enabled server names of the merged MCP catalog. */
	mcpServers(): string[];
	which(bin: string): string | undefined;
	/** Whether the environment variable is set (never its value). */
	env(name: string): boolean;
}

export interface ConnectorProbeResult {
	name: string;
	kind: ConnectorKind;
	reachable: boolean;
	reason: string;
	/** Missing pieces by name (server, binary, env variable). */
	needs: string[];
}

/** Probe each connector: reachable, or vacant with the missing pieces named (never a value). */
export function dryRunConnectors(connectors: ConnectorSpec[], probes: ConnectorProbes): ConnectorProbeResult[] {
	const enabled = new Set(probes.mcpServers());
	return connectors.map((connector) => {
		const needs: string[] = [];
		for (const variable of connector.env ?? []) if (!probes.env(variable)) needs.push(`env ${variable}`);
		switch (connector.kind) {
			case "mcp": {
				const server = connector.server ?? connector.name;
				if (!enabled.has(server)) needs.push(`mcp server ${server} (disabled or not in the catalog)`);
				break;
			}
			case "cli": {
				const bin = connector.bin ?? connector.name;
				if (!probes.which(bin)) needs.push(`binary ${bin} on PATH`);
				break;
			}
			case "orca": {
				if (!probes.which("orca")) needs.push("binary orca on PATH");
				break;
			}
			case "script":
				break;
		}
		const reachable = needs.length === 0;
		const detail = connector.kind === "mcp" ? `mcp ${connector.server ?? connector.name}` : connector.kind === "cli" ? `cli ${connector.bin ?? connector.name}` : connector.kind === "orca" ? `orca ${connector.command ?? connector.name}` : `script ${connector.script ?? "(unnamed)"}`;
		return { name: connector.name, kind: connector.kind, reachable, needs, reason: reachable ? `reachable · ${detail}` : `vacant · needs ${needs.join(", ")}` };
	});
}

/** Markdown table of a probe. */
export function renderConnectorTable(results: ConnectorProbeResult[]): string {
	const rows = results.map((r) => `| ${r.name} | ${r.kind} | ${r.reachable ? "✓ reachable" : "○ vacant"} | ${r.reachable ? r.reason.replace(/^reachable · /, "") : r.needs.join("; ")} |`);
	return ["| connector | kind | state | detail |", "|---|---|---|---|", ...rows].join("\n");
}

const PATH_EXTRA = () => [path.join(os.homedir(), "Dev Tools", "bin"), path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".bun", "bin")];

/** Real probes: the merged MCP catalog, PATH (+ the usual user bins), process.env presence. */
export function defaultProbes(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): ConnectorProbes {
	return {
		mcpServers: () => {
			try {
				return loadMcpCatalog(defaultCatalogPaths(cwd), env)
					.filter((server) => !server.disabled)
					.map((server) => server.name);
			} catch {
				return [];
			}
		},
		which: (bin) => {
			const dirs = [...(env.PATH ?? "").split(path.delimiter).filter(Boolean), ...PATH_EXTRA()];
			for (const dir of dirs) {
				const candidate = path.join(dir, bin);
				try {
					fs.accessSync(candidate, fs.constants.X_OK);
					return candidate;
				} catch {}
			}
			return undefined;
		},
		env: (name) => Boolean(env[name] && String(env[name]).trim()),
	};
}

export interface AutomationRecipe {
	workflow: string;
	source: string;
	trigger: TriggerSpec;
	recipe: string;
}

/** One `orca automations create …` recipe per installed workflow that declares a `trigger:` (printed, never executed). */
export function automationRecipes(cwd: string, opts: { overrides?: WorkflowDirOverrides; packageRoot?: string; provider?: string } = {}): AutomationRecipe[] {
	const recipes: AutomationRecipe[] = [];
	for (const entry of listWorkflows(cwd, opts.overrides)) {
		try {
			const file = fs.readdirSync(entry.dir).find((name) => /^.+\.ya?ml$/.test(name) && name.replace(/\.ya?ml$/, "") === entry.name);
			if (!file) continue;
			const doc = readWorkflowFile(path.join(entry.dir, file)).doc as { trigger?: TriggerSpec } | null;
			const trigger = doc && typeof doc === "object" ? doc.trigger : undefined;
			if (!trigger || typeof trigger !== "object") continue;
			recipes.push({ workflow: entry.name, source: entry.source, trigger, recipe: orcaAutomationRecipe(entry.name, trigger, path.resolve(cwd), { packageRoot: opts.packageRoot, provider: opts.provider }) });
		} catch {
			/* a workflow that cannot be read has no recipe */
		}
	}
	return recipes;
}
