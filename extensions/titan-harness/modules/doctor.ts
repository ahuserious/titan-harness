/**
 * doctor.ts — `/titan-doctor`: the operator gate behind every "runnable today" claim.
 *
 * One report, no model calls: which models the harness can actually run on this
 * machine (catalog + configured auth), which optional tools are on PATH, which
 * credential names exist (values are never read into the report), whether the
 * shift+tab rebind has been made, whether the pinned companion packages match and
 * the dynamic-workflows patch is applied, and the P0 decisions the plan records
 * (store root, concurrency cap, budget, monitor mode, watchdog default).
 *
 * `importInfranodusKey` is the one write path: it copies an existing InfraNodus key
 * into the user-level MCP config so pi-mcp-adapter can start the server. The value is
 * copied file-to-file and never returned or printed. The command handler confirms
 * with the user before calling it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readStackSettings } from "./stack-config.ts";

export type DoctorStatus = "ready" | "vacant" | "warn" | "unknown";

export interface DoctorItem {
	group: "models" | "tools" | "credentials" | "keys" | "pins" | "decisions" | "store";
	key: string;
	label: string;
	status: DoctorStatus;
	detail: string;
	action?: string;
}

export interface DoctorReport {
	generatedAt: string;
	items: DoctorItem[];
	summary: { ready: number; vacant: number; warn: number; unknown: number };
}

/** The models the level shapes and the fusion team name, with the operator action that unblocks each. */
export const DOCTOR_MODELS: Array<{ model: string; purpose: string; action: string }> = [
	{ model: "openai-codex/gpt-6-astra", purpose: "level 2/3 architect, /create-workflow default", action: "/login openai-codex" },
	{ model: "anthropic/claude-fable-5-1", purpose: "level 3 builders, fusion seat 1, fuser", action: "add Anthropic credentials to Pi (API key or Pi login) or an OpenRouter key" },
	{ model: "openrouter/meta/muse-spark-1.3", purpose: "fusion seat 4", action: "set OPENROUTER_API_KEY for Pi" },
	{ model: "xai/grok-4.6", purpose: "level 2 builders, level 3 verifiers, fusion seat 2, fallback architect", action: "/login xai" },
	{ model: "antigravity/gemini-3.8-flash", purpose: "level 1 architect, workers, judge, fusion seat 3", action: "/login antigravity" },
	{ model: "antigravity/claude-opus-4-6", purpose: "fallback for Fable slots, cross-family auditor", action: "/login antigravity" },
	{ model: "cerebras/qwen-3.8-27b", purpose: "level 0/1 architect and workers, watchdogs, exa lanes", action: "/login cerebras" },
];

/** Optional tools the verification lanes shell out to; absence is a vacancy, never an error. */
export const DOCTOR_TOOLS: Array<{ tool: string; purpose: string; action: string }> = [
	{ tool: "kane-cli", purpose: "simulated-user runs, evidence packs", action: "npm i -g @testmuai/kane-cli && kane-cli login" },
	{ tool: "orca", purpose: "monitor split pane, local browser driver", action: "install Orca CLI" },
	{ tool: "tmux", purpose: "monitor split fallback", action: "install tmux" },
	{ tool: "ffmpeg", purpose: "video evidence from screenshot sequences", action: "install ffmpeg" },
	{ tool: "uvx", purpose: "Python mcp2cli named links", action: "install uv" },
	{ tool: "gh", purpose: "terraform GitHub connector", action: "install gh" },
];

/** Credential NAMES the plan references; only presence is reported. */
export const DOCTOR_ENV_NAMES = ["INFRANODUS_API_KEY", "CURSOR_API_KEY", "MOMENTIC_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"];

export const USER_MCP_CONFIG_PATH = path.join(os.homedir(), ".config", "mcp", "mcp.json");
export const KEYBINDINGS_PATH = path.join(os.homedir(), ".pi", "agent", "keybindings.json");

