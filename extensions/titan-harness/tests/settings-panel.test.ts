import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogPath } from "../modules/mcp-toggle.ts";
import { formatConfigList, parseTitanConfigArgs, registerTitanConfigCommand, TITAN_CONFIG_HELP } from "../modules/cmd-titan-config.ts";
import { listQuickConfigs } from "../modules/quick-configs.ts";
import { applyRowChange, buildSettingsModel, FOOTER_HELP, formatSettingsSummary, handleSettingsKey, listShapeCodenames, navigableRows, type PanelDeps, renderSettingsPanel, SHAPE_DRIVEN } from "../modules/settings-panel.ts";
import { readStackSettings, writeStackSettings } from "../modules/stack-config.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-settings-panel-"));
	dirs.push(dir);
	return dir;
};

/** A temp settings file, shapes dir (consult + levels 0–3), configs dir and a two-server catalog. */
function harness(extra: Partial<PanelDeps> = {}): PanelDeps & { root: string; userFile: string } {
	const root = scratch();
	const shapesDir = join(root, "shapes");
	mkdirSync(shapesDir, { recursive: true });
	for (const name of ["consult", "level-0", "level-1", "level-2", "level-3", "ultraplan"]) writeFileSync(join(shapesDir, `model-stack-${name}.yaml`), "version: 2\nslots: []\n");
	const packageFile = join(root, "pkg", "mcp", "mcp.json");
	mkdirSync(join(root, "pkg", "mcp"), { recursive: true });
	writeFileSync(packageFile, JSON.stringify({ mcpServers: { figma: { command: "npx", args: ["figma-mcp"] }, momentic: { command: "npx", args: ["momentic-mcp"], disabled: true } } }));
	const userFile = join(root, "home", "mcp.json");
	const paths: CatalogPath[] = [{ path: packageFile, layer: "package" }, { path: userFile, layer: "user" }, { path: join(root, "project", ".mcp.json"), layer: "project" }];
	return { root, userFile, settingsPath: join(root, "titan-harness.json"), shapesDir, configsDir: join(root, "configs"), mcp: { paths, env: {} }, models: ["cerebras/qwen-3.8-27b", "xai/grok-4.6"], now: () => new Date("2026-09-15T12:00:00Z"), ...extra };
}

