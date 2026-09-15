#!/usr/bin/env node
/**
 * mcp2cli.mjs — titan's own mcp2cli (PRD v0.9 R5): a CLI over
 * extensions/titan-harness/modules/mcp-client.ts, the dependency-free stdio JSON-RPC
 * client the workflow runtime uses for `mcp_tool` nodes and the InfraNodus stage. It reads
 * the same merged catalog as the runtime bridge (package mcp/mcp.json → user
 * ~/.config/mcp/mcp.json → project .mcp.json), so a `bash:` node can call any catalogued
 * server from a shell. This is the THIRD binary named mcp2cli: the Python one
 * (knowsuchagency, `uvx mcp2cli`) and the Rust one (mcp2cli.dev, the Grok plugin) are
 * separate tools with their own flags — see skills/mcp-cli-bridges.
 *
 *   node scripts/mcp2cli.mjs list [--json] [--cwd <dir> | --catalog <file>]
 *       every catalogued server: name, transport, sources, enabled or disabled (env NAMES only)
 *   node scripts/mcp2cli.mjs tools <server> [--json] [--timeout <ms>]
 *       tools/list with descriptions
 *   node scripts/mcp2cli.mjs call <server> <tool> [--json '{…}' | key=value …] [--timeout <ms>] [--text] [--verbose]
 *       tools/call; prints structuredContent (or the parsed JSON text) as JSON, or the text with --text
 *   node scripts/mcp2cli.mjs doctor [--cwd <dir> | --catalog <file>]
 *       probe matrix as JSON: servers enabled/disabled with reasons, node/npx/uvx on PATH, the
 *       three mcp2cli flavours (titan = this file, python, rust)
 *
 * Exit codes: 0 ok · 1 the tool returned isError (or an RPC error such as an unknown tool)
 *             · 2 usage / bad JSON · 3 server missing, disabled or failed to start · 4 timeout.
 * Credential values are never printed: catalog env values stay inside the process, and
 * echoed call arguments whose key matches /key|token|secret|password/i are redacted.
 *
 * The client module uses TypeScript parameter properties, so Node's strip-only loader
 * cannot import it; this file re-executes itself under `--experimental-transform-types`
 * (Node ≥ 22.7) when that flag is absent. Under bun the module loads natively.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(here, "..", "extensions", "titan-harness", "modules", "mcp-client.ts");
const TRANSFORM_FLAG = "--experimental-transform-types";
const REDACT = /key|token|secret|password/i;

// ── Re-exec under transform-types on Node (bun needs nothing) ─────────────────────────
if (!process.versions.bun && !process.execArgv.includes(TRANSFORM_FLAG)) {
	const child = spawnSync(process.execPath, [TRANSFORM_FLAG, "--disable-warning=ExperimentalWarning", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
	process.exit(child.status ?? (child.signal ? 1 : 2));
}

function usage(code = 2) {
	process.stderr.write(
		[
			"usage: mcp2cli.mjs list [--json] [--cwd <dir> | --catalog <file>]",
			"       mcp2cli.mjs tools <server> [--json] [--timeout <ms>] [--cwd <dir> | --catalog <file>]",
			"       mcp2cli.mjs call <server> <tool> [--json '{…}' | key=value …] [--timeout <ms>] [--text] [--verbose] [--cwd <dir> | --catalog <file>]",
			"       mcp2cli.mjs doctor [--cwd <dir> | --catalog <file>]",
			"exit: 0 ok · 1 tool error · 2 usage · 3 server missing/disabled/failed to start · 4 timeout",
			"",
		].join("\n"),
	);
	process.exit(code);
}

/** `--flag value` / `--flag` / `key=value` / positional. `--json` takes a value only for `call`. */
function parseArgs(argv, command) {
	const out = { _: [], kv: {} };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const next = argv[i + 1];
			const takesValue = key === "cwd" || key === "catalog" || key === "timeout" || (key === "json" && command === "call");
			if (takesValue) {
				if (next === undefined) usage();
				out[key] = next;
				i++;
			} else out[key] = true;
		} else if (command === "call" && out._.length >= 2 && /^[A-Za-z_][\w.-]*=/.test(arg)) {
			const eq = arg.indexOf("=");
			out.kv[arg.slice(0, eq)] = parseValue(arg.slice(eq + 1));
		} else out._.push(arg);
	}
	return out;
}

