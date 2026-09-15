import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DW_DIST_FILE,
  DW_PACKAGE,
  DW_PATCH_MARKER,
  PINS,
  checkPins,
  defaultAgentDir,
  dwPatchApplied,
  formatPinReport,
} from "../modules/pins.ts";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function agentDir(): string { const d = mkdtempSync(join(tmpdir(), "titan-pins-")); dirs.push(d); return d; }
function installPackage(agent: string, name: string, version: string): string {
  const root = join(agent, "npm", "node_modules", name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name, version })}\n`);
  return root;
}

// A synthetic 3.10.x dist: the anchor sits at the same nesting (20 spaces) as the real file.
const PRISTINE = [
  'import { openWorkflowNavigator } from "./navigator.js";',
  "export function registerWorkflowCommands(pi, manager) {",
  '    pi.registerCommand("workflows", {',
  "        handler: async (args, ctx) => {",
  "            const parts = args.trim().split(/\\s+/).filter(Boolean);",
  "                    if (parts.length === 0 && ctx.hasUI) {",
  "                        await openWorkflowNavigator(pi, manager, ctx.ui, {",
  "                            storage: getStorage(),",
  "                            cwd: getCwd(),",
  "                            getStorage,",
  "                            getCwd,",
  "                            getManager,",
  "                        });",
  "                        return;",
  "                    }",
  "                    const runs = manager.listRuns();",
  "        },",
  "    });",
  "}",
  "",
].join("\n");

function installDw(agent: string, version = "3.10.1", dist = PRISTINE): string {
  const root = installPackage(agent, DW_PACKAGE, version);
  const file = join(root, DW_DIST_FILE);
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(file, dist);
  return file;
}

const SCRIPT = join(import.meta.dir, "..", "..", "..", "scripts", "apply-dw-patch.mjs");
function run(agent: string, ...flags: string[]) {
  const result = spawnSync("node", [SCRIPT, "--agent-dir", agent, ...flags], { encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

describe("version pins", () => {
  test("PINS lists the seven companion packages at their verified versions", () => {
    expect(PINS).toEqual({
      "pi-mcp-adapter": "2.33.0",
      "@quintinshaw/pi-dynamic-workflows": "3.10.1",
      "pi-subagents": "0.67.0",
      "pi-exa": "0.6.1",
      "pi-antigravity": "0.7.2",
      "@raindrop-ai/pi-agent": "0.2.1",
      "@signalridge/pi-codex-compact": "1.3.1",
    });
  });

  test("checkPins reports ok, drifted and missing packages in PINS order", () => {
    const agent = agentDir();
    for (const [name, version] of Object.entries(PINS)) installPackage(agent, name, version);
    expect(checkPins(agent).every((r) => r.ok)).toBe(true);

    installPackage(agent, "pi-exa", "0.7.0");
    rmSync(join(agent, "npm", "node_modules", "@raindrop-ai"), { recursive: true, force: true });
    const reports = checkPins(agent);
    expect(reports.map((r) => r.name)).toEqual(Object.keys(PINS));
    const exa = reports.find((r) => r.name === "pi-exa")!;
    expect(exa).toEqual({ name: "pi-exa", expected: "0.6.1", found: "0.7.0", ok: false });
    const raindrop = reports.find((r) => r.name === "@raindrop-ai/pi-agent")!;
    expect(raindrop.found).toBeNull();
    expect(raindrop.ok).toBe(false);
    expect(reports.filter((r) => r.ok)).toHaveLength(5);
    expect(formatPinReport(reports)).toBe("pi-exa@0.6.1 found 0.7.0 · @raindrop-ai/pi-agent@0.2.1 missing");
    expect(formatPinReport(reports.filter((r) => r.ok))).toBe("pins ok (5)");
  });

  test("an unreadable manifest counts as missing, never throws", () => {
    const agent = agentDir();
    const root = installPackage(agent, "pi-exa", "0.6.1");
    writeFileSync(join(root, "package.json"), "{ not json");
    expect(checkPins(agent).find((r) => r.name === "pi-exa")!.found).toBeNull();
    expect(() => checkPins(join(agent, "does-not-exist"))).not.toThrow();
  });

  test("defaultAgentDir follows PI_CODING_AGENT_DIR like Pi does", () => {
    expect(defaultAgentDir({})).toBe(join(homedir(), ".pi", "agent"));
    expect(defaultAgentDir({ PI_CODING_AGENT_DIR: "~/alt/agent" })).toBe(join(homedir(), "alt", "agent"));
    expect(defaultAgentDir({ PI_CODING_AGENT_DIR: "/opt/pi-agent" })).toBe("/opt/pi-agent");
  });

  test("dwPatchApplied reads the marker from the pinned dist file", () => {
    const agent = agentDir();
    expect(dwPatchApplied(agent)).toBe(false);
    const file = installDw(agent);
    expect(dwPatchApplied(agent)).toBe(false);
    writeFileSync(file, PRISTINE.replace("await openWorkflowNavigator", `const stackMenu = globalThis[${DW_PATCH_MARKER}];\n                        await openWorkflowNavigator`));
    expect(dwPatchApplied(agent)).toBe(true);
  });
});

describe("scripts/apply-dw-patch.mjs", () => {
  test("check → apply → check → restore round trip on a pristine 3.10.x dist", () => {
    const agent = agentDir();
    const file = installDw(agent);

    const pristine = run(agent, "--check");
    expect(pristine.code).toBe(2);
    expect(pristine.out).toContain("pristine");
    expect(existsSync(`${file}.orig`)).toBe(false);

    const applied = run(agent);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain("applied");
    expect(readFileSync(`${file}.orig`, "utf8")).toBe(PRISTINE);
    const patched = readFileSync(file, "utf8");
    expect(patched).toContain(DW_PATCH_MARKER);
    expect(patched).toContain("                        const openNavigator = () => openWorkflowNavigator(pi, manager, ctx.ui, {");
    expect(patched).toContain('                        if (typeof stackMenu === "function") {\n                            await stackMenu(ctx, openNavigator);\n                            return;\n                        }\n                        await openNavigator();\n                        return;\n                    }\n                    const runs = manager.listRuns();');
    expect(dwPatchApplied(agent)).toBe(true);

    const again = run(agent);
    expect(again.code).toBe(0);
    expect(again.out).toContain("already applied");
    expect(readFileSync(file, "utf8")).toBe(patched);
    expect(run(agent, "--check").code).toBe(0);

    const restored = run(agent, "--restore");
    expect(restored.code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(PRISTINE);
    expect(run(agent, "--check").code).toBe(2);
    expect(dwPatchApplied(agent)).toBe(false);
  });

  test("keeps the file's own indentation unit", () => {
    const agent = agentDir();
    const file = installDw(agent, "3.10.1", PRISTINE.replace(/^( {4})+/gm, (m) => "  ".repeat(m.length / 4)));
    expect(run(agent).code).toBe(0);
    const patched = readFileSync(file, "utf8");
    expect(patched).toContain(`\n          if (parts.length === 0 && ctx.hasUI) {\n            const openNavigator = () => openWorkflowNavigator(pi, manager, ctx.ui, {\n              storage: getStorage(),`);
    expect(patched).toContain(`\n            const stackMenu = globalThis[${DW_PATCH_MARKER}];\n`);
  });

  test("refuses every version but 3.10.x and touches nothing", () => {
    const agent = agentDir();
    const file = installDw(agent, "3.11.0");
    for (const flags of [["--check"], [], ["--restore"]]) {
      const result = run(agent, ...flags);
      expect(result.code).toBe(1);
      expect(result.out).toContain("3.10.x");
    }
    expect(readFileSync(file, "utf8")).toBe(PRISTINE);
    expect(existsSync(`${file}.orig`)).toBe(false);
  });

  test("errors on a missing package, a missing backup and an unknown layout", () => {
    const empty = agentDir();
    expect(run(empty, "--check").code).toBe(1);

    const agent = agentDir();
    const file = installDw(agent);
    expect(run(agent, "--restore").code).toBe(1);
    writeFileSync(file, PRISTINE.replace("getManager,", "getManager, extra,"));
    const unknown = run(agent, "--check");
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain("neither");
    expect(run(agent).code).toBe(1);
    expect(existsSync(`${file}.orig`)).toBe(false);
  });

  // On a machine where the real pinned package carries the patch and its .orig backup,
  // the script must reproduce the live dist byte for byte from the backup.
  const realRoot = join(defaultAgentDir(), "npm", "node_modules", DW_PACKAGE);
  const realDist = join(realRoot, DW_DIST_FILE);
  const realAvailable = existsSync(`${realDist}.orig`) && dwPatchApplied() && /^3\.10\./.test(JSON.parse(readFileSync(join(realRoot, "package.json"), "utf8")).version);
  test.skipIf(!realAvailable)("reproduces the live patched dist from the real .orig", () => {
    const agent = agentDir();
    const file = installDw(agent);
    copyFileSync(`${realDist}.orig`, file);
    expect(run(agent, "--check").code).toBe(2);
    expect(run(agent).code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(readFileSync(realDist, "utf8"));
    expect(readFileSync(`${file}.orig`, "utf8")).toBe(readFileSync(`${realDist}.orig`, "utf8"));
  });
});
