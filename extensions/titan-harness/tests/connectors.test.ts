import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	automationRecipes,
	connectorsPath,
	DEFAULT_CONNECTORS,
	defaultProbes,
	dryRunConnectors,
	ensureConnectorsFile,
	loadConnectors,
	parseConnectors,
	renderConnectorTable,
	renderConnectorsYaml,
} from "../modules/connectors.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-connectors-"));
	dirs.push(dir);
	return dir;
};

const probes = (over: Partial<{ servers: string[]; bins: string[]; env: string[] }> = {}) => ({
	mcpServers: () => over.servers ?? [],
	which: (bin: string) => ((over.bins ?? []).includes(bin) ? `/usr/bin/${bin}` : undefined),
	env: (name: string) => (over.env ?? []).includes(name),
});

describe("connectors.yaml", () => {
	test("the default catalog renders and parses back unchanged", () => {
		const text = renderConnectorsYaml();
		expect(text.startsWith("# .titan/terraform/connectors.yaml")).toBe(true);
		const parsed = parseConnectors(text);
		expect(parsed.map((c) => c.name)).toEqual(DEFAULT_CONNECTORS.map((c) => c.name));
		expect(parsed.find((c) => c.name === "infranodus")).toMatchObject({ kind: "mcp", server: "infranodus", env: ["INFRANODUS_API_KEY"] });
		expect(parsed.find((c) => c.name === "github")).toMatchObject({ kind: "cli", bin: "gh" });
		expect(parsed.find((c) => c.name === "linear")).toMatchObject({ kind: "orca", command: "linear" });
		expect(parsed.find((c) => c.name === "analytics-db")).toMatchObject({ kind: "script", env: ["ANALYTICS_DATABASE_URL"] });
		expect(text).not.toMatch(/=[^\s]/); // no assignments anywhere in the shipped file
	});

	test("refuses credential values, unknown kinds, bad names and duplicates", () => {
		expect(() => parseConnectors("connectors:\n  - { name: db, kind: script, env: ['DATABASE_URL=postgres://x'] }\n")).toThrow(/NAMES only/);
		expect(() => parseConnectors("connectors:\n  - { name: db, kind: script, env: ['lowercase'] }\n")).toThrow(/not an environment variable name/);
		expect(() => parseConnectors("connectors:\n  - { name: x, kind: ftp }\n")).toThrow(/kind must be one of/);
		expect(() => parseConnectors("connectors:\n  - { name: 'Bad Name', kind: cli }\n")).toThrow(/name must match/);
		expect(() => parseConnectors("connectors:\n  - { name: a, kind: cli }\n  - { name: a, kind: cli }\n")).toThrow(/duplicate/);
		expect(() => parseConnectors("nope: 1\n")).toThrow(/expected a `connectors:` list/);
		expect(parseConnectors("")).toEqual([]);
	});

	test("loadConnectors returns the defaults unwritten; ensureConnectorsFile creates once and never overwrites", () => {
		const cwd = scratch();
		const absent = loadConnectors(cwd);
		expect(absent.exists).toBe(false);
		expect(absent.connectors).toBe(DEFAULT_CONNECTORS);
		expect(existsSync(connectorsPath(cwd))).toBe(false);
		const first = ensureConnectorsFile(cwd);
		expect(first.created).toBe(true);
		writeFileSync(first.path, "connectors:\n  - { name: only, kind: cli, bin: gh, purpose: t }\n");
		expect(ensureConnectorsFile(cwd).created).toBe(false);
		const loaded = loadConnectors(cwd);
		expect(loaded.exists).toBe(true);
		expect(loaded.connectors.map((c) => c.name)).toEqual(["only"]);
		writeFileSync(first.path, "connectors: [ { name: x, kind: nope } ]\n");
		expect(() => loadConnectors(cwd)).toThrow(/kind must be one of/);
	});
});

