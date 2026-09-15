/**
 * cloud-providers.ts — the cloud simulated-user provider registry (plan §2 H9, §5.8, P8).
 *
 * Four lanes, each mapped onto the P4 verify runner that executes it:
 *
 *   cursor-cloud          Cursor background agents      runner cursor-cloud   needs CURSOR_API_KEY (+ git remote)
 *   testmu-hyperexecute   TestMu AI cloud (HyperExecute) runner testmu         needs the `testmu` MCP server enabled
 *   kane-remote           KaneAI on cloud devices        runner kane           needs kane-cli on PATH (+ `kane-cli login`)
 *   momentic              Momentic AI E2E                runner momentic       needs MOMENTIC_API_KEY or MOMENTIC_CONFIG + the `momentic` server enabled
 *
 * A probe reads readiness by NAME only: whether an environment variable is set (never its
 * value), whether a binary is on PATH, whether a catalog server is enabled. The matrix the
 * command prints therefore never carries a credential. `ready: false` is a vacancy, not an
 * error (plan D15): the setup-agent path exists for exactly that case. Pure Node, no pi.
 */
import type { RunnerName } from "./workflow/tiers.ts";

export type CloudProviderName = "cursor-cloud" | "testmu-hyperexecute" | "kane-remote" | "momentic";

export interface CloudProvider {
	name: CloudProviderName;
	label: string;
	/** The P4 verify runner that executes this lane. */
	runner: RunnerName;
	/** The skill a setup agent loads (skills/<name>/SKILL.md). */
	skill: string;
	/** Environment variable NAMES that must be set (any one of `envAnyOf`, all of `envNames`). */
	envNames: string[];
	envAnyOf: string[];
	/** Binaries that must be on PATH. */
	binaries: string[];
	/** Catalog MCP servers that must be enabled. */
	mcpServers: string[];
	/** The lane runs per device (`--devices`). */
	devices: boolean;
	/** Evidence kinds the one-node verify workflow requires from this lane. */
	requires: string[];
	/** Where the vendor documents the setup. */
	docs: string;
	/** Setup steps the advice starts from (the setup agent refines them). */
	setupSteps: string[];
	aliases: string[];
}

export const CLOUD_PROVIDERS: CloudProvider[] = [
	{
		name: "cursor-cloud",
		label: "Cursor cloud agents",
		runner: "cursor-cloud",
		skill: "titan-cloud-simulated-users",
		envNames: ["CURSOR_API_KEY"],
		envAnyOf: [],
		binaries: ["git"],
		mcpServers: [],
		devices: false,
		requires: ["report"],
		docs: "https://docs.cursor.com/background-agent/api",
		setupSteps: [
			"Create an API key in the Cursor dashboard (Background Agents → API keys) and export it as CURSOR_API_KEY before launching Pi (name only in titan; the value is never stored).",
			"Push the branch the agent should start from: git push origin titan/<runId> (the runner refuses a ref that is not on the remote).",
			"Copy .pi/titan-harness/templates/cursor.yaml to <project>/.titan/cursor.yaml and set env.type / env.name / repo.",
			"Probe again: /cloud-simulated-users probe → cursor-cloud ready.",
		],
		aliases: ["cursor", "cursor-cloud", "cursor-agents"],
	},
	{
		name: "testmu-hyperexecute",
		label: "TestMu AI cloud (HyperExecute)",
		runner: "testmu",
		skill: "testmu-cloud-testing",
		envNames: [],
		envAnyOf: [],
		binaries: [],
		mcpServers: ["testmu"],
		devices: true,
		requires: ["report"],
		docs: "https://www.testmuai.com/support/docs/mcp-server/",
		setupSteps: [
			"Enable the package-local `testmu` MCP server (/mcp enable testmu) and complete its login flow.",
			"Start a HyperExecute job from the TestMu console or a Kane run; titan triages it through the server's tools (job status, logs, SmartUI, WCAG).",
			"Probe again: /cloud-simulated-users probe → testmu-hyperexecute ready.",
		],
		aliases: ["testmu", "hyperexecute", "testmu-hyperexecute", "lambdatest"],
	},
	{
		name: "kane-remote",
		label: "KaneAI on cloud devices (kane-cli --remote)",
		runner: "kane",
		skill: "kane-cli-browser-runs",
		envNames: [],
		envAnyOf: [],
		binaries: ["kane-cli"],
		mcpServers: [],
		devices: true,
		requires: ["log"],
		docs: "https://www.testmuai.com/support/docs/kane-cli/",
		setupSteps: [
			"npm i -g @testmuai/kane-cli (documented, not installed by titan) and run kane-cli login.",
			"Name the cloud devices per run: /cloud-simulated-users run kane-remote --objective \"…\" --devices \"iPhone 15,Pixel 8\".",
			"Probe again: /cloud-simulated-users probe → kane-remote ready.",
		],
		aliases: ["kane", "kane-remote", "kaneai"],
	},
	{
		name: "momentic",
		label: "Momentic AI E2E",
		runner: "momentic",
		skill: "momentic-e2e",
		envNames: [],
		envAnyOf: ["MOMENTIC_API_KEY", "MOMENTIC_CONFIG"],
		binaries: [],
		mcpServers: ["momentic"],
		devices: false,
		requires: ["report"],
		docs: "https://docs.momentic.ai/",
		setupSteps: [
			"Export MOMENTIC_API_KEY (or MOMENTIC_CONFIG naming a config) before launching Pi; the catalog entry ships disabled.",
			"Enable the `momentic` MCP server (/mcp enable momentic).",
			"Verify nodes must opt in with `enabled: true`; a skipped lane is reported, never passed.",
			"Probe again: /cloud-simulated-users probe → momentic ready.",
		],
		aliases: ["momentic", "momentic-e2e"],
	},
];