function commandOnPath(name: string): string | undefined {
	const entries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	for (const dir of entries) {
		const candidate = path.join(dir, name);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			/* not here */
		}
	}
	return undefined;
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** Is `app.thinking.cycle` mapped away from shift+tab (so titan may bind it)? */
export function shiftTabFree(keybindingsPath = KEYBINDINGS_PATH): { free: boolean; detail: string } {
	const config = readJson(keybindingsPath);
	if (!config) return { free: false, detail: "no keybindings.json — Pi keeps shift+tab for app.thinking.cycle" };
	const value = config["app.thinking.cycle"];
	if (value === undefined) return { free: false, detail: "app.thinking.cycle not rebound — Pi keeps shift+tab" };
	const keys = Array.isArray(value) ? value.map(String) : [String(value)];
	const stillShiftTab = keys.some((key) => key.trim().toLowerCase() === "shift+tab");
	return stillShiftTab ? { free: false, detail: "app.thinking.cycle still includes shift+tab" } : { free: true, detail: `app.thinking.cycle → ${keys.length ? keys.join(", ") : "disabled"}` };
}

/** Does the user-level MCP config carry a keyed, enabled infranodus server? */
export function infranodusConfigured(userConfig = USER_MCP_CONFIG_PATH): { configured: boolean; detail: string } {
	const config = readJson(userConfig);
	const servers = config?.mcpServers as Record<string, any> | undefined;
	const entry = servers?.infranodus;
	if (!entry) return { configured: false, detail: "no infranodus entry in the user MCP config (package catalog entry ships disabled)" };
	const key = entry?.env?.INFRANODUS_API_KEY;
	const keyed = typeof key === "string" && key.trim().length > 0 && !key.includes("${");
	if (!keyed) return { configured: false, detail: "infranodus entry has no key" };
	if (entry.disabled === true) return { configured: false, detail: "infranodus entry is disabled" };
	return { configured: true, detail: "infranodus keyed and enabled in the user MCP config" };
}

/** Candidate sources for an existing InfraNodus key; only the first hit is used. */
function findInfranodusKey(): { value: string; source: string } | undefined {
	const fromEnv = process.env.INFRANODUS_API_KEY?.trim();
	if (fromEnv) return { value: fromEnv, source: "environment" };
	const serverEnv = path.join(os.homedir(), "Dev Tools", "mcp", "mcp-server-infranodus", ".env");
	try {
		const text = fs.readFileSync(serverEnv, "utf8");
		const match = text.match(/^\s*INFRANODUS_API_KEY\s*=\s*["']?([^"'\n\r]+)["']?\s*$/m);
		if (match?.[1]?.trim()) return { value: match[1].trim(), source: "mcp-server-infranodus/.env" };
	} catch {
		/* no server .env */
	}
	const claude = readJson(path.join(os.homedir(), ".claude.json"));
	const claudeKey = (claude?.mcpServers as any)?.infranodus?.env?.INFRANODUS_API_KEY;
	if (typeof claudeKey === "string" && claudeKey.trim() && !claudeKey.includes("${")) return { value: claudeKey.trim(), source: "~/.claude.json" };
	return undefined;
}

/**
 * Copy an existing InfraNodus key into the user MCP config's infranodus entry
 * (creating the entry from the package catalog shape). Never returns the value.
 */