describe("settings panel model", () => {
	test("buildSettingsModel lists every section and row from the defaults, the catalog and the configs", () => {
		const deps = harness();
		const model = buildSettingsModel(deps);
		expect(model.sections.map((section) => section.title)).toEqual(["Harness", "Watchdog", "Monitor", "Review", "Bar", "MCP servers", "Quick configs"]);
		const byId = Object.fromEntries(model.rows.map((row) => [row.id, row]));
		expect(byId.harnessLevel).toMatchObject({ kind: "select", value: SHAPE_DRIVEN, options: [SHAPE_DRIVEN, "0", "1", "2", "3"] });
		expect(byId.shape).toMatchObject({ kind: "select", value: "astra-gemini" });
		expect(byId.shape.options).toEqual(["consult", "level-0", "level-1", "level-2", "level-3", "ultraplan"]);
		expect(byId.builderFanOut).toMatchObject({ kind: "number", value: 2, min: 1, max: 8 });
		expect(byId.budgetUsd).toMatchObject({ kind: "number", value: 0, hint: "0 = no budget" });
		expect(byId["watchdog.enabled"]).toMatchObject({ kind: "toggle", value: false });
		expect(byId["watchdog.model"].options).toEqual(["cerebras/qwen-3.8-27b", "xai/grok-4.6"]);
		expect(byId["watchdog.onCompaction"].options).toEqual(["halt-inspect", "summary-only", "off"]);
		expect(byId["monitor.mode"]).toMatchObject({ kind: "select", value: "overlay", options: ["bar", "overlay", "split"] });
		expect(byId.auditor).toMatchObject({ kind: "toggle", value: true });
		expect(byId.modelBar).toMatchObject({ kind: "toggle", value: true });
		expect(byId["mcp:figma"]).toMatchObject({ kind: "toggle", value: true, hint: "package" });
		expect(byId["mcp:momentic"]).toMatchObject({ kind: "toggle", value: false, hint: "package · disabled in the catalog" });
		expect(byId["config:save"]).toMatchObject({ kind: "action" });
		expect(byId["config:none"]).toMatchObject({ kind: "info" });
		expect(model.levels).toEqual([0, 1, 2, 3]);
		expect(navigableRows(model)).not.toContain(model.rows.indexOf(byId["config:none"]));
		expect(listShapeCodenames(join(deps.root, "missing"))).toEqual([]);
	});

	test("applyRowChange round-trips toggles, numbers and selects into the settings file", async () => {
		const deps = harness();
		let model = buildSettingsModel(deps);
		let outcome = await applyRowChange(model, "auditor", false, deps);
		expect(readStackSettings(deps.settingsPath).auditor).toBe(false);
		expect(outcome.note).toBe("auditors → false");
		expect(outcome.model.rows.find((row) => row.id === "auditor")?.value).toBe(false);
		outcome = await applyRowChange(outcome.model, "builderFanOut", 5, deps);
		expect(readStackSettings(deps.settingsPath).builderFanOut).toBe(5);
		outcome = await applyRowChange(outcome.model, "budgetUsd", 0, deps);
		expect(readStackSettings(deps.settingsPath).budgetUsd).toBeNull();
		expect(outcome.note).toBe("budget $ → off");
		outcome = await applyRowChange(outcome.model, "budgetUsd", 25, deps);
		expect(readStackSettings(deps.settingsPath).budgetUsd).toBe(25);
		outcome = await applyRowChange(outcome.model, "watchdog.onCompaction", "summary-only", deps);
		expect(readStackSettings(deps.settingsPath).watchdog.onCompaction).toBe("summary-only");
		outcome = await applyRowChange(outcome.model, "watchdog.enabled", true, deps);
		expect(readStackSettings(deps.settingsPath).watchdog.enabled).toBe(true);
		outcome = await applyRowChange(outcome.model, "monitor.mode", "split", deps);
		expect(readStackSettings(deps.settingsPath).monitor.mode).toBe("split");
		outcome = await applyRowChange(outcome.model, "nope", 1, deps);
		expect(outcome.note).toBe("unknown setting nope");
		model = outcome.model;
		expect(model.settings.builderFanOut).toBe(5);
	});

	test("level and shape rows go through the live loader when one is given, else the settings file", async () => {
		const loads: Array<[string, number | null | undefined]> = [];
		const deps = harness({ loadShape: (codename, level) => loads.push([codename, level]) });
		const model = buildSettingsModel(deps);
		let outcome = await applyRowChange(model, "harnessLevel", "3", deps);
		expect(loads).toEqual([["level-3", 3]]);
		expect(outcome.note).toBe("level 3 applied");
		outcome = await applyRowChange(outcome.model, "shape", "consult", deps);
		expect(loads[1]).toEqual(["consult", null]);
		outcome = await applyRowChange(outcome.model, "harnessLevel", SHAPE_DRIVEN, deps);
		expect(readStackSettings(deps.settingsPath).harnessLevel).toBeNull();
		const bare = harness();
		const written = await applyRowChange(buildSettingsModel(bare), "harnessLevel", "2", bare);
		expect(readStackSettings(bare.settingsPath)).toMatchObject({ harnessLevel: 2, shape: "level-2" });
		expect(written.note).toContain("level 2 written");
		const failing = harness({
			loadShape: () => {
				throw new Error("not runnable");
			},
		});
		const failed = await applyRowChange(buildSettingsModel(failing), "shape", "consult", failing);
		expect(failed.note).toBe("shape consult: not runnable");
	});

	test("MCP toggles write the user file, ask for a reload and reflect in the rebuilt model", async () => {
		const deps = harness();
		const model = buildSettingsModel(deps);
		const outcome = await applyRowChange(model, "mcp:momentic", true, deps);
		expect(outcome.needsReload).toBe(true);
		expect(outcome.note).toContain("mcp momentic enabled in user config (entry created) — /reload to apply");
		expect(JSON.parse(readFileSync(deps.userFile, "utf8")).mcpServers.momentic.disabled).toBe(false);
		expect(outcome.model.rows.find((row) => row.id === "mcp:momentic")).toMatchObject({ value: true, hint: "user" });
		expect(outcome.model.needsReload).toBe(true);
		// The reload flag sticks for the panel's lifetime and shows in the title.
		const later = await applyRowChange(outcome.model, "modelBar", false, deps);
		expect(later.model.needsReload).toBe(true);
		expect(renderSettingsPanel(later.model, { width: 80, height: 30, cursor: 0 })[0]).toContain("/reload pending");
		const none = await applyRowChange(model, "mcp:none", true, deps);
		expect(none.note).toBe("no MCP servers to toggle");
	});

	test("quick configs: save → list → apply through the model, round-tripping settings and MCP states", async () => {
		const deps = harness();
		let outcome = await applyRowChange(buildSettingsModel(deps), "builderFanOut", 4, deps);
		outcome = await applyRowChange(outcome.model, "mcp:momentic", true, deps);
		outcome = await applyRowChange(outcome.model, "config:save", "ops", deps);
		expect(outcome.note).toContain("saved quick config ops");
		expect(listQuickConfigs(deps.configsDir).map((row) => row.name)).toEqual(["ops"]);
		expect(outcome.model.rows.find((row) => row.id === "config:apply:ops")).toMatchObject({ kind: "action", label: "apply ops" });
		// Change things, then apply the saved config back.
		outcome = await applyRowChange(outcome.model, "builderFanOut", 1, deps);
		outcome = await applyRowChange(outcome.model, "mcp:momentic", false, deps);
		expect(readStackSettings(deps.settingsPath).builderFanOut).toBe(1);
		outcome = await applyRowChange(outcome.model, "config:apply:ops", undefined, deps);
		expect(outcome.note).toContain("applied ops");
		expect(readStackSettings(deps.settingsPath).builderFanOut).toBe(4);
		expect(JSON.parse(readFileSync(deps.userFile, "utf8")).mcpServers.momentic.disabled).toBe(false);
		expect(outcome.needsReload).toBe(true);
		const bad = await applyRowChange(outcome.model, "config:save", "Bad Name", deps);
		expect(bad.note).toContain("config name must match");
		const missing = await applyRowChange(outcome.model, "config:apply:ghost", undefined, deps);
		expect(missing.note).toContain("no quick config named");
	});

	test("handleSettingsKey: navigation wraps over navigable rows, space/left/right edit, s prompts, escape closes", async () => {
		const deps = harness();
		const model = buildSettingsModel(deps);
		const nav = navigableRows(model);
		let out = await handleSettingsKey(model, nav[0], "up", deps);
		expect(out.cursor).toBe(nav[nav.length - 1]);
		out = await handleSettingsKey(model, out.cursor, "down", deps);
		expect(out.cursor).toBe(nav[0]);
		// harnessLevel select: right → "0", left from "0" → shape-driven.
		out = await handleSettingsKey(model, nav[0], "right", deps);
		expect(out.model.rows[nav[0]].value).toBe("0");
		expect(readStackSettings(deps.settingsPath)).toMatchObject({ harnessLevel: 0, shape: "level-0" });
		out = await handleSettingsKey(out.model, nav[0], "left", deps);
		expect(out.model.rows[nav[0]].value).toBe(SHAPE_DRIVEN);
		// builders number: right steps +1 within bounds, left −1.
		const builders = out.model.rows.findIndex((row) => row.id === "builderFanOut");
		out = await handleSettingsKey(out.model, builders, "right", deps);
		expect(out.model.rows[builders].value).toBe(3);
		out = await handleSettingsKey(out.model, builders, "left", deps);
		expect(out.model.rows[builders].value).toBe(2);
		// toggle via space and return.
		const auditor = out.model.rows.findIndex((row) => row.id === "auditor");
		out = await handleSettingsKey(out.model, auditor, "space", deps);
		expect(out.model.rows[auditor].value).toBe(false);
		out = await handleSettingsKey(out.model, auditor, "return", deps);
		expect(out.model.rows[auditor].value).toBe(true);
		// s asks the host for a name; escape closes.
		out = await handleSettingsKey(out.model, auditor, "s", deps);
		expect(out.prompt).toBe("config-name");
		const save = out.model.rows.findIndex((row) => row.id === "config:save");
		out = await handleSettingsKey(out.model, save, "return", deps);
		expect(out.prompt).toBe("config-name");
		out = await handleSettingsKey(out.model, auditor, "escape", deps);
		expect(out.close).toBe(true);
		out = await handleSettingsKey(out.model, auditor, "x", deps);
		expect(out.close).toBeUndefined();
	});

	test("renderSettingsPanel fits the width, clips to the height with the cursor visible, and paints roles", () => {
		const deps = harness();
		const model = buildSettingsModel(deps, "hello note");
		const roles: string[] = [];
		const lines = renderSettingsPanel(model, { width: 90, height: 18, cursor: 3, color: (role, text) => (roles.push(role), text) });
		expect(lines).toHaveLength(18);
		for (const line of lines) expect([...line].length).toBeLessThanOrEqual(90);
		expect(lines[0]).toContain("⚙ titan settings");
		expect(lines[lines.length - 1]).toBe(FOOTER_HELP);
		expect(lines[lines.length - 2]).toBe(" hello note");
		const narrow = renderSettingsPanel(model, { width: 60, height: 18, cursor: 3 });
		for (const line of narrow) expect([...line].length).toBeLessThanOrEqual(60);
		expect(narrow[narrow.length - 1].endsWith("…")).toBe(true);
		expect(lines.some((line) => line.startsWith(" › "))).toBe(true);
		expect(lines.some((line) => line.includes("[x] exa in children") || line.includes("[x]"))).toBe(true);
		expect(roles).toEqual(expect.arrayContaining(["title", "header", "cursor", "on", "hint", "footer", "note"]));
		// A cursor deep in the list scrolls the window so its line is visible.
		const last = navigableRows(model).pop()!;
		const deep = renderSettingsPanel(model, { width: 60, height: 12, cursor: last });
		expect(deep).toHaveLength(12);
		expect(deep.some((line) => line.startsWith(" › "))).toBe(true);
		const summary = formatSettingsSummary(model);
		expect(summary).toContain("Harness:");
		expect(summary).toContain("level: shape-driven");
		expect(summary).toContain("budget $: off");
		expect(summary).toContain("momentic: off (package · disabled in the catalog)");
	});
});

