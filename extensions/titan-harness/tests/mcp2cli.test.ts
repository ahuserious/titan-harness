import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

// scripts/mcp2cli.mjs driven as a real process against tests/fixtures/mcp/fake-server.mjs
// through a temp catalog file (--catalog isolates it from the package and user catalogs).
const CLI = resolve(import.meta.dir, "..", "..", "..", "scripts", "mcp2cli.mjs");
const FAKE_SERVER = join(import.meta.dir, "fixtures", "mcp", "fake-server.mjs");
const SECRET = "abc123secretvalue";

/** The real Node on PATH (the CLI re-execs itself under --experimental-transform-types); bun otherwise. */
function nodeBinary(): string {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		const candidate = join(dir, "node");
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	return process.execPath;
}
const NODE = nodeBinary();

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function catalogFile(extra: Record<string, unknown> = {}, fakeEnv: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "titan-mcp2cli-"));
	dirs.push(dir);
	const file = join(dir, "catalog.json");
	writeFileSync(
		file,
		JSON.stringify({
			mcpServers: {
				fake: { command: process.execPath, args: [FAKE_SERVER], env: { SECRET_TOKEN: SECRET, ...fakeEnv } },
				off: { command: "node", args: ["never.js"], disabled: true },
				vacant: { command: "node", args: ["never.js"], env: { API_KEY: "${TITAN_MCP2CLI_TEST_MISSING_ENV}" } },
				remote: { url: "https://example.invalid/mcp" },
				...extra,
			},
		}),
	);
	return file;
}

function run(args: string[], env: Record<string, string> = {}) {
	const result = spawnSync(NODE, [CLI, ...args], { encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env } });
	return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("mcp2cli list / doctor", () => {
	test("list names every server with its state and env NAMES, never a value", () => {
		const file = catalogFile();
		const text = run(["list", "--catalog", file]);
		expect(text.code).toBe(0);
		expect(text.stdout).toContain("fake");
		expect(text.stdout).toMatch(/fake\s+stdio\s+enabled/);
		expect(text.stdout).toMatch(/off\s+stdio\s+disabled/);
		expect(text.stdout).toMatch(/vacant\s+stdio\s+disabled.*TITAN_MCP2CLI_TEST_MISSING_ENV/);
		expect(text.stdout).toContain("pi-mcp-adapter"); // url servers are catalogued but not spawnable here
		expect(text.stdout).not.toContain(SECRET); // a literal env value stays inside the process
		const json = run(["list", "--catalog", file, "--json"]);
		expect(json.code).toBe(0);
		const rows = JSON.parse(json.stdout) as Array<{ name: string; enabled: boolean; reason?: string; envNames: string[]; sources: string[] }>;
		const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
		expect(byName.fake.enabled).toBe(true);
		expect(byName.fake.envNames).toEqual([]); // only `${VAR}` references are names; literals are never listed
		expect(byName.vacant.envNames).toEqual(["TITAN_MCP2CLI_TEST_MISSING_ENV"]);
		expect(byName.off.enabled).toBe(false);
		expect(byName.vacant.reason).toContain("TITAN_MCP2CLI_TEST_MISSING_ENV");
		expect(byName.remote.enabled).toBe(false);
		expect(json.stdout).not.toContain(SECRET);
	});

	test("doctor prints the probe matrix as JSON: servers, binaries, the three mcp2cli flavours", () => {
		const file = catalogFile();
		const result = run(["doctor", "--catalog", file]);
		expect(result.code).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.summary).toEqual({ enabled: 1, disabled: 3 }); // fake; off (catalog), vacant (env), remote (url → pi-mcp-adapter)
		expect(report.servers.map((row: any) => row.name).sort()).toEqual(["fake", "off", "remote", "vacant"]);
		expect(report.binaries.node.present).toBe(true);
		expect(typeof report.binaries.npx.present).toBe("boolean");
		expect(typeof report.binaries.uvx.present).toBe("boolean");
		expect(report.mcp2cli.titan.available).toBe(true);
		expect(report.mcp2cli.titan.how).toBe("node scripts/mcp2cli.mjs");
		expect(["python", "rust"].every((flavour) => typeof report.mcp2cli[flavour].available === "boolean")).toBe(true);
		expect(report.catalog[0].present).toBe(true);
		expect(result.stdout).not.toContain(SECRET);
	});

	test("usage errors exit 2", () => {
		expect(run([]).code).toBe(2);
		expect(run(["bogus"]).code).toBe(2);
		expect(run(["tools"]).code).toBe(2);
		expect(run(["call", "fake"]).code).toBe(2);
		expect(run(["call", "fake", "echo", "--json", "{not json", "--catalog", catalogFile()]).code).toBe(2);
	});
});

