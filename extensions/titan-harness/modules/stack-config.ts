/**
 * stack-config.ts — the titan-harness settings store and the process-wide hooks the
 * package's extensions use to talk to each other.
 *
 * Settings live in ~/.pi/agent/titan-harness.json (machine-local, never in a repo).
 *
 * Tools and delegation
 *   subagentTools    false → every harness child runs tool-less (--no-tools); /stack mirrors
 *                    this into pi-dynamic-workflows' excludeSubagentTools.
 *   childSubagents   "all" | "builders" | "off" — which harness children carry the
 *                    pi-subagents `subagent` tool (tier 3 delegation).
 *   childExa         harness children get pi-exa's web search/fetch tools.
 *   subagentModel    provider/id pi-subagents uses for every agent without its own model
 *                    (mirrored into Pi settings.json → subagents.defaultModel).
 *   subagentThinking thinking level for those subagents (subagents.defaultThinking).
 *   subagentFanOut   cap on concurrently running subagents per child (0 = off): written to
 *                    pi-subagents' globalConcurrencyLimit and dynamic-workflows'
 *                    defaultConcurrency, and stated in every child's system prompt.
 *
 * Shape (the 3-tier hierarchy)
 *   shape            codename of the stack YAML in ~/.pi/titan-harness (or "legacy").
 *   builderFanOut    n builders active (1-8); extra builders are cloned from the builder
 *                    pool, surplus YAML builders are parked.
 *   auditor          true → every builder gets an AUDITOR that must review a write task's
 *                    report before it reaches the architect.
 *   auditorModel     "auto" (cross-family relative to the builder) or a provider/id.
 *   auditorThinking  thinking level for auditors.
 *   auditRounds      bounded correction rounds after a FAIL verdict (1-3).
 *   anonymize        prompts carry callsigns only; model identities are withheld from agents.
 *
 * Levels and lanes (shape schema v2, plan §4; written by /titan-level via levels.ts)
 *   harnessLevel     0-3, or null when the shape alone decides (no level applied yet).
 *   workerFanOut, watchdogFanOut, verifierFanOut, exaFanOut
 *                    pool sizes per lane (0-16). Pools, not simultaneous children (D8):
 *                    maxConcurrentChildren is the only concurrency cap.
 *   maxConcurrentChildren  the child-runner semaphore (1-16).
 *   budgetUsd        run budget in USD, or null for no cap.
 *   watchdog         the titan-native watchdog (D3): enabled, model, thinking,
 *                    stalemateRepeats (identical findings before "stalemate"), onCompaction
 *                    ("halt-inspect" | "summary-only" | "off"), inspectorTimeoutMs,
 *                    preemptAtContextFraction (children are pre-empted at this share of
 *                    their context window).
 *   store            the run store: root (hash-chained JSONL runs), sqliteIndex (optional
 *                    derived index).
 *   monitor          /workflow-monitor surface: "bar" | "overlay" | "split".
 *   shiftTabHintShown  the one-time "shift+tab is reserved by Pi" notify has been shown.
 *   schedules        per-workflow trigger state for /workflow schedule: { [workflow]: { armed, lastRun? } }
 *                    (armed = the in-process scheduler fires its `trigger:`; lastRun = ISO time of the last fire).
 *
 * UI
 *   modelBar         the belowEditor status bar.
 *
 * Children spawned by the harness carry STACK_CHILD_ENV=1; every extension in this
 * package returns early when it sees it, so children load the host's OTHER extensions
 * (provider extensions, pi-subagents, pi-exa) without re-running the harness.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const STACK_CHILD_ENV = "TITAN_HARNESS_CHILD";
export const STACK_SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "titan-harness.json");
/** Where --titan-config stacks live (model-stack-<codename>.yaml). */
export const STACK_DIR = path.join(os.homedir(), ".pi", "titan-harness");
/** Default root of the run store (one directory per run, hash-chained JSONL inside). */
export const DEFAULT_RUN_ROOT = path.join(os.homedir(), ".pi", "titan-harness", "runs");
/** pi-subagents' own config file (globalConcurrencyLimit lives here). */
export const PI_SUBAGENTS_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "extensions", "subagent", "config.json");
/** globalThis hook: (visible: boolean) => void — set by titan-harness, called by /stack. */
export const STACK_MODEL_BAR_HOOK = Symbol.for("titan-harness:model-bar");
/** globalThis hook: (ctx, openNavigator) => Promise<void> — set by /stack, called by the patched /workflows. */
export const STACK_WORKFLOWS_MENU_HOOK = Symbol.for("titan-harness:workflows-menu");
/** globalThis hook: () => void — set by titan-harness; /stack calls it after shape-relevant settings change. */
export const STACK_SHAPE_HOOK = Symbol.for("titan-harness:shape-changed");

