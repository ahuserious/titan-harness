/**
 * mcp-client.ts — a dependency-free MCP client over stdio (plan D14 / A13, P7).
 *
 * pi-mcp-adapter registers MCP tools for the *model*; an extension cannot invoke another
 * extension's tools, so titan's own `mcp_tool` workflow nodes and the InfraNodus
 * reasoning-ontology stage talk to servers themselves. Wire format mirrors
 * @modelcontextprotocol/sdk's StdioClientTransport exactly (checked against the copy
 * pi-mcp-adapter 2.33.0 ships): JSON-RPC 2.0, one JSON object per line
 * (`JSON.stringify(msg) + "\n"`, a trailing `\r` tolerated, 10 MiB read cap), the
 * `initialize` request → `notifications/initialized` notification handshake, then
 * `tools/list` (paged by `nextCursor`) and `tools/call`. Server → client requests are
 * answered with `{}` for `ping` and "method not found" for everything else.
 *
 * Catalog: `loadMcpCatalog()` merges <package>/mcp/mcp.json, ~/.config/mcp/mcp.json and
 * <cwd>/.mcp.json (later wins per server name, field by field). `${VAR}`, `$env:VAR` and
 * `{env:VAR}` in `env` values and `args` expand from the process environment the way
 * pi-mcp-adapter's interpolateEnvVars does; an unresolved variable disables the entry
 * with a reason that names the VARIABLE only — no value is ever logged, stored in a
 * status row or included in an error message. `!command` secret expressions are not
 * executed here (disabled with a reason). HTTP servers (`url`) are catalogued but not
 * spawnable by this client (pi-mcp-adapter owns them).
 *
 *   loadMcpCatalog(paths?, env?)      → McpServerConfig[]
 *   new McpClient(cfg, opts).start()  → { protocolVersion, serverInfo, capabilities, instructions }
 *   client.listTools() / client.callTool(name, args) / client.close()
 *   createMcpToolBridge({ catalog })  → { mcpTool(server, tool, args), status(), close() }
 *                                       lazy start per server, one process reused, fail closed
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ═══ Catalog ═════════════════════════════════════════════════════════════════

export type McpTransport = "stdio" | "http";

export interface McpServerConfig {
	name: string;
	transport: McpTransport;
	command: string;
	args: string[];
	/** Expanded environment overrides for the child (values never leave this object). */
	env: Record<string, string>;
	/** Names of the environment variables the entry references (for doctor-style reports). */
	envNames: string[];
	disabled: boolean;
	/** Why the entry is disabled — names variables, never values. */
	reason?: string;
	cwd?: string;
	url?: string;
	auth?: string;
	/** Which catalog files contributed, in precedence order (last wins). */
	sources: string[];
}

export type McpCatalogLayer = "package" | "user" | "project";

const ENV_REF = /\$\{(\w+)\}|\$env:(\w+)|\{env:(\w+)\}/g;

/** Every environment variable a string references, in order of appearance (deduplicated). */
export function envReferences(value: string): string[] {
	const names: string[] = [];
	for (const match of value.matchAll(ENV_REF)) {
		const name = match[1] ?? match[2] ?? match[3];
		if (name && !names.includes(name)) names.push(name);
	}
	return names;
}

/** pi-mcp-adapter's interpolation: `${VAR}`, `$env:VAR`, `{env:VAR}`; a missing variable becomes "". */
export function interpolateEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
	return value.replace(ENV_REF, (_m, a, b, c) => env[a ?? b ?? c] ?? "");
}

const MODULE_DIR = typeof __dirname === "string" ? __dirname : path.dirname(new URL(import.meta.url).pathname);

/** The package root (…/titan-harness) from this module's directory. */
export function packageRoot(): string {
	return path.resolve(MODULE_DIR, "..", "..", "..");
}

