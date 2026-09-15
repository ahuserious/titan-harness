/**
 * pins.ts — the companion-package version pins titan-harness is verified against, and
 * the boot check that reports drift.
 *
 * Pure Node: no pi imports, so scripts and tests can load it without a host. The
 * session-start hook in the extension factory calls checkPins() and dwPatchApplied()
 * and only notifies; nothing here installs, upgrades or patches anything (the patch is
 * applied by scripts/apply-dw-patch.mjs, the pins by `pi install npm:<pkg>@<version>`).
 *
 * Pins live in ~/.pi/agent/npm/node_modules/<pkg>/package.json (Pi's npm package dir;
 * PI_CODING_AGENT_DIR relocates the agent dir the same way Pi does).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const PINS = {
	"pi-mcp-adapter": "2.33.0",
	"@quintinshaw/pi-dynamic-workflows": "3.10.1",
	"pi-subagents": "0.67.0",
	"pi-exa": "0.6.1",
	"pi-antigravity": "0.7.2",
	"@raindrop-ai/pi-agent": "0.2.1",
	"@signalridge/pi-codex-compact": "1.3.1",
} as const;

export type PinnedPackage = keyof typeof PINS;

export interface PinReport {
	name: string;
	expected: string;
	/** installed version, or null when the package is missing or its manifest is unreadable */
	found: string | null;
	ok: boolean;
}

export const DW_PACKAGE = "@quintinshaw/pi-dynamic-workflows";
export const DW_DIST_FILE = "dist/workflow-commands.js";
/** The string the local /workflows menu-hook patch adds; its presence means "patch applied". */
export const DW_PATCH_MARKER = 'Symbol.for("titan-harness:workflows-menu")';

export function defaultAgentDir(env: Record<string, string | undefined> = process.env): string {
	const configured = env.PI_CODING_AGENT_DIR?.trim();
	if (!configured) return path.join(os.homedir(), ".pi", "agent");
	if (configured === "~") return os.homedir();
	if (configured.startsWith("~/")) return path.resolve(os.homedir(), configured.slice(2));
	return path.resolve(configured);
}

export function packageManifestPath(pkg: string, agentDir = defaultAgentDir()): string {
	return path.join(agentDir, "npm", "node_modules", pkg, "package.json");
}

export function installedVersion(pkg: string, agentDir = defaultAgentDir()): string | null {
	try {
		const manifest = JSON.parse(fs.readFileSync(packageManifestPath(pkg, agentDir), "utf8")) as { version?: unknown };
		return typeof manifest.version === "string" && manifest.version.trim() ? manifest.version.trim() : null;
	} catch {
		return null;
	}
}

/** One report per pin, in PINS order. `ok` is an exact version match. */
export function checkPins(agentDir = defaultAgentDir()): PinReport[] {
	return (Object.entries(PINS) as [string, string][]).map(([name, expected]) => {
		const found = installedVersion(name, agentDir);
		return { name, expected, found, ok: found === expected };
	});
}

export function dwDistPath(agentDir = defaultAgentDir()): string {
	return path.join(agentDir, "npm", "node_modules", DW_PACKAGE, DW_DIST_FILE);
}

/** True when the pinned pi-dynamic-workflows dist carries the local menu-hook patch. */
export function dwPatchApplied(agentDir = defaultAgentDir()): boolean {
	try {
		return fs.readFileSync(dwDistPath(agentDir), "utf8").includes(DW_PATCH_MARKER);
	} catch {
		return false;
	}
}

/** One-line summary for a notify: only the drifted or missing pins are spelled out. */
export function formatPinReport(reports: PinReport[]): string {
	const bad = reports.filter((r) => !r.ok);
	if (bad.length === 0) return `pins ok (${reports.length})`;
	return bad.map((r) => `${r.name}@${r.expected} ${r.found === null ? "missing" : `found ${r.found}`}`).join(" · ");
}
