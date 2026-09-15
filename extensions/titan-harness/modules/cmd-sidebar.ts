/**
 * cmd-sidebar.ts — `/workflow-sidebar`, the workflow progress sidebar (PRD v0.9 R3).
 *
 *   /workflow-sidebar            open the sidebar for the live run (the in-flight workflow
 *                                run when one exists, else the newest run of this project)
 *   /workflow-sidebar <runId>    the same for one run (a prefix of its id is enough)
 *   /workflow-sidebar expand     toggle the node lines under every phase
 *   /workflow-sidebar close      close it
 *
 * The overlay redraws every 500 ms from the store, dims dormant phases, and closes itself
 * 10 minutes after the run reached a terminal state (sidebarAutoCloseDue). The controller
 * this returns (`toggle`, `open`, `close`, `isOpen`) is what the lead binds to ctrl+w /
 * alt+w in titan-harness.ts. No pi rendering lives here: `deps.openOverlay` is the lead's
 * ctx.ui.custom overlay (with handle.unfocus so the editor keeps input), `deps.loadedFor`
 * resolves the run's workflow document (default: loadWorkflow by the run's workflow name).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSidebarView, renderSidebar, sidebarAutoCloseDue, type SidebarView } from "./monitor/sidebar.ts";
import { RunStore } from "./run-store.ts";
import type { LoadedWorkflow } from "./workflow/loader.ts";
import { loadWorkflow } from "./workflow/loader.ts";
import type { WorkflowDoc } from "./workflow/schema.ts";

export const SIDEBAR_REFRESH_MS = 500;
export const SIDEBAR_SUBCOMMANDS = ["expand", "collapse", "close"] as const;

export interface SidebarOverlayHandle {
	close(): void;
	refresh(): void;
}

export interface SidebarCommandDeps {
	store(): RunStore;
	cwd(ctx: any): string;
	/** Open the overlay; `render` is called on every refresh with the tick and the current size. Undefined when there is no TUI. */
	openOverlay(ctx: any, render: (tick: number, size: { width: number; height: number }) => string[], onClose: () => void): SidebarOverlayHandle | undefined;
	notify(ctx: any, text: string, level?: "info" | "warning" | "error"): void;
	panel(ctx: any, title: string, markdown: string): void;
	/** The in-flight workflow run's directory, when the lead tracks one. */
	currentRunDir?(ctx: any): string | undefined;
	/** Truecolor painter for overlay lines (hex, text) → styled text; plain text without it. */
	color?(hex: string, text: string): string;
	/** The run's workflow document when it is installed; default: loadWorkflow(run.workflow.name, cwd). */
	loadedFor?(runDir: string, ctx: any): LoadedWorkflow | undefined;
  /** Clock override for tests. */
	now?(): number;
}

export interface SidebarController {
	/** ctrl+w: open when closed, close when open. */
	toggle(ctx: any): void;
	open(ctx: any, runId?: string): void;
	close(): boolean;
	isOpen(): boolean;
	expanded(): boolean;
	setExpanded(value: boolean): void;
}

/** Resolve which run directory the sidebar shows. */
export function resolveSidebarRun(store: RunStore, projectSlug: string, wanted: string | undefined, currentRunDir?: string): { dir: string; runId: string } | undefined {
	if (wanted) {
		const match = store.listRuns(projectSlug, 300).find((run) => run.runId === wanted || run.runId.startsWith(wanted) || run.runId.endsWith(wanted));
		return match ? { dir: store.dir(match.runId, match.projectSlug), runId: match.runId } : undefined;
	}
	if (currentRunDir) {
		try {
			return { dir: currentRunDir, runId: store.readRun(currentRunDir).runId };
		} catch {
			/* fall through */
		}
	}
	const latest = store.listRuns(projectSlug, 1)[0];
	return latest ? { dir: store.dir(latest.runId, latest.projectSlug), runId: latest.runId } : undefined;
}

/** The workflow doc for a run, when its workflow is installed for this project. */
export function defaultLoadedFor(store: RunStore, runDir: string, cwd: string): LoadedWorkflow | undefined {
	try {
		const run = store.readRun(runDir);
		if (!run.workflow?.name) return undefined;
		return loadWorkflow(run.workflow.name, cwd);
	} catch {
		return undefined;
	}
}

