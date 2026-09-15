import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyLevel, describeLevel, fanoutForStack, leaveLevel, LEVEL_CODENAMES, levelShapePath, listLevels, loadLevelStack, nextLevel } from "../modules/levels.ts";
import { loadModelStack } from "../modules/model-stack.ts";
import { BUILDER_FANOUT_CYCLE, DEFAULT_STACK_SETTINGS, LEVEL_CYCLE, readStackSettings, writeStackSettings } from "../modules/stack-config.ts";

const SHIPPED = fileURLToPath(new URL("../../../.pi/titan-harness/", import.meta.url));
const REBIND = fileURLToPath(new URL("../../../scripts/keybindings-rebind.mjs", import.meta.url));

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), "titan-levels-test-")); dirs.push(dir); return dir; };
const settingsIn = (dir: string) => join(dir, "titan-harness.json");

describe("levels", () => {
  test("codenames and shape paths", () => {
    expect(LEVEL_CODENAMES).toEqual(["level-0", "level-1", "level-2", "level-3"]);
    expect(LEVEL_CYCLE).toEqual([0, 1, 2, 3]);
    expect(levelShapePath(3, "/x/y")).toBe("/x/y/model-stack-level-3.yaml");
    expect(levelShapePath(0).endsWith(join(".pi", "titan-harness", "model-stack-level-0.yaml"))).toBe(true);
  });

  test("listLevels reports only the levels whose shape file exists", () => {
    const dir = tmp();
    expect(listLevels(dir)).toEqual([]);
    expect(listLevels(join(dir, "missing"))).toEqual([]);
    copyFileSync(join(SHIPPED, "model-stack-level-0.yaml"), levelShapePath(0, dir));
    copyFileSync(join(SHIPPED, "model-stack-level-3.yaml"), levelShapePath(3, dir));
    expect(listLevels(dir)).toEqual([0, 3]);
    expect(listLevels(SHIPPED)).toEqual([0, 1, 2, 3]);
  });

  test("nextLevel wraps, skips missing levels, and starts at the lowest", () => {
    expect(nextLevel(undefined, [0, 1, 2, 3])).toBe(0);
    expect(nextLevel(null, [1, 3])).toBe(1);
    expect(nextLevel(0, [0, 1, 2, 3])).toBe(1);
    expect(nextLevel(3, [0, 1, 2, 3])).toBe(0);
    expect(nextLevel(1, [0, 2])).toBe(2);
    expect(nextLevel(2, [3, 0])).toBe(3);
    expect(nextLevel(7, [0, 1])).toBe(0);
    expect(() => nextLevel(0, [])).toThrow("no level shape files");
  });

  test("shipped levels cycle 0→1→2→3→0 with the printed fan-out table", () => {
    const available = listLevels(SHIPPED);
    const walk: number[] = [];
    let level: number | undefined;
    for (let i = 0; i < 5; i++) { level = nextLevel(level, available); walk.push(level); }
    expect(walk).toEqual([0, 1, 2, 3, 0]);
    const table = Object.fromEntries(available.map((l) => [l, fanoutForStack(loadLevelStack(l, SHIPPED))]));
    expect(table).toEqual({
      0: { builders: 0, workers: 5, watchdogs: 0, verifiers: 0, exa: 5 },
      1: { builders: 0, workers: 5, watchdogs: 0, verifiers: 0, exa: 5 },
      2: { builders: 5, workers: 5, watchdogs: 5, verifiers: 0, exa: 5 },
      3: { builders: 3, workers: 5, watchdogs: 5, verifiers: 5, exa: 10 },
    });
    expect(loadLevelStack(2, SHIPPED).entry).toBe("authored-workflow");
    expect(loadLevelStack(3, SHIPPED).requires).toEqual(["terraform"]);
  });

  test("loadLevelStack rejects a file whose level does not match its name, and a v1 file", () => {
    const dir = tmp();
    writeFileSync(levelShapePath(2, dir), readFileSync(join(SHIPPED, "model-stack-level-3.yaml"), "utf8"));
    expect(() => loadLevelStack(2, dir)).toThrow("declares level 3, not 2");
    copyFileSync(join(SHIPPED, "model-stack-consult.yaml"), levelShapePath(1, dir));
    expect(() => loadLevelStack(1, dir)).toThrow("needs version: 2");
  });

  test("fanoutForStack takes exa from exa.fanout when the shape has no exa lane", () => {
    const dir = tmp();
    const file = join(dir, "model-stack-noexa.yaml");
    writeFileSync(file, `version: 2\nexa: { enabled: true, fanout: 7 }\nslots:\n  - { name: rune, architect: true, model: a/b }\n  - { name: forge, primary: true, model: c/d, fanout: 2 }\n`);
    expect(fanoutForStack(loadModelStack(file))).toEqual({ builders: 2, workers: 0, watchdogs: 0, verifiers: 0, exa: 7 });
    const ultraplan = loadModelStack(join(SHIPPED, "model-stack-ultraplan.yaml"));
    expect(fanoutForStack(ultraplan)).toEqual({ builders: 0, workers: 0, watchdogs: 0, verifiers: 0, exa: 0 });
  });

  test("applyLevel 3 writes level, shape and the five pool sizes and leaves unrelated keys alone", () => {
    const dir = tmp();
    const path = settingsIn(dir);
    writeFileSync(path, JSON.stringify({ shape: "consult", subagentFanOut: 6, auditor: false, builderFanOut: 2, watchdog: { model: "xai/grok-4.6", stalemateRepeats: 5 } }));
    const stack = loadLevelStack(3, SHIPPED);
    const next = applyLevel(3, stack, path);
    expect(next).toMatchObject({
      harnessLevel: 3,
      shape: "level-3",
      builderFanOut: 3,
      workerFanOut: 5,
      watchdogFanOut: 5,
      verifierFanOut: 5,
      exaFanOut: 10,
      childExa: true,
      auditor: true,           // review: required
      subagentFanOut: 6,       // untouched
      watchdog: { enabled: true, onCompaction: "halt-inspect", model: "xai/grok-4.6", stalemateRepeats: 5, thinking: "medium" },
    });
    expect(readStackSettings(path)).toEqual(next);
    expect(JSON.parse(readFileSync(path, "utf8")).harnessLevel).toBe(3);
    expect(readdirSync(dir)).toEqual(["titan-harness.json"]); // never touches pi-subagents / dynamic-workflows files
  });

  test("applyLevel 0 clamps builders to 1, keeps the auditor choice and turns the watchdog off", () => {
    const dir = tmp();
    const path = settingsIn(dir);
    writeFileSync(path, JSON.stringify({ auditor: false, watchdog: { enabled: true } }));
    const next = applyLevel(0, loadLevelStack(0, SHIPPED), path);
    expect(next).toMatchObject({ harnessLevel: 0, shape: "level-0", builderFanOut: 1, workerFanOut: 5, watchdogFanOut: 0, verifierFanOut: 0, exaFanOut: 5, childExa: true, auditor: false });
    expect(next.watchdog.enabled).toBe(false);
    const again = applyLevel(0, loadLevelStack(0, SHIPPED), path);
    expect(again).toEqual(next);
  });

  test("entering a level snapshots the plain-shape settings and leaveLevel restores them", () => {
    const path = settingsIn(tmp());
    writeFileSync(path, JSON.stringify({ shape: "consult", builderFanOut: 2, exaFanOut: 4, childExa: false, auditor: false, watchdog: { enabled: false } }));
    const entered = applyLevel(3, loadLevelStack(3, SHIPPED), path);
    expect(entered.levelRestore).toEqual({ builderFanOut: 2, workerFanOut: 5, watchdogFanOut: 0, verifierFanOut: 0, exaFanOut: 4, childExa: false, auditor: false, watchdogEnabled: false });
    expect(entered).toMatchObject({ harnessLevel: 3, builderFanOut: 3, exaFanOut: 10, childExa: true, auditor: true });
    // Level → level keeps the original snapshot (the pre-level settings, not level 3's).
    const hopped = applyLevel(1, loadLevelStack(1, SHIPPED), path);
    expect(hopped.levelRestore?.builderFanOut).toBe(2);
    const left = leaveLevel("consult", path);
    expect(left).toMatchObject({ harnessLevel: null, shape: "consult", builderFanOut: 2, exaFanOut: 4, childExa: false, auditor: false, levelRestore: null });
    expect(left.watchdog.enabled).toBe(false);
    // Leaving with no snapshot only clears the level.
    const again = leaveLevel("legacy", path);
    expect(again).toMatchObject({ harnessLevel: null, shape: "legacy", builderFanOut: 2 });
  });

  test("applyLevel refuses a level the shape does not declare and levels outside 0-3", () => {
    const path = settingsIn(tmp());
    const stack = loadLevelStack(3, SHIPPED);
    expect(() => applyLevel(2, stack, path)).toThrow("declares level 3, not 2");
    expect(() => applyLevel(4, stack, path)).toThrow("level must be one of 0, 1, 2, 3");
    expect(existsSync(path)).toBe(false);
  });

  test("describeLevel renders the status line", () => {
    const stack = loadLevelStack(3, SHIPPED);
    expect(describeLevel(stack, DEFAULT_STACK_SETTINGS)).toBe("L3 engineering · builders 3 · workers 5 · watchdogs 5 · verifiers 5 · exa 10 · plan → /ultraplan");
    expect(describeLevel(loadLevelStack(0, SHIPPED), DEFAULT_STACK_SETTINGS)).toBe("L0 ultrafast · builders 0 · workers 5 · watchdogs 0 · verifiers 0 · exa 5");
    const ultraplan = loadModelStack(join(SHIPPED, "model-stack-ultraplan.yaml"));
    expect(describeLevel(ultraplan, DEFAULT_STACK_SETTINGS)).toBe("ultraplan · builders 0 · workers 0 · watchdogs 0 · verifiers 0 · exa 0");
    expect(describeLevel(ultraplan, { ...DEFAULT_STACK_SETTINGS, harnessLevel: 2 })).toBe("L2 ultraplan · builders 0 · workers 0 · watchdogs 0 · verifiers 0 · exa 0");
  });
});