export function importInfranodusKey(userConfig = USER_MCP_CONFIG_PATH): { ok: boolean; message: string; source?: string } {
	const found = findInfranodusKey();
	if (!found) {
		return {
			ok: false,
			message: `No InfraNodus key found in the environment, mcp-server-infranodus/.env or ~/.claude.json. Get one at https://infranodus.com/api-access and add it to ${userConfig} under mcpServers.infranodus.env.INFRANODUS_API_KEY (or export INFRANODUS_API_KEY before launching pi).`,
		};
	}
	const config = readJson(userConfig) ?? {};
	const servers = (config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers) ? config.mcpServers : {}) as Record<string, any>;
	const existing = servers.infranodus && typeof servers.infranodus === "object" ? servers.infranodus : { command: "npx", args: ["-y", "infranodus-mcp-server"] };
	servers.infranodus = { ...existing, env: { ...(existing.env ?? {}), INFRANODUS_API_KEY: found.value }, disabled: false };
	config.mcpServers = servers;
	fs.mkdirSync(path.dirname(userConfig), { recursive: true });
	const tmp = `${userConfig}.titan.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, userConfig);
	return { ok: true, source: found.source, message: `InfraNodus key imported from ${found.source} into ${userConfig} (infranodus enabled). Run /reload so pi-mcp-adapter starts it.` };
}

export interface DoctorOptions {
	/** The session ctx (modelRegistry) — without it every model is "unknown". */
	ctx?: any;
	/** Injected for tests. */
	pins?: () => Array<{ name: string; expected: string; found?: string; ok: boolean }>;
	dwPatchApplied?: () => boolean;
	keybindingsPath?: string;
	userMcpConfig?: string;
	env?: NodeJS.ProcessEnv;
}

/** Build the doctor report. Pure apart from reading local files and the registry. */
export function runDoctor(opts: DoctorOptions = {}): DoctorReport {
	const items: DoctorItem[] = [];
	const env = opts.env ?? process.env;
	const registry = opts.ctx?.modelRegistry;
	for (const entry of DOCTOR_MODELS) {
		const slash = entry.model.indexOf("/");
		let status: DoctorStatus = "unknown";
		let detail = "no model registry on this context";
		if (registry) {
			try {
				const found = registry.find?.(entry.model.slice(0, slash), entry.model.slice(slash + 1));
				if (!found) {
					status = "vacant";
					detail = "not in Pi's catalog";
				} else if (!registry.hasConfiguredAuth?.(found)) {
					status = "vacant";
					detail = "in catalog, no configured auth";
				} else {
					status = "ready";
					detail = `authed · ${entry.purpose}`;
				}
			} catch (error) {
				status = "unknown";
				detail = `registry error: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		items.push({ group: "models", key: entry.model, label: entry.model, status, detail, action: status === "ready" ? undefined : entry.action });
	}
	for (const entry of DOCTOR_TOOLS) {
		const where = commandOnPath(entry.tool);
		items.push({ group: "tools", key: entry.tool, label: entry.tool, status: where ? "ready" : "vacant", detail: where ? `${where} · ${entry.purpose}` : `not on PATH · ${entry.purpose}`, action: where ? undefined : entry.action });
	}
	for (const name of DOCTOR_ENV_NAMES) {
		const present = typeof env[name] === "string" && env[name]!.trim().length > 0;
		items.push({ group: "credentials", key: name, label: name, status: present ? "ready" : "vacant", detail: present ? "present in the environment (value not read)" : "absent from the environment", action: present ? undefined : `export ${name} before launching pi, or add it to the relevant MCP entry` });
	}
	const infranodus = infranodusConfigured(opts.userMcpConfig);
	items.push({ group: "credentials", key: "infranodus-mcp", label: "InfraNodus MCP (user config)", status: infranodus.configured ? "ready" : "vacant", detail: infranodus.detail, action: infranodus.configured ? undefined : "/titan-doctor --import-infranodus-key" });
	const shiftTab = shiftTabFree(opts.keybindingsPath);
	items.push({ group: "keys", key: "shift-tab", label: "shift+tab for /titan-level", status: shiftTab.free ? "ready" : "warn", detail: shiftTab.detail, action: shiftTab.free ? undefined : "/titan-level --claim-shift-tab (alt+l and /titan-level work regardless)" });
	if (opts.pins) {
		try {
			for (const pin of opts.pins()) {
				items.push({ group: "pins", key: pin.name, label: pin.name, status: pin.ok ? "ready" : "warn", detail: pin.ok ? `${pin.found} pinned` : `expected ${pin.expected}, found ${pin.found ?? "missing"}`, action: pin.ok ? undefined : `pi install npm:${pin.name}@${pin.expected}` });
			}
		} catch (error) {
			items.push({ group: "pins", key: "pins", label: "companion package pins", status: "unknown", detail: error instanceof Error ? error.message : String(error) });
		}
	}
	if (opts.dwPatchApplied) {
		let applied = false;
		try {
			applied = opts.dwPatchApplied();
		} catch {
			/* unreadable */
		}
		items.push({ group: "pins", key: "dw-patch", label: "dynamic-workflows /workflows menu patch", status: applied ? "ready" : "warn", detail: applied ? "applied" : "not applied (bare /workflows opens the navigator directly)", action: applied ? undefined : "node scripts/apply-dw-patch.mjs" });
	}
	const settings = readStackSettings() as any;
	const storeRoot: string = settings.store?.root ?? path.join(os.homedir(), ".pi", "titan-harness", "runs");
	let storeStatus: DoctorStatus = "ready";
	let storeDetail = storeRoot;
	try {
		fs.mkdirSync(storeRoot, { recursive: true });
		fs.accessSync(storeRoot, fs.constants.W_OK);
	} catch (error) {
		storeStatus = "warn";
		storeDetail = `${storeRoot} not writable: ${error instanceof Error ? error.message : String(error)}`;
	}
	items.push({ group: "store", key: "run-store", label: "run store root", status: storeStatus, detail: storeDetail });
	const decisions: Array<[string, string]> = [
		["store", `JSONL + SHA-256 chain${settings.store?.sqliteIndex ? " + sqlite index" : ""}`],
		["maxConcurrentChildren", String(settings.maxConcurrentChildren ?? 8)],
		["budgetUsd", settings.budgetUsd == null ? "none" : `$${settings.budgetUsd}`],
		["monitor", settings.monitor?.mode ?? "overlay"],
		["watchdog", settings.watchdog?.enabled ? `on · ${settings.watchdog.model ?? "cerebras/qwen-3.8-27b"} (${settings.watchdog.thinking ?? "medium"})` : "off"],
		["harnessLevel", settings.harnessLevel == null ? `shape-driven (${settings.shape})` : `L${settings.harnessLevel}`],
	];
	for (const [key, value] of decisions) items.push({ group: "decisions", key, label: key, status: "ready", detail: value });
	const summary = { ready: 0, vacant: 0, warn: 0, unknown: 0 };
	for (const item of items) summary[item.status]++;
	return { generatedAt: new Date().toISOString(), items, summary };
}