export interface ProbeDeps {
	/** Is the variable SET (value never read here)? */
	env(name: string): boolean;
	which(binary: string): string | undefined;
	mcpEnabled(server: string): boolean;
}

export interface ProbeResult {
	provider: CloudProviderName;
	label: string;
	runner: RunnerName;
	skill: string;
	ready: boolean;
	/** Human line: "ready" or what is missing, names only. */
	reason: string;
	/** Missing pieces, names only (env names, binaries, servers). */
	needs: string[];
}

export function providerByName(name: string | undefined): CloudProvider | undefined {
	if (!name) return undefined;
	const wanted = name.trim().toLowerCase();
	return CLOUD_PROVIDERS.find((provider) => provider.name === wanted || provider.aliases.includes(wanted));
}

export function probeProvider(provider: CloudProvider, deps: ProbeDeps): ProbeResult {
	const needs: string[] = [];
	for (const name of provider.envNames) if (!deps.env(name)) needs.push(`env ${name}`);
	if (provider.envAnyOf.length && !provider.envAnyOf.some((name) => deps.env(name))) needs.push(`env ${provider.envAnyOf.join(" or ")}`);
	for (const binary of provider.binaries) if (!deps.which(binary)) needs.push(`binary ${binary}`);
	for (const server of provider.mcpServers) if (!deps.mcpEnabled(server)) needs.push(`mcp server ${server} (enabled)`);
	const ready = needs.length === 0;
	return { provider: provider.name, label: provider.label, runner: provider.runner, skill: provider.skill, ready, reason: ready ? "ready" : `vacant — missing ${needs.join(", ")}`, needs };
}

export function probeAll(deps: ProbeDeps): ProbeResult[] {
	return CLOUD_PROVIDERS.map((provider) => probeProvider(provider, deps));
}

/** A presence-only env probe over `env` (default process.env): true when the variable is set and non-blank. */
export function envProbe(env: Record<string, string | undefined> = process.env): ProbeDeps["env"] {
	return (name) => typeof env[name] === "string" && env[name]!.trim().length > 0;
}

/** The probe matrix as a markdown table (names only, never values). */
export function formatProbeMatrix(results: ProbeResult[]): string {
	const rows = results.map((r) => `| ${r.provider} | ${r.label} | ${r.ready ? "✓ ready" : "○ vacant"} | ${r.ready ? "—" : r.needs.join(", ")} | ${r.runner} | ${r.skill} |`);
	return ["| provider | lane | state | needs | runner | skill |", "|---|---|---|---|---|---|", ...rows].join("\n");
}
