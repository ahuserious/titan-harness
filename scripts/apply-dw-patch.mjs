#!/usr/bin/env node
/**
 * apply-dw-patch.mjs — maintain titan-harness's one local patch to
 * @quintinshaw/pi-dynamic-workflows (pinned 3.10.1).
 *
 * The patch (one hunk in dist/workflow-commands.js): bare `/workflows` calls
 * globalThis[Symbol.for("titan-harness:workflows-menu")] when that hook exists (the
 * /stack menu: run navigator, subagent tools, fan-out, stack settings); without the hook
 * it is exactly the stock navigator call. `/workflows ui` is untouched.
 *
 *   node scripts/apply-dw-patch.mjs             # apply, idempotent: saves .orig if absent, inserts the hunk
 *   node scripts/apply-dw-patch.mjs --check     # exit 0 = applied, 2 = pristine (unpatched), 1 = error
 *   node scripts/apply-dw-patch.mjs --restore   # copy .orig back over the dist file
 *   node scripts/apply-dw-patch.mjs --agent-dir <dir>   # Pi agent dir (default ~/.pi/agent; PI_CODING_AGENT_DIR is honoured)
 *
 * Refuses every version of the package except 3.10.x: the hunk is anchored on that
 * file's layout. The boot pin check (modules/pins.ts) reports whether the marker is
 * present; this script is the only thing that writes the file. Retire the patch the
 * day upstream ships a menu hook (plan D1).
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE = "@quintinshaw/pi-dynamic-workflows";
const DIST_FILE = join("dist", "workflow-commands.js");
const SUPPORTED = /^3\.10\.\d+$/;
const MARKER = 'Symbol.for("titan-harness:workflows-menu")';

// Relative indentation (multiples of four spaces); the file's own base indent and unit are
// detected at the anchor so the hunk lands with the surrounding style.
const ORIGINAL_LINES = [
	"if (parts.length === 0 && ctx.hasUI) {",
	"    await openWorkflowNavigator(pi, manager, ctx.ui, {",
	"        storage: getStorage(),",
	"        cwd: getCwd(),",
	"        getStorage,",
	"        getCwd,",
	"        getManager,",
	"    });",
	"    return;",
	"}",
];
const PATCHED_LINES = [
	"if (parts.length === 0 && ctx.hasUI) {",
	"    const openNavigator = () => openWorkflowNavigator(pi, manager, ctx.ui, {",
	"        storage: getStorage(),",
	"        cwd: getCwd(),",
	"        getStorage,",
	"        getCwd,",
	"        getManager,",
	"    });",
	"    // Local patch (titan-harness, 2026-09-14): bare /workflows offers the",
	"    // stack's settings menu (subagent tools, fan-out) when its hook is",
	"    // present; without the hook this is exactly the original navigator call.",
	`    const stackMenu = globalThis[${MARKER}];`,
	'    if (typeof stackMenu === "function") {',
	"        await stackMenu(ctx, openNavigator);",
	"        return;",
	"    }",
	"    await openNavigator();",
	"    return;",
	"}",
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

function agentDir() {
	const given = opt("--agent-dir") ?? process.env.PI_CODING_AGENT_DIR?.trim();
	if (!given) return join(homedir(), ".pi", "agent");
	if (given === "~") return homedir();
	if (given.startsWith("~/")) return resolve(homedir(), given.slice(2));
	return resolve(given);
}

function fail(message, code = 1) {
	console.error(`apply-dw-patch: ${message}`);
	process.exit(code);
}

function leading(line) {
	return line.match(/^[ \t]*/)[0];
}

/** Find the pristine anchor. Returns { start, base, unit } or null; throws when ambiguous. */
function locate(lines) {
	const hits = [];
	for (let i = 0; i + ORIGINAL_LINES.length <= lines.length; i++) {
		if (lines[i].trim() !== ORIGINAL_LINES[0]) continue;
		const matches = ORIGINAL_LINES.every((expected, k) => lines[i + k].trim() === expected.trim());
		if (matches) hits.push(i);
	}
	if (hits.length > 1) throw new Error(`anchor occurs ${hits.length} times; refusing to guess`);
	if (hits.length === 0) return null;
	const start = hits[0];
	const base = leading(lines[start]);
	const inner = leading(lines[start + 1]);
	const unit = inner.startsWith(base) && inner.length > base.length ? inner.slice(base.length) : "    ";
	return { start, base, unit };
}

function render(relativeLines, base, unit) {
	return relativeLines.map((line) => {
		const spaces = leading(line).length;
		return base + unit.repeat(spaces / 4) + line.slice(spaces);
	});
}

function writeAtomic(file, text) {
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
}

const root = join(agentDir(), "npm", "node_modules", PACKAGE);
const manifestPath = join(root, "package.json");
const file = join(root, DIST_FILE);
const orig = `${file}.orig`;

if (!existsSync(manifestPath)) fail(`${PACKAGE} is not installed under ${root} (pi install npm:${PACKAGE}@3.10.1)`);
let version;
try {
	version = JSON.parse(readFileSync(manifestPath, "utf8")).version;
} catch (error) {
	fail(`cannot read ${manifestPath}: ${error.message}`);
}
if (typeof version !== "string" || !SUPPORTED.test(version)) {
	fail(`${PACKAGE} is ${version ?? "unversioned"}; this patch is only known for 3.10.x. Nothing written. Pin the package (pi install npm:${PACKAGE}@3.10.1) or retire the patch.`);
}
if (!existsSync(file)) fail(`${file} is missing`);

const mode = flag("--check") ? "check" : flag("--restore") ? "restore" : "apply";

if (mode === "restore") {
	if (!existsSync(orig)) fail(`no backup at ${orig}; nothing to restore`);
	copyFileSync(orig, `${file}.${process.pid}.tmp`);
	renameSync(`${file}.${process.pid}.tmp`, file);
	console.log(`restored ${file} from ${orig} (${PACKAGE}@${version})`);
	process.exit(0);
}

const content = readFileSync(file, "utf8");
const eol = content.includes("\r\n") ? "\r\n" : "\n";
const lines = content.split(/\r?\n/);
const applied = content.includes(MARKER);

if (mode === "check") {
	if (applied) {
		console.log(`check: applied (${PACKAGE}@${version}, ${file})`);
		process.exit(0);
	}
	let location = null;
	try {
		location = locate(lines);
	} catch (error) {
		fail(error.message);
	}
	if (location) {
		console.log(`check: pristine, patch not applied (${PACKAGE}@${version}); run without flags to apply`);
		process.exit(2);
	}
	fail(`${file} matches neither the patched nor the pristine 3.10.x layout`);
}

// apply
if (applied) {
	console.log(`already applied (${PACKAGE}@${version}, ${file}); nothing to do`);
	process.exit(0);
}
let location = null;
try {
	location = locate(lines);
} catch (error) {
	fail(error.message);
}
if (!location) fail(`anchor not found in ${file}; the file differs from the 3.10.x layout this patch knows. Nothing written.`);

const hadBackup = existsSync(orig);
copyFileSync(file, orig); // the file is verified pristine: (re)take the backup from it
const patched = [
	...lines.slice(0, location.start),
	...render(PATCHED_LINES, location.base, location.unit),
	...lines.slice(location.start + ORIGINAL_LINES.length),
].join(eol);
writeAtomic(file, patched);
if (!readFileSync(file, "utf8").includes(MARKER)) fail(`wrote ${file} but the marker is missing; restore with --restore`);
console.log(`applied the /workflows menu hook to ${file} (${PACKAGE}@${version}); backup ${hadBackup ? "refreshed" : "saved"} at ${orig}`);