describe("mcp2cli tools / call", () => {
	test("tools lists the fake server's tools", () => {
		const file = catalogFile();
		const text = run(["tools", "fake", "--catalog", file]);
		expect(text.code).toBe(0);
		expect(text.stdout).toMatch(/^echo\s+Echo the arguments back/m);
		expect(text.stdout).toMatch(/^boom\s+Always fails/m);
		const json = run(["tools", "fake", "--catalog", file, "--json"]);
		expect(JSON.parse(json.stdout).map((tool: { name: string }) => tool.name)).toEqual(["echo", "boom"]);
	});

	test("call echo with key=value and --json args returns the structured echo and exits 0", () => {
		const file = catalogFile();
		const kv = run(["call", "fake", "echo", "text=hello", "n=3", "flag=true", "--catalog", file]);
		expect(kv.code).toBe(0);
		expect(JSON.parse(kv.stdout)).toEqual({ echoed: { text: "hello", n: 3, flag: true } });
		const json = run(["call", "fake", "echo", "--json", '{"text":"from json","extra":[1,2]}', "text=override", "--catalog", file]);
		expect(json.code).toBe(0);
		expect(JSON.parse(json.stdout)).toEqual({ echoed: { text: "override", extra: [1, 2] } });
		const text = run(["call", "fake", "echo", "text=plain", "--text", "--catalog", file]);
		expect(text.code).toBe(0);
		expect(text.stdout).toContain('"text": "plain"');
	});

	test("call boom exits 1 and prints the error text; an unknown tool exits 1", () => {
		const file = catalogFile();
		const boom = run(["call", "fake", "boom", "reason=nope", "--catalog", file]);
		expect(boom.code).toBe(1);
		expect(boom.stdout).toContain("boom failed: nope");
		const unknown = run(["call", "fake", "nope", "--catalog", file]);
		expect(unknown.code).toBe(1);
		expect(unknown.stderr).toContain("unknown tool");
	});

	test("a disabled, vacant, unknown or url server exits 3 and names the reason without values", () => {
		const file = catalogFile();
		const off = run(["call", "off", "echo", "--catalog", file]);
		expect(off.code).toBe(3);
		expect(off.stderr).toContain("disabled");
		const vacant = run(["tools", "vacant", "--catalog", file]);
		expect(vacant.code).toBe(3);
		expect(vacant.stderr).toContain("TITAN_MCP2CLI_TEST_MISSING_ENV");
		const missing = run(["call", "ghost", "echo", "--catalog", file]);
		expect(missing.code).toBe(3);
		expect(missing.stderr).toContain("not in the catalog");
		const remote = run(["tools", "remote", "--catalog", file]);
		expect(remote.code).toBe(3);
		expect(remote.stderr).toContain("pi-mcp-adapter");
	});

	test("--verbose redacts credential-looking argument keys in the echoed call line", () => {
		const file = catalogFile();
		const result = run(["call", "fake", "echo", "api_key=hunter2", "password=pw", "text=ok", "--verbose", "--catalog", file]);
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("→ fake.echo");
		expect(result.stderr).toContain("[redacted]");
		expect(result.stderr).not.toContain("hunter2");
		expect(result.stderr).not.toContain("pw");
		expect(result.stderr).toContain('"text":"ok"');
	});

	test("a slow tool with --timeout exits 4", () => {
		const file = catalogFile({}, { FAKE_MCP_SLOW_MS: "3000" });
		const result = run(["call", "fake", "echo", "text=slow", "--timeout", "300", "--catalog", file]);
		expect(result.code).toBe(4);
		expect(result.stderr).toContain("timed out");
	});

	test("a server that dies at start exits 3", () => {
		const file = catalogFile({}, { FAKE_MCP_EXIT_ON_START: "1" });
		const result = run(["tools", "fake", "--catalog", file]);
		expect(result.code).toBe(3);
		expect(result.stderr).toContain("failed to start");
	});
});
