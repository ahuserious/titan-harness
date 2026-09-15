import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyQuickConfig,
	CAPTURED_KEYS,
	configPath,
	deleteQuickConfig,
	listQuickConfigs,
	loadQuickConfig,
	parseQuickConfig,
	sanitizeSettingsPatch,
	saveQuickConfig,
	snapshotCurrent,
	validateConfigName,
} from "../modules/quick-configs.ts";
import { DEFAULT_STACK_SETTINGS, readStackSettings, type StackSettingsPatch, writeStackSettings } from "../modules/stack-config.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-quick-configs-"));
	dirs.push(dir);
	return dir;
};

describe("quick configs", () => {
	test("names are validated and mapped to <dir>/<name>.json", () => {
		expect(validateConfigName("  fast-l1 ")).toBe("fast-l1");
		expect(() => validateConfigName("Bad Name")).toThrow("config name must match");
		expect(() => validateConfigName("../escape")).toThrow();
		expect(() => validateConfigName("")).toThrow();
		expect(configPath("night.ops", "/x")).toBe("/x/night.ops.json");
	});

	test("snapshotCurrent captures only the operator-facing keys plus shape, level and the MCP map", () => {
		const settings = { ...DEFAULT_STACK_SETTINGS, shape: "level-2", harnessLevel: 2, budgetUsd: 12, watchdog: { ...DEFAULT_STACK_SETTINGS.watchdog, enabled: true }, store: { root: "/nowhere", sqliteIndex: true }, shiftTabHintShown: true, schedules: { wf: { armed: true } } };
		const cfg = snapshotCurrent({ settings, mcpServers: [{ name: "figma", enabled: true }, { name: "momentic", enabled: false }], note: " night ops " }, "night-ops", new Date("2026-09-15T12:00:00Z"));
		expect(cfg.name).toBe("night-ops");
		expect(cfg.savedAt).toBe("2026-09-15T12:00:00.000Z");
		expect(cfg.note).toBe("night ops");
		expect(cfg.shape).toBe("level-2");
		expect(cfg.level).toBe(2);
		expect(cfg.mcp).toEqual({ figma: true, momentic: false });
		for (const key of CAPTURED_KEYS) expect(cfg.settings).toHaveProperty(key);
		expect(cfg.settings.watchdog?.enabled).toBe(true);
		expect(cfg.settings.monitor?.mode).toBe("overlay");
		expect(cfg.settings).not.toHaveProperty("store");
		expect(cfg.settings).not.toHaveProperty("schedules");
		expect(cfg.settings).not.toHaveProperty("shiftTabHintShown");
		expect(cfg.settings).not.toHaveProperty("levelRestore");
	});

	test("save → list → load round-trips atomically with 0600 files, and delete removes", () => {
		const dir = join(scratch(), "configs");
		const cfg = snapshotCurrent({ settings: DEFAULT_STACK_SETTINGS }, "alpha", new Date("2026-09-15T00:00:00Z"));
		const file = saveQuickConfig(cfg, dir);
		expect(file).toBe(join(dir, "alpha.json"));
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
		saveQuickConfig({ ...cfg, name: "beta", savedAt: "2026-09-16T00:00:00.000Z", mcp: { figma: false } }, dir);
		writeFileSync(join(dir, "broken.json"), "{ not json");
		const rows = listQuickConfigs(dir);
		expect(rows.map((row) => row.name)).toEqual(["alpha", "beta"]);
		expect(rows[1].mcpCount).toBe(1);
		const loaded = loadQuickConfig("alpha", dir);
		expect(loaded.config).toEqual(cfg);
		expect(loaded.dropped).toEqual([]);
		expect(() => loadQuickConfig("missing", dir)).toThrow("no quick config named");
		expect(deleteQuickConfig("alpha", dir)).toBe(true);
		expect(deleteQuickConfig("alpha", dir)).toBe(false);
		expect(listQuickConfigs(join(dir, "nope"))).toEqual([]);
	});

	test("unknown or ill-typed keys are dropped, never applied", () => {
		const { settings, dropped } = sanitizeSettingsPatch({ builderFanOut: 99, workerFanOut: "five", auditor: "yes", budgetUsd: -3, harnessLevel: 7, watchdog: { enabled: true, model: "not-a-model", thinking: "xhigh", onCompaction: "nope" }, monitor: { mode: "sidebar" }, evil: "x", subagentModel: "cerebras/qwen-3.8-27b" });
		expect(settings.builderFanOut).toBe(8); // clamped
		expect(settings.subagentModel).toBe("cerebras/qwen-3.8-27b");
		expect(settings.watchdog).toEqual({ enabled: true, thinking: "xhigh" });
		expect(settings).not.toHaveProperty("workerFanOut");
		expect(settings).not.toHaveProperty("auditor");
		expect(settings).not.toHaveProperty("budgetUsd");
		expect(settings).not.toHaveProperty("harnessLevel");
		expect(settings).not.toHaveProperty("monitor");
		expect(dropped).toEqual(expect.arrayContaining(["workerFanOut", "auditor", "budgetUsd", "harnessLevel", "monitor.mode", "evil"]));
		const parsed = parseQuickConfig({ name: "x", settings: { modelBar: false }, level: 9, mcp: { "bad name": true, figma: "yes", relume: false } });
		expect(parsed.config.level).toBeUndefined();
		expect(parsed.config.mcp).toEqual({ relume: false });
		expect(parsed.dropped).toEqual(expect.arrayContaining(["mcp.bad name", "mcp.figma"]));
		expect(() => parseQuickConfig([])).toThrow("must be a JSON object");
	});

	test("applyQuickConfig writes settings, loads the shape/level and toggles MCP servers, reporting what it skipped", async () => {
		const settingsPath = join(scratch(), "titan-harness.json");
		const writes: StackSettingsPatch[] = [];
		const toggles: Array<[string, boolean]> = [];
		const shapes: Array<[string, number | null | undefined]> = [];
		const cfg = { name: "ops", savedAt: "2026-09-15T00:00:00.000Z", settings: { builderFanOut: 3, watchdog: { enabled: true } } as StackSettingsPatch, shape: "level-2", level: 2, mcp: { figma: true, broken: false } };
		const outcome = await applyQuickConfig(cfg, {
			writeSettings: (patch) => {
				writes.push(patch);
				return writeStackSettings(patch, settingsPath);
			},
			setMcpEnabled: (server, enabled) => {
				if (server === "broken") throw new Error("not in any catalog layer");
				toggles.push([server, enabled]);
			},
			loadShape: (codename, level) => {
				shapes.push([codename, level]);
			},
		});
		expect(writes[0]).toMatchObject({ builderFanOut: 3, shape: "level-2", harnessLevel: 2, watchdog: { enabled: true } });
		expect(readStackSettings(settingsPath)).toMatchObject({ builderFanOut: 3, shape: "level-2", harnessLevel: 2 });
		expect(readStackSettings(settingsPath).watchdog.enabled).toBe(true);
		expect(shapes).toEqual([["level-2", 2]]);
		expect(toggles).toEqual([["figma", true]]);
		expect(outcome.needsReload).toBe(true);
		expect(outcome.applied).toEqual(["settings (4 keys)", "shape level-2 (level 2)", "mcp figma on"]);
		expect(outcome.skipped).toEqual(["mcp broken: not in any catalog layer"]);
		// Without a loader or toggles the config still lands in the settings file and says so.
		const bare = await applyQuickConfig(cfg, { writeSettings: (patch) => writeStackSettings(patch, settingsPath) });
		expect(bare.skipped).toEqual(["shape level-2 (settings written; no live loader)", "mcp figma (no toggle available)", "mcp broken (no toggle available)"]);
		expect(bare.needsReload).toBe(false);
		expect(readFileSync(settingsPath, "utf8")).toContain('"builderFanOut": 3');
	});
});