/** <package>/mcp/mcp.json, ~/.config/mcp/mcp.json, <cwd>/.mcp.json — precedence ascending. */
export function defaultCatalogPaths(cwd: string = process.cwd()): Array<{ path: string; layer: McpCatalogLayer }> {
	return [
		{ path: path.join(packageRoot(), "mcp", "mcp.json"), layer: "package" },
		{ path: path.join(os.homedir(), ".config", "mcp", "mcp.json"), layer: "user" },
		{ path: path.join(path.resolve(cwd), ".mcp.json"), layer: "project" },
	];
}

interface RawServer {
	command?: unknown;
	args?: unknown;
	env?: unknown;
	disabled?: unknown;
	cwd?: unknown;
	url?: unknown;
	auth?: unknown;
}

function readCatalogFile(file: string): Record<string, RawServer> | undefined {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(text);
		const servers = parsed && typeof parsed === "object" ? (parsed.mcpServers ?? parsed) : undefined;
		return servers && typeof servers === "object" && !Array.isArray(servers) ? (servers as Record<string, RawServer>) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Merge the catalog files (later files override earlier ones per server, field by field),
 * expand environment references and mark what cannot run. Pure: reads the files and `env`.
 */
export function loadMcpCatalog(paths: Array<string | { path: string; layer?: McpCatalogLayer }> = defaultCatalogPaths(), env: NodeJS.ProcessEnv = process.env): McpServerConfig[] {
	const merged = new Map<string, { raw: RawServer; sources: string[] }>();
	for (const entry of paths) {
		const file = typeof entry === "string" ? entry : entry.path;
		const servers = readCatalogFile(file);
		if (!servers) continue;
		for (const [name, raw] of Object.entries(servers)) {
			if (!raw || typeof raw !== "object") continue;
			const current = merged.get(name);
			merged.set(name, { raw: { ...(current?.raw ?? {}), ...raw }, sources: [...(current?.sources ?? []), file] });
		}
	}
	const configs: McpServerConfig[] = [];
	for (const [name, { raw, sources }] of merged) {
		const url = typeof raw.url === "string" ? raw.url : undefined;
		const command = typeof raw.command === "string" ? raw.command : "";
		const rawArgs = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : [];
		const rawEnv = raw.env && typeof raw.env === "object" && !Array.isArray(raw.env) ? (raw.env as Record<string, unknown>) : {};
		const envNames = new Set<string>();
		const missing = new Set<string>();
		const unsupported: string[] = [];
		const expandedEnv: Record<string, string> = {};
		// args are scanned before env so a reason lists variables in catalog order (command line first).
		const args = rawArgs.map((arg) => {
			for (const ref of envReferences(arg)) {
				envNames.add(ref);
				if (env[ref] === undefined) missing.add(ref);
			}
			return interpolateEnv(arg, env);
		});
		for (const [key, value] of Object.entries(rawEnv)) {
			if (typeof value !== "string") continue;
			if (value.startsWith("!") && !value.startsWith("!!")) {
				unsupported.push(key);
				continue;
			}
			// pi-mcp-adapter: "!!…" means a literal value that begins with one "!" (interpolated), never a command.
			const literal = value.startsWith("!!") ? value.slice(1) : value;
			for (const ref of envReferences(literal)) {
				envNames.add(ref);
				if (env[ref] === undefined) missing.add(ref);
			}
			expandedEnv[key] = interpolateEnv(literal, env);
		}
		const transport: McpTransport = url && !command ? "http" : "stdio";
		let disabled = raw.disabled === true;
		let reason: string | undefined = disabled ? "disabled in the catalog" : undefined;
		if (!disabled && missing.size) {
			disabled = true;
			reason = `missing env ${[...missing].join(", ")}`;
		}
		if (!disabled && unsupported.length) {
			disabled = true;
			reason = `command secrets (!…) are not executed by titan's client: env ${unsupported.join(", ")}`;
		}
		if (!disabled && transport === "http") {
			disabled = true;
			reason = "http transport is served by pi-mcp-adapter, not by titan's stdio client";
		}
		if (!disabled && !command) {
			disabled = true;
			reason = "no command";
		}
		configs.push({
			name,
			transport,
			command,
			args,
			env: expandedEnv,
			envNames: [...envNames],
			disabled,
			reason,
			cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
			url,
			auth: typeof raw.auth === "string" ? raw.auth : undefined,
			sources,
		});
	}
	return configs;
}

/** A status row for a config — names only, never values. */
export function describeServer(cfg: McpServerConfig): { name: string; transport: McpTransport; command?: string; envNames: string[]; disabled: boolean; reason?: string } {
	return { name: cfg.name, transport: cfg.transport, command: cfg.command || undefined, envNames: [...cfg.envNames], disabled: cfg.disabled, reason: cfg.reason };
}

// ═══ Client ══════════════════════════════════════════════════════════════════

export const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
export const DEFAULT_START_TIMEOUT_MS = 20_000;
export const STDERR_TAIL_BYTES = 8 * 1024;
export const READ_BUFFER_MAX = 10 * 1024 * 1024;

export type McpClientState = "idle" | "starting" | "running" | "closed" | "failed";

export interface McpTool {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

export interface McpToolResult {
	content: unknown;
	isError?: boolean;
	structured?: unknown;
}

export interface McpInitializeResult {
	protocolVersion: string;
	serverInfo?: unknown;
	capabilities?: unknown;
	instructions?: string;
}

export interface McpClientOptions {
	timeoutMs?: number;
	startTimeoutMs?: number;
	spawn?: typeof nodeSpawn;
	protocolVersion?: string;
	clientInfo?: { name: string; version: string };
	onStderr?(text: string): void;
	/** Inherit process.env under the config env (default true; tests pass false). */
	inheritEnv?: boolean;
}

interface Pending {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
	method: string;
}

export class McpTimeoutError extends Error {
	constructor(method: string, ms: number) {
		super(`MCP ${method} timed out after ${ms} ms`);
		this.name = "McpTimeoutError";
	}
}

export class McpRpcError extends Error {
	constructor(
		method: string,
		public readonly code: number,
		message: string,
		public readonly data?: unknown,
	) {
		super(`MCP ${method} failed (${code}): ${message}`);
		this.name = "McpRpcError";
	}
}

export class McpClient {
	private proc: ChildProcess | undefined;
	private buffer: Buffer = Buffer.alloc(0);
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private stderrTailBuf = "";
	private stateValue: McpClientState = "idle";
	private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	private startPromise: Promise<McpInitializeResult> | undefined;
	private readonly opts: Required<Pick<McpClientOptions, "timeoutMs" | "startTimeoutMs" | "protocolVersion" | "clientInfo" | "inheritEnv">> & McpClientOptions;
	public initialized: McpInitializeResult | undefined;
	public calls = 0;

	constructor(
		public readonly cfg: McpServerConfig,
		opts: McpClientOptions = {},
	) {
		this.opts = {
			timeoutMs: opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
			startTimeoutMs: opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
			protocolVersion: opts.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
			clientInfo: opts.clientInfo ?? { name: "titan-harness", version: "0.7.0" },
			inheritEnv: opts.inheritEnv ?? true,
			...opts,
		};
	}

	get state(): McpClientState {
		return this.stateValue;
	}

	/** Last ≤ 8 KiB of the server's stderr (diagnostics; the server's own output, never our env). */
	stderrTail(): string {
		return this.stderrTailBuf;
	}

	/** Spawn the server and run the initialize handshake. Idempotent while running. */
	start(): Promise<McpInitializeResult> {
		if (this.startPromise) return this.startPromise;
		this.startPromise = this.doStart().catch((error) => {
			this.stateValue = "failed";
			this.startPromise = undefined;
			throw error;
		});
		return this.startPromise;
	}

	private async doStart(): Promise<McpInitializeResult> {
		if (this.cfg.disabled) throw new Error(`MCP server ${this.cfg.name} is disabled: ${this.cfg.reason ?? "disabled"}`);
		if (this.cfg.transport !== "stdio" || !this.cfg.command) throw new Error(`MCP server ${this.cfg.name} has no stdio command`);
		this.stateValue = "starting";
		const spawnImpl = this.opts.spawn ?? nodeSpawn;
		const env: Record<string, string> = {};
		if (this.opts.inheritEnv) for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
		Object.assign(env, this.cfg.env);
		let proc: ChildProcess;
		try {
			// detached → the server (and anything npx wraps around it) is its own process group,
			// so close() can kill the whole tree; a lingering grandchild would otherwise hold the
			// stdout pipe open and keep the host's event loop alive.
			proc = spawnImpl(this.cfg.command, this.cfg.args, { cwd: this.cfg.cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false, detached: process.platform !== "win32" });
			proc.unref();
		} catch (error) {
			throw new Error(`MCP server ${this.cfg.name}: failed to spawn ${this.cfg.command}: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.proc = proc;
		proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
		proc.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			this.stderrTailBuf = (this.stderrTailBuf + text).slice(-STDERR_TAIL_BYTES);
			try {
				this.opts.onStderr?.(text);
			} catch {}
		});
		proc.on("error", (error) => this.fail(new Error(`MCP server ${this.cfg.name}: ${error.message}`)));
		proc.on("exit", (code, signal) => {
			this.exitInfo = { code, signal };
			this.fail(new Error(`MCP server ${this.cfg.name} exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})${this.stderrTailBuf.trim() ? `: ${lastLine(this.stderrTailBuf)}` : ""}`));
		});
		const result = (await this.request("initialize", { protocolVersion: this.opts.protocolVersion, capabilities: {}, clientInfo: this.opts.clientInfo }, this.opts.startTimeoutMs)) as Record<string, unknown>;
		const protocolVersion = typeof result?.protocolVersion === "string" ? result.protocolVersion : this.opts.protocolVersion;
		this.notify("notifications/initialized", {});
		this.initialized = { protocolVersion, serverInfo: result?.serverInfo, capabilities: result?.capabilities, instructions: typeof result?.instructions === "string" ? result.instructions : undefined };
		this.stateValue = "running";
		return this.initialized;
	}

	/** Every tool the server advertises (follows `nextCursor`). */
	async listTools(): Promise<McpTool[]> {
		const tools: McpTool[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 50; page++) {
			const result = (await this.request("tools/list", cursor ? { cursor } : {})) as { tools?: unknown; nextCursor?: unknown };
			for (const tool of Array.isArray(result?.tools) ? result.tools : []) {
				if (tool && typeof tool === "object" && typeof (tool as McpTool).name === "string") {
					const t = tool as McpTool;
					tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
				}
			}
			cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
			if (!cursor) break;
		}
		return tools;
	}

	/** `tools/call`; a JSON-RPC error rejects, an `isError` result is returned as-is (the caller decides). */
	async callTool(name: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<McpToolResult> {
		this.calls += 1;
		const result = (await this.request("tools/call", { name, arguments: args }, timeoutMs)) as Record<string, unknown>;
		return { content: result?.content ?? [], isError: result?.isError === true, structured: result?.structuredContent };
	}

	/** Generic request with a per-call timeout. */
	request(method: string, params: unknown, timeoutMs: number = this.opts.timeoutMs): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const proc = this.proc;
			if (!proc || !proc.stdin || proc.stdin.destroyed || this.stateValue === "closed" || this.stateValue === "failed") {
				reject(new Error(`MCP server ${this.cfg.name} is not running (${this.stateValue})`));
				return;
			}
			const id = this.nextId++;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new McpTimeoutError(method, timeoutMs));
			}, Math.max(1, timeoutMs));
			this.pending.set(id, { resolve, reject, timer, method });
			try {
				proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new Error(`MCP server ${this.cfg.name}: write failed: ${error instanceof Error ? error.message : String(error)}`));
			}
		});
	}

	notify(method: string, params: unknown): void {
		try {
			this.proc?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
		} catch {
			/* a dead pipe surfaces on the next request */
		}
	}

	/**
	 * End stdin and SIGTERM the server's process group (what the SDK's transport does on
	 * close), give it 2 s to exit, then SIGKILL the group. Pending calls reject.
	 */
	async close(): Promise<void> {
		const proc = this.proc;
		this.stateValue = "closed";
		this.startPromise = undefined;
		this.fail(new Error(`MCP server ${this.cfg.name} closed`));
		if (!proc) return;
		try {
			proc.stdin?.end();
		} catch {}
		if (proc.exitCode === null && proc.signalCode === null) {
			killTree(proc, "SIGTERM");
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					killTree(proc, "SIGKILL");
					resolve();
				}, 2000);
				proc.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
		// The direct child is gone; make sure nothing it spawned keeps the pipes (and our loop) alive.
		killTree(proc, "SIGKILL");
		for (const stream of [proc.stdout, proc.stderr]) {
			try {
				stream?.destroy();
			} catch {}
		}
		this.proc = undefined;
	}

	exited(): { code: number | null; signal: NodeJS.Signals | null } | undefined {
		return this.exitInfo;
	}

	private fail(error: Error): void {
		if (this.stateValue !== "closed") this.stateValue = "failed";
		for (const [id, p] of this.pending) {
			clearTimeout(p.timer);
			this.pending.delete(id);
			p.reject(error);
		}
	}

	private onData(chunk: Buffer): void {
		if (this.buffer.length + chunk.length > READ_BUFFER_MAX) {
			this.buffer = Buffer.alloc(0);
			this.fail(new Error(`MCP server ${this.cfg.name}: read buffer exceeded ${READ_BUFFER_MAX} bytes`));
			return;
		}
		this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
		for (;;) {
			const index = this.buffer.indexOf(0x0a);
			if (index === -1) return;
			const line = this.buffer.toString("utf8", 0, index).replace(/\r$/, "");
			this.buffer = this.buffer.subarray(index + 1);
			if (!line.trim()) continue;
			let message: any;
			try {
				message = JSON.parse(line);
			} catch {
				continue; // non-JSON noise on stdout (servers that log there) — ignored like the adapter's guard
			}
			this.onMessage(message);
		}
	}

	private onMessage(message: any): void {
		if (!message || typeof message !== "object") return;
		const hasId = message.id !== undefined && message.id !== null;
		if (hasId && typeof message.method === "string") {
			// A request from the server: answer ping, refuse the rest.
			if (message.method === "ping") this.reply(message.id, {});
			else this.replyError(message.id, -32601, `method not supported by titan's client: ${message.method}`);
			return;
		}
		if (!hasId) return; // notification (logging, progress) — nothing to do
		const p = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
		if (!p) return;
		clearTimeout(p.timer);
		this.pending.delete(message.id);
		if (message.error) {
			const err = message.error;
			p.reject(new McpRpcError(p.method, typeof err.code === "number" ? err.code : -32000, typeof err.message === "string" ? err.message : "error", err.data));
		} else p.resolve(message.result);
	}

	private reply(id: unknown, result: unknown): void {
		try {
			this.proc?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
		} catch {}
	}

	private replyError(id: unknown, code: number, message: string): void {
		try {
			this.proc?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
		} catch {}
	}
}

/** Signal the child's whole process group (detached spawn) and, failing that, the child itself. */
const killTree = (proc: ChildProcess, signal: NodeJS.Signals): void => {
	try {
		if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, signal);
		else proc.kill(signal);
	} catch {
		try {
			proc.kill(signal);
		} catch {}
	}
};