describe("/titan-config", () => {
	test("parseTitanConfigArgs covers every verb, the --project flag and the error cases", () => {
		expect(parseTitanConfigArgs("")).toMatchObject({ verb: "show", scope: "user", errors: [] });
		expect(parseTitanConfigArgs("save ops night run")).toMatchObject({ verb: "save", name: "ops", note: "night run" });
		expect(parseTitanConfigArgs("apply")).toMatchObject({ verb: "apply", errors: ["apply needs a config name"] });
		expect(parseTitanConfigArgs("mcp momentic on --project")).toMatchObject({ verb: "mcp", server: "momentic", enabled: true, scope: "project" });
		expect(parseTitanConfigArgs("mcp figma disable")).toMatchObject({ enabled: false });
		expect(parseTitanConfigArgs("mcp figma maybe").errors).toEqual(["mcp needs on|off"]);
		expect(parseTitanConfigArgs("dance").verb).toBe("help");
		expect(formatConfigList([])).toContain("no quick configs saved yet");
		expect(TITAN_CONFIG_HELP).toContain("/titan-config panel");
	});

	test("the command runs through a fake pi: save, list, apply, mcp toggle, show", async () => {
		const deps = harness();
		const notices: string[] = [];
		const panels: Array<[string, string]> = [];
		let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
		const pi = { registerCommand: (_name: string, spec: any) => (handler = spec.handler) } as any;
		registerTitanConfigCommand(pi, {
			cwd: () => deps.root,
			notify: (_ctx, text) => notices.push(text),
			panel: (_ctx, title, md) => panels.push([title, md]),
			settingsPath: deps.settingsPath,
			configsDir: deps.configsDir,
			mcp: deps.mcp,
			models: () => deps.models!,
		});
		expect(handler).toBeDefined();
		writeStackSettings({ builderFanOut: 6 }, deps.settingsPath);
		await handler!("save ops nightly", {});
		expect(notices.at(-1)).toContain("saved ops");
		expect(listQuickConfigs(deps.configsDir)[0]).toMatchObject({ name: "ops", note: "nightly" });
		await handler!("list", {});
		expect(panels.at(-1)![1]).toContain("ops");
		await handler!("mcp momentic on", {});
		expect(notices.at(-1)).toContain("momentic enabled in user config");
		expect(JSON.parse(readFileSync(deps.userFile, "utf8")).mcpServers.momentic.disabled).toBe(false);
		writeStackSettings({ builderFanOut: 1 }, deps.settingsPath);
		await handler!("apply ops", {});
		expect(notices.at(-1)).toContain("applied ops");
		expect(readStackSettings(deps.settingsPath).builderFanOut).toBe(6);
		await handler!("show", {});
		expect(panels.at(-1)![0]).toContain("SHOW");
		expect(panels.at(-1)![1]).toContain("builders: 6");
		await handler!("delete ops", {});
		expect(listQuickConfigs(deps.configsDir)).toEqual([]);
		await handler!("panel", {});
		expect(notices.at(-1)).toContain("needs the TUI");
		await handler!("mcp", {});
		expect(notices.at(-1)).toContain("mcp needs a server name");
	});
});