/** pi-subagents' delegation tool. */
export const SUBAGENT_TOOL = "subagent";
/** pi-exa's tools (deep_search_exa needs an Exa API key; the others work without one). */
export const EXA_TOOL_NAMES = ["web_search_exa", "web_fetch_exa", "web_search_advanced_exa", "deep_search_exa"];

export type ChildSubagents = "all" | "builders" | "off";
export const CHILD_SUBAGENT_MODES: ChildSubagents[] = ["all", "builders", "off"];
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const BUILDER_FANOUT_CYCLE = [1, 2, 3, 4, 5, 8];
export const SUBAGENT_FANOUT_CYCLE = [0, 2, 4, 6, 8];
/** Harness levels, in cycling order (/titan-level next, alt+l). */
export const LEVEL_CYCLE = [0, 1, 2, 3];

export type WatchdogOnCompaction = "halt-inspect" | "summary-only" | "off";
export const WATCHDOG_ON_COMPACTION_MODES: WatchdogOnCompaction[] = ["halt-inspect", "summary-only", "off"];
export type MonitorMode = "bar" | "overlay" | "split";
export const MONITOR_MODES: MonitorMode[] = ["bar", "overlay", "split"];

export interface WatchdogSettings {
	enabled: boolean;
	model: string;
	thinking: string;
	stalemateRepeats: number;
	onCompaction: WatchdogOnCompaction;
	inspectorTimeoutMs: number;
	preemptAtContextFraction: number;
}

export interface StoreSettings {
	root: string;
	sqliteIndex: boolean;
}

export interface MonitorSettings {
	mode: MonitorMode;
}

/** /workflow schedule state for one workflow (settings.schedules[workflow]). */
export interface ScheduleState {
	armed: boolean;
	lastRun?: string;
}

/** What a level overwrote, kept so leaving the level (loading a plain shape) restores it. */
export interface LevelRestore {
	builderFanOut: number;
	workerFanOut: number;
	watchdogFanOut: number;
	verifierFanOut: number;
	exaFanOut: number;
	childExa: boolean;
	auditor: boolean;
	watchdogEnabled: boolean;
}

export interface StackSettings {
	subagentTools: boolean;
	childSubagents: ChildSubagents;
	childExa: boolean;
	subagentModel: string;
	subagentThinking: string;
	subagentFanOut: number;
	shape: string;
	builderFanOut: number;
	auditor: boolean;
	auditorModel: string;
	auditorThinking: string;
	auditRounds: number;
	anonymize: boolean;
	modelBar: boolean;
	harnessLevel: number | null;
	workerFanOut: number;
	watchdogFanOut: number;
	verifierFanOut: number;
	exaFanOut: number;
	maxConcurrentChildren: number;
	budgetUsd: number | null;
	watchdog: WatchdogSettings;
	store: StoreSettings;
	monitor: MonitorSettings;
	shiftTabHintShown: boolean;
	levelRestore: LevelRestore | null;
	schedules: Record<string, ScheduleState>;
}

/** A settings patch: top-level keys are optional and the nested objects may be partial (they deep-merge). */
export type StackSettingsPatch = Partial<Omit<StackSettings, "watchdog" | "store" | "monitor" | "schedules">> & {
	watchdog?: Partial<WatchdogSettings>;
	store?: Partial<StoreSettings>;
	monitor?: Partial<MonitorSettings>;
	/** Per-workflow merge: a partial entry updates that workflow, `null` removes it. */
	schedules?: Record<string, Partial<ScheduleState> | null>;
};

