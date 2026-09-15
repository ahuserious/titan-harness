/**
 * settings-panel.ts — the pure model behind the settings panel overlay (PRD v0.9 R4).
 *
 * One place for the live harness configuration: harness preset (level/shape) and the lane
 * pools, concurrency and budget, watchdog, monitor, review, the model bar, every MCP server
 * of the merged catalog as a toggle, and the quick configs (save / apply). The model is a
 * flat list of rows grouped in sections; the host wraps it in a `ctx.ui.custom` overlay and
 * feeds keys into `handleSettingsKey`. Every change is written immediately through
 * `writeStackSettings` (settings), `setMcpEnabled` (catalog files) or the quick-config store,
 * then the model is rebuilt from disk so what the panel shows is what the files hold.
 * Opening the panel never spends model tokens. Pure Node, no pi.
 */
import * as fs from "node:fs";
import { listLevels } from "./levels.ts";
import { type McpServerRow, listMcpServers, setMcpEnabled as toggleMcp, type McpToggleOptions } from "./mcp-toggle.ts";
import { applyQuickConfig, CONFIGS_DIR, listQuickConfigs, loadQuickConfig, type QuickConfigSummary, saveQuickConfig, snapshotCurrent, validateConfigName } from "./quick-configs.ts";
import {
	LEVEL_CYCLE,
	MONITOR_MODES,
	type MonitorMode,
	readStackSettings,
	STACK_DIR,
	STACK_SETTINGS_PATH,
	type StackSettings,
	type StackSettingsPatch,
	THINKING_LEVELS,
	WATCHDOG_ON_COMPACTION_MODES,
	type WatchdogOnCompaction,
	writeStackSettings,
} from "./stack-config.ts";

export type RowKind = "toggle" | "select" | "number" | "action" | "info";

export interface PanelRow {
	id: string;
	section: string;
	label: string;
	kind: RowKind;
	value?: unknown;
	options?: string[];
	min?: number;
	max?: number;
	step?: number;
	hint?: string;
}

export interface PanelSection {
	title: string;
	rows: PanelRow[];
}

export interface SettingsModel {
	sections: PanelSection[];
	/** Every row in display order (info rows included). */
	rows: PanelRow[];
	settings: StackSettings;
	servers: McpServerRow[];
	configs: QuickConfigSummary[];
	shapes: string[];
	levels: number[];
	note?: string;
	needsReload: boolean;
}

export interface PanelDeps {
	settingsPath?: string;
	cwd?: string;
	shapesDir?: string;
	configsDir?: string;
	/** Catalog override for tests (paths + env). */
	mcp?: McpToggleOptions;
	/** Where MCP toggles are written (default user). */
	mcpScope?: "user" | "project";
	/** Live shape/level loader (the host's loadShape/cycleLevel); absent → settings write only. */
	loadShape?(codename: string, level: number | null | undefined): unknown;
	/** Watchdog model choices (the host lists usable models); default: the current model only. */
	models?: string[];
	now?(): Date;
}

export interface ChangeOutcome {
	model: SettingsModel;
	note: string;
	needsReload?: boolean;
}

export interface KeyOutcome {
	cursor: number;
	model: SettingsModel;
	note?: string;
	close?: boolean;
	needsReload?: boolean;
	/** The host should ask for a config name, then call applyRowChange(model, "config:save", name). */
	prompt?: "config-name";
}

export const SHAPE_DRIVEN = "shape-driven";
export const FOOTER_HELP = "↑↓ move · space/enter toggle-or-edit · ←→ change · s save config · esc close";

const NAVIGABLE: RowKind[] = ["toggle", "select", "number", "action"];

export function listShapeCodenames(dir: string = STACK_DIR): string[] {
	try {
		return fs
			.readdirSync(dir)
			.filter((file) => /^model-stack-.+\.ya?ml$/.test(file))
			.map((file) => file.replace(/^model-stack-/, "").replace(/\.ya?ml$/, ""))
			.sort();
	} catch {
		return [];
	}
}

const levelLabel = (level: number | null | undefined): string => (level === null || level === undefined ? SHAPE_DRIVEN : String(level));

