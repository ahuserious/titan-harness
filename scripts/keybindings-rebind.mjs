#!/usr/bin/env node
/**
 * keybindings-rebind.mjs — free `shift+tab` for titan's level hotkey (plan D5, §4.6).
 *
 * Pi reserves `shift+tab` for `app.thinking.cycle` and silently drops extension bindings
 * on it. This script moves that action to another key in ~/.pi/agent/keybindings.json
 * (created if absent, other keys preserved, backed up to keybindings.json.bak first) so
 * titan can bind `shift+tab` at the next session_start. Node ESM, no dependencies.
 *
 *   node scripts/keybindings-rebind.mjs             merge {"app.thinking.cycle": "alt+t"} (after backup)
 *   node scripts/keybindings-rebind.mjs --dry-run   print the would-be file, write nothing
 *   node scripts/keybindings-rebind.mjs --check     print "free" (exit 0) or "reserved" (exit 2)
 *   node scripts/keybindings-rebind.mjs --restore   put keybindings.json.bak back
 *   options: --to <key> (default alt+t), --file <path> (default $PI_CODING_AGENT_DIR or ~/.pi/agent + /keybindings.json)
 *
 * /titan-level --claim-shift-tab runs the merge after a confirm dialog and asks for /reload.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ACTION = "app.thinking.cycle";
const RESERVED_KEY = "shift+tab";
const DEFAULT_TARGET = "alt+t";
const KEY_RE = /^[a-z0-9]+(\+[a-z0-9]+)*$/i;

function usage(code) {
	const out = code === 0 ? console.log : console.error;
	out("usage: keybindings-rebind.mjs [--check | --dry-run | --restore] [--to <key>] [--file <path>]");
	process.exit(code);
}

function parseArgs(argv) {
	const args = { mode: "merge", to: DEFAULT_TARGET, file: undefined };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--check") args.mode = "check";
		else if (arg === "--dry-run") args.mode = "dry-run";
		else if (arg === "--restore") args.mode = "restore";
		else if (arg === "--help" || arg === "-h") usage(0);
		else if (arg === "--to") args.to = argv[++i] ?? "";
		else if (arg.startsWith("--to=")) args.to = arg.slice(5);
		else if (arg === "--file") args.file = argv[++i];
		else if (arg.startsWith("--file=")) args.file = arg.slice(7);
		else {
			console.error(`unknown argument: ${arg}`);
			usage(1);
		}
	}
	if (!KEY_RE.test(args.to)) {
		console.error(`--to must be a key chord such as alt+t; found ${JSON.stringify(args.to)}`);
		process.exit(1);
	}
	return args;
}

function expandTilde(p) {
	return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function keybindingsPath(fileFlag) {
	if (fileFlag) return resolve(expandTilde(fileFlag));
	const agentDir = process.env.PI_CODING_AGENT_DIR ? expandTilde(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
	return join(agentDir, "keybindings.json");
}

/** { exists, config, invalid } — config is the parsed object when the file is valid JSON. */
function readConfig(file) {
	if (!existsSync(file)) return { exists: false, config: undefined, invalid: false };
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { exists: true, config: undefined, invalid: true };
		return { exists: true, config: parsed, invalid: false };
	} catch {
		return { exists: true, config: undefined, invalid: true };
	}
}

/** Chord equality that ignores case and modifier order ("Shift+Tab" == "tab+shift"). */
function sameChord(a, b) {
	const norm = (chord) => String(chord).toLowerCase().split("+").map((part) => part.trim()).sort().join("+");
	return norm(a) === norm(b);
}

/**
 * The action is free when the file maps it to a string other than shift+tab or to a
 * string list without shift+tab (an empty list unbinds it). A missing file, a missing
 * key, or a value Pi would ignore (wrong type) means Pi's default — reserved.
 */
function isFree(binding) {
	if (typeof binding === "string") return !sameChord(binding, RESERVED_KEY);
	if (Array.isArray(binding) && binding.every((entry) => typeof entry === "string")) return !binding.some((entry) => sameChord(entry, RESERVED_KEY));
	return false;
}

function describe(binding) {
	return binding === undefined ? `unset (Pi default ${RESERVED_KEY})` : JSON.stringify(binding);
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const file = keybindingsPath(args.file);
	const backup = `${file}.bak`;
	const { exists, config, invalid } = readConfig(file);
	const binding = config?.[ACTION];

	if (args.mode === "check") {
		const free = isFree(binding);
		console.error(`${file}: ${ACTION} = ${describe(binding)}${invalid ? " (file is not valid JSON; Pi ignores it)" : ""}`);
		console.log(free ? "free" : "reserved");
		process.exit(free ? 0 : 2);
	}

	if (args.mode === "restore") {
		if (!existsSync(backup)) {
			console.error(`no backup to restore: ${backup}`);
			process.exit(1);
		}
		copyFileSync(backup, file);
		console.log(`restored ${file} from ${backup} — run /reload in pi`);
		process.exit(0);
	}

	if (invalid && args.mode === "merge") {
		console.error(`${file} exists but is not valid JSON; fix or remove it before rebinding (nothing written)`);
		process.exit(1);
	}

	const next = { ...(config ?? {}), [ACTION]: args.to };
	const content = `${JSON.stringify(next, null, 2)}\n`;
	const conflicts = Object.entries(next).filter(([action, keys]) => action !== ACTION && (Array.isArray(keys) ? keys : [keys]).some((key) => typeof key === "string" && sameChord(key, args.to)));
	for (const [action] of conflicts) console.error(`warning: ${args.to} is already bound to ${action} in ${file}`);

	if (args.mode === "dry-run") {
		console.error(`would write ${file}${exists ? ` (backup → ${backup})` : " (new file)"}:`);
		process.stdout.write(content);
		process.exit(0);
	}

	if (isFree(binding)) {
		console.log(`already free: ${ACTION} = ${describe(binding)} in ${file}; nothing written`);
		process.exit(0);
	}
	mkdirSync(dirname(file), { recursive: true });
	if (exists) copyFileSync(file, backup);
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, content, { mode: 0o600 });
	renameSync(tmp, file);
	console.log(`wrote ${file}: ${ACTION} → ${args.to}${exists ? ` (backup: ${backup})` : ""}`);
	console.log("run /reload in pi; titan binds shift+tab to the level cycle at the next session_start. Undo with --restore.");
}

main();