/**
 * Free shift+tab for /titan-level by rebinding Pi's `app.thinking.cycle` to alt+t in
 * ~/.pi/agent/keybindings.json (other keys preserved, backup written first). The
 * command handler confirms with the user before calling this; Pi needs /reload after.
 */
export function claimShiftTab(keybindingsPath = KEYBINDINGS_PATH, replacement = "alt+t"): { changed: boolean; backup?: string; message: string } {
	const current = readJson(keybindingsPath) ?? {};
	const value = current["app.thinking.cycle"];
	const keys = value === undefined ? ["shift+tab"] : Array.isArray(value) ? value.map(String) : [String(value)];
	if (!keys.some((key) => key.trim().toLowerCase() === "shift+tab")) {
		return { changed: false, message: `shift+tab is already free (app.thinking.cycle → ${keys.length ? keys.join(", ") : "disabled"}); run /reload if titan has not bound it yet.` };
	}
	let backup: string | undefined;
	if (fs.existsSync(keybindingsPath)) {
		backup = `${keybindingsPath}.bak`;
		fs.copyFileSync(keybindingsPath, backup);
	}
	const next = { ...current, "app.thinking.cycle": replacement };
	fs.mkdirSync(path.dirname(keybindingsPath), { recursive: true });
	const tmp = `${keybindingsPath}.titan.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, keybindingsPath);
	return { changed: true, backup, message: `app.thinking.cycle → ${replacement} in ${keybindingsPath}${backup ? ` (backup ${backup})` : ""}. Run /reload; titan then binds shift+tab to level cycling.` };
}

const STATUS_GLYPH: Record<DoctorStatus, string> = { ready: "✓", vacant: "○", warn: "△", unknown: "?" };

/** Human-readable report, grouped, one line per item, actions indented. */
export function formatDoctor(report: DoctorReport): string {
	const lines: string[] = [`titan doctor · ${report.generatedAt} · ready ${report.summary.ready} · vacant ${report.summary.vacant} · warn ${report.summary.warn} · unknown ${report.summary.unknown}`];
	const groups: DoctorItem["group"][] = ["models", "credentials", "tools", "keys", "pins", "store", "decisions"];
	for (const group of groups) {
		const rows = report.items.filter((item) => item.group === group);
		if (!rows.length) continue;
		lines.push(`  ${group.toUpperCase()}`);
		for (const row of rows) {
			lines.push(`    ${STATUS_GLYPH[row.status]} ${row.label.padEnd(36)} ${row.detail}`);
			if (row.action) lines.push(`        → ${row.action}`);
		}
	}
	return lines.join("\n");
}
