import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CatalogPath, formatMcpRows, listMcpServers, rawDefinition, readRawCatalog, setMcpEnabled } from "../modules/mcp-toggle.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-mcp-toggle-"));
	dirs.push(dir);
	return dir;
};

const SECRET = "sk-live-do-not-write-me-anywhere";

/** package (wrapped) + user (missing) + project (missing) — the shape the real machine has before any toggle. */
function fixture(): { paths: CatalogPath[]; env: NodeJS.ProcessEnv; packageFile: string; userFile: string; projectFile: string } {
	const root = scratch();
	const packageFile = join(root, "pkg", "mcp", "mcp.json");
	const userFile = join(root, "home", ".config", "mcp", "mcp.json");
	const projectFile = join(root, "project", ".mcp.json");
	mkdirSync(join(root, "pkg", "mcp"), { recursive: true });
	writeFileSync(
		packageFile,
		JSON.stringify(
			{
				mcpServers: {
					figma: { command: "npx", args: ["-y", "figma-mcp"], env: { FIGMA_TOKEN: "${FIGMA_TOKEN}" } },
					shadcn: { command: "npx", args: ["shadcn@latest", "mcp"] },
					momentic: { command: "npx", args: ["-y", "momentic-mcp"], env: { MOMENTIC_API_KEY: "${MOMENTIC_API_KEY}" }, disabled: true, note: "keep me" },
					remote: { url: "https://mcp.example.com/mcp" },
				},
			},
			null,
			2,
		),
	);
	return { paths: [{ path: packageFile, layer: "package" }, { path: userFile, layer: "user" }, { path: projectFile, layer: "project" }], env: { FIGMA_TOKEN: SECRET }, packageFile, userFile, projectFile };
}

describe("mcp-toggle", () => {
	test("listMcpServers reports state, source layer and env NAMES only", () => {
		const { paths, env } = fixture();
		const rows = listMcpServers({ paths, env });
		expect(rows.map((row) => row.name)).toEqual(["figma", "momentic", "remote", "shadcn"]);
		const figma = rows.find((row) => row.name === "figma")!;
		expect(figma).toMatchObject({ enabled: true, source: "package", sources: ["package"], envNames: ["FIGMA_TOKEN"], transport: "stdio", explicitlyDisabled: false });
		const momentic = rows.find((row) => row.name === "momentic")!;
		expect(momentic).toMatchObject({ enabled: false, explicitlyDisabled: true });
		expect(momentic.reason).toBe("disabled in the catalog");
		const remote = rows.find((row) => row.name === "remote")!;
		expect(remote.enabled).toBe(false);
		expect(remote.transport).toBe("http");
		const noEnv = listMcpServers({ paths, env: {} }).find((row) => row.name === "figma")!;
		expect(noEnv.enabled).toBe(false);
		expect(noEnv.reason).toBe("missing env FIGMA_TOKEN");
		const text = formatMcpRows(rows);
		expect(text).toContain("figma");
		expect(text).not.toContain(SECRET);
		expect(JSON.stringify(rows)).not.toContain(SECRET);
	});

	test("enabling a package server in the user scope copies the RAW definition (references, not values) and never touches the package file", () => {
		const { paths, env, packageFile, userFile } = fixture();
		const before = readFileSync(packageFile, "utf8");
		const result = setMcpEnabled("momentic", true, { paths, env, scope: "user" });
		expect(result).toEqual({ path: userFile, layer: "user", needsReload: true, created: true, enabled: true });
		expect(readFileSync(packageFile, "utf8")).toBe(before);
		const written = readFileSync(userFile, "utf8");
		expect(written).toContain('"${MOMENTIC_API_KEY}"');
		expect(written).not.toContain(SECRET);
		expect(statSync(userFile).mode & 0o777).toBe(0o600);
		const raw = readRawCatalog(userFile);
		expect(raw.wrapped).toBe(true);
		expect(raw.servers.momentic).toEqual({ command: "npx", args: ["-y", "momentic-mcp"], env: { MOMENTIC_API_KEY: "${MOMENTIC_API_KEY}" }, disabled: false, note: "keep me" });
		const rows = listMcpServers({ paths, env: { ...env, MOMENTIC_API_KEY: "x" } });
		expect(rows.find((row) => row.name === "momentic")).toMatchObject({ enabled: true, source: "user", sources: ["package", "user"], explicitlyDisabled: false });
		// Toggling again updates the existing entry in place (no duplicate, unknown keys kept).
		const again = setMcpEnabled("momentic", false, { paths, env, scope: "user" });
		expect(again.created).toBe(false);
		expect(readRawCatalog(userFile).servers.momentic.note).toBe("keep me");
		expect(readRawCatalog(userFile).servers.momentic.disabled).toBe(true);
	});

	test("existing user files keep their other servers, unknown top-level keys and unwrapped layout", () => {
		const { paths, env, userFile } = fixture();
		mkdirSync(join(userFile, ".."), { recursive: true });
		writeFileSync(userFile, JSON.stringify({ mine: { command: "node", args: ["mine.js"] }, $comment: "hand-written" }, null, 2));
		setMcpEnabled("shadcn", false, { paths, env, scope: "user" });
		const raw = readRawCatalog(userFile);
		expect(raw.wrapped).toBe(false);
		expect(raw.servers.mine).toEqual({ command: "node", args: ["mine.js"] });
		expect(raw.servers.shadcn).toEqual({ command: "npx", args: ["shadcn@latest", "mcp"], disabled: true });
		expect((raw.doc as Record<string, unknown>).$comment).toBe("hand-written");
		expect(listMcpServers({ paths, env }).find((row) => row.name === "shadcn")).toMatchObject({ enabled: false, source: "user", explicitlyDisabled: true, reason: "disabled in the catalog" });
	});

	test("project scope writes <cwd>/.mcp.json and wins over the user layer; unknown servers and the package target are refused", () => {
		const { paths, env, projectFile, userFile, packageFile } = fixture();
		const result = setMcpEnabled("figma", false, { paths, env, scope: "project" });
		expect(result.path).toBe(projectFile);
		expect(result.layer).toBe("project");
		expect(existsSync(userFile)).toBe(false);
		expect(readRawCatalog(projectFile).servers.figma.disabled).toBe(true);
		expect(readFileSync(projectFile, "utf8")).toContain('"${FIGMA_TOKEN}"');
		expect(readFileSync(projectFile, "utf8")).not.toContain(SECRET);
		expect(listMcpServers({ paths, env }).find((row) => row.name === "figma")).toMatchObject({ enabled: false, source: "project", sources: ["package", "project"] });
		expect(() => setMcpEnabled("ghost", true, { paths, env })).toThrow("not in any catalog layer");
		expect(() => setMcpEnabled("../x", true, { paths, env })).toThrow("invalid MCP server name");
		expect(() => setMcpEnabled("figma", true, { paths: [{ path: packageFile, layer: "user" }, { path: packageFile, layer: "package" }], env, scope: "user" })).toThrow("refusing to write the package catalog");
		expect(rawDefinition("figma", paths)?.layer).toBe("project");
		expect(rawDefinition("nope", paths)).toBeUndefined();
	});

	test("a malformed target file is refused rather than overwritten", () => {
		const { paths, env, userFile } = fixture();
		mkdirSync(join(userFile, ".."), { recursive: true });
		writeFileSync(userFile, "{ definitely not json");
		expect(() => setMcpEnabled("shadcn", false, { paths, env, scope: "user" })).toThrow("not valid JSON");
		expect(readFileSync(userFile, "utf8")).toBe("{ definitely not json");
	});
});