export const DEFAULT_STACK_SETTINGS: StackSettings = {
	subagentTools: true,
	childSubagents: "all",
	childExa: true,
	subagentModel: "cerebras/qwen-3.8-27b",
	subagentThinking: "high",
	subagentFanOut: 4,
	shape: "astra-gemini",
	builderFanOut: 2,
	auditor: true,
	auditorModel: "auto",
	auditorThinking: "high",
	auditRounds: 2,
	anonymize: true,
	modelBar: true,
	harnessLevel: null,
	workerFanOut: 5,
	watchdogFanOut: 0,
	verifierFanOut: 0,
	exaFanOut: 5,
	maxConcurrentChildren: 8,
	budgetUsd: null,
	watchdog: {
		enabled: false,
		model: "cerebras/qwen-3.8-27b",
		thinking: "medium",
		stalemateRepeats: 3,
		onCompaction: "halt-inspect",
		inspectorTimeoutMs: 20_000,
		preemptAtContextFraction: 0.75,
	},
	store: {
		root: DEFAULT_RUN_ROOT,
		sqliteIndex: false,
	},
	monitor: {
		mode: "overlay",
	},
	shiftTabHintShown: false,
	levelRestore: null,
	schedules: {},
};

export function isStackChild(): boolean {
	return process.env[STACK_CHILD_ENV] === "1";
}

const clampInt = (value: unknown, lo: number, hi: number, fallback: number): number =>
	typeof value === "number" && Number.isFinite(value) ? Math.min(hi, Math.max(lo, Math.round(value))) : fallback;
const clampNum = (value: unknown, lo: number, hi: number, fallback: number): number =>
	typeof value === "number" && Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : fallback;
const isMapping = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isModelId = (value: unknown): value is string => typeof value === "string" && value.includes("/");

function readWatchdog(raw: unknown, d: WatchdogSettings): WatchdogSettings {
	const r = isMapping(raw) ? raw : {};
	return {
		enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
		model: isModelId(r.model) ? r.model : d.model,
		thinking: typeof r.thinking === "string" && THINKING_LEVELS.includes(r.thinking) ? r.thinking : d.thinking,
		stalemateRepeats: clampInt(r.stalemateRepeats, 1, 10, d.stalemateRepeats),
		onCompaction: typeof r.onCompaction === "string" && (WATCHDOG_ON_COMPACTION_MODES as string[]).includes(r.onCompaction) ? (r.onCompaction as WatchdogOnCompaction) : d.onCompaction,
		inspectorTimeoutMs: clampInt(r.inspectorTimeoutMs, 1_000, 600_000, d.inspectorTimeoutMs),
		preemptAtContextFraction: clampNum(r.preemptAtContextFraction, 0.1, 0.95, d.preemptAtContextFraction),
	};
}

function readStore(raw: unknown, d: StoreSettings): StoreSettings {
	const r = isMapping(raw) ? raw : {};
	return {
		root: typeof r.root === "string" && r.root.trim() ? r.root.trim() : d.root,
		sqliteIndex: typeof r.sqliteIndex === "boolean" ? r.sqliteIndex : d.sqliteIndex,
	};
}

function readMonitor(raw: unknown, d: MonitorSettings): MonitorSettings {
	const r = isMapping(raw) ? raw : {};
	return {
		mode: typeof r.mode === "string" && (MONITOR_MODES as string[]).includes(r.mode) ? (r.mode as MonitorMode) : d.mode,
	};
}

function readSchedules(raw: unknown): Record<string, ScheduleState> {
	const out: Record<string, ScheduleState> = {};
	if (!isMapping(raw)) return out;
	for (const [workflow, entry] of Object.entries(raw)) {
		if (!isMapping(entry) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(workflow)) continue;
		const state: ScheduleState = { armed: entry.armed === true };
		if (typeof entry.lastRun === "string" && Number.isFinite(Date.parse(entry.lastRun))) state.lastRun = entry.lastRun;
		out[workflow] = state;
	}
	return out;
}

const copyDefaults = (d: StackSettings): StackSettings => ({ ...d, watchdog: { ...d.watchdog }, store: { ...d.store }, monitor: { ...d.monitor }, schedules: { ...d.schedules } });

