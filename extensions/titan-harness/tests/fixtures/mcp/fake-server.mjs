#!/usr/bin/env node
/**
 * fake-server.mjs — a minimal MCP server over stdio for tests (JSON-RPC 2.0, one JSON
 * object per line, exactly the framing @modelcontextprotocol/sdk's ReadBuffer uses).
 *
 * Methods: initialize → { protocolVersion (echoes the client's), capabilities: {tools:{}},
 * serverInfo }, notifications/initialized (ignored), ping → {}, tools/list → two tools
 * (`echo` returns its args as JSON text, `boom` returns isError with the reason), tools/call.
 * Env FAKE_MCP_SLOW_MS delays `echo` (timeout tests); FAKE_MCP_TOKEN, when set, must NOT
 * appear in any response (the secrecy test); FAKE_MCP_EXIT_ON_START makes the process exit
 * immediately (crash test). Logs one line to stderr at start so stderr capture is exercised.
 */
import { createInterface } from "node:readline";

if (process.env.FAKE_MCP_EXIT_ON_START) process.exit(3);
process.stderr.write("fake-mcp: ready\n");

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const tools = [
	{ name: "echo", description: "Echo the arguments back as JSON text.", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
	{ name: "boom", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
];

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
	if (!line.trim()) return;
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
		return;
	}
	if (msg.method === "notifications/initialized" || msg.id === undefined) return; // notification
	const reply = (result) => write({ jsonrpc: "2.0", id: msg.id, result });
	const fail = (code, message) => write({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
	switch (msg.method) {
		case "initialize":
			reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "0.0.1" }, instructions: "test server" });
			return;
		case "ping":
			reply({});
			return;
		case "tools/list":
			reply({ tools });
			return;
		case "tools/call": {
			const name = msg.params?.name;
			const args = msg.params?.arguments ?? {};
			if (name === "echo") {
				const slow = Number(process.env.FAKE_MCP_SLOW_MS ?? 0);
				if (slow > 0) await new Promise((resolve) => setTimeout(resolve, slow));
				reply({ content: [{ type: "text", text: JSON.stringify({ echoed: args, sawToken: Boolean(process.env.FAKE_MCP_TOKEN) }) }], structuredContent: { echoed: args } });
				return;
			}
			if (name === "boom") {
				reply({ content: [{ type: "text", text: `boom failed: ${String(args.reason ?? "no reason")}` }], isError: true });
				return;
			}
			fail(-32602, `unknown tool ${String(name)}`);
			return;
		}
		default:
			fail(-32601, `method not found: ${String(msg.method)}`);
	}
});
rl.on("close", () => process.exit(0));
