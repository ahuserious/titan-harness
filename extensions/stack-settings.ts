/**
 * stack-settings.ts — /stack, the pi-fusion-stack settings menu.
 *
 *   /stack                  interactive menu
 *   /stack tools on|off     subagent tools for harness children AND workflow agents
 *   /stack fanout <1-16>    pi-dynamic-workflows defaultConcurrency (fan-out size)
 *   /stack bar on|off       the belowEditor model bar (per-slot tps + FAN-OUT row)
 *   /stack status           print the effective settings
 *
 * "Subagent tools OFF" means:
 *   - fusion-harness children spawn with --no-tools (child-runner.ts reads the setting)
 *   - pi-dynamic-workflows gets `excludeSubagentTools` = every tool name Pi knows, in
 *     ~/.pi/workflows/settings.json, then extensions are reloaded so its manager
 *     reconfigures (it only re-reads that file on reload).
 * "ON" restores the command's own tool contract and clears the exclusion list.
 *
 * The same toggles are offered inside the dynamic-workflows menu: bare `/workflows`
 * calls the hook this extension publishes at STACK_WORKFLOWS_MENU_HOOK (see the
 * one-line patch documented in README.md), falling back to the navigator when the
 * hook is absent.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	isStackChild,
	readStackSettings,
	STACK_MODEL_BAR_HOOK,
	STACK_SETTINGS_PATH,
	STACK_WORKFLOWS_MENU_HOOK,
	writeStackSettings,
} from "./fusion-harness/modules/stack-config.ts";

const WORKFLOWS_SETTINGS_PATH = path.join(os.homedir(), ".pi", "workflows", "settings.json");
const FANOUT_CHOICES = [1, 2, 4, 8, 16];
/** Tool names workflow agents can see even when the host has not loaded the extension that owns them. */
const KNOWN_TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "find", "ls", "web_search", "web_fetch", "subagent", "run-ci", "workflow", "workflow_control"];

type JsonObject = Record<string, unknown>;

