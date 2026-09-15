/**
 * stack-settings.ts — /stack, the titan-harness settings menu.
 *
 *   /stack                          interactive menu
 *   /stack tools on|off             subagent tools for harness children AND workflow agents
 *   /stack subagent-model <provider/id> [thinking]
 *                                   the model pi-subagents uses for delegated workers (tier 3)
 *   /stack child-subagents all|builders|off
 *                                   which harness children carry the `subagent` tool
 *   /stack exa on|off               pi-exa web search tools in harness children
 *   /stack fanout <1-16>            pi-dynamic-workflows defaultConcurrency
 *   /stack auditor-model auto|<provider/id> [thinking]
 *                                   the auditor's model ("auto" = cross-family vs the builder)
 *   /stack audit-rounds <1-3>       bounded correction rounds after a FAIL verdict
 *   /stack anonymize on|off         callsign-only prompts (models withheld from agents)
 *   /stack bar on|off               the belowEditor model bar
 *   /stack status                   print the effective settings
 *
 * Shape controls live in the harness itself: /titan-shape, /titan-n, /titan-s,
 * /titan-audit and their hotkeys. This file owns the settings that need other packages'
 * config files: Pi settings.json (pi-subagents defaults), ~/.pi/workflows/settings.json
 * (dynamic-workflows), ~/.pi/agent/extensions/subagent/config.json (pi-subagents cap).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CHILD_SUBAGENT_MODES,
	type ChildSubagents,
	EXA_TOOL_NAMES,
	isStackChild,
	PI_SUBAGENTS_CONFIG_PATH,
	readStackSettings,
	STACK_MODEL_BAR_HOOK,
	STACK_SETTINGS_PATH,
	STACK_SHAPE_HOOK,
	STACK_WORKFLOWS_MENU_HOOK,
	THINKING_LEVELS,
	writeStackSettings,
} from "./titan-harness/modules/stack-config.ts";

const PI_SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");
const WORKFLOWS_SETTINGS_PATH = path.join(os.homedir(), ".pi", "workflows", "settings.json");
const FANOUT_CHOICES = [1, 2, 4, 8, 16];
/** Tool names workflow agents can see even when the host has not loaded the extension that owns them. */
const KNOWN_TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "find", "ls", "subagent", "parallel", "run-ci", "workflow", "workflow_control", ...EXA_TOOL_NAMES];

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

/** enabledModels patterns: exact `provider/id` or `provider/*`. */
function matchesPattern(pattern: string, key: string): boolean {
	const p = pattern.toLowerCase();
	const k = key.toLowerCase();
	if (p.endsWith("/*")) return k.startsWith(p.slice(0, -1));
	return p === k;
}

