/**
 * quick-configs.ts — named harness presets ("quick configs", PRD v0.9 R4).
 *
 * A quick config is one JSON file under ~/.pi/titan-harness/configs/<name>.json:
 *
 *   { name, savedAt, note?, settings: StackSettingsPatch, shape?, level?, mcp?: { <server>: enabled } }
 *
 * `settings` carries only the operator-facing keys (pools, caps, budget, review, watchdog,
 * monitor, bar); the run store root, the schedule state, the level snapshot and the one-time
 * hint flag are never captured. Applying a config writes the settings through the caller's
 * writer, reloads the shape/level through the caller's loader when one is given, and toggles
 * MCP servers through the caller's toggle (each toggle asks for a /reload). Files are written
 * atomically with mode 0600 in a 0700 directory. Pure Node, no pi.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CHILD_SUBAGENT_MODES,
	LEVEL_CYCLE,
	MONITOR_MODES,
	type StackSettings,
	type StackSettingsPatch,
	THINKING_LEVELS,
	WATCHDOG_ON_COMPACTION_MODES,
} from "./stack-config.ts";

export const CONFIGS_DIR = path.join(os.homedir(), ".pi", "titan-harness", "configs");
export const CONFIG_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export interface QuickConfig {
	name: string;
	savedAt: string;
	note?: string;
	settings: StackSettingsPatch;
	shape?: string;
	level?: number | null;
	mcp?: Record<string, boolean>;
}

export interface QuickConfigSummary {
	name: string;
	savedAt: string;
	path: string;
	shape?: string;
	level?: number | null;
	mcpCount: number;
	note?: string;
}

export interface SnapshotInput {
	settings: StackSettings;
	mcpServers?: Array<{ name: string; enabled: boolean }>;
	note?: string;
}

export interface ApplyDeps {
	writeSettings(patch: StackSettingsPatch): unknown;
	/** Toggle one catalog server (the mcp-toggle module); absent → mcp entries are reported, not applied. */
	setMcpEnabled?(server: string, enabled: boolean): unknown;
	/** Load a shape (and level) live; absent → the settings write alone carries shape/harnessLevel. */
	loadShape?(codename: string, level: number | null | undefined): unknown;
}

export interface ApplyOutcome {
	applied: string[];
	skipped: string[];
	needsReload: boolean;
}

/** The operator-facing keys a quick config captures (everything else in StackSettings is runtime state). */
export const CAPTURED_KEYS = [
	"subagentTools",
	"childSubagents",
	"childExa",
	"subagentModel",
	"subagentThinking",
	"subagentFanOut",
	"shape",
	"builderFanOut",
	"auditor",
	"auditorModel",
	"auditorThinking",
	"auditRounds",
	"anonymize",
	"modelBar",
	"harnessLevel",
	"workerFanOut",
	"watchdogFanOut",
	"verifierFanOut",
	"exaFanOut",
	"maxConcurrentChildren",
	"budgetUsd",
] as const;

export function validateConfigName(name: string): string {
	const trimmed = (name ?? "").trim();
	if (!CONFIG_NAME_RE.test(trimmed)) throw new Error(`titan-harness: config name must match ${CONFIG_NAME_RE} (got ${JSON.stringify(name)})`);
	return trimmed;
}

export function configPath(name: string, dir: string = CONFIGS_DIR): string {
	return path.join(dir, `${validateConfigName(name)}.json`);
}

/** Capture the current settings (whitelisted keys), shape, level and the MCP enabled map. */
export function snapshotCurrent(input: SnapshotInput, name: string, now: Date = new Date()): QuickConfig {
	const s = input.settings;
	const settings: StackSettingsPatch = {};
	for (const key of CAPTURED_KEYS) (settings as Record<string, unknown>)[key] = s[key];
	settings.watchdog = { ...s.watchdog };
	settings.monitor = { ...s.monitor };
	const cfg: QuickConfig = { name: validateConfigName(name), savedAt: now.toISOString(), settings, shape: s.shape, level: s.harnessLevel };
	if (input.note?.trim()) cfg.note = input.note.trim();
	if (input.mcpServers?.length) cfg.mcp = Object.fromEntries(input.mcpServers.map((row) => [row.name, row.enabled]));
	return cfg;
}

const clampInt = (value: unknown, lo: number, hi: number): number | undefined => {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.min(hi, Math.max(lo, Math.round(value)));
};