describe("dryRunConnectors", () => {
	test("marks reachable and vacant by NAME, never by value", () => {
		const results = dryRunConnectors(DEFAULT_CONNECTORS, probes({ servers: ["macro", "figma", "infranodus"], bins: ["gh"], env: ["ANALYTICS_DATABASE_URL"] }));
		const byName = Object.fromEntries(results.map((r) => [r.name, r]));
		expect(byName.macro).toMatchObject({ reachable: true, needs: [] });
		expect(byName.figma.reachable).toBe(true);
		expect(byName.infranodus).toMatchObject({ reachable: false, needs: ["env INFRANODUS_API_KEY"] });
		expect(byName.brandfetch.needs).toEqual(["mcp server brandfetch (disabled or not in the catalog)"]);
		expect(byName.github.reachable).toBe(true);
		expect(byName.linear).toMatchObject({ reachable: false, needs: ["binary orca on PATH"] });
		expect(byName["analytics-db"].reachable).toBe(true);
		const table = renderConnectorTable(results);
		expect(table).toContain("| infranodus | mcp | ○ vacant | env INFRANODUS_API_KEY |");
		expect(table).toContain("| macro | mcp | ✓ reachable |");
		expect(table).not.toContain("postgres");
		const allVacant = dryRunConnectors(DEFAULT_CONNECTORS, probes());
		expect(allVacant.every((r) => !r.reachable)).toBe(true);
		expect(allVacant.find((r) => r.name === "infranodus")!.needs).toEqual(["env INFRANODUS_API_KEY", "mcp server infranodus (disabled or not in the catalog)"]);
	});

	test("defaultProbes reads presence only", () => {
		const env = { PATH: "/definitely/not/a/dir", PRESENT: "value-that-must-not-leak", EMPTY: "" } as NodeJS.ProcessEnv;
		const real = defaultProbes(scratch(), env);
		expect(real.env("PRESENT")).toBe(true);
		expect(real.env("EMPTY")).toBe(false);
		expect(real.env("ABSENT")).toBe(false);
		expect(real.which("no-such-binary-xyz")).toBeUndefined();
		expect(Array.isArray(real.mcpServers())).toBe(true);
	});
});

describe("automationRecipes", () => {
	test("one orca automations recipe per installed workflow with a trigger", () => {
		const cwd = scratch();
		const user = join(scratch(), "user-workflows");
		const pkg = join(scratch(), "pkg-workflows");
		mkdirSync(join(cwd, ".titan", "workflows", "nightly-sweep"), { recursive: true });
		writeFileSync(join(cwd, ".titan", "workflows", "nightly-sweep", "nightly-sweep.yaml"), "apiVersion: titan.harness/v1\nname: nightly-sweep\ntrigger: { every: 6h }\nnodes:\n  - { id: a, bash: echo hi }\n");
		mkdirSync(join(cwd, ".titan", "workflows", "manual-only"), { recursive: true });
		writeFileSync(join(cwd, ".titan", "workflows", "manual-only", "manual-only.yaml"), "apiVersion: titan.harness/v1\nname: manual-only\nnodes:\n  - { id: a, bash: echo hi }\n");
		mkdirSync(join(cwd, ".titan", "workflows", "broken"), { recursive: true });
		writeFileSync(join(cwd, ".titan", "workflows", "broken", "broken.yaml"), "trigger: [\n");
		const recipes = automationRecipes(cwd, { overrides: { user, package: pkg }, packageRoot: "/pkg" });
		expect(recipes.map((r) => r.workflow)).toEqual(["nightly-sweep"]);
		expect(recipes[0].recipe).toContain("orca automations create");
		expect(recipes[0].recipe).toContain("--name titan-nightly-sweep");
		expect(recipes[0].recipe).toContain("titan-lock-check.mjs nightly-sweep");
		expect(recipes[0].recipe).toContain('/workflow run nightly-sweep');
		expect(recipes[0].trigger).toEqual({ every: "6h" });
		expect(readFileSync(join(cwd, ".titan", "workflows", "broken", "broken.yaml"), "utf8")).toContain("trigger"); // untouched, just skipped
	});
});
