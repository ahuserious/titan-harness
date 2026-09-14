/**
 * stack-config.ts — the pi-fusion-stack settings store and the process-wide hooks
 * the package's extensions use to talk to each other.
 *
 * Settings live in ~/.pi/agent/pi-fusion-stack.json (machine-local, never in a repo):
 *   subagentTools  true  → harness children keep the tools their command asks for;
 *                  false → every child runs tool-less (--no-tools). The /stack menu
 *                          mirrors this into pi-dynamic-workflows' excludeSubagentTools.
 *   modelBar       true  → the belowEditor status bar (per-slot tps + fan-out) shows.
 *
 * Children spawned by the harness carry STACK_CHILD_ENV=1; every extension in this
 * package returns early when it sees it, so children load the host's OTHER extensions
 * (provider extensions such as antigravity/*) without re-running the harness.
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

export interface StackSettings {
	subagentTools: boolean;
	modelBar: boolean;
}

export const DEFAULT_STACK_SETTINGS: StackSettings = { subagentTools: true, modelBar: true };

export function isStackChild(): boolean {
	return process.env[STACK_CHILD_ENV] === "1";
}

export function readStackSettings(): StackSettings {
	try {
		const raw = JSON.parse(fs.readFileSync(STACK_SETTINGS_PATH, "utf8"));
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			return {
				subagentTools: typeof raw.subagentTools === "boolean" ? raw.subagentTools : DEFAULT_STACK_SETTINGS.subagentTools,
				modelBar: typeof raw.modelBar === "boolean" ? raw.modelBar : DEFAULT_STACK_SETTINGS.modelBar,
			};
		}
	} catch {
		/* missing or malformed → defaults; never rewrite here */
	}
	return { ...DEFAULT_STACK_SETTINGS };
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

/** The tool contract a harness child actually gets after the /stack subagent-tools switch. */
export function childToolsFor(requested: string | "none"): string | "none" {
	return readStackSettings().subagentTools ? requested : "none";
}