describe("settings store (new keys)", () => {
  test("defaults carry the new keys and the builder cycle reaches 8", () => {
    expect(BUILDER_FANOUT_CYCLE).toEqual([1, 2, 3, 4, 5, 8]);
    expect(DEFAULT_STACK_SETTINGS).toMatchObject({
      harnessLevel: null, workerFanOut: 5, watchdogFanOut: 0, verifierFanOut: 0, exaFanOut: 5, maxConcurrentChildren: 8, budgetUsd: null, shiftTabHintShown: false,
      watchdog: { enabled: false, model: "cerebras/qwen-3.8-27b", thinking: "medium", stalemateRepeats: 3, onCompaction: "halt-inspect", inspectorTimeoutMs: 20000, preemptAtContextFraction: 0.75 },
      store: { sqliteIndex: false },
      monitor: { mode: "overlay" },
    });
    expect(DEFAULT_STACK_SETTINGS.store.root.endsWith(join(".pi", "titan-harness", "runs"))).toBe(true);
    // legacy defaults unchanged
    expect(DEFAULT_STACK_SETTINGS).toMatchObject({ shape: "astra-gemini", builderFanOut: 2, subagentFanOut: 4, auditor: true, auditRounds: 2 });
  });

  test("readStackSettings validates the new keys and never hands out the shared default objects", () => {
    const path = settingsIn(tmp());
    writeFileSync(path, JSON.stringify({
      builderFanOut: 12, harnessLevel: 9, workerFanOut: 40, maxConcurrentChildren: 0, budgetUsd: -3,
      watchdog: { enabled: "yes", onCompaction: "panic", preemptAtContextFraction: 2, inspectorTimeoutMs: 5, model: "nomodel" },
      store: { root: "  ", sqliteIndex: "no" }, monitor: { mode: "sidebar" }, shiftTabHintShown: true,
    }));
    const s = readStackSettings(path);
    expect(s).toMatchObject({ builderFanOut: 8, harnessLevel: null, workerFanOut: 16, maxConcurrentChildren: 1, budgetUsd: null, shiftTabHintShown: true });
    expect(s.watchdog).toMatchObject({ enabled: false, onCompaction: "halt-inspect", preemptAtContextFraction: 0.95, inspectorTimeoutMs: 1000, model: "cerebras/qwen-3.8-27b" });
    expect(s.store).toEqual(DEFAULT_STACK_SETTINGS.store);
    expect(s.monitor.mode).toBe("overlay");
    const missing = readStackSettings(join(tmp(), "absent.json"));
    expect(missing).toEqual(DEFAULT_STACK_SETTINGS);
    expect(missing.watchdog).not.toBe(DEFAULT_STACK_SETTINGS.watchdog);
    writeFileSync(path, JSON.stringify({ harnessLevel: 2, budgetUsd: 12.5, watchdog: { enabled: true, onCompaction: "off" }, monitor: { mode: "split" } }));
    expect(readStackSettings(path)).toMatchObject({ harnessLevel: 2, budgetUsd: 12.5, watchdog: { enabled: true, onCompaction: "off" }, monitor: { mode: "split" } });
  });

  test("writeStackSettings deep-merges the nested objects", () => {
    const path = settingsIn(tmp());
    writeStackSettings({ watchdog: { model: "xai/grok-4.6" } }, path);
    const next = writeStackSettings({ watchdog: { enabled: true }, monitor: { mode: "bar" }, shape: "level-1" }, path);
    expect(next.watchdog).toMatchObject({ enabled: true, model: "xai/grok-4.6", stalemateRepeats: 3 });
    expect(next.monitor.mode).toBe("bar");
    expect(next.shape).toBe("level-1");
    expect(readStackSettings(path)).toEqual(next);
  });
});