export default function (pi: ExtensionAPI) {
	if (isStackChild()) return;

	const shapeChanged = () => {
		const hook = (globalThis as any)[STACK_SHAPE_HOOK];
		if (typeof hook === "function") hook();
	};

	const allToolNames = (): string[] => {
		const names = new Set(KNOWN_TOOL_NAMES);
		try {
			for (const tool of (pi as any).getAllTools?.() ?? []) {
				const name = typeof tool === "string" ? tool : tool?.name;
				if (name) names.add(String(name));
			}
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
				ctx.ui.notify(`${why} Reloading extensions so the change is picked up…`, "info");
			} catch {}
			await ctx.reload();
			return;
		}
		try {
			ctx.ui.notify(`${why} Run /reload so the change is picked up.`, "warning");
		} catch {}
	};

	const fail = (ctx: any, error: unknown) => ctx.ui.notify(`Not applied: ${error instanceof Error ? error.message : String(error)}`, "error");

	/** The one switch behind "subagent tools": harness children + workflow agents together. */
	const applySubagentTools = async (ctx: any, on: boolean) => {
		let workflows: JsonObject;
		try {
			workflows = workflowsSettings();
		} catch (error) {
			return fail(ctx, error);
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
			return fail(ctx, error);
		}
		workflows.defaultConcurrency = n;
		writeJsonAtomic(WORKFLOWS_SETTINGS_PATH, workflows);
		await reloadExtensions(ctx, `Workflow fan-out set to ${n} concurrent agents.`);
	};

	/** Mirror the subagent cap into pi-subagents' globalConcurrencyLimit (0 → leave its default). */
	const applySubagentCapToPiSubagents = (cap: number) => {
		try {
			const config = readJsonObject(PI_SUBAGENTS_CONFIG_PATH);
			if (cap > 0) config.globalConcurrencyLimit = cap;
			else delete config.globalConcurrencyLimit;
			writeJsonAtomic(PI_SUBAGENTS_CONFIG_PATH, config);
		} catch {
			/* malformed pi-subagents config: leave it alone */
		}
	};

	/** Subagent model: stack setting + pi-subagents' documented keys in Pi's settings.json. */
	const applySubagentModel = async (ctx: any, model: string, thinking: string) => {
		const slash = model.indexOf("/");
		if (slash <= 0) return ctx.ui.notify("Subagent model must be provider/id (e.g. cerebras/qwen-3.8-27b).", "warning");
		if (!THINKING_LEVELS.includes(thinking)) return ctx.ui.notify(`Thinking must be one of ${THINKING_LEVELS.join(", ")}.`, "warning");
		let settings: JsonObject;
		try {
			settings = readJsonObject(PI_SETTINGS_PATH);
		} catch (error) {
			return fail(ctx, error);
		}
		if (Object.keys(settings).length === 0) return fail(ctx, `${PI_SETTINGS_PATH} is missing or empty`);
		writeStackSettings({ subagentModel: model, subagentThinking: thinking });
		const subagents = (settings.subagents && typeof settings.subagents === "object" && !Array.isArray(settings.subagents) ? settings.subagents : {}) as JsonObject;
		settings.subagents = { ...subagents, defaultModel: model, defaultProvider: model.slice(0, slash), defaultThinking: thinking };
		writeJsonAtomic(PI_SETTINGS_PATH, settings);
		let authNote = "";
		try {
			const found = ctx.modelRegistry?.find?.(model.slice(0, slash), model.slice(slash + 1));
			if (!found) authNote = " (not in Pi's catalog yet)";
			else if (!ctx.modelRegistry.hasConfiguredAuth(found)) authNote = ` (provider not authed: /login ${model.slice(0, slash)})`;
		} catch {}
		await reloadExtensions(ctx, `Subagent model → ${model} (${thinking})${authNote}.`);
	};

	const applyAuditorModel = (ctx: any, model: string, thinking: string) => {
		if (model !== "auto" && model.indexOf("/") <= 0) return ctx.ui.notify("Auditor model must be auto or provider/id.", "warning");
		if (!THINKING_LEVELS.includes(thinking)) return ctx.ui.notify(`Thinking must be one of ${THINKING_LEVELS.join(", ")}.`, "warning");
		writeStackSettings({ auditorModel: model, auditorThinking: thinking });
		shapeChanged();
		ctx.ui.notify(`Auditor model → ${model === "auto" ? "auto (cross-family vs the builder and architect)" : model} (${thinking}).`, "info");
	};

	const applyAuditRounds = (ctx: any, rounds: number) => {
		writeStackSettings({ auditRounds: rounds });
		ctx.ui.notify(`Audit correction rounds → ${rounds}.`, "info");
	};

	const applyAnonymize = (ctx: any, on: boolean) => {
		writeStackSettings({ anonymize: on });
		shapeChanged();
		ctx.ui.notify(on ? "Anonymize ON: agents see callsigns only; the transcript and bar still show models." : "Anonymize OFF: prompts include provider/model ids.", "info");
	};

	const applyChildSubagents = (ctx: any, mode: ChildSubagents) => {
		writeStackSettings({ childSubagents: mode });
		shapeChanged();
		ctx.ui.notify(
			mode === "all"
				? "Child subagents: ALL harness children (architect and builders) get the subagent tool."
				: mode === "builders"
					? "Child subagents: only write-capable children (builders, fuser, coordinator) get the subagent tool."
					: "Child subagents: OFF — no harness child can delegate.",
			"info",
		);
	};

	const applySubagentCap = async (ctx: any, cap: number) => {
		writeStackSettings({ subagentFanOut: cap });
		applySubagentCapToPiSubagents(cap);
		shapeChanged();
		if (cap > 0) await applyFanOut(ctx, Math.min(16, cap));
		else ctx.ui.notify("Subagent fan-out OFF: children get no delegation tool.", "info");
	};

	const applyChildExa = (ctx: any, on: boolean) => {
		writeStackSettings({ childExa: on });
		shapeChanged();
		ctx.ui.notify(`Exa in children ${on ? "ON" : "OFF"}: harness children ${on ? "get" : "lose"} pi-exa's web search/fetch tools.`, "info");
	};

	const applyModelBar = (ctx: any, on: boolean) => {
		writeStackSettings({ modelBar: on });
		const hook = (globalThis as any)[STACK_MODEL_BAR_HOOK];
		if (typeof hook === "function") hook(on);
		ctx.ui.notify(`Model bar ${on ? "ON" : "OFF"}${typeof hook === "function" ? "" : " (takes effect once titan-harness is loaded)"}.`, "info");
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

	// ── model picking: favorites → cerebras → openrouter → everything ──
	type ModelRow = { key: string; authed: boolean };
	const catalog = (ctx: any): ModelRow[] => {
		try {
			const all = ctx.modelRegistry?.getAll?.() ?? ctx.modelRegistry?.getAvailable?.() ?? [];
			return all
				.map((m: any) => ({
					key: `${m.provider}/${m.id}`,
					authed: (() => {
						try {
							return !!ctx.modelRegistry.hasConfiguredAuth(m);
						} catch {
							return false;
						}
					})(),
				}))
				.sort((a: ModelRow, b: ModelRow) => a.key.localeCompare(b.key));
		} catch {
			return [];
		}
	};
	const favorites = (rows: ModelRow[]): ModelRow[] => {
		let patterns: string[] = [];
		try {
			const value = readJsonObject(PI_SETTINGS_PATH).enabledModels;
			if (Array.isArray(value)) patterns = value.filter((v): v is string => typeof v === "string");
		} catch {}
		return rows.filter((row) => patterns.some((pattern) => matchesPattern(pattern, row.key)));
	};
	const pickModel = async (ctx: any, title: string, current: string, extraChoices: string[] = []): Promise<string | undefined> => {
		const rows = catalog(ctx);
		const favs = favorites(rows);
		const cerebras = rows.filter((row) => row.key.startsWith("cerebras/"));
		const openrouter = rows.filter((row) => row.key.startsWith("openrouter/"));
		const sources: Array<[string, ModelRow[]]> = [
			[`★ Favorites (${favs.length})`, favs],
			[`Cerebras (${cerebras.length})`, cerebras],
			[`OpenRouter — full catalog (${openrouter.length})`, openrouter],
			[`All providers (${rows.length})`, rows],
		];
		const picked = await ctx.ui.select(title, [...extraChoices, ...sources.map(([label]) => label)]);
		if (!picked) return undefined;
		if (extraChoices.includes(picked)) return picked;
		const list = sources.find(([label]) => label === picked)?.[1] ?? [];
		if (!list.length) {
			ctx.ui.notify("Nothing in that list yet (unauthed providers still show once their models are in Pi's catalog).", "warning");
			return undefined;
		}
		const labels = list.map((row) => `${row.key === current ? "● " : "○ "}${row.key}${row.authed ? "" : "  (not authed)"}`);
		const choice = await ctx.ui.select(`${title} — pick a model`, labels);
		if (!choice) return undefined;
		return list[labels.indexOf(choice)]?.key;
	};
	const pickThinking = async (ctx: any, title: string, current: string): Promise<string | undefined> => {
		const choice = await ctx.ui.select(title, THINKING_LEVELS.map((level) => `${level === current ? "● " : "○ "}${level}`));
		return choice ? choice.slice(2) : undefined;
	};
	const pickSubagentModel = async (ctx: any) => {
		const stack = readStackSettings();
		const model = await pickModel(ctx, "Subagent model (pi-subagents default)", stack.subagentModel);
		if (!model) return;
		const thinking = await pickThinking(ctx, "Thinking level for subagents", stack.subagentThinking);
		if (!thinking) return;
		await applySubagentModel(ctx, model, thinking);
	};
	const pickAuditorModel = async (ctx: any) => {
		const stack = readStackSettings();
		const auto = "auto — cross-family vs the builder (recommended)";
		const model = await pickModel(ctx, "Auditor model", stack.auditorModel, [auto]);
		if (!model) return;
		const thinking = await pickThinking(ctx, "Thinking level for auditors", stack.auditorThinking);
		if (!thinking) return;
		applyAuditorModel(ctx, model === auto ? "auto" : model, thinking);
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
	const nextChildMode = (mode: ChildSubagents): ChildSubagents => CHILD_SUBAGENT_MODES[(CHILD_SUBAGENT_MODES.indexOf(mode) + 1) % CHILD_SUBAGENT_MODES.length];

	const statusText = (ctx?: any): string => {
		const stack = readStackSettings();
		const fanOut = currentFanOut();
		let excluded = "none";
		try {
			const value = workflowsSettings().excludeSubagentTools;
			if (Array.isArray(value) && value.length) excluded = `${value.length} names`;
		} catch {
			excluded = "unreadable settings file";
		}
		const authOf = (model: string): string => {
			try {
				const slash = model.indexOf("/");
				const found = ctx?.modelRegistry?.find?.(model.slice(0, slash), model.slice(slash + 1));
				return !found ? "not in catalog" : ctx.modelRegistry.hasConfiguredAuth(found) ? "authed" : `not authed → /login ${model.slice(0, slash)}`;
			} catch {
				return "";
			}
		};
		return [
			"titan-harness settings",
			`  shape           : ${stack.shape}   builders ${stack.builderFanOut}   (/titan-shape, /titan-n · Ctrl+Tab, Ctrl+Shift+N)`,
			`  auditor         : ${stack.auditor ? "ON" : "OFF"}   model ${stack.auditorModel} (${stack.auditorThinking})   rounds ${stack.auditRounds}   (/titan-audit · Ctrl+Shift+A)`,
			`  anonymize       : ${stack.anonymize ? "ON (callsigns only)" : "OFF (models in prompts)"}`,
			`  subagent tools  : ${stack.subagentTools ? "ON" : "OFF"}   (harness children ${stack.subagentTools ? "keep their tools" : "run --no-tools"}; workflows excludeSubagentTools: ${excluded})`,
			`  subagent model  : ${stack.subagentModel} (${stack.subagentThinking})   [${authOf(stack.subagentModel)}]   (Pi settings.json → subagents.defaultModel)`,
			`  subagent fan-out: ${stack.subagentFanOut > 0 ? `≤${stack.subagentFanOut} per child` : "off"}   child subagents: ${stack.childSubagents}   (/titan-s · Ctrl+Shift+S; pi-subagents globalConcurrencyLimit)`,
			`  exa in children : ${stack.childExa ? "ON" : "OFF"}   (${EXA_TOOL_NAMES.length} pi-exa tools)`,
			`  workflow fan-out: ${fanOut ?? "package default (8)"}   (~/.pi/workflows/settings.json defaultConcurrency)`,
			`  model bar       : ${stack.modelBar ? "ON" : "OFF"}   (Σ TOTALS + slots + FAN-OUT + SUBAGENT + EXA + SHAPE + AUDITOR + LEVEL rows)`,
			`  harness level   : ${stack.harnessLevel == null ? "shape-driven" : `L${stack.harnessLevel}`}   lanes b${stack.builderFanOut} w${stack.workerFanOut} wd${stack.watchdogFanOut} v${stack.verifierFanOut} exa${stack.exaFanOut}   (/titan-level · Alt+L)`,
			`  child cap       : ${stack.maxConcurrentChildren} live children   budget ${stack.budgetUsd == null ? "none" : `$${stack.budgetUsd}`}   (/stack concurrency, /stack budget)`,
			`  watchdog        : ${stack.watchdog.enabled ? "ON" : "OFF"}   ${stack.watchdog.model} (${stack.watchdog.thinking})   stalemate ${stack.watchdog.stalemateRepeats}   compaction ${stack.watchdog.onCompaction}`,
			`  run store       : ${stack.store.root}${stack.store.sqliteIndex ? " (+sqlite index)" : ""}   monitor ${stack.monitor.mode}`,
			`  settings file   : ${STACK_SETTINGS_PATH}`,
		].join("\n");
	};

	const menu = async (ctx: any) => {
		const stack = readStackSettings();
		const fanOut = currentFanOut();
		const items: Array<[string, () => Promise<void>]> = [
			[`Harness shape: ${stack.shape} · builders ${stack.builderFanOut}  → /titan-shape`, async () => {
				if (!(await invokeCommand(ctx, "titan-shape", "next"))) ctx.ui.notify("titan-harness is not loaded.", "warning");
			}],
			[`Harness level: ${stack.harnessLevel == null ? "shape-driven" : `L${stack.harnessLevel}`}  → /titan-level next`, async () => {
				if (!(await invokeCommand(ctx, "titan-level", "next"))) ctx.ui.notify("titan-harness is not loaded.", "warning");
			}],
			[`Doctor: models, credentials, tools, pins  → /titan-doctor`, async () => {
				if (!(await invokeCommand(ctx, "titan-doctor", ""))) ctx.ui.notify("titan-harness is not loaded.", "warning");
			}],
			[`Child concurrency cap: ${stack.maxConcurrentChildren} · budget ${stack.budgetUsd == null ? "none" : `$${stack.budgetUsd}`}  → /stack concurrency / budget`, async () => ctx.ui.notify("Use /stack concurrency <1-16> and /stack budget <usd|off>.", "info")],
			[`Watchdog: ${stack.watchdog.enabled ? "ON" : "OFF"}  → toggle`, async () => {
				writeStackSettings({ watchdog: { enabled: !stack.watchdog.enabled } });
				shapeChanged();
				ctx.ui.notify(`Watchdog ${!stack.watchdog.enabled ? "ON" : "OFF"}.`, "info");
			}],
			[`Auditor: ${stack.auditor ? "ON" : "OFF"}  → toggle`, async () => {
				if (!(await invokeCommand(ctx, "titan-audit", "toggle"))) ctx.ui.notify("titan-harness is not loaded.", "warning");
			}],
			[`Auditor model: ${stack.auditorModel} (${stack.auditorThinking}) · rounds ${stack.auditRounds}  → change`, () => pickAuditorModel(ctx)],
			[`Anonymize (callsigns only): ${stack.anonymize ? "ON" : "OFF"}  → toggle`, async () => applyAnonymize(ctx, !stack.anonymize)],
			[`Subagent model: ${stack.subagentModel} (${stack.subagentThinking})  → change`, () => pickSubagentModel(ctx)],
			[`Subagent fan-out: ${stack.subagentFanOut > 0 ? `≤${stack.subagentFanOut}` : "off"} · children: ${stack.childSubagents}  → /titan-s`, async () => {
				if (!(await invokeCommand(ctx, "titan-s", "next"))) ctx.ui.notify("titan-harness is not loaded.", "warning");
			}],
			[`Child subagents: ${stack.childSubagents}  → ${nextChildMode(stack.childSubagents)}`, async () => applyChildSubagents(ctx, nextChildMode(stack.childSubagents))],
			[`Subagent tools: ${stack.subagentTools ? "ON" : "OFF"}  → turn ${stack.subagentTools ? "OFF" : "ON"}`, () => applySubagentTools(ctx, !stack.subagentTools)],
			[`Exa in children: ${stack.childExa ? "ON" : "OFF"}  → toggle`, async () => applyChildExa(ctx, !stack.childExa)],
			[`Workflow fan-out: ${fanOut ?? "default (8)"}  → change`, () => pickFanOut(ctx)],
			[`Model bar: ${stack.modelBar ? "ON" : "OFF"}  → toggle`, async () => applyModelBar(ctx, !stack.modelBar)],
			["Open workflows run navigator", async () => {
				if (!(await invokeCommand(ctx, "workflows", "ui"))) ctx.ui.notify("pi-dynamic-workflows is not loaded.", "warning");
			}],
			["Context window (/ctx)", async () => {
				if (!(await invokeCommand(ctx, "ctx", ""))) ctx.ui.notify("/ctx is not loaded.", "warning");
			}],
			["Show current settings", async () => ctx.ui.notify(statusText(ctx), "info")],
		];
		const picked = await ctx.ui.select("titan-harness", items.map(([label]) => label));
		if (!picked) return;
		const item = items.find(([label]) => label === picked);
		if (item) await item[1]();
	};

	const handler = async (args: string, ctx: any) => {
		const parts = args.trim().split(/\s+/).filter(Boolean);
		const verb = (parts[0] ?? "").toLowerCase();
		const value = parts[1] ?? "";
		const onOff = (v: string): boolean | undefined => (v.toLowerCase() === "on" ? true : v.toLowerCase() === "off" ? false : undefined);
		switch (verb) {
			case "":
				return menu(ctx);
			case "tools": {
				const on = onOff(value);
				if (on === undefined) return ctx.ui.notify("Usage: /stack tools on|off", "warning");
				return applySubagentTools(ctx, on);
			}
			case "subagent-model":
			case "model": {
				if (!value) return pickSubagentModel(ctx);
				return applySubagentModel(ctx, value, (parts[2] ?? readStackSettings().subagentThinking).toLowerCase());
			}
			case "auditor-model": {
				if (!value) return pickAuditorModel(ctx);
				return applyAuditorModel(ctx, value.toLowerCase() === "auto" ? "auto" : value, (parts[2] ?? readStackSettings().auditorThinking).toLowerCase());
			}
			case "audit-rounds": {
				const n = Number.parseInt(value, 10);
				if (!Number.isFinite(n) || n < 1 || n > 3) return ctx.ui.notify("Usage: /stack audit-rounds <1-3>", "warning");
				return applyAuditRounds(ctx, n);
			}
			case "anonymize": {
				const on = onOff(value);
				if (on === undefined) return ctx.ui.notify("Usage: /stack anonymize on|off", "warning");
				return applyAnonymize(ctx, on);
			}
			case "child-subagents":
			case "children": {
				const mode = value.toLowerCase() as ChildSubagents;
				if (!CHILD_SUBAGENT_MODES.includes(mode)) return ctx.ui.notify("Usage: /stack child-subagents all|builders|off", "warning");
				return applyChildSubagents(ctx, mode);
			}
			case "subagent-cap":
			case "cap": {
				const n = Number.parseInt(value, 10);
				if (!Number.isFinite(n) || n < 0 || n > 16) return ctx.ui.notify("Usage: /stack subagent-cap <0-16>", "warning");
				return applySubagentCap(ctx, n);
			}
			case "exa": {
				const on = onOff(value);
				if (on === undefined) return ctx.ui.notify("Usage: /stack exa on|off", "warning");
				return applyChildExa(ctx, on);
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
			case "concurrency":
			case "cap-children": {
				const n = Number.parseInt(value, 10);
				if (!Number.isFinite(n) || n < 1 || n > 16) return ctx.ui.notify("Usage: /stack concurrency <1-16>  (live titan children at once)", "warning");
				writeStackSettings({ maxConcurrentChildren: n });
				shapeChanged();
				return ctx.ui.notify(`Child concurrency cap → ${n} (fan-out numbers are pool sizes; this is how many children run at once).`, "info");
			}
			case "budget": {
				if (value.toLowerCase() === "off" || value.toLowerCase() === "none") {
					writeStackSettings({ budgetUsd: null });
					return ctx.ui.notify("Run budget cleared.", "info");
				}
				const usd = Number.parseFloat(value);
				if (!Number.isFinite(usd) || usd < 0) return ctx.ui.notify("Usage: /stack budget <usd|off>", "warning");
				writeStackSettings({ budgetUsd: usd });
				return ctx.ui.notify(`Run budget → $${usd} (children are refused past it; the bar shows held-spend).`, "info");
			}
			case "watchdog": {
				const on = onOff(value);
				if (on === undefined) return ctx.ui.notify("Usage: /stack watchdog on|off", "warning");
				writeStackSettings({ watchdog: { enabled: on } });
				shapeChanged();
				return ctx.ui.notify(`Watchdog ${on ? "ON" : "OFF"} (titan-native; pi-subagents' child watchdog stays off).`, "info");
			}
			case "level":
				if (!(await invokeCommand(ctx, "titan-level", value || "next"))) ctx.ui.notify("titan-harness is not loaded.", "warning");
				return;
			case "doctor":
				if (!(await invokeCommand(ctx, "titan-doctor", value))) ctx.ui.notify("titan-harness is not loaded.", "warning");
				return;
			case "status":
				return ctx.ui.notify(statusText(ctx), "info");
			default:
				return ctx.ui.notify("Usage: /stack [tools on|off | subagent-model <provider/id> [thinking] | auditor-model auto|<provider/id> [thinking] | audit-rounds <1-3> | anonymize on|off | child-subagents all|builders|off | subagent-cap <0-16> | exa on|off | fanout <1-16> | concurrency <1-16> | budget <usd|off> | watchdog on|off | level [0-3|next] | doctor | bar on|off | status]", "warning");
		}
	};

	pi.registerCommand("stack", {
		description: "titan-harness settings: level, shape, auditor, watchdog, anonymize, subagent model/cap, subagent tools, exa, fan-out, concurrency cap, budget, model bar, doctor",
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
			[`Subagent model: ${stack.subagentModel} (${stack.subagentThinking})  → change`, () => pickSubagentModel(ctx)],
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