/** Keep only well-typed, known settings keys (a hand-edited file never smuggles in surprises). */
export function sanitizeSettingsPatch(raw: unknown): { settings: StackSettingsPatch; dropped: string[] } {
	const dropped: string[] = [];
	const settings: StackSettingsPatch = {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { settings, dropped: ["settings"] };
	const r = raw as Record<string, unknown>;
	const bool = (key: keyof StackSettingsPatch) => {
		if (typeof r[key] === "boolean") (settings as Record<string, unknown>)[key] = r[key];
		else if (r[key] !== undefined) dropped.push(key);
	};
	const num = (key: keyof StackSettingsPatch, lo: number, hi: number) => {
		const value = clampInt(r[key], lo, hi);
		if (value !== undefined) (settings as Record<string, unknown>)[key] = value;
		else if (r[key] !== undefined) dropped.push(key);
	};
	const oneOf = (key: keyof StackSettingsPatch, options: readonly string[]) => {
		if (typeof r[key] === "string" && options.includes(r[key] as string)) (settings as Record<string, unknown>)[key] = r[key];
		else if (r[key] !== undefined) dropped.push(key);
	};
	const model = (key: keyof StackSettingsPatch, allowAuto = false) => {
		if (typeof r[key] === "string" && ((allowAuto && r[key] === "auto") || (r[key] as string).includes("/"))) (settings as Record<string, unknown>)[key] = r[key];
		else if (r[key] !== undefined) dropped.push(key);
	};
	bool("subagentTools");
	oneOf("childSubagents", CHILD_SUBAGENT_MODES);
	bool("childExa");
	model("subagentModel");
	oneOf("subagentThinking", THINKING_LEVELS);
	num("subagentFanOut", 0, 16);
	if (typeof r.shape === "string" && r.shape.trim()) settings.shape = r.shape.trim();
	else if (r.shape !== undefined) dropped.push("shape");
	num("builderFanOut", 1, 8);
	bool("auditor");
	model("auditorModel", true);
	oneOf("auditorThinking", THINKING_LEVELS);
	num("auditRounds", 1, 3);
	bool("anonymize");
	bool("modelBar");
	if (r.harnessLevel === null) settings.harnessLevel = null;
	else if (typeof r.harnessLevel === "number" && LEVEL_CYCLE.includes(r.harnessLevel)) settings.harnessLevel = r.harnessLevel;
	else if (r.harnessLevel !== undefined) dropped.push("harnessLevel");
	num("workerFanOut", 0, 16);
	num("watchdogFanOut", 0, 16);
	num("verifierFanOut", 0, 16);
	num("exaFanOut", 0, 16);
	num("maxConcurrentChildren", 1, 16);
	if (r.budgetUsd === null) settings.budgetUsd = null;
	else if (typeof r.budgetUsd === "number" && Number.isFinite(r.budgetUsd) && r.budgetUsd >= 0) settings.budgetUsd = r.budgetUsd;
	else if (r.budgetUsd !== undefined) dropped.push("budgetUsd");
	if (r.watchdog && typeof r.watchdog === "object" && !Array.isArray(r.watchdog)) {
		const w = r.watchdog as Record<string, unknown>;
		const watchdog: NonNullable<StackSettingsPatch["watchdog"]> = {};
		if (typeof w.enabled === "boolean") watchdog.enabled = w.enabled;
		if (typeof w.model === "string" && w.model.includes("/")) watchdog.model = w.model;
		if (typeof w.thinking === "string" && THINKING_LEVELS.includes(w.thinking)) watchdog.thinking = w.thinking;
		const repeats = clampInt(w.stalemateRepeats, 1, 10);
		if (repeats !== undefined) watchdog.stalemateRepeats = repeats;
		if (typeof w.onCompaction === "string" && (WATCHDOG_ON_COMPACTION_MODES as string[]).includes(w.onCompaction)) watchdog.onCompaction = w.onCompaction as (typeof WATCHDOG_ON_COMPACTION_MODES)[number];
		const timeout = clampInt(w.inspectorTimeoutMs, 1_000, 600_000);
		if (timeout !== undefined) watchdog.inspectorTimeoutMs = timeout;
		if (typeof w.preemptAtContextFraction === "number" && w.preemptAtContextFraction > 0 && w.preemptAtContextFraction <= 1) watchdog.preemptAtContextFraction = w.preemptAtContextFraction;
		if (Object.keys(watchdog).length) settings.watchdog = watchdog;
	} else if (r.watchdog !== undefined) dropped.push("watchdog");
	if (r.monitor && typeof r.monitor === "object" && !Array.isArray(r.monitor)) {
		const mode = (r.monitor as Record<string, unknown>).mode;
		if (typeof mode === "string" && (MONITOR_MODES as string[]).includes(mode)) settings.monitor = { mode: mode as (typeof MONITOR_MODES)[number] };
		else dropped.push("monitor.mode");
	} else if (r.monitor !== undefined) dropped.push("monitor");
	for (const key of Object.keys(r)) {
		if (!(CAPTURED_KEYS as readonly string[]).includes(key) && key !== "watchdog" && key !== "monitor") dropped.push(key);
	}
	return { settings, dropped: [...new Set(dropped)] };
}

/** Parse a config file's JSON; unknown or ill-typed keys are dropped (returned in `dropped`), never applied. */
export function parseQuickConfig(raw: unknown, fallbackName?: string): { config: QuickConfig; dropped: string[] } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("titan-harness: quick config must be a JSON object");
	const r = raw as Record<string, unknown>;
	const name = validateConfigName(typeof r.name === "string" ? r.name : (fallbackName ?? ""));
	const { settings, dropped } = sanitizeSettingsPatch(r.settings ?? {});
	const config: QuickConfig = { name, savedAt: typeof r.savedAt === "string" ? r.savedAt : new Date(0).toISOString(), settings };
	if (typeof r.note === "string" && r.note.trim()) config.note = r.note.trim();
	if (typeof r.shape === "string" && r.shape.trim()) config.shape = r.shape.trim();
	if (r.level === null || (typeof r.level === "number" && LEVEL_CYCLE.includes(r.level))) config.level = r.level as number | null;
	if (r.mcp && typeof r.mcp === "object" && !Array.isArray(r.mcp)) {
		const mcp: Record<string, boolean> = {};
		for (const [server, enabled] of Object.entries(r.mcp as Record<string, unknown>)) {
			if (typeof enabled === "boolean" && /^[A-Za-z0-9_.-]+$/.test(server)) mcp[server] = enabled;
			else dropped.push(`mcp.${server}`);
		}
		config.mcp = mcp;
	}
	return { config, dropped };
}