/** Missing file → {}. Malformed file → throws, so a broken settings file is never overwritten. */
function readJsonObject(file: string): JsonObject {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`${file}: ${String(error)}`);
	}
	const parsed = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file}: top-level value is not an object`);
	return parsed as JsonObject;
}

function writeJsonAtomic(file: string, value: unknown) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.stack.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

export default function (pi: ExtensionAPI) {
	if (isStackChild()) return;

	const allToolNames = (): string[] => {
		const names = new Set(KNOWN_TOOL_NAMES);
		try {
			for (const tool of (pi as any).getAllTools?.() ?? []) if (tool?.name) names.add(String(tool.name));
		} catch {
			/* runtime not bound yet — the static list still covers the builtins */
		}
		return [...names].sort();
	};

	const workflowsSettings = (): JsonObject => readJsonObject(WORKFLOWS_SETTINGS_PATH);
	const currentFanOut = (): number | undefined => {
		try {
			const value = workflowsSettings().defaultConcurrency;
			return typeof value === "number" ? value : undefined;
		} catch {
			return undefined;
		}
	};

	const reloadExtensions = async (ctx: any, why: string) => {
		if (typeof ctx.reload === "function") {
			try {
				ctx.ui.notify(`${why} Reloading extensions so pi-dynamic-workflows picks it up…`, "info");
			} catch {}
			await ctx.reload();
			return;
		}
		try {
			ctx.ui.notify(`${why} Run /reload so pi-dynamic-workflows picks it up.`, "warning");
		} catch {}
	};

	/** The one switch behind "subagent tools": harness children + workflow agents together. */
	const applySubagentTools = async (ctx: any, on: boolean) => {
		let workflows: JsonObject;
		try {
			workflows = workflowsSettings();
		} catch (error) {
			ctx.ui.notify(`Not applied: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		writeStackSettings({ subagentTools: on });
		let excluded = 0;
		if (on) delete workflows.excludeSubagentTools;
		else {
			const names = allToolNames();
			workflows.excludeSubagentTools = names;
			excluded = names.length;
		}
		writeJsonAtomic(WORKFLOWS_SETTINGS_PATH, workflows);
		await reloadExtensions(
			ctx,
			on
				? "Subagent tools ON: harness children keep their command's tools; workflow agents get their normal tools."
				: `Subagent tools OFF: harness children run tool-less; ${excluded} tool names excluded from workflow agents.`,
		);
	};

	const applyFanOut = async (ctx: any, n: number) => {
		let workflows: JsonObject;
		try {
			workflows = workflowsSettings();
		} catch (error) {
			ctx.ui.notify(`Not applied: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		workflows.defaultConcurrency = n;
		writeJsonAtomic(WORKFLOWS_SETTINGS_PATH, workflows);
		await reloadExtensions(ctx, `Workflow fan-out set to ${n} concurrent agents.`);
	};

	const applyModelBar = (ctx: any, on: boolean) => {
		writeStackSettings({ modelBar: on });
		const hook = (globalThis as any)[STACK_MODEL_BAR_HOOK];
		if (typeof hook === "function") hook(on);
		ctx.ui.notify(`Model bar ${on ? "ON" : "OFF"}${typeof hook === "function" ? "" : " (takes effect once fusion-harness is loaded)"}.`, "info");
	};

	const invokeCommand = async (ctx: any, name: string, args: string): Promise<boolean> => {
		try {
			const command = (pi as any).getCommands?.().find((candidate: any) => candidate.name === name);
			if (!command?.handler) return false;
			await command.handler(args, ctx);
			return true;
		} catch (error) {
			ctx.ui.notify(`/${name} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			return true;
		}
	};

	const statusText = (): string => {
		const stack = readStackSettings();
		const fanOut = currentFanOut();
		let excluded = "none";
		try {
			const value = workflowsSettings().excludeSubagentTools;
			if (Array.isArray(value) && value.length) excluded = `${value.length} names`;
		} catch {
			excluded = "unreadable settings file";
		}
		return [
			"pi-fusion-stack settings",
			`  subagent tools : ${stack.subagentTools ? "ON" : "OFF"}   (harness children ${stack.subagentTools ? "keep their tools" : "run --no-tools"}; workflows excludeSubagentTools: ${excluded})`,
			`  workflow fan-out: ${fanOut ?? "package default (8)"}   (~/.pi/workflows/settings.json defaultConcurrency)`,
			`  model bar       : ${stack.modelBar ? "ON" : "OFF"}   (per-slot tps + FAN-OUT row, /fh on|off)`,
			`  settings file   : ${STACK_SETTINGS_PATH}`,
		].join("\n");
	};

	const pickFanOut = async (ctx: any) => {
		const current = currentFanOut();
		const picked = await ctx.ui.select(
			"Workflow fan-out (concurrent agents)",
			FANOUT_CHOICES.map((n) => `${n === current ? "●" : "○"} ${n}`),
		);
		if (!picked) return;
		const n = Number.parseInt(picked.replace(/^[●○]\s*/, ""), 10);
		if (Number.isFinite(n)) await applyFanOut(ctx, n);
	};

	const menu = async (ctx: any) => {
		const stack = readStackSettings();
		const fanOut = currentFanOut();
		const items: Array<[string, () => Promise<void>]> = [
			[`Subagent tools: ${stack.subagentTools ? "ON" : "OFF"}  → turn ${stack.subagentTools ? "OFF" : "ON"}`, () => applySubagentTools(ctx, !stack.subagentTools)],
			[`Workflow fan-out: ${fanOut ?? "default (8)"}  → change`, () => pickFanOut(ctx)],
			[`Model bar (tps + fan-out): ${stack.modelBar ? "ON" : "OFF"}  → toggle`, async () => applyModelBar(ctx, !stack.modelBar)],
			["Open workflows run navigator", async () => {
				if (!(await invokeCommand(ctx, "workflows", "ui"))) ctx.ui.notify("pi-dynamic-workflows is not loaded.", "warning");
			}],
			["Context window (/ctx)", async () => {
				if (!(await invokeCommand(ctx, "ctx", ""))) ctx.ui.notify("/ctx is not loaded.", "warning");
			}],
			["Show current settings", async () => ctx.ui.notify(statusText(), "info")],
		];
		const picked = await ctx.ui.select("pi-fusion-stack", items.map(([label]) => label));
		if (!picked) return;
		const item = items.find(([label]) => label === picked);
		if (item) await item[1]();
	};

	const handler = async (args: string, ctx: any) => {
		const [verb = "", value = ""] = args.trim().toLowerCase().split(/\s+/);
		const onOff = (v: string): boolean | undefined => (v === "on" ? true : v === "off" ? false : undefined);
		switch (verb) {
			case "":
				return menu(ctx);
			case "tools": {
				const on = onOff(value);
				if (on === undefined) return ctx.ui.notify("Usage: /stack tools on|off", "warning");
				return applySubagentTools(ctx, on);
			}
			case "fanout":
			case "fan-out": {
				const n = Number.parseInt(value, 10);
				if (!Number.isFinite(n) || n < 1 || n > 16) return ctx.ui.notify("Usage: /stack fanout <1-16>", "warning");
				return applyFanOut(ctx, n);
			}
			case "bar": {
				const on = onOff(value);
				if (on === undefined) return ctx.ui.notify("Usage: /stack bar on|off", "warning");
				return applyModelBar(ctx, on);
			}
			case "status":
				return ctx.ui.notify(statusText(), "info");
			default:
				return ctx.ui.notify("Usage: /stack [tools on|off | fanout <1-16> | bar on|off | status]", "warning");
		}
	};

	pi.registerCommand("stack", {
		description: "pi-fusion-stack settings: subagent tools on/off, workflow fan-out, model bar, workflows navigator",
		handler,
	});
	pi.registerCommand("stack-settings", {
		description: "Alias for /stack",
		handler,
	});

	// The dynamic-workflows menu hook: bare /workflows shows this instead of jumping
	// straight to the navigator (the navigator is the first entry).
	(globalThis as any)[STACK_WORKFLOWS_MENU_HOOK] = async (ctx: any, openNavigator: () => Promise<void>) => {
		const stack = readStackSettings();
		const fanOut = currentFanOut();
		const items: Array<[string, () => Promise<void>]> = [
			["Open run navigator", openNavigator],
			[`Subagent tools: ${stack.subagentTools ? "ON" : "OFF"}  → turn ${stack.subagentTools ? "OFF" : "ON"}`, () => applySubagentTools(ctx, !stack.subagentTools)],
			[`Fan-out (concurrent agents): ${fanOut ?? "default (8)"}  → change`, () => pickFanOut(ctx)],
			["Stack settings (/stack)", () => menu(ctx)],
		];
		const picked = await ctx.ui.select("Dynamic workflows", items.map(([label]) => label));
		if (!picked) return;
		const item = items.find(([label]) => label === picked);
		if (item) await item[1]();
	};
}
