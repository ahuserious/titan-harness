/**
 * cmd-monitor.ts — `/workflow-monitor`, the store-driven run monitor (plan D4, H4, §5.4).
 *
 *   /workflow-monitor              overlay of the live run (the in-flight workflow run when
 *                                  one exists, else the newest run of this project), redrawn
 *                                  every 500 ms from the store with the spinner tick
 *   /workflow-monitor <runId>      the same for one run (a prefix of its id is enough)
 *   /workflow-monitor list         the runs table: titan runs + pi-dynamic-workflows runs
 *   /workflow-monitor --split      the same frame in a side pane: `orca terminal split`,
 *                                  else `tmux split-window`, else an explicit "none"
 *   /workflow-monitor close        close the overlay
 *
 * Pi has no sidebar or pane API, so the overlay is primary and `--split` is the opt-in
 * path (scripts/titan-monitor.mjs is the pane's tailer). This module holds no pi
 * rendering: the lead's factory implements `deps.openOverlay` (ctx.ui.custom overlay +
 * handle.unfocus), `deps.spawnSplit`, `deps.panel` and `deps.notify`; everything the
 * frame needs lives in modules/monitor/* and is unit-tested without pi.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readDwRuns } from "./monitor/dw-adapter.ts";
import { renderFrame, renderList } from "./monitor/frame.ts";
import { buildRunView, latestRuns, type RunView } from "./monitor/rows.ts";
import { RunStore } from "./run-store.ts";

export const MONITOR_REFRESH_MS = 500;
export const MONITOR_SUBCOMMANDS = ["list", "--split", "close"] as const;

export interface OverlayHandle {
	close(): void;
	refresh(): void;
}

export interface MonitorCommandDeps {
	store(): RunStore;
	cwd(ctx: any): string;
	/** Open the overlay; `render` is called on every refresh with the tick and the current size. Undefined when there is no TUI. */
	openOverlay(ctx: any, render: (tick: number, size: { width: number; height: number }) => string[], onClose: () => void): OverlayHandle | undefined;
	/** Start the side pane running `argv`; `how` says which host did it, "none" when neither Orca nor tmux is available. */
	spawnSplit(ctx: any, argv: string[]): Promise<{ ok: boolean; how: "orca" | "tmux" | "none"; detail: string }>;
	notify(ctx: any, text: string, level?: "info" | "warning" | "error"): void;
	panel(ctx: any, title: string, markdown: string): void;
	/** The in-flight workflow run's directory, when the lead tracks one. */
	currentRunDir?(ctx: any): string | undefined;
	/** Truecolor painter for overlay lines (hex, text) → styled text; plain text without it. */
	color?(hex: string, text: string): string;
}

/** `<package>/scripts/titan-monitor.mjs` — the pane tailer, resolved from this module's location. */
export function monitorScriptPath(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "titan-monitor.mjs");
}

/** Resolve which run directory `/workflow-monitor [runId]` means. */
export function resolveRunDir(store: RunStore, projectSlug: string, wanted: string | undefined, currentRunDir?: string): { dir: string; runId: string } | undefined {
	if (wanted) {
		const match = store.listRuns(projectSlug, 300).find((run) => run.runId === wanted || run.runId.startsWith(wanted) || run.runId.endsWith(wanted));
		return match ? { dir: store.dir(match.runId, match.projectSlug), runId: match.runId } : undefined;
	}
	if (currentRunDir) {
		try {
			return { dir: currentRunDir, runId: store.readRun(currentRunDir).runId };
		} catch {
			/* fall through to the newest run */
		}
	}
	const latest = store.listRuns(projectSlug, 1)[0];
	return latest ? { dir: store.dir(latest.runId, latest.projectSlug), runId: latest.runId } : undefined;
}