function parseValue(raw) {
	const trimmed = raw.trim();
	if (/^(-?\d+(\.\d+)?|true|false|null|[[{].*[\]}])$/s.test(trimmed)) {
		try {
			return JSON.parse(trimmed);
		} catch {
			/* keep the string */
		}
	}
	return raw;
}

function redact(value) {
	if (Array.isArray(value)) return value.map(redact);
	if (value && typeof value === "object") {
		const out = {};
		for (const [key, inner] of Object.entries(value)) out[key] = REDACT.test(key) ? "[redacted]" : redact(inner);
		return out;
	}
	return value;
}

function which(binary) {
	const dirs = [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".bun", "bin"), path.join(os.homedir(), ".cargo", "bin")];
	for (const dir of dirs) {
		const candidate = path.join(dir, binary);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {}
	}
	return undefined;
}

/** Which of the other two mcp2cli binaries a `mcp2cli` on PATH is (their --help texts differ). */
function mcp2cliFlavour(binary) {
	const probe = spawnSync(binary, ["--help"], { encoding: "utf8", timeout: 5000 });
	const text = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
	if (/--mcp-stdio|--mcp\b/.test(text)) return "python";
	if (/link create|config init/.test(text)) return "rust";
	return "unknown";
}

const layerOf = (source) => {
	const normal = source.replace(/\\/g, "/");
	if (normal.endsWith("/.mcp.json")) return "project";
	if (normal.includes("/.config/mcp/")) return "user";
	if (normal.endsWith("/mcp/mcp.json")) return "package";
	return path.basename(source);
};

const argv = process.argv.slice(2);
const command = argv[0];
if (!command || command === "--help" || command === "-h") usage(command ? 0 : 2);
if (!["list", "tools", "call", "doctor"].includes(command)) usage();
const args = parseArgs(argv.slice(1), command);

let mcp;
try {
	mcp = await import(pathToFileURL(modulePath).href);
} catch (error) {
	process.stderr.write(`mcp2cli.mjs: cannot load ${modulePath}: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(2);
}

const catalogPaths = args.catalog ? [{ path: path.resolve(String(args.catalog)), layer: "project" }] : mcp.defaultCatalogPaths(args.cwd ? path.resolve(String(args.cwd)) : process.cwd());
const catalog = mcp.loadMcpCatalog(catalogPaths);
const timeoutMs = args.timeout !== undefined ? Number(args.timeout) : undefined;
if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0)) usage();

const serverRow = (cfg) => ({
	name: cfg.name,
	transport: cfg.transport,
	enabled: !cfg.disabled,
	reason: cfg.reason,
	envNames: cfg.envNames,
	sources: cfg.sources.map(layerOf),
	command: cfg.transport === "stdio" ? cfg.command : undefined,
	url: cfg.url,
});

function findServer(name) {
	const cfg = catalog.find((entry) => entry.name === name);
	if (!cfg) {
		process.stderr.write(`mcp2cli: server "${name}" is not in the catalog (${catalog.map((entry) => entry.name).join(", ") || "empty"})\n`);
		process.exit(3);
	}
	if (cfg.disabled) {
		process.stderr.write(`mcp2cli: server "${name}" is disabled: ${cfg.reason ?? "disabled in the catalog"}\n`);
		process.exit(3);
	}
	if (cfg.transport !== "stdio") {
		process.stderr.write(`mcp2cli: server "${name}" is an ${cfg.transport} server — only stdio servers run through titan's bridge (pi-mcp-adapter owns url servers)\n`);
		process.exit(3);
	}
	return cfg;
}

async function withClient(cfg, fn) {
	const client = new mcp.McpClient(cfg, { timeoutMs: timeoutMs ?? mcp.DEFAULT_CALL_TIMEOUT_MS, startTimeoutMs: timeoutMs ? Math.max(timeoutMs, 2000) : undefined });
	try {
		try {
			await client.start();
		} catch (error) {
			const tail = client.stderrTail().trim();
			process.stderr.write(`mcp2cli: server "${cfg.name}" failed to start: ${error instanceof Error ? error.message : String(error)}${tail ? `\n  stderr: ${tail.slice(-400)}` : ""}\n`);
			process.exit(error instanceof mcp.McpTimeoutError ? 4 : 3);
		}
		return await fn(client);
	} finally {
		await client.close();
	}
}