/** Build the model from disk: settings, the merged MCP catalog and the saved quick configs. */
export function buildSettingsModel(deps: PanelDeps = {}, note?: string, needsReload = false): SettingsModel {
	const settingsPath = deps.settingsPath ?? STACK_SETTINGS_PATH;
	const settings = readStackSettings(settingsPath);
	const shapes = listShapeCodenames(deps.shapesDir ?? STACK_DIR);
	const levels = listLevels(deps.shapesDir ?? STACK_DIR);
	let servers: McpServerRow[] = [];
	try {
		servers = listMcpServers({ ...(deps.mcp ?? {}), cwd: deps.cwd ?? deps.mcp?.cwd });
	} catch {
		servers = [];
	}
	const configs = listQuickConfigs(deps.configsDir ?? CONFIGS_DIR);
	const levelOptions = [SHAPE_DRIVEN, ...(levels.length ? levels : LEVEL_CYCLE).map(String)];
	const shapeOptions = shapes.length ? shapes : [settings.shape];
	const models = [...new Set([settings.watchdog.model, ...(deps.models ?? [])])];
	const sections: PanelSection[] = [
		{
			title: "Harness",
			rows: [
				{ id: "harnessLevel", section: "Harness", label: "level", kind: "select", value: levelLabel(settings.harnessLevel), options: levelOptions, hint: "0 ultrafast · 1 brain+workers · 2 triggered ops · 3 engineering" },
				{ id: "shape", section: "Harness", label: "shape", kind: "select", value: settings.shape, options: shapeOptions, hint: "model-stack-<codename>.yaml" },
				{ id: "builderFanOut", section: "Harness", label: "builders", kind: "number", value: settings.builderFanOut, min: 1, max: 8, step: 1, hint: "pool size" },
				{ id: "workerFanOut", section: "Harness", label: "workers", kind: "number", value: settings.workerFanOut, min: 0, max: 16, step: 1 },
				{ id: "watchdogFanOut", section: "Harness", label: "watchdogs", kind: "number", value: settings.watchdogFanOut, min: 0, max: 16, step: 1 },
				{ id: "verifierFanOut", section: "Harness", label: "verifiers", kind: "number", value: settings.verifierFanOut, min: 0, max: 16, step: 1 },
				{ id: "exaFanOut", section: "Harness", label: "exa lanes", kind: "number", value: settings.exaFanOut, min: 0, max: 16, step: 1 },
				{ id: "childExa", section: "Harness", label: "exa in children", kind: "toggle", value: settings.childExa },
				{ id: "subagentFanOut", section: "Harness", label: "subagents per child", kind: "number", value: settings.subagentFanOut, min: 0, max: 16, step: 1 },
				{ id: "maxConcurrentChildren", section: "Harness", label: "concurrent children", kind: "number", value: settings.maxConcurrentChildren, min: 1, max: 16, step: 1, hint: "the one concurrency cap" },
				{ id: "budgetUsd", section: "Harness", label: "budget $", kind: "number", value: settings.budgetUsd ?? 0, min: 0, max: 10_000, step: 5, hint: "0 = no budget" },
			],
		},
		{
			title: "Watchdog",
			rows: [
				{ id: "watchdog.enabled", section: "Watchdog", label: "enabled", kind: "toggle", value: settings.watchdog.enabled },
				{ id: "watchdog.model", section: "Watchdog", label: "model", kind: "select", value: settings.watchdog.model, options: models },
				{ id: "watchdog.thinking", section: "Watchdog", label: "thinking", kind: "select", value: settings.watchdog.thinking, options: [...THINKING_LEVELS] },
				{ id: "watchdog.onCompaction", section: "Watchdog", label: "on compaction", kind: "select", value: settings.watchdog.onCompaction, options: [...WATCHDOG_ON_COMPACTION_MODES] },
				{ id: "watchdog.stalemateRepeats", section: "Watchdog", label: "stalemate repeats", kind: "number", value: settings.watchdog.stalemateRepeats, min: 1, max: 10, step: 1 },
			],
		},
		{
			title: "Monitor",
			rows: [{ id: "monitor.mode", section: "Monitor", label: "mode", kind: "select", value: settings.monitor.mode, options: [...MONITOR_MODES] }],
		},
		{
			title: "Review",
			rows: [
				{ id: "auditor", section: "Review", label: "auditors", kind: "toggle", value: settings.auditor },
				{ id: "anonymize", section: "Review", label: "anonymize (callsigns only)", kind: "toggle", value: settings.anonymize },
				{ id: "auditRounds", section: "Review", label: "audit rounds", kind: "number", value: settings.auditRounds, min: 1, max: 3, step: 1 },
			],
		},
		{
			title: "Bar",
			rows: [{ id: "modelBar", section: "Bar", label: "model bar", kind: "toggle", value: settings.modelBar }],
		},
		{
			title: "MCP servers",
			rows: servers.length
				? servers.map((row) => ({
						id: `mcp:${row.name}`,
						section: "MCP servers",
						label: row.name,
						kind: "toggle" as RowKind,
						value: row.enabled,
						hint: `${row.source}${row.enabled ? "" : ` · ${row.reason ?? "disabled"}`}`,
					}))
				: [{ id: "mcp:none", section: "MCP servers", label: "no servers in the catalog", kind: "info" as RowKind }],
		},
		{
			title: "Quick configs",
			rows: [
				{ id: "config:save", section: "Quick configs", label: "save current as…", kind: "action", hint: "s" },
				...(configs.length
					? configs.map((cfg) => ({ id: `config:apply:${cfg.name}`, section: "Quick configs", label: `apply ${cfg.name}`, kind: "action" as RowKind, hint: `${cfg.shape ?? "?"}${cfg.level !== null && cfg.level !== undefined ? ` · L${cfg.level}` : ""}${cfg.mcpCount ? ` · ${cfg.mcpCount} mcp` : ""} · ${cfg.savedAt.slice(0, 16)}` }))
					: [{ id: "config:none", section: "Quick configs", label: "none saved yet", kind: "info" as RowKind }]),
			],
		},
	];
	return { sections, rows: sections.flatMap((section) => section.rows), settings, servers, configs, shapes, levels, note, needsReload };
}