export function registerMonitorCommand(pi: ExtensionAPI, deps: MonitorCommandDeps): void {
	let overlay: { handle: OverlayHandle; timer: ReturnType<typeof setInterval>; runId: string } | undefined;
	const closeOverlay = (): boolean => {
		if (!overlay) return false;
		clearInterval(overlay.timer);
		try {
			overlay.handle.close();
		} catch {}
		overlay = undefined;
		return true;
	};

	const open = (ctx: any, wanted?: string) => {
		const store = deps.store();
		const cwd = deps.cwd(ctx);
		const target = resolveRunDir(store, RunStore.projectSlug(cwd), wanted, deps.currentRunDir?.(ctx));
		if (!target) return deps.notify(ctx, wanted ? `No run matching "${wanted}" in this project.` : "No runs recorded for this project yet — every /titan-* command and /workflow run opens one.", "warning");
		closeOverlay();
		let tick = 0;
		let offset = 0;
		let cached: RunView | undefined;
		let cachedAt = 0;
		const view = (): RunView => {
			const now = Date.now();
			if (!cached || now - cachedAt >= MONITOR_REFRESH_MS) {
				try {
					cached = buildRunView(store, target.dir, now);
					cachedAt = now;
				} catch (error) {
					if (!cached) throw error;
				}
			}
			return cached;
		};
		const render = (currentTick: number, size: { width: number; height: number }): string[] => {
			tick = currentTick;
			return renderFrame(view(), { width: size.width, height: size.height, tick, offset, color: deps.color });
		};
		const handle = deps.openOverlay(ctx, render, () => closeOverlay());
		if (!handle) {
			// No TUI (headless or -p): one plain frame as a panel instead of a silent no-op.
			return deps.panel(ctx, `◫ MONITOR ${target.runId}`, `\`\`\`\n${renderFrame(view(), { width: 120, height: 60, tick: 0 }).join("\n")}\n\`\`\``);
		}
		const timer = setInterval(() => {
			tick += 1;
			try {
				handle.refresh();
			} catch {
				closeOverlay();
			}
		}, MONITOR_REFRESH_MS);
		overlay = { handle, timer, runId: target.runId };
		deps.notify(ctx, `monitor: ${target.runId} · /workflow-monitor close to hide`, "info");
		void offset;
	};

	const list = (ctx: any) => {
		const store = deps.store();
		const cwd = deps.cwd(ctx);
		const views = [...latestRuns(store, RunStore.projectSlug(cwd), 20), ...readDwRuns(cwd)];
		if (!views.length) return deps.notify(ctx, "No titan or pi-dynamic-workflows runs recorded for this project.", "warning");
		deps.panel(ctx, "◫ MONITOR — RUNS", `\`\`\`\n${renderList(views, 140).join("\n")}\n\`\`\``);
	};

	const split = async (ctx: any, wanted?: string) => {
		const store = deps.store();
		const cwd = deps.cwd(ctx);
		const target = resolveRunDir(store, RunStore.projectSlug(cwd), wanted, deps.currentRunDir?.(ctx));
		if (!target) return deps.notify(ctx, "No run to tail yet.", "warning");
		const result = await deps.spawnSplit(ctx, ["node", monitorScriptPath(), "--run", target.dir, "--follow"]);
		if (result.how === "none" || !result.ok) return deps.notify(ctx, `monitor --split: no pane host available (${result.detail}). The overlay (/workflow-monitor) works without one; the tailer runs by hand: node ${monitorScriptPath()} --run ${target.dir} --follow`, "warning");
		deps.notify(ctx, `monitor: tailing ${target.runId} in a ${result.how} pane (${result.detail})`, "info");
	};

	pi.registerCommand("workflow-monitor", {
		description: "titan run monitor: overlay of the live run (default), <runId>, list, --split (Orca/tmux pane), close",
		getArgumentCompletions: (prefix: string) => {
			const items = MONITOR_SUBCOMMANDS.filter((verb) => verb.startsWith(prefix.trim().toLowerCase())).map((verb) => ({ value: verb, label: verb }));
			return items.length ? items : null;
		},
		handler: async (args: string, ctx: any) => {
			const words = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const verb = (words[0] ?? "").toLowerCase();
			if (verb === "list" || verb === "ls") return list(ctx);
			if (verb === "close" || verb === "hide") return deps.notify(ctx, closeOverlay() ? "monitor closed" : "monitor: nothing open", "info");
			if (verb === "--split" || verb === "split") return split(ctx, words[1]);
			return open(ctx, words[0]);
		},
	});
}
