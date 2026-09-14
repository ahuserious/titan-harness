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
 *   builderFanOut    n builders active (1-4); extra builders are cloned from the builder
 *                    pool, surplus YAML builders are parked.
 *   auditor          true → every builder gets an AUDITOR that must review a write task's
 *                    report before it reaches the architect.
 *   auditorModel     "auto" (cross-family relative to the builder) or a provider/id.
 *   auditorThinking  thinking level for auditors.
 *   auditRounds      bounded correction rounds after a FAIL verdict (1-3).
 *   anonymize        prompts carry callsigns only; model identities are withheld from agents.
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
export const BUILDER_FANOUT_CYCLE = [1, 2, 3, 4];
export const SUBAGENT_FANOUT_CYCLE = [0, 2, 4, 6, 8];

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
}

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
};

export function isStackChild(): boolean {
	return process.env[STACK_CHILD_ENV] === "1";
}

const clampInt = (value: unknown, lo: number, hi: number, fallback: number): number =>
	typeof value === "number" && Number.isFinite(value) ? Math.min(hi, Math.max(lo, Math.round(value))) : fallback;

export function readStackSettings(): StackSettings {
	const d = DEFAULT_STACK_SETTINGS;
	try {
		const raw = JSON.parse(fs.readFileSync(STACK_SETTINGS_PATH, "utf8"));
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			return {
				subagentTools: typeof raw.subagentTools === "boolean" ? raw.subagentTools : d.subagentTools,
				childSubagents: CHILD_SUBAGENT_MODES.includes(raw.childSubagents) ? raw.childSubagents : d.childSubagents,
				childExa: typeof raw.childExa === "boolean" ? raw.childExa : d.childExa,
				subagentModel: typeof raw.subagentModel === "string" && raw.subagentModel.includes("/") ? raw.subagentModel : d.subagentModel,
				subagentThinking: THINKING_LEVELS.includes(raw.subagentThinking) ? raw.subagentThinking : d.subagentThinking,
				subagentFanOut: clampInt(raw.subagentFanOut, 0, 16, d.subagentFanOut),
				shape: typeof raw.shape === "string" && raw.shape.trim() ? raw.shape.trim() : d.shape,
				builderFanOut: clampInt(raw.builderFanOut, 1, 4, d.builderFanOut),
				auditor: typeof raw.auditor === "boolean" ? raw.auditor : d.auditor,
				auditorModel: typeof raw.auditorModel === "string" && (raw.auditorModel === "auto" || raw.auditorModel.includes("/")) ? raw.auditorModel : d.auditorModel,
				auditorThinking: THINKING_LEVELS.includes(raw.auditorThinking) ? raw.auditorThinking : d.auditorThinking,
				auditRounds: clampInt(raw.auditRounds, 1, 3, d.auditRounds),
				anonymize: typeof raw.anonymize === "boolean" ? raw.anonymize : d.anonymize,
				modelBar: typeof raw.modelBar === "boolean" ? raw.modelBar : d.modelBar,
			};
		}
	} catch {
		/* missing or malformed → defaults; never rewrite here */
	}
	return { ...d };
}

/** Atomic merge-write (temp file + rename, mode 0600). Returns the new settings. */
export function writeStackSettings(patch: Partial<StackSettings>): StackSettings {
	const next = { ...readStackSettings(), ...patch };
	fs.mkdirSync(path.dirname(STACK_SETTINGS_PATH), { recursive: true });
	const tmp = `${STACK_SETTINGS_PATH}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, STACK_SETTINGS_PATH);
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