if (command === "list") {
	const rows = catalog.map(serverRow);
	if (args.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
	else {
		const width = Math.max(6, ...rows.map((row) => row.name.length));
		for (const row of rows) {
			const state = row.enabled ? "enabled " : "disabled";
			const detail = row.enabled ? (row.envNames.length ? `env ${row.envNames.join(", ")}` : "") : (row.reason ?? "");
			process.stdout.write(`${row.name.padEnd(width)}  ${row.transport.padEnd(5)}  ${state}  ${row.sources.join(" › ") || "-"}${detail ? `  ${detail}` : ""}\n`);
		}
		if (!rows.length) process.stdout.write("(no servers in the catalog)\n");
	}
	process.exit(0);
}

if (command === "doctor") {
	const node = process.execPath;
	const mcp2cliBin = which("mcp2cli");
	const uvx = which("uvx");
	const report = {
		catalog: catalogPaths.map((entry) => ({ path: entry.path, layer: entry.layer, present: fs.existsSync(entry.path) })),
		servers: catalog.map(serverRow),
		summary: { enabled: catalog.filter((cfg) => !cfg.disabled).length, disabled: catalog.filter((cfg) => cfg.disabled).length },
		binaries: {
			node: { present: true, path: node, version: process.versions.node ?? process.version },
			npx: { present: !!which("npx"), path: which("npx") },
			uvx: { present: !!uvx, path: uvx },
			mcp2cli: mcp2cliBin ? { present: true, path: mcp2cliBin, flavour: mcp2cliFlavour(mcp2cliBin) } : { present: false },
		},
		mcp2cli: {
			titan: { available: true, path: fileURLToPath(import.meta.url), how: "node scripts/mcp2cli.mjs" },
			python: mcp2cliBin && mcp2cliFlavour(mcp2cliBin) === "python" ? { available: true, how: mcp2cliBin } : uvx ? { available: true, how: "uvx mcp2cli (downloads on first use)" } : { available: false, how: "install uv, then uvx mcp2cli" },
			rust: mcp2cliBin && mcp2cliFlavour(mcp2cliBin) === "rust" ? { available: true, how: mcp2cliBin } : { available: false, how: "curl -fsSL https://mcp2cli.dev/install.sh | sh (the Grok plugin's binary)" },
		},
	};
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	process.exit(0);
}

if (command === "tools") {
	const name = args._[0];
	if (!name) usage();
	const cfg = findServer(name);
	const tools = await withClient(cfg, (client) => client.listTools()).catch((error) => {
		process.stderr.write(`mcp2cli: tools/list failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(error instanceof mcp.McpTimeoutError ? 4 : 1);
	});
	if (args.json) process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`);
	else {
		const width = Math.max(4, ...tools.map((tool) => tool.name.length));
		for (const tool of tools) process.stdout.write(`${tool.name.padEnd(width)}  ${(tool.description ?? "").replace(/\s+/g, " ").trim()}\n`);
		if (!tools.length) process.stdout.write("(no tools)\n");
	}
	process.exit(0);
}

// call
const [name, tool] = args._;
if (!name || !tool) usage();
let callArgs = { ...args.kv };
if (args.json !== undefined) {
	try {
		const parsed = JSON.parse(String(args.json));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--json must be a JSON object");
		callArgs = { ...parsed, ...callArgs };
	} catch (error) {
		process.stderr.write(`mcp2cli: bad --json: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(2);
	}
}
const cfg = findServer(name);
if (args.verbose) process.stderr.write(`→ ${cfg.name}.${tool} ${JSON.stringify(redact(callArgs))}\n`);
const outcome = await withClient(cfg, async (client) => {
	try {
		return { result: await client.callTool(tool, callArgs, timeoutMs) };
	} catch (error) {
		return { error };
	}
});
if (outcome.error) {
	const error = outcome.error;
	process.stderr.write(`mcp2cli: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(error instanceof mcp.McpTimeoutError ? 4 : 1);
}
const value = mcp.toolResultValue(outcome.result);
if (args.text) process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
process.exit(outcome.result.isError ? 1 : 0);
