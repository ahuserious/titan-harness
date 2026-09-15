/**
 * cmd-titan-config.ts — `/titan-config`, the command face of the settings panel (PRD v0.9 R4).
 *
 *   /titan-config show                  every setting, MCP server and quick config, as text
 *   /titan-config list                  the saved quick configs
 *   /titan-config save <name> [note…]   snapshot the live settings + MCP states as <name>
 *   /titan-config apply <name>          apply a saved quick config (settings, shape/level, MCP)
 *   /titan-config delete <name>
 *   /titan-config mcp <server> on|off [--project]
 *                                       toggle a catalog server in the user (or project) file
 *   /titan-config panel                 open the settings panel (the host wires the overlay)
 *
 * The parsing and formatting are pure and exported for tests; the host supplies the deps
 * seam (cwd, notify, panel, the shape loader, the overlay opener).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatMcpRows, listMcpServers, setMcpEnabled } from "./mcp-toggle.ts";
import { applyQuickConfig, CONFIGS_DIR, deleteQuickConfig, listQuickConfigs, loadQuickConfig, type QuickConfigSummary, saveQuickConfig, snapshotCurrent } from "./quick-configs.ts";
import { buildSettingsModel, formatSettingsSummary, type PanelDeps } from "./settings-panel.ts";
import { readStackSettings, STACK_SETTINGS_PATH, writeStackSettings } from "./stack-config.ts";

export const TITAN_CONFIG_VERBS = ["show", "list", "save", "apply", "delete", "mcp", "panel", "help"] as const;
export type TitanConfigVerb = (typeof TITAN_CONFIG_VERBS)[number];

export interface TitanConfigArgs {
	verb: TitanConfigVerb;
	name?: string;
	note?: string;
	server?: string;
	enabled?: boolean;
	scope: "user" | "project";
	errors: string[];
}

export interface TitanConfigDeps {
	cwd(ctx: any): string;
	notify(ctx: any, text: string, level?: "info" | "warning" | "error"): void;
	panel(ctx: any, title: string, markdown: string): void;
	/** Opens the settings panel overlay; absent → `/titan-config panel` explains it is TUI-only. */
	openPanel?(ctx: any): Promise<void> | void;
	loadShape?(codename: string, level: number | null | undefined, ctx: any): unknown;
	models?(): string[];
	settingsPath?: string;
	configsDir?: string;
	mcp?: PanelDeps["mcp"];
}

export function parseTitanConfigArgs(raw: string): TitanConfigArgs {
	const tokens = (raw ?? "").trim().split(/\s+/).filter(Boolean);
	const scope: "user" | "project" = tokens.includes("--project") ? "project" : "user";
	const words = tokens.filter((token) => token !== "--project" && token !== "--user");
	const verb = (words[0] ?? "show").toLowerCase();
	const errors: string[] = [];
	if (!(TITAN_CONFIG_VERBS as readonly string[]).includes(verb)) return { verb: "help", scope, errors: [`unknown verb ${verb}`] };
	const args: TitanConfigArgs = { verb: verb as TitanConfigVerb, scope, errors };
	if (verb === "save" || verb === "apply" || verb === "delete") {
		if (!words[1]) errors.push(`${verb} needs a config name`);
		else args.name = words[1];
		if (verb === "save" && words.length > 2) args.note = words.slice(2).join(" ");
	}
	if (verb === "mcp") {
		if (!words[1]) errors.push("mcp needs a server name");
		else args.server = words[1];
		const state = (words[2] ?? "").toLowerCase();
		if (state === "on" || state === "enable" || state === "enabled") args.enabled = true;
		else if (state === "off" || state === "disable" || state === "disabled") args.enabled = false;
		else errors.push("mcp needs on|off");
	}
	return args;
}

export function formatConfigList(rows: QuickConfigSummary[]): string {
	if (!rows.length) return "no quick configs saved yet — /titan-config save <name> (or `s` in the settings panel)";
	const width = Math.max(...rows.map((row) => row.name.length));
	return rows
		.map((row) => `${row.name.padEnd(width)}  ${row.shape ?? "?"}${row.level !== null && row.level !== undefined ? ` · L${row.level}` : ""}${row.mcpCount ? ` · ${row.mcpCount} mcp` : ""}  ${row.savedAt.slice(0, 19).replace("T", " ")}${row.note ? `  — ${row.note}` : ""}`)
		.join("\n");
}

export const TITAN_CONFIG_HELP = [
	"/titan-config show                      every setting, MCP server and quick config",
	"/titan-config list                      saved quick configs",
	"/titan-config save <name> [note…]       snapshot settings + MCP states as <name>",
	"/titan-config apply <name>              apply a saved quick config",
	"/titan-config delete <name>",
	"/titan-config mcp <server> on|off [--project]   toggle a catalog server (user file by default); /reload after",
	"/titan-config panel                     open the settings panel (ctrl+, / alt+,)",
].join("\n");

