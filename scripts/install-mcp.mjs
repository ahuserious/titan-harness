#!/usr/bin/env node
/**
 * install-mcp.mjs — merge this package's MCP catalog (mcp/mcp.json) into an MCP
 * config file that Pi (pi-mcp-adapter), Claude Code, Cursor, and Codex all read.
 *
 *   node scripts/install-mcp.mjs                 # → ~/.config/mcp/mcp.json (user-global)
 *   node scripts/install-mcp.mjs --project       # → ./.mcp.json (project-local)
 *   node scripts/install-mcp.mjs --target PATH   # → any mcp.json
 *   node scripts/install-mcp.mjs --force         # overwrite same-named servers
 *   node scripts/install-mcp.mjs --dry-run       # print the merged result, write nothing
 *
 * Never writes secrets: entries reference ${ENV_VAR} placeholders that the MCP host
 * interpolates at connect time. OAuth servers authenticate in the browser on first use.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const catalogPath = join(here, "..", "mcp", "mcp.json");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

const target = opt("--target")
	? resolve(opt("--target"))
	: flag("--project")
		? resolve(process.cwd(), ".mcp.json")
		: join(homedir(), ".config", "mcp", "mcp.json");

const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
let existing = {};
if (existsSync(target)) {
	try {
		existing = JSON.parse(readFileSync(target, "utf8"));
	} catch (error) {
		console.error(`Refusing to touch ${target}: it is not valid JSON (${error.message}).`);
		process.exit(2);
	}
	if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
		console.error(`Refusing to touch ${target}: top-level value is not an object.`);
		process.exit(2);
	}
}

const merged = { ...existing, mcpServers: { ...(existing.mcpServers ?? {}) } };
const added = [];
const kept = [];
const replaced = [];
for (const [name, entry] of Object.entries(catalog.mcpServers)) {
	if (merged.mcpServers[name] && !flag("--force")) {
		kept.push(name);
		continue;
	}
	if (merged.mcpServers[name]) replaced.push(name);
	else added.push(name);
	merged.mcpServers[name] = entry;
}

const envVars = new Set();
for (const name of [...added, ...replaced]) {
	const text = JSON.stringify(catalog.mcpServers[name]);
	for (const match of text.matchAll(/\$\{([A-Z0-9_]+)\}/g)) envVars.add(match[1]);
}
const missingEnv = [...envVars].filter((v) => !process.env[v]);
const oauth = [...added, ...replaced].filter((name) => catalog.mcpServers[name].auth === "oauth");
const disabled = [...added, ...replaced].filter((name) => catalog.mcpServers[name].disabled);

if (flag("--dry-run")) {
	console.log(JSON.stringify(merged, null, 2));
} else {
	mkdirSync(dirname(target), { recursive: true });
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, target);
	console.log(`Wrote ${target}`);
}
console.log(`  added:    ${added.join(", ") || "none"}`);
console.log(`  replaced: ${replaced.join(", ") || "none"}`);
console.log(`  kept:     ${kept.join(", ") || "none"}${kept.length ? "  (use --force to overwrite)" : ""}`);
if (oauth.length) console.log(`  OAuth on first use (browser): ${oauth.join(", ")}  — in Pi: /mcp, pick the server, authenticate`);
if (disabled.length) console.log(`  disabled until configured:    ${disabled.join(", ")}  — set the env vars below and flip "disabled" to false`);
if (missingEnv.length) console.log(`  env vars not set in this shell: ${missingEnv.join(", ")}`);