/** Read the settings file (default: ~/.pi/agent/titan-harness.json); missing or malformed → defaults, never rewritten here. */
export function readStackSettings(settingsPath: string = STACK_SETTINGS_PATH): StackSettings {
	const d = DEFAULT_STACK_SETTINGS;
	try {
		const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			return {
				subagentTools: typeof raw.subagentTools === "boolean" ? raw.subagentTools : d.subagentTools,
				childSubagents: CHILD_SUBAGENT_MODES.includes(raw.childSubagents) ? raw.childSubagents : d.childSubagents,
				childExa: typeof raw.childExa === "boolean" ? raw.childExa : d.childExa,
				subagentModel: typeof raw.subagentModel === "string" && raw.subagentModel.includes("/") ? raw.subagentModel : d.subagentModel,
				subagentThinking: THINKING_LEVELS.includes(raw.subagentThinking) ? raw.subagentThinking : d.subagentThinking,
				subagentFanOut: clampInt(raw.subagentFanOut, 0, 16, d.subagentFanOut),
				shape: typeof raw.shape === "string" && raw.shape.trim() ? raw.shape.trim() : d.shape,
				builderFanOut: clampInt(raw.builderFanOut, 1, 8, d.builderFanOut),
				auditor: typeof raw.auditor === "boolean" ? raw.auditor : d.auditor,
				auditorModel: typeof raw.auditorModel === "string" && (raw.auditorModel === "auto" || raw.auditorModel.includes("/")) ? raw.auditorModel : d.auditorModel,
				auditorThinking: THINKING_LEVELS.includes(raw.auditorThinking) ? raw.auditorThinking : d.auditorThinking,
				auditRounds: clampInt(raw.auditRounds, 1, 3, d.auditRounds),
				anonymize: typeof raw.anonymize === "boolean" ? raw.anonymize : d.anonymize,
				modelBar: typeof raw.modelBar === "boolean" ? raw.modelBar : d.modelBar,
				harnessLevel: raw.harnessLevel === null ? null : LEVEL_CYCLE.includes(raw.harnessLevel) ? raw.harnessLevel : d.harnessLevel,
				workerFanOut: clampInt(raw.workerFanOut, 0, 16, d.workerFanOut),
				watchdogFanOut: clampInt(raw.watchdogFanOut, 0, 16, d.watchdogFanOut),
				verifierFanOut: clampInt(raw.verifierFanOut, 0, 16, d.verifierFanOut),
				exaFanOut: clampInt(raw.exaFanOut, 0, 16, d.exaFanOut),
				maxConcurrentChildren: clampInt(raw.maxConcurrentChildren, 1, 16, d.maxConcurrentChildren),
				budgetUsd: raw.budgetUsd === null ? null : typeof raw.budgetUsd === "number" && Number.isFinite(raw.budgetUsd) && raw.budgetUsd >= 0 ? raw.budgetUsd : d.budgetUsd,
				watchdog: readWatchdog(raw.watchdog, d.watchdog),
				store: readStore(raw.store, d.store),
				monitor: readMonitor(raw.monitor, d.monitor),
				shiftTabHintShown: typeof raw.shiftTabHintShown === "boolean" ? raw.shiftTabHintShown : d.shiftTabHintShown,
				levelRestore: readLevelRestore(raw.levelRestore),
				schedules: readSchedules(raw.schedules),
			};
		}
	} catch {
		/* missing or malformed → defaults; never rewrite here */
	}
	return copyDefaults(d);
}

function readLevelRestore(raw: any): LevelRestore | null {
	if (!raw || typeof raw !== "object") return null;
	return {
		builderFanOut: clampInt(raw.builderFanOut, 1, 8, DEFAULT_STACK_SETTINGS.builderFanOut),
		workerFanOut: clampInt(raw.workerFanOut, 0, 16, DEFAULT_STACK_SETTINGS.workerFanOut),
		watchdogFanOut: clampInt(raw.watchdogFanOut, 0, 16, DEFAULT_STACK_SETTINGS.watchdogFanOut),
		verifierFanOut: clampInt(raw.verifierFanOut, 0, 16, DEFAULT_STACK_SETTINGS.verifierFanOut),
		exaFanOut: clampInt(raw.exaFanOut, 0, 16, DEFAULT_STACK_SETTINGS.exaFanOut),
		childExa: typeof raw.childExa === "boolean" ? raw.childExa : DEFAULT_STACK_SETTINGS.childExa,
		auditor: typeof raw.auditor === "boolean" ? raw.auditor : DEFAULT_STACK_SETTINGS.auditor,
		watchdogEnabled: typeof raw.watchdogEnabled === "boolean" ? raw.watchdogEnabled : DEFAULT_STACK_SETTINGS.watchdog.enabled,
	};
}