export function registerTitanConfigCommand(pi: ExtensionAPI, deps: TitanConfigDeps): void {
	const settingsPath = () => deps.settingsPath ?? STACK_SETTINGS_PATH;
	const configsDir = () => deps.configsDir ?? CONFIGS_DIR;
	const panelDeps = (ctx: any): PanelDeps => ({
		settingsPath: settingsPath(),
		configsDir: configsDir(),
		cwd: deps.cwd(ctx),
		mcp: deps.mcp,
		models: deps.models?.(),
		loadShape: deps.loadShape ? (codename, level) => deps.loadShape!(codename, level, ctx) : undefined,
	});
	pi.registerCommand("titan-config", {
		description: "Harness configuration in one place: /titan-config [show|list|save <name>|apply <name>|delete <name>|mcp <server> on|off [--project]|panel]",
		getArgumentCompletions: (prefix: string) => {
			const items = TITAN_CONFIG_VERBS.filter((verb) => verb.startsWith(prefix.trim().toLowerCase())).map((verb) => ({ value: verb, label: verb }));
			return items.length ? items : null;
		},
		handler: async (raw: string, ctx: any) => {
			const args = parseTitanConfigArgs(raw ?? "");
			if (args.errors.length) return deps.notify(ctx, `${args.errors.join("; ")}\n${TITAN_CONFIG_HELP}`, "warning");
			switch (args.verb) {
				case "help":
					return deps.panel(ctx, "◆ TITAN CONFIG — HELP", `\`\`\`\n${TITAN_CONFIG_HELP}\n\`\`\``);
				case "show": {
					const model = buildSettingsModel(panelDeps(ctx));
					return deps.panel(ctx, "◆ TITAN CONFIG — SHOW", `\`\`\`\n${formatSettingsSummary(model)}\n\nquick configs:\n${formatConfigList(model.configs)}\n\`\`\``);
				}
				case "list":
					return deps.panel(ctx, "◆ TITAN CONFIG — QUICK CONFIGS", `\`\`\`\n${formatConfigList(listQuickConfigs(configsDir()))}\n\`\`\``);
				case "save": {
					let servers: Array<{ name: string; enabled: boolean }> = [];
					try {
						servers = listMcpServers({ ...(deps.mcp ?? {}), cwd: deps.cwd(ctx) }).map((row) => ({ name: row.name, enabled: row.enabled }));
					} catch {}
					try {
						const snapshot = snapshotCurrent({ settings: readStackSettings(settingsPath()), mcpServers: servers, note: args.note }, args.name!);
						const file = saveQuickConfig(snapshot, configsDir());
						return deps.notify(ctx, `titan config: saved ${snapshot.name} → ${file}`);
					} catch (error) {
						return deps.notify(ctx, `titan config: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				}
				case "apply": {
					try {
						const { config, dropped } = loadQuickConfig(args.name!, configsDir());
						const outcome = await applyQuickConfig(config, {
							writeSettings: (patch) => writeStackSettings(patch, settingsPath()),
							setMcpEnabled: (server, enabled) => setMcpEnabled(server, enabled, { ...(deps.mcp ?? {}), cwd: deps.cwd(ctx), scope: args.scope }),
							loadShape: deps.loadShape ? (codename, level) => deps.loadShape!(codename, level, ctx) : undefined,
						});
						const lines = [`applied ${config.name}: ${outcome.applied.join(", ")}`];
						if (outcome.skipped.length) lines.push(`skipped: ${outcome.skipped.join("; ")}`);
						if (dropped.length) lines.push(`ignored keys: ${dropped.join(", ")}`);
						if (outcome.needsReload) lines.push("/reload to apply the MCP changes");
						return deps.notify(ctx, `titan config: ${lines.join(" · ")}`, outcome.skipped.length ? "warning" : "info");
					} catch (error) {
						return deps.notify(ctx, `titan config: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				}
				case "delete":
					return deps.notify(ctx, deleteQuickConfig(args.name!, configsDir()) ? `titan config: deleted ${args.name}` : `titan config: no quick config named ${args.name}`, "info");
				case "mcp": {
					try {
						const result = setMcpEnabled(args.server!, args.enabled!, { ...(deps.mcp ?? {}), cwd: deps.cwd(ctx), scope: args.scope });
						const rows = listMcpServers({ ...(deps.mcp ?? {}), cwd: deps.cwd(ctx) });
						deps.panel(ctx, "◆ TITAN CONFIG — MCP", `\`\`\`\n${formatMcpRows(rows)}\n\`\`\``);
						return deps.notify(ctx, `titan config: ${args.server} ${result.enabled ? "enabled" : "disabled"} in ${result.layer} config (${result.path})${result.created ? " · entry created from the package definition" : ""} — /reload to apply`);
					} catch (error) {
						return deps.notify(ctx, `titan config: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				}
				case "panel":
					if (!deps.openPanel) return deps.notify(ctx, "titan config: the settings panel needs the TUI (ctrl+, / alt+,)", "warning");
					await deps.openPanel(ctx);
					return;
			}
		},
	} as any);
}
