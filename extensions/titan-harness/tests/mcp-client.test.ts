import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	McpClient,
	McpRpcError,
	McpTimeoutError,
	type McpServerConfig,
	createMcpToolBridge,
	defaultCatalogPaths,
	describeServer,
	envReferences,
	interpolateEnv,
	loadMcpCatalog,
	packageRoot,
	toolResultValue,
} from "../modules/mcp-client.ts";

const FAKE_SERVER = join(import.meta.dir, "fixtures", "mcp", "fake-server.mjs");
const TOKEN = "sk-test-secret-value-9f8e7d";

const dirs: string[] = [];
const clients: McpClient[] = [];
afterEach(async () => {
	while (clients.length) await clients.pop()!.close();
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-mcp-"));
	dirs.push(dir);
	return dir;
};

/** A stdio config that runs the fake server under the current runtime (bun or node). */
function fakeConfig(over: Partial<McpServerConfig> = {}): McpServerConfig {
	return {
		name: "fake",
		transport: "stdio",
		command: process.execPath,
		args: [FAKE_SERVER],
		env: {},
		envNames: [],
		disabled: false,
		sources: [],
		...over,
	};
}

const track = (client: McpClient): McpClient => {
	clients.push(client);
	return client;
};

describe("catalog", () => {
	test("env reference forms and interpolation", () => {
		expect(envReferences("${A} $env:B {env:C} ${A}")).toEqual(["A", "B", "C"]);
		expect(interpolateEnv("x=${A};y=$env:B;z={env:C};w=${MISSING}", { A: "1", B: "2", C: "3" })).toBe("x=1;y=2;z=3;w=");
	});

	test("merges package → user → project (later wins per server, field by field), expands env, disables on missing vars naming the variable only", () => {
		const dir = scratch();
		const pkg = join(dir, "pkg.json");
		const user = join(dir, "user.json");
		const project = join(dir, "project.json");
		writeFileSync(
			pkg,
			JSON.stringify({
				mcpServers: {
					infranodus: { command: "npx", args: ["-y", "infranodus-mcp-server"], env: { INFRANODUS_API_KEY: "${INFRANODUS_API_KEY}" }, disabled: true },
					momentic: { command: "npx", args: ["-y", "momentic", "mcp", "--config", "${MOMENTIC_CONFIG}"], env: { MOMENTIC_API_KEY: "${MOMENTIC_API_KEY}" } },
					figma: { url: "https://mcp.figma.com/mcp", auth: "oauth" },
					secretcmd: { command: "srv", env: { KEY: "!op read op://vault/key" } },
					literal: { command: "srv", env: { KEY: "!!${KEEP}" } },
				},
			}),
		);
		writeFileSync(user, JSON.stringify({ mcpServers: { infranodus: { env: { INFRANODUS_API_KEY: "${INFRANODUS_API_KEY}" }, disabled: false } } }));
		writeFileSync(project, JSON.stringify({ mcpServers: { extra: { command: "node", args: ["x.js"] }, momentic: { disabled: true } } }));
		const env = { INFRANODUS_API_KEY: "key-value-abc", KEEP: "literal-kept" };
		const catalog = loadMcpCatalog([pkg, user, project], env);
		const byName = Object.fromEntries(catalog.map((c) => [c.name, c]));
		// user layer re-enabled infranodus and the key resolved
		expect(byName.infranodus.disabled).toBe(false);
		expect(byName.infranodus.env.INFRANODUS_API_KEY).toBe("key-value-abc");
		expect(byName.infranodus.envNames).toEqual(["INFRANODUS_API_KEY"]);
		expect(byName.infranodus.sources).toEqual([pkg, user]);
		expect(byName.infranodus.args).toEqual(["-y", "infranodus-mcp-server"]); // field-wise merge kept the package args
		// momentic: the project layer disabled it (explicit disabled wins before the env check)
		expect(byName.momentic.disabled).toBe(true);
		expect(byName.momentic.reason).toBe("disabled in the catalog");
		// http server: catalogued, not spawnable here
		expect(byName.figma.transport).toBe("http");
		expect(byName.figma.disabled).toBe(true);
		expect(byName.figma.reason).toContain("pi-mcp-adapter");
		// command secrets are not executed
		expect(byName.secretcmd.disabled).toBe(true);
		expect(byName.secretcmd.reason).toContain("KEY");
		expect(byName.secretcmd.reason).not.toContain("op://");
		// "!!" = a literal value starting with one "!" (pi-mcp-adapter's rule), still interpolated, never executed
		expect(byName.literal.env.KEY).toBe("!literal-kept");
		expect(byName.literal.disabled).toBe(false);
		expect(byName.extra.disabled).toBe(false);
		// missing variables: names only
		const missing = loadMcpCatalog([pkg, user], { KEEP: "x" });
		const infra = missing.find((c) => c.name === "infranodus")!;
		expect(infra.disabled).toBe(true);
		expect(infra.reason).toBe("missing env INFRANODUS_API_KEY");
		const mom = missing.find((c) => c.name === "momentic")!;
		expect(mom.reason).toBe("missing env MOMENTIC_CONFIG, MOMENTIC_API_KEY");
		expect(JSON.stringify(describeServer(infra))).not.toContain("key-value");
		expect(describeServer(infra)).toEqual({ name: "infranodus", transport: "stdio", command: "npx", envNames: ["INFRANODUS_API_KEY"], disabled: true, reason: "missing env INFRANODUS_API_KEY" });
	});

	test("default paths point at the package catalog, the user config and the project .mcp.json; the shipped catalog parses", () => {
		const paths = defaultCatalogPaths("/tmp/somewhere");
		expect(paths.map((p) => p.layer)).toEqual(["package", "user", "project"]);
		expect(paths[0].path).toBe(join(packageRoot(), "mcp", "mcp.json"));
		expect(paths[2].path).toBe("/tmp/somewhere/.mcp.json");
		const shipped = loadMcpCatalog([paths[0].path], {});
		const infranodus = shipped.find((c) => c.name === "infranodus");
		expect(infranodus?.command).toBe("npx");
		expect(infranodus?.disabled).toBe(true);
		expect(infranodus?.envNames).toEqual(["INFRANODUS_API_KEY"]);
	});

	test("malformed or missing files are skipped", () => {
		const dir = scratch();
		const bad = join(dir, "bad.json");
		writeFileSync(bad, "{ not json");
		expect(loadMcpCatalog([bad, join(dir, "missing.json")], {})).toEqual([]);
	});
});

describe("McpClient over stdio", () => {
	test("initialize handshake, tools/list and tools/call against the fake server", async () => {
		const client = track(new McpClient(fakeConfig(), { timeoutMs: 5000 }));
		const init = await client.start();
		expect(init.protocolVersion).toBe("2025-11-25");
		expect((init.serverInfo as any).name).toBe("fake-mcp");
		expect(init.instructions).toBe("test server");
		expect(client.state).toBe("running");
		await expect(client.start()).resolves.toBe(init); // idempotent
		const tools = await client.listTools();
		expect(tools.map((t) => t.name)).toEqual(["echo", "boom"]);
		const echo = await client.callTool("echo", { text: "hi", n: 2 });
		expect(echo.isError).toBe(false);
		expect(echo.structured).toEqual({ echoed: { text: "hi", n: 2 } });
		expect(toolResultValue(echo)).toEqual({ echoed: { text: "hi", n: 2 } });
		const boom = await client.callTool("boom", { reason: "because" });
		expect(boom.isError).toBe(true);
		expect(toolResultValue(boom)).toBe("boom failed: because");
		await expect(client.callTool("nope")).rejects.toBeInstanceOf(McpRpcError);
		expect(client.calls).toBe(3);
		expect(client.stderrTail()).toContain("fake-mcp: ready");
		await client.close();
		expect(client.state).toBe("closed");
		await expect(client.callTool("echo")).rejects.toThrow("not running");
	});

	test("a slow call times out without killing the client; a crashing server rejects start with its exit code", async () => {
		const slow = track(new McpClient(fakeConfig({ env: { FAKE_MCP_SLOW_MS: "1500" } }), { timeoutMs: 150 }));
		await slow.start();
		await expect(slow.callTool("echo", {})).rejects.toBeInstanceOf(McpTimeoutError);
		expect(slow.state).toBe("running");
		const crash = track(new McpClient(fakeConfig({ env: { FAKE_MCP_EXIT_ON_START: "1" } }), { startTimeoutMs: 5000 }));
		await expect(crash.start()).rejects.toThrow("exited (code 3");
		expect(crash.state).toBe("failed");
		const disabled = track(new McpClient(fakeConfig({ disabled: true, reason: "missing env X" })));
		await expect(disabled.start()).rejects.toThrow("disabled: missing env X");
	});

	test("the config env reaches the child but its values never appear in errors, status or stderr tails", async () => {
		const client = track(new McpClient(fakeConfig({ env: { FAKE_MCP_TOKEN: TOKEN }, envNames: ["FAKE_MCP_TOKEN"] }), { timeoutMs: 5000 }));
		await client.start();
		const echo = await client.callTool("echo", {});
		expect((echo.structured as any).echoed).toEqual({});
		expect(JSON.parse((echo.content as any)[0].text).sawToken).toBe(true);
		let message = "";
		try {
			await client.callTool("nope", {});
		} catch (error) {
			message = String(error);
		}
		expect(message).not.toContain(TOKEN);
		expect(client.stderrTail()).not.toContain(TOKEN);
		expect(JSON.stringify(describeServer(client.cfg))).not.toContain(TOKEN);
	});

	test("server-initiated ping is answered and notifications are ignored (raw framing)", async () => {
		// Drive the client against an inline server that sends a ping request and a notification before answering.
		const dir = scratch();
		const server = join(dir, "pinger.mjs");
		writeFileSync(
			server,
			`import { createInterface } from "node:readline";
const w = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    w({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "hello" } });
    w({ jsonrpc: "2.0", id: "srv-1", method: "ping", params: {} });
    w({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "pinger", version: "1" } } });
  } else if (m.id === "srv-1") {
    process.stderr.write("pong " + JSON.stringify(m.result) + "\\n");
  } else if (m.method === "tools/list") {
    w({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "a" }], nextCursor: "p2" } });
  } else if (m.method === "tools/list-never") {
  } else if (m.id !== undefined && m.method === "tools/list") {
  }
});
`,
		);
		// Second page handling: patch the server to answer the cursor page too.
		writeFileSync(
			server,
			`import { createInterface } from "node:readline";
const w = (m) => process.stdout.write(JSON.stringify(m) + "\\r\\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    w({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "hello" } });
    w({ jsonrpc: "2.0", id: "srv-1", method: "ping", params: {} });
    w({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "pinger", version: "1" } } });
  } else if (m.id === "srv-1") {
    process.stderr.write("pong " + JSON.stringify(m.result) + "\\n");
  } else if (m.method === "tools/list") {
    if (m.params && m.params.cursor === "p2") w({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "b" }] } });
    else w({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "a" }], nextCursor: "p2" } });
  }
});
`,
		);
		const client = track(new McpClient(fakeConfig({ args: [server] }), { timeoutMs: 5000 }));
		const init = await client.start();
		expect(init.protocolVersion).toBe("2025-06-18");
		const tools = await client.listTools();
		expect(tools.map((t) => t.name)).toEqual(["a", "b"]);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(client.stderrTail()).toContain("pong {}");
	});
});

describe("createMcpToolBridge", () => {
	test("lazy start, one process reused across calls, disabled servers fail closed, close ends everything", async () => {
		const spawns: string[] = [];
		const spawnCounting: typeof spawn = ((cmd: string, args: string[], opts: any) => {
			spawns.push(cmd);
			return spawn(cmd, args, opts);
		}) as typeof spawn;
		const calls: Array<{ server: string; tool: string; ok: boolean }> = [];
		const bridge = createMcpToolBridge({
			catalog: [fakeConfig(), fakeConfig({ name: "vacant", disabled: true, reason: "missing env INFRANODUS_API_KEY" })],
			timeoutMs: 5000,
			clientOptions: { spawn: spawnCounting },
			onCall: (row) => calls.push({ server: row.server, tool: row.tool, ok: row.ok }),
		});
		expect(bridge.status().map((s) => [s.server, s.state])).toEqual([
			["fake", "idle"],
			["vacant", "disabled"],
		]);
		expect(await bridge.mcpTool("fake", "echo", { a: 1 })).toEqual({ echoed: { a: 1 } });
		expect(await bridge.mcpTool("fake", "echo", { b: 2 })).toEqual({ echoed: { b: 2 } });
		expect(spawns).toHaveLength(1);
		await expect(bridge.mcpTool("fake", "boom", { reason: "x" })).rejects.toThrow("returned an error: boom failed: x");
		await expect(bridge.mcpTool("vacant", "echo", {})).rejects.toThrow("MCP server vacant disabled: missing env INFRANODUS_API_KEY");
		await expect(bridge.mcpTool("unknown", "echo", {})).rejects.toThrow("not in the catalog");
		expect((await bridge.listTools("fake")).map((t) => t.name)).toEqual(["echo", "boom"]);
		const status = bridge.status();
		expect(status[0]).toMatchObject({ server: "fake", state: "running", calls: 3, tools: 2 });
		expect(calls).toEqual([
			{ server: "fake", tool: "echo", ok: true },
			{ server: "fake", tool: "echo", ok: true },
			{ server: "fake", tool: "boom", ok: false },
		]);
		expect(JSON.stringify(status)).not.toContain(TOKEN);
		await bridge.close();
		expect(bridge.status()[0].state).toBe("idle");
	});

	test("toolResultValue: structured wins, single JSON text parses, several texts join, other content passes through", () => {
		expect(toolResultValue({ content: [{ type: "text", text: "{\"a\":1}" }], structured: { s: true } })).toEqual({ s: true });
		expect(toolResultValue({ content: [{ type: "text", text: " [1,2] " }] })).toEqual([1, 2]);
		expect(toolResultValue({ content: [{ type: "text", text: "{not json" }] })).toBe("{not json");
		expect(toolResultValue({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
		expect(toolResultValue({ content: [{ type: "image", data: "…" }] })).toEqual([{ type: "image", data: "…" }]);
	});
});