export function createSidebarController(deps: SidebarCommandDeps): SidebarController {
	let overlay: { handle: SidebarOverlayHandle; timer: ReturnType<typeof setInterval>; runId: string } | undefined;
	let expanded = false;
	const now = () => deps.now?.() ?? Date.now();
	const close = (): boolean => {
		if (!overlay) return false;
		clearInterval(overlay.timer);
		try {
			overlay.handle.close();
		} catch {}
		overlay = undefined;
		return true;
	};
	const open = (ctx: any, wanted?: string): void => {
		const store = deps.store();
		const cwd = deps.cwd(ctx);
		const target = resolveSidebarRun(store, RunStore.projectSlug(cwd), wanted, deps.currentRunDir?.(ctx));
		if (!target) return deps.notify(ctx, wanted ? `No run matching "${wanted}" in this project.` : "No runs recorded for this project yet — /workflow run <name> opens one.", "warning");
		close();
		const doc: WorkflowDoc | undefined = (deps.loadedFor ? deps.loadedFor(target.dir, ctx) : defaultLoadedFor(store, target.dir, cwd))?.doc;
		let cached: SidebarView | undefined;
		let cachedAt = 0;
		const view = (): SidebarView => {
			const at = now();
			if (!cached || at - cachedAt >= SIDEBAR_REFRESH_MS) {
				try {
					cached = buildSidebarView(store, target.dir, doc, at);
					cachedAt = at;
				} catch (error) {
					if (!cached) throw error;
				}
			}
			return cached;
		};
		const render = (tick: number, size: { width: number; height: number }): string[] => renderSidebar(view(), { width: size.width, height: size.height, tick, color: deps.color, expanded, now: now() });
		const handle = deps.openOverlay(ctx, render, () => close());
		if (!handle) {
			// Headless: one plain frame as a panel instead of a silent no-op.
			return deps.panel(ctx, `◧ WORKFLOW ${target.runId}`, `\`\`\`\n${renderSidebar(view(), { width: 100, height: 60, tick: 0, expanded, now: now() }).join("\n")}\n\`\`\``);
		}
		let tick = 0;
		const timer = setInterval(() => {
			tick += 1;
			try {
				if (sidebarAutoCloseDue(view(), now())) {
					close();
					deps.notify(ctx, `sidebar: ${target.runId} settled 10 minutes ago — closed`, "info");
					return;
				}
				handle.refresh();
			} catch {
				close();
			}
		}, SIDEBAR_REFRESH_MS);
		overlay = { handle, timer, runId: target.runId };
		void tick;
		deps.notify(ctx, `sidebar: ${target.runId} · ctrl+w or /workflow-sidebar close to hide`, "info");
	};
	return {
		toggle: (ctx) => {
			if (overlay) close();
			else open(ctx);
		},
		open,
		close,
		isOpen: () => !!overlay,
		expanded: () => expanded,
		setExpanded: (value) => {
			expanded = value;
			try {
				overlay?.handle.refresh();
			} catch {}
		},
	};
}

export function registerSidebarCommand(pi: ExtensionAPI, deps: SidebarCommandDeps): SidebarController {
	const controller = createSidebarController(deps);
	pi.registerCommand("workflow-sidebar", {
		description: "workflow progress sidebar: phases coloured by role and state (ctrl+w toggles it): /workflow-sidebar [runId|expand|collapse|close]",
		getArgumentCompletions: (prefix: string) => {
			const items = SIDEBAR_SUBCOMMANDS.filter((verb) => verb.startsWith(prefix.trim().toLowerCase())).map((verb) => ({ value: verb, label: verb }));
			return items.length ? items : null;
		},
		handler: async (args: string, ctx: any) => {
			const words = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const verb = (words[0] ?? "").toLowerCase();
			if (verb === "close" || verb === "hide") return deps.notify(ctx, controller.close() ? "sidebar closed" : "sidebar: nothing open", "info");
			if (verb === "expand") {
				controller.setExpanded(true);
				if (!controller.isOpen()) controller.open(ctx, words[1]);
				return;
			}
			if (verb === "collapse") {
				controller.setExpanded(false);
				if (!controller.isOpen()) controller.open(ctx, words[1]);
				return;
			}
			controller.open(ctx, words[0]);
		},
	} as any);
	return controller;
}
