/**
 * mcp-toggle.ts — list the merged MCP catalog and toggle servers on/off (PRD v0.9 R4).
 *
 * Reads the same three layers titan's stdio bridge and pi-mcp-adapter read — the package
 * catalog (mcp/mcp.json), the user file (~/.config/mcp/mcp.json) and the project file
 * (<cwd>/.mcp.json) — through modules/mcp-client.ts, and writes ONLY the user or the project
 * file. Toggling a server that is defined in a lower layer copies its RAW definition (the
 * `${VAR}` references, never expanded values) into the target file, then sets `disabled`.
 * Unknown keys in the target file are preserved; writes are atomic and 0600; the package
 * file is never written. pi-mcp-adapter reads the catalog at start, so every write reports
 * `needsReload: true`. Reasons name environment variables, never their values.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultCatalogPaths, loadMcpCatalog, type McpCatalogLayer, type McpServerConfig, type McpTransport } from "./mcp-client.ts";

export interface CatalogPath {
	path: string;
	layer: McpCatalogLayer;
}

export interface McpServerRow {
	name: string;
	/** The layer whose definition wins (last file that defines the server). */
	source: McpCatalogLayer;
	sources: McpCatalogLayer[];
	enabled: boolean;
	/** Why the runtime bridge would not start it (names only). */
	reason?: string;
	envNames: string[];
	transport: McpTransport;
	command?: string;
	/** `disabled: true` is written explicitly in the winning file (as opposed to disabled by a missing env). */
	explicitlyDisabled: boolean;
}

export interface McpToggleOptions {
	cwd?: string;
	/** Override the three catalog files (tests). */
	paths?: CatalogPath[];
	env?: NodeJS.ProcessEnv;
	scope?: "user" | "project";
}

export interface McpToggleResult {
	path: string;
	layer: "user" | "project";
	needsReload: true;
	/** The entry did not exist in the target file and was copied from a lower layer. */
	created: boolean;
	enabled: boolean;
}

export function catalogPaths(opts: McpToggleOptions = {}): CatalogPath[] {
	return opts.paths ?? defaultCatalogPaths(opts.cwd ?? process.cwd());
}

type RawCatalog = { doc: Record<string, unknown>; servers: Record<string, Record<string, unknown>>; wrapped: boolean };

/** Read a catalog file raw (no env expansion). A missing file → an empty wrapped document. */
export function readRawCatalog(file: string): RawCatalog {
	let text: string | undefined;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return { doc: { mcpServers: {} }, servers: {}, wrapped: true };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`titan-harness: ${file} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`titan-harness: ${file} must hold a JSON object`);
	const doc = parsed as Record<string, unknown>;
	const wrapped = doc.mcpServers !== undefined && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers);
	const servers = (wrapped ? (doc.mcpServers as Record<string, unknown>) : doc) as Record<string, Record<string, unknown>>;
	return { doc, servers, wrapped };
}

/** Every catalog server with its state — the runtime bridge's view plus where it is defined. */
export function listMcpServers(opts: McpToggleOptions = {}): McpServerRow[] {
	const paths = catalogPaths(opts);
	const layerOf = new Map(paths.map((entry) => [path.resolve(entry.path), entry.layer]));
	const configs: McpServerConfig[] = loadMcpCatalog(paths, opts.env ?? process.env);
	const explicit = new Map<string, boolean>();
	for (const entry of paths) {
		try {
			const raw = readRawCatalog(entry.path);
			for (const [name, def] of Object.entries(raw.servers)) {
				if (def && typeof def === "object") explicit.set(name, def.disabled === true);
			}
		} catch {
			/* a malformed layer is ignored here; the bridge reports it */
		}
	}
	return configs
		.map((cfg) => {
			const sources = cfg.sources.map((file) => layerOf.get(path.resolve(file)) ?? ("user" as McpCatalogLayer));
			return {
				name: cfg.name,
				source: sources[sources.length - 1] ?? "package",
				sources,
				enabled: !cfg.disabled,
				reason: cfg.reason,
				envNames: cfg.envNames,
				transport: cfg.transport,
				command: cfg.command || undefined,
				explicitlyDisabled: explicit.get(cfg.name) === true,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** The raw definition of `name` from the highest-precedence layer that defines it (project > user > package). */
export function rawDefinition(name: string, paths: CatalogPath[]): { def: Record<string, unknown>; layer: McpCatalogLayer } | undefined {
	for (const entry of [...paths].reverse()) {
		try {
			const raw = readRawCatalog(entry.path);
			const def = raw.servers[name];
			if (def && typeof def === "object" && !Array.isArray(def)) return { def, layer: entry.layer };
		} catch {
			/* skip malformed */
		}
	}
	return undefined;
}

/**
 * Enable or disable one server in the user (default) or project catalog file. The entry is
 * created from its raw lower-layer definition when the target file lacks it; every other key
 * of the file and of the entry is preserved.
 */
export function setMcpEnabled(name: string, enabled: boolean, opts: McpToggleOptions = {}): McpToggleResult {
	if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`titan-harness: invalid MCP server name ${JSON.stringify(name)}`);
	const paths = catalogPaths(opts);
	const scope = opts.scope ?? "user";
	const target = paths.find((entry) => entry.layer === scope);
	if (!target) throw new Error(`titan-harness: no ${scope} catalog path configured`);
	const packageFile = paths.find((entry) => entry.layer === "package")?.path;
	if (packageFile && path.resolve(packageFile) === path.resolve(target.path)) throw new Error("titan-harness: refusing to write the package catalog");
	const raw = readRawCatalog(target.path);
	let created = false;
	let entry = raw.servers[name];
	if (!entry) {
		const source = rawDefinition(name, paths);
		if (!source) throw new Error(`titan-harness: MCP server ${JSON.stringify(name)} is not in any catalog layer (${paths.map((p) => p.layer).join(", ")})`);
		entry = JSON.parse(JSON.stringify(source.def)) as Record<string, unknown>; // the RAW definition: ${VAR} references stay references
		created = true;
	}
	entry.disabled = !enabled;
	raw.servers[name] = entry;
	const doc = raw.wrapped ? { ...raw.doc, mcpServers: raw.servers } : raw.servers;
	fs.mkdirSync(path.dirname(target.path), { recursive: true, mode: 0o700 });
	const tmp = `${target.path}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, target.path);
	try {
		fs.chmodSync(target.path, 0o600);
	} catch {
		/* best effort on exotic filesystems */
	}
	return { path: target.path, layer: scope, needsReload: true, created, enabled };
}

/** One line per server for panels and /titan-config show. */
export function formatMcpRows(rows: McpServerRow[]): string {
	if (!rows.length) return "no MCP servers in the catalog";
	const width = Math.max(...rows.map((row) => row.name.length));
	return rows
		.map((row) => {
			const state = row.enabled ? "on " : "off";
			const why = row.enabled ? "" : ` · ${row.reason ?? "disabled"}`;
			return `${row.enabled ? "✓" : "○"} ${row.name.padEnd(width)}  ${state}  ${row.source}${why}`;
		})
		.join("\n");
}
