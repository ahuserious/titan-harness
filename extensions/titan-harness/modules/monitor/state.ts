/**
 * monitor/state.ts — the monitor's state vocabulary (plan §5.4): every agent state the
 * store can hold, its colour, its glyph and its class (working / needs input / terminal).
 *
 * The rules that must never be broken (§5.4): `done-unverified` is never collapsed into
 * `done-verified`, and `stalemate` is never rendered as `in-review`. Colours are the
 * plan's hex values; the overlay paints them with the TUI's truecolor helper, the split
 * pane with ANSI, and tests see them through a recording `color` function.
 *
 * TODO(P5): import AgentState from modules/watchdog/state.ts once the watchdog module
 * lands; until then the union is declared here (same members as plan §5.4 + the P4
 * `failed-review` state).
 */

export type AgentState =
	| "queued"
	| "dispatched-working"
	| "waiting-architect"
	| "in-review"
	| "edit-round-n"
	| "stalemate"
	| "harvesting"
	| "done-verified"
	| "done-unverified"
	| "authoring-workflow"
	| "repairing-workflow"
	| "compacting"
	| "inspecting-compaction"
	| "resuming"
	| "held-spend"
	| "blocked-guard"
	| "system-run"
	| "watchdog-failed"
	| "uncertain-launch"
	| "failed"
	| "cancelled"
	| "failed-review";

export const AGENT_STATES: AgentState[] = [
	"queued",
	"dispatched-working",
	"waiting-architect",
	"in-review",
	"edit-round-n",
	"stalemate",
	"harvesting",
	"done-verified",
	"done-unverified",
	"authoring-workflow",
	"repairing-workflow",
	"compacting",
	"inspecting-compaction",
	"resuming",
	"held-spend",
	"blocked-guard",
	"system-run",
	"watchdog-failed",
	"uncertain-launch",
	"failed",
	"cancelled",
	"failed-review",
];

/** Exactly the plan's colours (§5.4); `failed-review` (P4) gets its own rose. */
export const STATE_COLORS: Record<AgentState, string> = {
	queued: "#64748b",
	"dispatched-working": "#2563eb",
	"waiting-architect": "#7c3aed",
	"in-review": "#d97706",
	"edit-round-n": "#ea580c",
	stalemate: "#dc2626",
	harvesting: "#0891b2",
	"done-verified": "#16a34a",
	"done-unverified": "#ca8a04",
	"authoring-workflow": "#9333ea",
	"repairing-workflow": "#e11d48",
	compacting: "#4f46e5",
	"inspecting-compaction": "#6366f1",
	resuming: "#0ea5e9",
	"held-spend": "#78716c",
	"blocked-guard": "#c026d3",
	"system-run": "#0d9488",
	"watchdog-failed": "#b91c1c",
	"uncertain-launch": "#92400e",
	failed: "#991b1b",
	cancelled: "#6b7280",
	"failed-review": "#9f1239",
};

/** States that draw the spinner: the agent (or the harness on its behalf) is doing something right now. */
export const WORKING_STATES: AgentState[] = ["dispatched-working", "in-review", "edit-round-n", "harvesting", "compacting", "inspecting-compaction", "resuming", "authoring-workflow", "repairing-workflow", "system-run"];

/** States that wait on a human or the architect. */
export const NEEDS_INPUT_STATES: AgentState[] = ["waiting-architect", "stalemate", "held-spend", "blocked-guard", "uncertain-launch"];

/** States nothing follows. */
export const TERMINAL_STATES: AgentState[] = ["done-verified", "done-unverified", "failed", "cancelled", "watchdog-failed", "failed-review"];

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Glyphs follow Grok's dashboard: spinner = working, `●` = needs input / terminal, `○` = idle. */
export function STATE_GLYPH(state: AgentState | string, tick: number): string {
	if ((WORKING_STATES as string[]).includes(state)) return SPINNER_FRAMES[((tick % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length];
	if (state === "queued") return "○";
	return "●";
}

/** Only `done-verified` counts as verified; `done-unverified` never does. */
export function isVerified(state: AgentState | string): boolean {
	return state === "done-verified";
}

export const isWorking = (state: AgentState | string): boolean => (WORKING_STATES as string[]).includes(state);
export const isTerminal = (state: AgentState | string): boolean => (TERMINAL_STATES as string[]).includes(state);
export const isNeedsInput = (state: AgentState | string): boolean => (NEEDS_INPUT_STATES as string[]).includes(state);

/** A state the store wrote that this vocabulary does not know keeps its own name and the `failed` colour class' neutral grey. */
export function colorOf(state: AgentState | string): string {
	return STATE_COLORS[state as AgentState] ?? "#94a3b8";
}
