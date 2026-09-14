/**
 * stack-config.ts — the pi-fusion-stack settings store and the process-wide hooks
 * the package's extensions use to talk to each other.
 *
 * Settings live in ~/.pi/agent/pi-fusion-stack.json (machine-local, never in a repo):
 *   subagentTools    true  → harness children keep the tools their command asks for;
 *                    false → every child runs tool-less (--no-tools). /stack mirrors
 *                            this into pi-dynamic-workflows' excludeSubagentTools.
 *   childSubagents   "all" | "builders" | "off" — which harness children also get the
 *                    pi-subagents `subagent` tool, so ARCHITECT and BUILDER children can
 *                    fan out their own workers. "builders" limits it to write-capable
 *                    children (builder, fuser, coordinator) so read-only research roles
 *                    cannot delegate to a writer by accident.
 *   childExa         true  → harness children get pi-exa's web search/fetch tools.
 *   subagentModel    provider/id used by pi-subagents for every agent without its own
 *                    model (mirrored into Pi settings.json → subagents.defaultModel).
 *   subagentThinking thinking level for those subagents (subagents.defaultThinking).
 *   modelBar         true  → the belowEditor status bar shows (slots, fan-out, subagent, exa).
 *
 * Children spawned by the harness carry STACK_CHILD_ENV=1; every extension in this
 * package returns early when it sees it, so children load the host's OTHER extensions
 * (provider extensions such as antigravity/*, pi-subagents, pi-exa) without re-running
 * the harness.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const STACK_CHILD_ENV = "PI_FUSION_STACK_CHILD";
export const STACK_SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "pi-fusion-stack.json");
/** globalThis hook: (visible: boolean) => void — set by fusion-harness, called by /stack. */
export const STACK_MODEL_BAR_HOOK = Symbol.for("pi-fusion-stack:model-bar");
/** globalThis hook: (ctx, openNavigator) => Promise<void> — set by /stack, called by the patched /workflows. */
export const STACK_WORKFLOWS_MENU_HOOK = Symbol.for("pi-fusion-stack:workflows-menu");

/** pi-subagents' delegation tool. */
export const SUBAGENT_TOOL = "subagent";
/** pi-exa's tools (deep_search_exa needs an Exa API key; the others work without one). */
export const EXA_TOOL_NAMES = ["web_search_exa", "web_fetch_exa", "web_search_advanced_exa", "deep_search_exa"];

export type ChildSubagents = "all" | "builders" | "off";
export const CHILD_SUBAGENT_MODES: ChildSubagents[] = ["all", "builders", "off"];
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface StackSettings {
	subagentTools: boolean;
	childSubagents: ChildSubagents;
	childExa: boolean;
	subagentModel: string;
	subagentThinking: string;
	modelBar: boolean;
}

export const DEFAULT_STACK_SETTINGS: StackSettings = {
	subagentTools: true,
	childSubagents: "all",
	childExa: true,
	subagentModel: "cerebras/qwen-3.8-27b",
	subagentThinking: "high",
	modelBar: true,
};

export function isStackChild(): boolean {
	return process.env[STACK_CHILD_ENV] === "1";
}

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
	if (s.childSubagents === "all" || (s.childSubagents === "builders" && canWrite)) names.add(SUBAGENT_TOOL);
	if (s.childExa) for (const n of EXA_TOOL_NAMES) names.add(n);
	return [...names].join(",");
}