/** Atomic merge-write (temp file + rename, mode 0600); nested objects deep-merge. Returns the new settings. */
export function writeStackSettings(patch: StackSettingsPatch, settingsPath: string = STACK_SETTINGS_PATH): StackSettings {
	const current = readStackSettings(settingsPath);
	const { watchdog, store, monitor, schedules, ...flat } = patch;
	const mergedSchedules: Record<string, ScheduleState> = { ...current.schedules };
	for (const [workflow, entry] of Object.entries(schedules ?? {})) {
		if (entry === null) delete mergedSchedules[workflow];
		else mergedSchedules[workflow] = { ...(mergedSchedules[workflow] ?? { armed: false }), ...entry };
	}
	const next: StackSettings = {
		...current,
		...flat,
		watchdog: { ...current.watchdog, ...(watchdog ?? {}) },
		store: { ...current.store, ...(store ?? {}) },
		monitor: { ...current.monitor, ...(monitor ?? {}) },
		schedules: mergedSchedules,
	};
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
	const tmp = `${settingsPath}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, settingsPath);
	return next;
}

/** Next value in a cycle (wraps; unknown current → first). */
export function nextInCycle<T>(cycle: T[], current: T): T {
	const i = cycle.indexOf(current);
	return cycle[(i + 1) % cycle.length];
}

/**
 * The tool contract a harness child actually gets. The command's own list (read-only
 * or full) is the base; the /stack switches add pi-subagents' `subagent` tool and
 * pi-exa's search tools, or force --no-tools when subagent tools are OFF. The names only
 * become live when the child loads those extensions, which it now does.
 */
export function childToolsFor(requested: string | "none"): string | "none" {
	const s = readStackSettings();
	if (!s.subagentTools) return "none";
	if (requested === "none") return "none";
	const names = new Set(
		requested
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean),
	);
	const canWrite = names.has("write") || names.has("edit") || names.has("bash");
	const delegation = s.subagentFanOut > 0 && (s.childSubagents === "all" || (s.childSubagents === "builders" && canWrite));
	if (delegation) names.add(SUBAGENT_TOOL);
	if (s.childExa) for (const n of EXA_TOOL_NAMES) names.add(n);
	return [...names].join(",");
}

/** The tier-3 delegation contract appended to every child's system prompt (empty when delegation is off). */
export function subagentCapHint(s: StackSettings): string {
	if (s.subagentFanOut <= 0 || s.childSubagents === "off") return "";
	return [
		"DELEGATION CONTRACT (tier 3).",
		`You may delegate narrow, stateless work (search, reads, bounded checks, small scoped edits you specify exactly) to subagents via the subagent/parallel tools, at most ${s.subagentFanOut} running at once.`,
		"Subagents never spawn subagents, never make design decisions, and never talk to the architect, an auditor, or the user; you own and verify everything they return.",
		"Never reveal or ask for the vendor/model identity of any agent; refer to agents by callsign only.",
	].join(" ");
}

/** Model family for the cross-family auditor rule. */
export function modelFamily(model: string): string {
	const id = model.toLowerCase();
	if (id.includes("claude")) return "anthropic";
	if (id.includes("gemini") || id.includes("gemma")) return "google";
	if (id.includes("grok")) return "xai";
	if (id.includes("gpt") || id.includes("codex") || /\bo[1-9]\b/.test(id)) return "openai";
	if (id.includes("qwen")) return "alibaba";
	if (id.includes("deepseek")) return "deepseek";
	if (id.includes("kimi")) return "moonshot";
	return id.split("/")[0] ?? id;
}