const lastLine = (text: string): string => {
	const lines = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	return lines[lines.length - 1] ?? "";
};

// ═══ Bridge (what WorkflowRuntimeDeps.mcpTool is built from) ═════════════════

export interface McpBridgeOptions {
	catalog?: McpServerConfig[];
	/** Re-read the catalog on first use when `catalog` is absent. */
	cwd?: string;
	timeoutMs?: number;
	startTimeoutMs?: number;
	clientOptions?: Omit<McpClientOptions, "timeoutMs" | "startTimeoutMs">;
	/** Called with the wall time of each tool call (MCP calls have no token cost). */
	onCall?(row: { server: string; tool: string; ms: number; ok: boolean }): void;
}

export interface McpBridgeStatus {
	server: string;
	state: McpClientState | "disabled";
	reason?: string;
	calls: number;
	tools?: number;
}

export interface McpToolBridge {
	mcpTool(server: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
	listTools(server: string): Promise<McpTool[]>;
	status(): McpBridgeStatus[];
	catalog(): McpServerConfig[];
	close(): Promise<void>;
}

/** Text content blocks → the value the workflow stores: structuredContent, else parsed JSON text, else the text. */
export function toolResultValue(result: McpToolResult): unknown {
	if (result.structured !== undefined) return result.structured;
	const texts = (Array.isArray(result.content) ? result.content : [])
		.filter((block: any) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text as string);
	if (texts.length === 1) {
		const trimmed = texts[0].trim();
		if (/^[[{]/.test(trimmed)) {
			try {
				return JSON.parse(trimmed);
			} catch {
				/* plain text */
			}
		}
		return texts[0];
	}
	if (texts.length) return texts.join("\n");
	return result.content;
}

export function createMcpToolBridge(opts: McpBridgeOptions = {}): McpToolBridge {
	let configs: McpServerConfig[] | undefined = opts.catalog;
	const clients = new Map<string, McpClient>();
	const tools = new Map<string, number>();
	const catalog = (): McpServerConfig[] => (configs ??= loadMcpCatalog(defaultCatalogPaths(opts.cwd)));
	const configFor = (server: string): McpServerConfig => {
		const cfg = catalog().find((c) => c.name === server);
		if (!cfg) throw new Error(`MCP server ${server} is not in the catalog (${catalog().map((c) => c.name).join(", ") || "empty"})`);
		if (cfg.disabled) throw new Error(`MCP server ${server} disabled: ${cfg.reason ?? "disabled"}`);
		return cfg;
	};
	const clientFor = async (server: string): Promise<McpClient> => {
		const cfg = configFor(server);
		let client = clients.get(server);
		if (client && (client.state === "failed" || client.state === "closed")) {
			clients.delete(server);
			client = undefined;
		}
		if (!client) {
			client = new McpClient(cfg, { ...(opts.clientOptions ?? {}), timeoutMs: opts.timeoutMs, startTimeoutMs: opts.startTimeoutMs });
			clients.set(server, client);
		}
		await client.start();
		return client;
	};
	return {
		async mcpTool(server, tool, args) {
			const client = await clientFor(server); // catalog refusals (unknown/disabled) throw before any call is counted
			const started = Date.now();
			let ok = false;
			try {
				const result = await client.callTool(tool, args ?? {});
				if (result.isError) {
					const text = toolResultValue(result);
					throw new Error(`MCP ${server}/${tool} returned an error: ${typeof text === "string" ? text : JSON.stringify(text)}`);
				}
				ok = true;
				return toolResultValue(result);
			} finally {
				try {
					opts.onCall?.({ server, tool, ms: Date.now() - started, ok });
				} catch {}
			}
		},
		async listTools(server) {
			const client = await clientFor(server);
			const list = await client.listTools();
			tools.set(server, list.length);
			return list;
		},
		status() {
			return catalog().map((cfg) => {
				const client = clients.get(cfg.name);
				return { server: cfg.name, state: cfg.disabled ? "disabled" : (client?.state ?? "idle"), reason: cfg.reason, calls: client?.calls ?? 0, tools: tools.get(cfg.name) };
			});
		},
		catalog: () => catalog().map((cfg) => ({ ...cfg, env: { ...cfg.env } })),
		async close() {
			await Promise.all([...clients.values()].map((client) => client.close().catch(() => {})));
			clients.clear();
		},
	};
}