/** Write <dir>/<name>.json atomically (0600, dir 0700). Returns the path. */
export function saveQuickConfig(cfg: QuickConfig, dir: string = CONFIGS_DIR): string {
	const file = configPath(cfg.name, dir);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify({ ...cfg, name: validateConfigName(cfg.name) }, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
	return file;
}

export function listQuickConfigs(dir: string = CONFIGS_DIR): QuickConfigSummary[] {
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
	} catch {
		return [];
	}
	const rows: QuickConfigSummary[] = [];
	for (const file of entries.sort()) {
		try {
			const { config } = parseQuickConfig(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")), file.replace(/\.json$/, ""));
			rows.push({ name: config.name, savedAt: config.savedAt, path: path.join(dir, file), shape: config.shape, level: config.level, mcpCount: Object.keys(config.mcp ?? {}).length, note: config.note });
		} catch {
			/* a malformed file is skipped, never applied */
		}
	}
	return rows;
}

export function loadQuickConfig(name: string, dir: string = CONFIGS_DIR): { config: QuickConfig; dropped: string[]; path: string } {
	const file = configPath(name, dir);
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		throw new Error(`titan-harness: no quick config named ${JSON.stringify(name)} in ${dir}`);
	}
	const parsed = parseQuickConfig(JSON.parse(text), validateConfigName(name));
	return { ...parsed, path: file };
}

export function deleteQuickConfig(name: string, dir: string = CONFIGS_DIR): boolean {
	const file = configPath(name, dir);
	try {
		fs.unlinkSync(file);
		return true;
	} catch {
		return false;
	}
}

/** Apply a config: settings first, then the shape/level loader, then MCP toggles. Never throws on a toggle failure. */
export async function applyQuickConfig(cfg: QuickConfig, deps: ApplyDeps): Promise<ApplyOutcome> {
	const applied: string[] = [];
	const skipped: string[] = [];
	let needsReload = false;
	const patch: StackSettingsPatch = { ...cfg.settings };
	if (cfg.shape) patch.shape = cfg.shape;
	if (cfg.level !== undefined) patch.harnessLevel = cfg.level;
	deps.writeSettings(patch);
	applied.push(`settings (${Object.keys(patch).length} keys)`);
	if (cfg.shape) {
		if (deps.loadShape) {
			try {
				await deps.loadShape(cfg.shape, cfg.level);
				applied.push(`shape ${cfg.shape}${cfg.level !== undefined && cfg.level !== null ? ` (level ${cfg.level})` : ""}`);
			} catch (error) {
				skipped.push(`shape ${cfg.shape}: ${error instanceof Error ? error.message : String(error)}`);
			}
		} else skipped.push(`shape ${cfg.shape} (settings written; no live loader)`);
	}
	for (const [server, enabled] of Object.entries(cfg.mcp ?? {})) {
		if (!deps.setMcpEnabled) {
			skipped.push(`mcp ${server} (no toggle available)`);
			continue;
		}
		try {
			await deps.setMcpEnabled(server, enabled);
			applied.push(`mcp ${server} ${enabled ? "on" : "off"}`);
			needsReload = true;
		} catch (error) {
			skipped.push(`mcp ${server}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { applied, skipped, needsReload };
}