export const navigableRows = (model: SettingsModel): number[] => model.rows.map((row, index) => (NAVIGABLE.includes(row.kind) ? index : -1)).filter((index) => index >= 0);

const patchFor = (rowId: string, value: unknown): StackSettingsPatch | undefined => {
	switch (rowId) {
		case "builderFanOut":
		case "workerFanOut":
		case "watchdogFanOut":
		case "verifierFanOut":
		case "exaFanOut":
		case "subagentFanOut":
		case "maxConcurrentChildren":
		case "auditRounds":
			return { [rowId]: Number(value) } as StackSettingsPatch;
		case "childExa":
		case "auditor":
		case "anonymize":
		case "modelBar":
			return { [rowId]: Boolean(value) } as StackSettingsPatch;
		case "budgetUsd":
			return { budgetUsd: Number(value) > 0 ? Number(value) : null };
		case "watchdog.enabled":
			return { watchdog: { enabled: Boolean(value) } };
		case "watchdog.model":
			return { watchdog: { model: String(value) } };
		case "watchdog.thinking":
			return { watchdog: { thinking: String(value) } };
		case "watchdog.onCompaction":
			return { watchdog: { onCompaction: String(value) as WatchdogOnCompaction } };
		case "watchdog.stalemateRepeats":
			return { watchdog: { stalemateRepeats: Number(value) } };
		case "monitor.mode":
			return { monitor: { mode: String(value) as MonitorMode } };
		default:
			return undefined;
	}
};