describe("keybindings-rebind.mjs (dry-run and check only)", () => {
  const run = (...args: string[]) => {
    const proc = Bun.spawnSync({ cmd: [process.execPath, REBIND, ...args], stdout: "pipe", stderr: "pipe", env: { ...process.env, PI_CODING_AGENT_DIR: "/nonexistent-agent-dir" } });
    return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
  };

  test("--check: no file, a shift+tab list or a wrong type is reserved (exit 2); another key or [] is free", () => {
    const file = join(tmp(), "keybindings.json");
    expect(run("--check", "--file", file)).toMatchObject({ code: 2, out: "reserved\n" });
    writeFileSync(file, JSON.stringify({ "app.thinking.cycle": ["Shift+Tab", "alt+t"] }));
    expect(run("--check", "--file", file)).toMatchObject({ code: 2, out: "reserved\n" });
    writeFileSync(file, JSON.stringify({ "app.thinking.cycle": "tab+shift" }));
    expect(run("--check", "--file", file)).toMatchObject({ code: 2, out: "reserved\n" });
    writeFileSync(file, JSON.stringify({ "app.thinking.cycle": 42 }));
    expect(run("--check", "--file", file)).toMatchObject({ code: 2, out: "reserved\n" });
    writeFileSync(file, "{not json");
    expect(run("--check", "--file", file)).toMatchObject({ code: 2, out: "reserved\n" });
    writeFileSync(file, JSON.stringify({ "app.thinking.cycle": "alt+t" }));
    expect(run("--check", "--file", file)).toMatchObject({ code: 0, out: "free\n" });
    writeFileSync(file, JSON.stringify({ "app.thinking.cycle": [] }));
    expect(run("--check", "--file", file)).toMatchObject({ code: 0, out: "free\n" });
    writeFileSync(file, JSON.stringify({ "app.thinking.cycle": ["ctrl+alt+t"] }));
    expect(run("--check", "--file", file)).toMatchObject({ code: 0, out: "free\n" });
  });

  test("--dry-run prints the merged file, preserves other keys and writes nothing", () => {
    const dir = tmp();
    const file = join(dir, "keybindings.json");
    const before = JSON.stringify({ "app.model.select": "ctrl+l", "app.thinking.cycle": "shift+tab" }, null, 2);
    writeFileSync(file, before);
    const result = run("--dry-run", "--file", file);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ "app.model.select": "ctrl+l", "app.thinking.cycle": "alt+t" });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual(["keybindings.json"]); // no .bak from a dry run
    const fresh = run("--dry-run", "--file", join(dir, "absent", "keybindings.json"));
    expect(fresh.code).toBe(0);
    expect(JSON.parse(fresh.out)).toEqual({ "app.thinking.cycle": "alt+t" });
    expect(existsSync(join(dir, "absent"))).toBe(false);
    const custom = run("--dry-run", "--to", "ctrl+alt+t", "--file", file);
    expect(JSON.parse(custom.out)["app.thinking.cycle"]).toBe("ctrl+alt+t");
    expect(run("--dry-run", "--to", "not a key", "--file", file).code).toBe(1);
    expect(run("--bogus").code).toBe(1);
  });

  test("--dry-run warns when the target chord is already bound elsewhere", () => {
    const file = join(tmp(), "keybindings.json");
    writeFileSync(file, JSON.stringify({ "app.message.copy": "alt+t" }));
    const result = run("--dry-run", "--file", file);
    expect(result.code).toBe(0);
    expect(result.err).toContain("already bound to app.message.copy");
  });

  test("--restore without a backup fails without touching the file", () => {
    const file = join(tmp(), "keybindings.json");
    const result = run("--restore", "--file", file);
    expect(result.code).toBe(1);
    expect(result.err).toContain("no backup to restore");
    expect(existsSync(file)).toBe(false);
  });
});