/** Apply one row's new value: settings, shape/level, MCP toggle or quick-config action. Returns the rebuilt model. */
export async function applyRowChange(model: SettingsModel, rowId: string, value: unknown, deps: PanelDeps = {}): Promise<ChangeOutcome> {
	const settingsPath = deps.settingsPath ?? STACK_SETTINGS_PATH;
	const configsDir = deps.configsDir ?? CONFIGS_DIR;
	const rebuild = (note: string, needsReload = false) => ({ model: buildSettingsModel(deps, note, needsReload || model.needsReload), note, needsReload: needsReload || model.needsReload || undefined });
	if (rowId === "harnessLevel") {
		const label = String(value);
		if (label === SHAPE_DRIVEN) {
			writeStackSettings({ harnessLevel: null }, settingsPath);
			return rebuild("level: shape-driven (the shape alone decides)");
		}
		const level = Number(label);
		if (!LEVEL_CYCLE.includes(level)) return rebuild(`level ${label} is not one of ${LEVEL_CYCLE.join(", ")}`);
		if (deps.loadShape) {
			try {
				await deps.loadShape(`level-${level}`, level);
				return rebuild(`level ${level} applied`);
			} catch (error) {
				return rebuild(`level ${level}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		writeStackSettings({ harnessLevel: level, shape: `level-${level}` }, settingsPath);
		return rebuild(`level ${level} written (takes effect on the next shape load)`);
	}
	if (rowId === "shape") {
		const codename = String(value);
		if (deps.loadShape) {
			try {
				await deps.loadShape(codename, null);
				return rebuild(`shape ${codename} loaded`);
			} catch (error) {
				return rebuild(`shape ${codename}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		writeStackSettings({ shape: codename, harnessLevel: null }, settingsPath);
		return rebuild(`shape ${codename} written`);
	}
	if (rowId.startsWith("mcp:")) {
		const name = rowId.slice(4);
		if (name === "none") return rebuild("no MCP servers to toggle");
		try {
			const result = toggleMcp(name, Boolean(value), { ...(deps.mcp ?? {}), cwd: deps.cwd ?? deps.mcp?.cwd, scope: deps.mcpScope ?? deps.mcp?.scope ?? "user" });
			return rebuild(`mcp ${name} ${result.enabled ? "enabled" : "disabled"} in ${result.layer} config${result.created ? " (entry created)" : ""} — /reload to apply`, true);
		} catch (error) {
			return rebuild(`mcp ${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (rowId === "config:save") {
		let name: string;
		try {
			name = validateConfigName(String(value ?? ""));
		} catch (error) {
			return rebuild(error instanceof Error ? error.message : String(error));
		}
		const snapshot = snapshotCurrent({ settings: readStackSettings(settingsPath), mcpServers: model.servers.map((row) => ({ name: row.name, enabled: row.enabled })) }, name, deps.now?.());
		const file = saveQuickConfig(snapshot, configsDir);
		return rebuild(`saved quick config ${name} → ${file}`);
	}
	if (rowId.startsWith("config:apply:")) {
		const name = rowId.slice("config:apply:".length);
		try {
			const { config, dropped } = loadQuickConfig(name, configsDir);
			const outcome = await applyQuickConfig(config, {
				writeSettings: (patch) => writeStackSettings(patch, settingsPath),
				setMcpEnabled: (server, enabled) => toggleMcp(server, enabled, { ...(deps.mcp ?? {}), cwd: deps.cwd ?? deps.mcp?.cwd, scope: deps.mcpScope ?? deps.mcp?.scope ?? "user" }),
				loadShape: deps.loadShape,
			});
			const parts = [`applied ${name}: ${outcome.applied.join(", ")}`];
			if (outcome.skipped.length) parts.push(`skipped: ${outcome.skipped.join("; ")}`);
			if (dropped.length) parts.push(`ignored keys: ${dropped.join(", ")}`);
			if (outcome.needsReload) parts.push("/reload to apply the MCP changes");
			return rebuild(parts.join(" · "), outcome.needsReload);
		} catch (error) {
			return rebuild(`apply ${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const patch = patchFor(rowId, value);
	if (!patch) return rebuild(`unknown setting ${rowId}`);
	writeStackSettings(patch, settingsPath);
	const row = model.rows.find((candidate) => candidate.id === rowId);
	return rebuild(`${row?.label ?? rowId} → ${rowId === "budgetUsd" && Number(value) <= 0 ? "off" : String(value)}`);
}


const nextOption = (row: PanelRow, direction: 1 | -1): string => {
	const options = row.options ?? [];
	if (!options.length) return String(row.value ?? "");
	const index = options.indexOf(String(row.value));
	return options[(index + direction + options.length) % options.length];
};

const steppedNumber = (row: PanelRow, direction: 1 | -1): number => {
	const step = row.step ?? 1;
	const next = Number(row.value ?? 0) + direction * step;
	return Math.min(row.max ?? Number.POSITIVE_INFINITY, Math.max(row.min ?? Number.NEGATIVE_INFINITY, next));
};

/** Keys: up/down move, space/return toggle-or-advance, left/right change, s save config (prompt), escape close. */
export async function handleSettingsKey(model: SettingsModel, cursor: number, key: string, deps: PanelDeps = {}): Promise<KeyOutcome> {
	const nav = navigableRows(model);
	if (!nav.length) return { cursor: 0, model, close: key === "escape" };
	const position = Math.max(0, nav.indexOf(cursor));
	const rowIndex = nav[position];
	const row = model.rows[rowIndex];
	switch (key) {
		case "up":
			return { cursor: nav[(position - 1 + nav.length) % nav.length], model };
		case "down":
			return { cursor: nav[(position + 1) % nav.length], model };
		case "escape":
			return { cursor: rowIndex, model, close: true };
		case "s":
			return { cursor: rowIndex, model, prompt: "config-name", note: "name for the quick config?" };
		case "space":
		case "return":
		case "right":
		case "left": {
			const direction: 1 | -1 = key === "left" ? -1 : 1;
			if (row.kind === "toggle") {
				const outcome = await applyRowChange(model, row.id, !row.value, deps);
				return { cursor: rowIndex, model: outcome.model, note: outcome.note, needsReload: outcome.needsReload };
			}
			if (row.kind === "select") {
				const outcome = await applyRowChange(model, row.id, nextOption(row, direction), deps);
				return { cursor: rowIndex, model: outcome.model, note: outcome.note, needsReload: outcome.needsReload };
			}
			if (row.kind === "number") {
				const outcome = await applyRowChange(model, row.id, steppedNumber(row, direction), deps);
				return { cursor: rowIndex, model: outcome.model, note: outcome.note, needsReload: outcome.needsReload };
			}
			if (row.kind === "action") {
				if (row.id === "config:save") return { cursor: rowIndex, model, prompt: "config-name", note: "name for the quick config?" };
				if (key === "left" || key === "right") return { cursor: rowIndex, model };
				const outcome = await applyRowChange(model, row.id, undefined, deps);
				return { cursor: rowIndex, model: outcome.model, note: outcome.note, needsReload: outcome.needsReload };
			}
			return { cursor: rowIndex, model };
		}
		default:
			return { cursor: rowIndex, model };
	}
}

export type PanelColorRole = "title" | "header" | "cursor" | "on" | "off" | "hint" | "footer" | "note" | "reload";

export interface RenderOptions {
	width: number;
	height: number;
	cursor: number;
	color?: (role: PanelColorRole, text: string) => string;
}

const identity = (_role: PanelColorRole, text: string) => text;

const fit = (text: string, width: number): string => {
	const chars = [...text];
	return chars.length <= width ? text : `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
};

/** Render the panel: title, sections, rows with a cursor marker, then a note line and the footer. Never wider than `width` or taller than `height`. */
export function renderSettingsPanel(model: SettingsModel, opts: RenderOptions): string[] {
	const paint = opts.color ?? identity;
	const width = Math.max(20, Math.floor(opts.width));
	const height = Math.max(6, Math.floor(opts.height));
	const body: Array<{ text: string; rowIndex?: number }> = [];
	for (const section of model.sections) {
		body.push({ text: paint("header", fit(`── ${section.title} ${"─".repeat(Math.max(0, width - section.title.length - 4))}`, width)) });
		for (const row of section.rows) {
			const rowIndex = model.rows.indexOf(row);
			const marker = rowIndex === opts.cursor ? "›" : " ";
			let text: string;
			if (row.kind === "toggle") text = `${row.value ? paint("on", "[x]") : paint("off", "[ ]")} ${row.label}`;
			else if (row.kind === "select") text = `${row.label}  ‹ ${String(row.value)} ›`;
			else if (row.kind === "number") text = `${row.label}  ‹ ${row.id === "budgetUsd" && Number(row.value) <= 0 ? "off" : String(row.value)} ›`;
			else if (row.kind === "action") text = `▸ ${row.label}`;
			else text = paint("hint", row.label);
			const hint = row.hint ? paint("hint", `  ${row.hint}`) : "";
			const line = ` ${rowIndex === opts.cursor ? paint("cursor", marker) : marker} ${text}${hint}`;
			body.push({ text: fit(line, width), rowIndex });
		}
	}
	const title = paint("title", fit(`⚙ titan settings${model.needsReload ? paint("reload", " · /reload pending") : ""}`, width));
	const footerLines = [model.note ? paint("note", fit(` ${model.note}`, width)) : undefined, paint("footer", fit(FOOTER_HELP, width))].filter((line): line is string => !!line);
	const available = Math.max(1, height - 1 - footerLines.length);
	// Scroll so the cursor row is visible.
	const cursorLine = body.findIndex((line) => line.rowIndex === opts.cursor);
	let start = 0;
	if (cursorLine >= available) start = cursorLine - available + 1;
	const visible = body.slice(start, start + available).map((line) => line.text);
	return [title, ...visible, ...footerLines];
}

/** A text summary of the model for /titan-config show (no colours). */
export function formatSettingsSummary(model: SettingsModel): string {
	const lines: string[] = [];
	for (const section of model.sections) {
		lines.push(`${section.title}:`);
		for (const row of section.rows) {
			if (row.kind === "info") lines.push(`  ${row.label}`);
			else if (row.kind === "toggle") lines.push(`  ${row.label}: ${row.value ? "on" : "off"}${row.hint ? ` (${row.hint})` : ""}`);
			else if (row.kind === "action") continue;
			else lines.push(`  ${row.label}: ${row.id === "budgetUsd" && Number(row.value) <= 0 ? "off" : String(row.value)}`);
		}
	}
	return lines.join("\n");
}
